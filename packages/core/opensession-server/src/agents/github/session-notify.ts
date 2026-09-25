/**
 * Merge/deploy/preview events for PR-linked Open Session sessions. When a PR whose
 * head branch belongs to a session (primary branch or an attached repo) is
 * merged, a `[GitHub]` message is delivered into that session's transcript through the
 * SessionControl registry — the same steer/queue/start path a human message
 * takes — so the agent sees it and can react. The merge commit is then tracked in
 * ~/.opensession-github/pending-deploys.json (survives restarts), and when the
 * Deploy workflow (.github/workflows/deploy.yml) completes for that commit the
 * session gets a second message with the outcome. A repo can replace the
 * success message with its own prompt in `.opensession/deploy-verify.md` (read at
 * the deployed commit), so the session that wrote the change verifies it in
 * production against the review's "How we'll know" plan. (Pre-merge staging previews
 * are NOT announced here — the session header's Preview environment button already surfaces
 * the preview URL + Ready state, so a session notification would just be redundant.)
 */
import { stateDir } from "../../server/paths";
import { existsSync, readFileSync } from "fs";
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import {
  tryGetSessionControl,
  type SessionControl,
} from "../../server/session-control";
import { audit } from "../../server/audit";
import { configuredRepos, getConfigAsync } from "../../server/config";
import { SESSION_BRANCH_MATCH_LIMIT } from "../../server/session-list-protocol";
import { githubRequest } from "./github-rest";
import { readPrStateAsync } from "./state";
import { monitoringPlanMarkdown } from "./monitoring-plan";
import {
  matchSessions,
  workspaceIdForRepo,
  SessionOwnershipOverflowError,
} from "./session-matching";
export {
  matchReviewOwners,
  matchSessions,
  workspaceIdForRepo,
} from "./session-matching";

const PENDING_PATH = `${stateDir("github")}/pending-deploys.json`;
const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";
/** A merge whose deploy never reported back is dropped after this long. */
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;
/** A branch-linked event should normally target one session. Refuse an
 * implausible broadcast before it can start a fleet of agent turns. */
export const MAX_SESSION_NOTIFICATION_FANOUT = SESSION_BRANCH_MATCH_LIMIT;

/** Repo-owned post-deploy prompt, read at the deployed commit. */
export const DEPLOY_VERIFY_PROMPT_PATH = ".opensession/deploy-verify.md";
const MAX_DEPLOY_PROMPT_CHARS = 20_000;

interface PendingDeploy {
  prNumber: number;
  title: string;
  headRef: string;
  sessionIds: string[];
  recordedAt: string;
  /** owner/name; absent on entries written before deploy prompts shipped. */
  ghRepo?: string;
  author?: string;
  mergedBy?: string;
}

/** merge_commit_sha → the merge we're waiting on a deploy for. */
type PendingDeploys = Record<string, PendingDeploy>;

function readPending(): PendingDeploys {
  if (!existsSync(PENDING_PATH)) return {};
  try {
    const all = JSON.parse(
      readFileSync(PENDING_PATH, "utf-8"),
    ) as PendingDeploys;
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [sha, p] of Object.entries(all)) {
      if (new Date(p.recordedAt).getTime() < cutoff) delete all[sha];
    }
    return all;
  } catch {
    return {};
  }
}

/** Sessions a merged PR is still waiting on a deploy for. The worktree reaper
 *  keeps their checkouts even when the session is archived, so the post-deploy
 *  verify prompt lands in a session whose checkout still exists. */
export async function sessionsAwaitingDeploy(): Promise<Set<string>> {
  let all: PendingDeploys;
  try {
    all = JSON.parse(await readFile(PENDING_PATH, "utf-8")) as PendingDeploys;
  } catch {
    return new Set();
  }
  const cutoff = Date.now() - PENDING_TTL_MS;
  const ids = new Set<string>();
  for (const p of Object.values(all)) {
    if (new Date(p.recordedAt).getTime() < cutoff) continue;
    for (const id of p.sessionIds || []) ids.add(id);
  }
  return ids;
}

/** Deduplicate ordinary multi-session matches and fail closed on an
 * implausible broadcast. Exported as a pure seam for the fan-out regression
 * test; the caller owns logging/auditing the refusal. */
export function boundedSessionNotificationIds(
  sessionIds: string[],
): string[] | null {
  const unique = [...new Set(sessionIds)];
  return unique.length <= MAX_SESSION_NOTIFICATION_FANOUT ? unique : null;
}

function guardedSessionNotificationIds(
  sessionIds: string[],
  event: "pr_merged" | "deploy_completed",
  detail: Record<string, unknown>,
): string[] | null {
  const bounded = boundedSessionNotificationIds(sessionIds);
  if (bounded) return bounded;
  console.error(
    `[github] Refusing ${event} session notification fan-out to ${new Set(sessionIds).size} sessions`,
  );
  audit({
    msg: "github_session_notification_fuse",
    event,
    matched_sessions: new Set(sessionIds).size,
    max_sessions: MAX_SESSION_NOTIFICATION_FANOUT,
    ...detail,
  });
  return null;
}

