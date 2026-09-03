/**
 * GitHub webhook → PR-cache sync. GithubAgent's signature-verified
 * `POST /github/webhook` forwards every delivery
 * here so PR state in OS1 reacts to external events (a teammate's review, CI
 * finishing, a merge from github.com) instead of waiting out polling TTLs:
 *
 *  - the per-branch detail cache (pr-info.ts) is invalidated for the event's
 *    head branch, so the next fetch re-reads GitHub. CI deliveries do this on
 *    a coalescing timer instead of per delivery (see CI_COALESCE_MS);
 *  - `pull_request` / `pull_request_review` payloads are written through into
 *    the bulk open-PR cache (sessions.ts) — zero GitHub quota spent;
 *  - a debounced `pr_updated` broadcast tells open tabs to refetch now,
 *    which is what turns the invalidation into a visible update.
 *
 * Events GitHub currently delivers (see the webhook config on your
 * GitHub App): pull_request, pull_request_review, issue_comment,
 * pull_request_review_comment, workflow_run. check_suite / check_run / status
 * are handled here too so subscribing to them GitHub-side needs no code.
 *
 * Kill switch: OPENSESSION_PR_WEBHOOKS=0 reverts to pure polling.
 */
import { configuredRepos, type Repo } from "./config";
import { sessionRefFromPrBody } from "./pr-cache";
import { invalidatePrInfo } from "./pr-info";
import { getReviewRequest, setReviewRequest } from "./review-requests";
import { executeSessionProjection } from "./session-projection-executor";
import { applyPrWebhookToBulkCache, cachedPrBranchByNumber } from "./sessions";
import { invalidateSessionsCache } from "./session-cache";
import { githubLoginFor } from "./shared/user-mappings";
import { scheduleSandboxEnvironmentInvalidation } from "./sandbox/environments";
import { broadcastToAll } from "./ws-hub";

/** Head branches (and PR number, when known) a delivery is about. */
function branchesFor(
  event: string,
  payload: any,
  ghRepo: string,
): { branches: string[]; number?: number } {
  switch (event) {
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment": {
      const branch = payload?.pull_request?.head?.ref;
      return {
        branches: branch ? [branch] : [],
        number: payload?.pull_request?.number,
      };
    }
    case "issue_comment": {
      // Only PR conversation comments matter, and they carry no head ref —
      // resolve it from the bulk cache by PR number.
      if (!payload?.issue?.pull_request) return { branches: [] };
      const number = payload.issue.number;
      const branch =
        typeof number === "number"
          ? cachedPrBranchByNumber(ghRepo, number)
          : undefined;
      return { branches: branch ? [branch] : [], number };
    }
    case "check_suite": {
      const branch = payload?.check_suite?.head_branch;
      return { branches: branch ? [branch] : [] };
    }
    case "check_run": {
      const branch = payload?.check_run?.check_suite?.head_branch;
      return { branches: branch ? [branch] : [] };
    }
    case "status":
      // Commit statuses (e.g. Vercel) list the branches whose head is the
      // commit — usually exactly the PR's head branch.
      return {
        branches: (payload?.branches || [])
          .map((b: any) => b?.name)
          .filter((n: any): n is string => typeof n === "string" && !!n),
      };
    case "workflow_run": {
      const branch = payload?.workflow_run?.head_branch;
      return { branches: branch ? [branch] : [] };
    }
    case "push": {
      const branch = payload?.ref?.replace?.(/^refs\/heads\//, "");
      return { branches: branch ? [branch] : [] };
    }
    default:
      return { branches: [] };
  }
}

// A push lands as a burst (synchronize + workflow/check events within
// seconds) — coalesce into one broadcast per repo+branch and one session-list
// invalidation globally. A large CI fan-out can deliver hundreds of check
// events; invalidating per delivery made every connected client rebuild its
// scoped session list in overlapping waves and starved transcript watches.
const pendingBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();
let pendingSessionsInvalidation: ReturnType<typeof setTimeout> | undefined;
const BROADCAST_DEBOUNCE_MS = 2_000;

// CI deliveries stream for as long as a workflow runs: every job start and
// finish is a check_run, workflow_job, or status delivery for the same head
// branch. Each one used to drop the detail cache and broadcast two seconds
// later, so every open tab re-read the PR once per delivery — a 25-minute
// pipeline across a few branches spent the installation's hourly GraphQL
// budget (2026-09-03). Fold CI activity per branch into one refresh per
// window; PR, review, comment, and push deliveries still refresh promptly.
export const CI_COALESCE_MS = 30_000;
const CI_EVENTS = new Set([
  "check_suite",
  "check_run",
  "status",
  "workflow_run",
]);
const pendingCiRefresh = new Map<string, ReturnType<typeof setTimeout>>();

/** Whether a delivery only reports check or workflow progress. */
export function isCiWebhookEvent(event: string): boolean {
  return CI_EVENTS.has(event);
}

