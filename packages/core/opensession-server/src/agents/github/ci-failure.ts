/**
 * "CI failed on your PR" as a system event, delivered to the one session that
 * owns the PR, the way merge conflicts (pr-conflict.ts) and review findings
 * (handoff.ts) already are.
 *
 * Three webhook events report a failure on a PR's head commit:
 *  - `workflow_run`: a GitHub Actions workflow finished.
 *  - `check_run`: a check from any other GitHub App (Actions' own jobs are
 *    skipped: their workflow_run already covers them).
 *  - `status`: a commit status (deploy previews, infrastructure plans, ...).
 *
 * A push usually fails in several places at once, and each place reports on
 * its own. Failures are grouped per (repo, PR, head sha) for a short window,
 * so one notice lists everything that failed on that push. The window is in
 * memory: a restart inside it drops that notice, and the PR panel still shows
 * the red checks.
 *
 * At flush the PR must still be open with the failing sha as its head (an
 * agent that already pushed again is past this failure), and the owning
 * session is skipped when it registered a `pr_checks` wait for the branch,
 * which already wakes it on the first failed check.
 *
 * Kill switch: OPENSESSION_CI_FAILURE_NOTICE=0.
 */
import { audit } from "../../server/audit";
import { getPrsByRepo, type PrInfo } from "../../server/pr-cache";
import type { UnifiedSession } from "../../server/types";
import { SessionOwnershipOverflowError } from "./session-matching";

export const CI_FAILURE_WINDOW_MS = 60_000;

const WORKFLOW_FAILURES = new Set(["failure", "timed_out", "startup_failure"]);
const CHECK_FAILURES = new Set(["failure", "timed_out"]);
const STATUS_FAILURES = new Set(["failure", "error"]);

export interface CiFailure {
  repoId: string;
  /** `owner/name`, to match a wait_for registered with either form. */
  ghRepo: string;
  branch: string;
  number: number;
  sha: string;
  /** Identity within the push: a re-delivery of the same report is ignored. */
  id: string;
  name: string;
  conclusion: string;
  url: string;
}

/** A registered repository: its id and `owner/name`. */
export interface CiRepo {
  id: string;
  ghRepo: string;
}

/** Open PRs of one repo keyed by head branch (pr-cache getPrsByRepo()). */
export type RepoPrs = Map<string, PrInfo> | undefined;