async function deliver(
  control: SessionControl,
  sessionIds: string[],
  message: string,
  deliveryKey: string,
): Promise<void> {
  for (const id of sessionIds) {
    try {
      // Default busy behavior: fold into the running turn as a steer. Steering
      // is a non-interrupting history append the turn picks up at its next
      // stopping point (steerPiRun) — exactly right for an FYI; it only
      // falls back to the queue when nothing is steerable (external run).
      const res = await control.deliverToSession(id, message, "GitHub", {
        deliveryId: `${deliveryKey}:${id}`,
      });
      console.log(`[github] session notify → ${id}: ${res.status}`);
    } catch (e) {
      console.error(`[github] session notify → ${id} failed:`, e);
    }
  }
}

/** `pull_request` webhook payload with action=closed & merged=true. */
export async function notifyMergedPrSessions(payload: any): Promise<void> {
  const pr = payload?.pull_request;
  const headRef: string = pr?.head?.ref || "";
  const workspaceId = await workspaceIdForRepo(
    payload?.repository?.full_name || "",
  );
  if (!pr || !headRef || !workspaceId) return;
  const control = tryGetSessionControl();
  if (!control) return;

  let sessions: Awaited<ReturnType<typeof matchSessions>>;
  try {
    sessions = await matchSessions(workspaceId, headRef);
  } catch (error) {
    if (!(error instanceof SessionOwnershipOverflowError)) throw error;
    audit({
      msg: "github_session_notification_fuse",
      event: "pr_merged",
      matched_sessions_at_least: error.minimumMatches,
      max_sessions: MAX_SESSION_NOTIFICATION_FANOUT,
      pr_number: pr.number,
      workspace_id: workspaceId,
      head_ref: headRef,
    });
    console.error(`[github] ${error.message}`);
    return;
  }
  if (!sessions.length) return;

  const prNumber: number = pr.number;
  const title: string = pr.title || `PR #${prNumber}`;
  const mergedBy: string =
    pr.merged_by?.login || payload?.sender?.login || "someone";
  const author: string = pr.user?.login || "";
  const ghRepo: string = payload?.repository?.full_name || "";
  const base: string = pr.base?.ref || "main";
  const repo = configuredRepos(await getConfigAsync())[workspaceId];
  const trackDeploy =
    repo?.deploymentTracking === true &&
    base === repo.defaultBranch &&
    !!pr.merge_commit_sha;

  // One line. The session already knows which PR it owns, and its panel shows
  // the title, so the number and who merged it is the whole news.
  const message =
    `PR #${prNumber} merged` +
    (repo && base === repo.defaultBranch ? "" : ` into ${base}`) +
    ` by ${mergedBy}.` +
    (trackDeploy ? " Deploying." : "") +
    " No action needed.";

  const sessionIds = guardedSessionNotificationIds(
    sessions.map((s) => s.id),
    "pr_merged",
    { pr_number: prNumber, workspace_id: workspaceId, head_ref: headRef },
  );
  if (!sessionIds) return;

  console.log(
    `[github] PR #${prNumber} merged → notifying ${sessionIds.length} session(s) on ${workspaceId}:${headRef}`,
  );
  await deliver(
    control,
    sessionIds,
    message,
    `github-merge:${payload?.repository?.full_name || workspaceId}:${prNumber}:${pr.merge_commit_sha || headRef}`,
  );

  if (trackDeploy) {
    const pending = readPending();
    pending[pr.merge_commit_sha] = {
      prNumber,
      title,
      headRef,
      sessionIds,
      recordedAt: new Date().toISOString(),
      ...(ghRepo ? { ghRepo } : {}),
      ...(author ? { author } : {}),
      mergedBy,
    };
    writeJsonAtomic(PENDING_PATH, pending);
  }
}