function scheduleCiRefresh(repoId: string, ghRepo: string, branch: string) {
  const key = `${ghRepo}\u0000${branch}`;
  if (pendingCiRefresh.has(key)) return;
  pendingCiRefresh.set(
    key,
    setTimeout(() => {
      pendingCiRefresh.delete(key);
      // Invalidate at broadcast time, not delivery time, so a poll landing
      // inside the window still serves the cached PR instead of re-reading.
      invalidatePrInfo(ghRepo, branch);
      broadcastToAll({ type: "pr_updated", repo: repoId, ghRepo, branch });
    }, CI_COALESCE_MS),
  );
}

function scheduleSessionsInvalidation(): void {
  if (pendingSessionsInvalidation) return;
  pendingSessionsInvalidation = setTimeout(() => {
    pendingSessionsInvalidation = undefined;
    invalidateSessionsCache();
  }, BROADCAST_DEBOUNCE_MS);
}

export function reviewerRemovalClearsSessionRequest(
  payload: any,
  requestTo: string,
): boolean {
  if (payload?.action !== "review_request_removed") return false;
  const owner = String(payload?.repository?.owner?.login || "").toLowerCase();
  const remaining = new Set<string>();
  for (const reviewer of payload?.pull_request?.requested_reviewers || [])
    if (reviewer?.login) remaining.add(String(reviewer.login).toLowerCase());
  for (const team of payload?.pull_request?.requested_teams || []) {
    if (!team?.slug) continue;
    const slug = String(team.slug).toLowerCase();
    remaining.add(slug);
    if (owner) remaining.add(`${owner}/${slug}`);
  }
  const target = requestTo.toLowerCase();
  const login = githubLoginFor(requestTo)?.toLowerCase();
  return !remaining.has(target) && (!login || !remaining.has(login));
}

export function sandboxEnvironmentInvalidationNeeded(
  event: string,
  payload: any,
  defaultBranch: string,
): boolean {
  if (event === "push") {
    return payload?.ref === `refs/heads/${defaultBranch}`;
  }
  return (
    event === "pull_request" &&
    payload?.action === "closed" &&
    payload?.pull_request?.merged === true &&
    payload?.pull_request?.base?.ref === defaultBranch
  );
}

function scheduleBroadcast(
  repoId: string,
  ghRepo: string,
  branch: string,
  number?: number,
) {
  const key = `${ghRepo}\u0000${branch}`;
  if (pendingBroadcasts.has(key)) return;
  pendingBroadcasts.set(
    key,
    setTimeout(() => {
      pendingBroadcasts.delete(key);
      broadcastToAll({
        type: "pr_updated",
        repo: repoId,
        ghRepo,
        branch,
        ...(typeof number === "number" ? { number } : {}),
      });
    }, BROADCAST_DEBOUNCE_MS),
  );
}

/** Fire-and-forget from the webhook route; never throws. */
export function handlePrWebhookEvent(event: string, payload: any): void {
  try {
    if (process.env.OPENSESSION_PR_WEBHOOKS === "0") return;
    const fullName: string | undefined = payload?.repository?.full_name;
    if (!fullName) return;
    const match = Object.entries(configuredRepos()).find(
      ([, repo]) => repo.ghRepo?.toLowerCase() === fullName.toLowerCase(),
    ) as [string, Repo] | undefined;
    if (!match) return;
    const [repoId, repo] = match;
    const ghRepo = repo.ghRepo;
    const { branches, number } = branchesFor(event, payload, ghRepo);
    if (
      sandboxEnvironmentInvalidationNeeded(event, payload, repo.defaultBranch)
    ) {
      scheduleSandboxEnvironmentInvalidation(repoId);
    }
    // Default-branch activity (deploy workflows on master/main) is not PR
    // activity — nudging every session parked on that branch would spend gh
    // calls on branches that have no PR.
    const prBranches = branches.filter((b) => b !== repo.defaultBranch);
    if (!prBranches.length) return;
    applyPrWebhookToBulkCache(ghRepo, event, payload);
    // The sidebar picker mirrors its local request to GitHub. Treat removing
    // that reviewer on GitHub as the same undo, rather than leaving the local
    // request behind indefinitely. The PR footer gives us one exact session,
    // so this never scans session actors.
    if (event === "pull_request") {
      const sessionId = sessionRefFromPrBody(payload?.pull_request?.body);
      const request = sessionId ? getReviewRequest(sessionId) : undefined;
      if (
        sessionId &&
        request &&
        !request.accepted &&
        reviewerRemovalClearsSessionRequest(payload, request.to)
      ) {
        void executeSessionProjection(sessionId, "review_request", () =>
          setReviewRequest(sessionId, null),
        )
          .then(() => scheduleSessionsInvalidation())
          .catch((e) =>
            console.error("[pr-webhook] failed to clear review request:", e),
          );
      }
    }
    // Session prState enrichment reads the bulk cache through the session
    // list snapshots. Invalidate once for the whole delivery burst; the
    // branch-specific detail broadcasts stay independently coalesced below.
    scheduleSessionsInvalidation();
    for (const branch of prBranches) {
      if (isCiWebhookEvent(event)) {
        scheduleCiRefresh(repoId, ghRepo, branch);
        continue;
      }
      invalidatePrInfo(ghRepo, branch);
      scheduleBroadcast(repoId, ghRepo, branch, number);
    }
  } catch (e) {
    console.error("[pr-webhook] failed to apply event:", e);
  }
}
