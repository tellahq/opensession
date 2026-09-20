/**
 * Merge/deploy/preview events for PR-linked Open Session sessions. When a PR whose
 * head branch belongs to a session (primary branch or an attached repo) is
 * merged, a `[GitHub]` message is delivered into that session's transcript through the
 * SessionControl registry — the same steer/queue/start path a human message
 * takes — so the agent sees it and can react. The merge commit is then tracked in
 * ~/.opensession-github/pending-deploys.json (survives restarts), and when the
 * Deploy workflow (.github/workflows/deploy.yml) completes for that commit the
 * session gets a second message with the outcome. (Pre-merge staging previews
 * are NOT announced here — the session header's Preview environment button already surfaces
 * the preview URL + Ready state, so a session notification would just be redundant.)
 */
import { stateDir } from "../../server/paths";
import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import {
  tryGetSessionControl,
  type SessionControl,
} from "../../server/session-control";
import { audit } from "../../server/audit";
import { configuredRepos, getConfigAsync } from "../../server/config";
import { SESSION_BRANCH_MATCH_LIMIT } from "../../server/session-list-protocol";
import {
  matchSessions,
  workspaceIdForRepo,
  SessionOwnershipOverflowError,
} from "./session-matching";
export { matchSessions, workspaceIdForRepo } from "./session-matching";

const PENDING_PATH = `${stateDir("github")}/pending-deploys.json`;
const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";
/** A merge whose deploy never reported back is dropped after this long. */
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;
/** A branch-linked event should normally target one session. Refuse an
 * implausible broadcast before it can start a fleet of agent turns. */
export const MAX_SESSION_NOTIFICATION_FANOUT = SESSION_BRANCH_MATCH_LIMIT;

interface PendingDeploy {
  prNumber: number;
  title: string;
  headRef: string;
  sessionIds: string[];
  recordedAt: string;
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
  await deliver(
    control,
    sessionIds,
    message,
    `github-deploy:${run.id || run.head_sha}:${run.conclusion || "unknown"}`,
  );
}