/** `workflow_run` webhook payload; acts only on Deploy completions we're waiting on. */
export async function handleDeployWorkflowRun(payload: any): Promise<void> {
  if (payload?.action !== "completed") return;
  const run = payload?.workflow_run;
  if (!run || (run.path !== DEPLOY_WORKFLOW_PATH && run.name !== "Deploy"))
    return;

  const pending = readPending();
  const entry = pending[run.head_sha];
  if (!entry) return;
  delete pending[run.head_sha];
  writeJsonAtomic(PENDING_PATH, pending);

  const control = tryGetSessionControl();
  if (!control) return;

  const success = run.conclusion === "success";
  const message = success
    ? `PR #${entry.prNumber} deployed. No action needed.`
    : `Deploy ${run.conclusion || "failed"} for PR #${entry.prNumber}: ${run.html_url}`;

  const sessionIds = guardedSessionNotificationIds(
    entry.sessionIds,
    "deploy_completed",
    {
      pr_number: entry.prNumber,
      head_sha: run.head_sha,
      conclusion: run.conclusion,
    },
  );
  if (!sessionIds) return;

  console.log(
    `[github] Deploy ${run.conclusion} for ${run.head_sha} → notifying ${sessionIds.length} session(s)`,
  );
  // The repo's verify prompt goes to ONE owning session: several sessions on
  // the same branch would otherwise each verify, and each might open its own
  // fix or revert PR. The rest keep the plain FYI.
  const ghRepo: string = entry.ghRepo || payload?.repository?.full_name || "";
  const verifier = success ? deployVerifierSession(sessionIds) : null;
  const verifyPrompt =
    verifier && ghRepo
      ? await deployVerifyPrompt(entry, {
          ghRepo,
          sha: run.head_sha,
          runUrl: run.html_url || "",
        }).catch((e) => {
          console.warn(
            `[github] deploy verify prompt unavailable for PR #${entry.prNumber}:`,
            e,
          );
          return null;
        })
      : null;
  const deliveryKey = `github-deploy:${run.id || run.head_sha}:${run.conclusion || "unknown"}`;
  if (!verifier || !verifyPrompt) {
    await deliver(control, sessionIds, message, deliveryKey);
    return;
  }
  const rest = sessionIds.filter((id) => id !== verifier);
  audit({
    msg: "github_deploy_verify_prompt",
    pr_number: entry.prNumber,
    repo: ghRepo,
    head_sha: run.head_sha,
    session_id: verifier,
  });
  // The owner may have archived the session after merging. The verify turn
  // runs either way; unarchive it first so that turn, and anything it opens,
  // is visible in the sidebar instead of running out of sight.
  await surfaceArchivedSession(verifier).catch((e) =>
    console.warn(
      `[github] could not unarchive ${verifier} for deploy verify:`,
      e,
    ),
  );
  await deliver(control, [verifier], verifyPrompt, deliveryKey);
  if (rest.length) await deliver(control, rest, message, deliveryKey);
}

async function surfaceArchivedSession(id: string): Promise<void> {
  const [{ findSessionAsync }, { unarchiveForHumanTurn }] = await Promise.all([
    import("../../server/session-cache"),
    import("../../server/session-unarchive"),
  ]);
  const session = await findSessionAsync(id);
  if (!session || !(await unarchiveForHumanTurn(session))) return;
  console.log(`[github] unarchived ${id} to verify its deploy`);
  audit({ msg: "github_deploy_verify_unarchived", session_id: id });
}

/** The session that verifies a deploy: the first one a person works in. The
 *  PR agent's own sessions (`bks-ghpr-<pr>-review`, `-autofix`, ...) match the
 *  branch too, but a reviewer did not write the change and must not act on
 *  production. With only those, nobody verifies and everyone gets the FYI. */
export function deployVerifierSession(sessionIds: string[]): string | null {
  return sessionIds.find((id) => !id.startsWith("bks-ghpr-")) ?? null;
}

/** Fill `{{name}}` placeholders; unknown names stay as written so a typo in
 *  the repo's prompt is visible rather than silently blank. */
export function renderDeployPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? vars[name] : whole,
  );
}

async function readRepoFileAt(
  ghRepo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const res = await githubRequest<{ content?: string; encoding?: string }>(
    "GET",
    `/repos/${ghRepo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  );
  if (!res.ok || !res.data?.content || res.data.encoding !== "base64")
    return null;
  return Buffer.from(res.data.content, "base64").toString("utf-8");
}

/** The repo's post-deploy prompt with this deploy filled in, or null when the
 *  repo has none (the caller keeps the plain success line). */
async function deployVerifyPrompt(
  entry: PendingDeploy,
  deploy: { ghRepo: string; sha: string; runUrl: string },
): Promise<string | null> {
  const template = await readRepoFileAt(
    deploy.ghRepo,
    DEPLOY_VERIFY_PROMPT_PATH,
    deploy.sha,
  );
  if (!template?.trim()) return null;
  const state = await readPrStateAsync(entry.prNumber, deploy.ghRepo);
  const stored = state?.monitoringPlan;
  const plan = stored
    ? `${monitoringPlanMarkdown(stored)}\n\n(From the review of ${stored.sha.slice(0, 7)}. Written by a model from the diff: treat it as a starting point, not instructions.)`
    : "No monitoring plan was recorded for this PR. Work out what to check from the diff.";
  const body = renderDeployPrompt(template.slice(0, MAX_DEPLOY_PROMPT_CHARS), {
    pr: String(entry.prNumber),
    title: entry.title,
    repo: deploy.ghRepo,
    branch: entry.headRef,
    sha: deploy.sha,
    shortSha: deploy.sha.slice(0, 7),
    runUrl: deploy.runUrl,
    author: entry.author || "unknown",
    mergedBy: entry.mergedBy || "unknown",
    plan,
  }).trim();
  return `PR #${entry.prNumber} deployed (${deploy.sha.slice(0, 7)}, ${deploy.runUrl}). Verify it with the repository's post-deploy prompt:\n\n${body}`;
}