/** Names and URLs come from other apps; keep them one short line. */
function clean(text: unknown, max = 120): string {
  const value = typeof text === "string" ? text : "";
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function httpsUrl(value: unknown): string {
  return typeof value === "string" && /^https:\/\/\S+$/.test(value)
    ? value
    : "";
}

/** The same-repo PR GitHub attached to a run whose head is `branch@sha`. */
function attachedPr(
  pullRequests: unknown,
  branch: string,
  sha: string,
): number | null {
  if (!Array.isArray(pullRequests)) return null;
  const pr = pullRequests.find(
    (p: any) => p?.head?.ref === branch && p?.head?.sha === sha,
  );
  return typeof pr?.number === "number" ? pr.number : null;
}

/** An open PR from the bulk cache whose head is `sha`, preferring `branches`. */
function cachedPrForSha(
  prs: RepoPrs,
  sha: string,
  branches: string[] = [],
): { branch: string; number: number } | null {
  if (!prs) return null;
  for (const branch of branches) {
    const pr = prs.get(branch);
    if (pr?.state === "OPEN" && pr.headRefOid === sha)
      return { branch, number: pr.number };
  }
  for (const [branch, pr] of prs)
    if (pr.state === "OPEN" && pr.headRefOid === sha)
      return { branch, number: pr.number };
  return null;
}

/**
 * A failed GitHub Actions run on a PR head. Cancelled runs are skipped: they
 * are almost always superseded by a newer push. Pushes to the default branch
 * and fork PRs (which GitHub does not attach) map to no PR.
 */
export function ciFailureFromWorkflowRun(
  payload: any,
  repo: CiRepo,
): CiFailure | null {
  const run = payload?.workflow_run;
  if (payload?.action !== "completed" || !run) return null;
  if (!WORKFLOW_FAILURES.has(run.conclusion)) return null;
  const branch: string = run.head_branch || "";
  const sha: string = run.head_sha || "";
  if (!branch || !sha) return null;
  const number = attachedPr(run.pull_requests, branch, sha);
  if (number == null) return null;
  return {
    repoId: repo.id,
    ghRepo: repo.ghRepo,
    branch,
    number,
    sha,
    id: `run:${run.id}.${run.run_attempt || 1}`,
    name: clean(run.name || run.display_title) || "Workflow",
    conclusion: run.conclusion,
    url: httpsUrl(run.html_url),
  };
}

/**
 * A failed check run from an app other than GitHub Actions (whose jobs are
 * reported once, as their workflow_run). GitHub attaches same-repo PRs; when
 * it did not, the bulk cache maps the head sha to an open PR.
 */
export function ciFailureFromCheckRun(
  payload: any,
  repo: CiRepo,
  prs: RepoPrs,
): CiFailure | null {
  const check = payload?.check_run;
  if (payload?.action !== "completed" || !check) return null;
  if (!CHECK_FAILURES.has(check.conclusion)) return null;
  if (check.app?.slug === "github-actions") return null;
  const sha: string = check.head_sha || "";
  if (!sha) return null;
  const headBranch: string = check.check_suite?.head_branch || "";
  let branch = headBranch;
  let number = headBranch
    ? attachedPr(check.pull_requests, headBranch, sha)
    : null;
  if (number == null) {
    const cached = cachedPrForSha(prs, sha, headBranch ? [headBranch] : []);
    if (!cached) return null;
    ({ branch, number } = cached);
  }
  return {
    repoId: repo.id,
    ghRepo: repo.ghRepo,
    branch,
    number,
    sha,
    id: `check:${check.id}`,
    name: clean(check.name) || "Check",
    conclusion: check.conclusion,
    url: httpsUrl(check.html_url) || httpsUrl(check.details_url),
  };
}

/**
 * A failed commit status on an open PR's head. Two kinds are skipped:
 *  - statuses that link to a GitHub Actions run of this repository: the run's
 *    own workflow_run reports it, and when that run was cancelled the status
 *    is a false alarm;
 *  - statuses whose description says the work was cancelled.
 */
export function ciFailureFromStatus(
  payload: any,
  repo: CiRepo,
  prs: RepoPrs,
): CiFailure | null {
  if (!STATUS_FAILURES.has(payload?.state)) return null;
  const sha: string = payload?.sha || "";
  const context = clean(payload?.context);
  if (!sha || !context) return null;
  const url = httpsUrl(payload?.target_url);
  const actionsRun =
    `https://github.com/${repo.ghRepo}/actions/runs/`.toLowerCase();
  if (url.toLowerCase().startsWith(actionsRun)) return null;
  if (/\bcancel(?:l?ed|ling|led)\b/i.test(payload?.description || ""))
    return null;
  const branches: string[] = Array.isArray(payload?.branches)
    ? payload.branches
        .map((b: any) => b?.name)
        .filter((n: unknown): n is string => typeof n === "string" && !!n)
    : [];
  const pr = cachedPrForSha(prs, sha, branches);
  if (!pr) return null;
  return {
    repoId: repo.id,
    ghRepo: repo.ghRepo,
    branch: pr.branch,
    number: pr.number,
    sha,
    id: `status:${context}`,
    name: context,
    conclusion: payload.state,
    url,
  };
}

export function ciFailureMessage(failures: CiFailure[]): string {
  const first = failures[0]!;
  const lines = failures.map(
    (f) => `- ${f.name} (${f.conclusion})${f.url ? `: ${f.url}` : ""}`,
  );
  return [
    `CI failed on PR #${first.number} at ${first.sha.slice(0, 10)}:`,
    ...lines,
    "",
    "This session is assigned to handle it. Read the failing jobs' logs, fix the cause and push. If the failure is unrelated to this change (a flake, or already broken on the base branch), say so instead of changing code.",
  ].join("\n");
}

export function ciFailureDeliveryId(failures: CiFailure[]): string {
  const first = failures[0]!;
  const ids = failures.map((f) => f.id).sort();
  return `github-ci-failed:${first.repoId}:${first.number}:${first.sha}:${ids.join(",")}`;
}

// ---------------------------------------------------------------------------
// Grouping window and delivery
// ---------------------------------------------------------------------------

export interface CiFailureDeps {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The bulk cache's PRs for a repo (pr-cache getPrsByRepo). */
  repoPrs(repoId: string): RepoPrs;
  /** pr-conflict.ts owningPrSession. */
  owner(
    repoId: string,
    branch: string,
    sessionRef?: string,
  ): Promise<UnifiedSession | undefined>;
  /** The session's registered wait_for wait, if any. */
  waitFor(
    sessionId: string,
  ): Promise<{ kind: string; repo?: string; branch?: string } | undefined>;
  deliver(
    sessionId: string,
    message: string,
    deliveryId: string,
  ): Promise<{ status: string }>;
  audit(entry: Record<string, unknown>): void;
}

const defaultDeps: CiFailureDeps = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  repoPrs: (repoId) => getPrsByRepo().get(repoId),
  owner: async (repoId, branch, sessionRef) =>
    (await import("./pr-conflict")).owningPrSession(repoId, branch, sessionRef),
  waitFor: async (sessionId) =>
    (await import("../../server/agent-waits")).getAgentWait(sessionId),
  deliver: async (sessionId, message, deliveryId) => {
    const { tryGetSessionControl } =
      await import("../../server/session-control");
    const control = tryGetSessionControl();
    if (!control) return { status: "error" };
    return control.deliverToSession(sessionId, message, "GitHub", {
      deliveryId,
    });
  },
  audit,
};

let deps: CiFailureDeps = defaultDeps;

/** Test seam: replace any dependency; omitted ones keep their defaults. */
export function __setCiFailureDepsForTest(
  overrides?: Partial<CiFailureDeps>,
): void {
  deps = { ...defaultDeps, ...overrides };
}

interface CiWindow {
  failures: Map<string, CiFailure>;
  timer: unknown;
}

const windows = new Map<string, CiWindow>();

function windowKey(f: CiFailure): string {
  return `${f.repoId}#${f.number}@${f.sha}`;
}

/** Test seam: drop open windows without delivering them. */
export function resetCiFailureWindows(): void {
  for (const window of windows.values()) deps.clearTimer(window.timer);
  windows.clear();
}

/** Add a failure to its push's window, opening the window on the first one. */
export function recordCiFailure(failure: CiFailure): void {
  const key = windowKey(failure);
  const open = windows.get(key);
  if (open) {
    open.failures.set(failure.id, failure);
    return;
  }
  const window: CiWindow = {
    failures: new Map([[failure.id, failure]]),
    timer: deps.setTimer(() => {
      windows.delete(key);
      void flushCiFailures([...window.failures.values()]).catch((error) =>
        console.error(
          `[github] CI failure notice failed for PR #${failure.number}:`,
          error,
        ),
      );
    }, CI_FAILURE_WINDOW_MS),
  };
  windows.set(key, window);
}

function sameRepo(waitRepo: string | undefined, failure: CiFailure): boolean {
  const want = waitRepo?.toLowerCase();
  return (
    !!want &&
    (want === failure.repoId.toLowerCase() ||
      want === failure.ghRepo.toLowerCase())
  );
}

export async function flushCiFailures(failures: CiFailure[]): Promise<void> {
  if (!failures.length) return;
  const first = failures[0]!;
  const { repoId, branch, number, sha } = first;
  const base = {
    msg: "github_pr_ci_failure_notified",
    pr_number: number,
    repo_id: repoId,
    head_ref: branch,
    head_sha: sha,
    failed: failures.map((f) => f.name),
  };
  const pr = deps.repoPrs(repoId)?.get(branch);
  if (pr && (pr.state !== "OPEN" || pr.number !== number)) return;
  // The agent already pushed again: this failure is about an old head.
  if (pr?.headRefOid && pr.headRefOid !== sha) return;

  let target: UnifiedSession | undefined;
  try {
    target = await deps.owner(repoId, branch, pr?.sessionRef);
  } catch (error) {
    if (!(error instanceof SessionOwnershipOverflowError)) throw error;
    deps.audit({ ...base, delivery: "ownership_overflow" });
    console.error(`[github] ${error.message}`);
    return;
  }
  if (!target) return;

  const wait = await deps.waitFor(target.id).catch(() => undefined);
  if (
    wait?.kind === "pr_checks" &&
    wait.branch === branch &&
    sameRepo(wait.repo, first)
  ) {
    deps.audit({ ...base, session_id: target.id, delivery: "pr_checks_wait" });
    return;
  }

  const res = await deps.deliver(
    target.id,
    ciFailureMessage(failures),
    ciFailureDeliveryId(failures),
  );
  console.log(
    `[github] CI failed on PR #${number} at ${sha.slice(0, 10)} → ${target.id}: ${res.status}`,
  );
  deps.audit({
    ...base,
    session_id: target.id,
    matched_by: pr?.sessionRef === target.id ? "pr_footer" : "head_branch",
    delivery: res.status,
  });
}

export function ciFailureNoticeEnabled(): boolean {
  return process.env.OPENSESSION_CI_FAILURE_NOTICE !== "0";
}

/** Whether a delivery could be a failure at all. Nearly every check_run is
 *  an Actions job or a success, so this runs before any cache lookup. */
function mayReportFailure(event: string, payload: any): boolean {
  if (event === "workflow_run")
    return WORKFLOW_FAILURES.has(payload?.workflow_run?.conclusion);
  if (event === "check_run")
    return (
      CHECK_FAILURES.has(payload?.check_run?.conclusion) &&
      payload?.check_run?.app?.slug !== "github-actions"
    );
  return event === "status" && STATUS_FAILURES.has(payload?.state);
}

/** Webhook entry point for `workflow_run`, `check_run`, and `status`. */
export function handleCiWebhookEvent(
  event: string,
  payload: any,
  repo: CiRepo,
): void {
  if (!ciFailureNoticeEnabled() || !mayReportFailure(event, payload)) return;
  const failure =
    event === "workflow_run"
      ? ciFailureFromWorkflowRun(payload, repo)
      : event === "check_run"
        ? ciFailureFromCheckRun(payload, repo, deps.repoPrs(repo.id))
        : ciFailureFromStatus(payload, repo, deps.repoPrs(repo.id));
  if (failure) recordCiFailure(failure);
}
