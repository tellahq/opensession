/**
 * GitHub Actions workflow run reads for `wait_for` kind `workflow_run`.
 *
 * REST with the same installation credential PR check waits read with: the
 * read mint already carries `actions: read` (shared/github-app-permissions).
 * REST rather than GraphQL because GraphQL has no lookup of a run by workflow
 * and ref, and REST keeps these polls off the GraphQL budget that the PR
 * panels and pr_checks waits share.
 */
import { githubInstallationCredential } from "./github-app";
import {
  ghRateLimited,
  isGhRateLimitMsg,
  noteGhRateLimited,
} from "./github-limit";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";

export interface WorkflowRun {
  id: number;
  name: string;
  /** queued | in_progress | completed | waiting | requested | pending */
  status: string;
  /** success | failure | cancelled | timed_out | action_required | skipped |
   * neutral | stale | startup_failure, or "" while running. */
  conclusion: string;
  url: string;
  headBranch: string;
  headSha: string;
  event: string;
  runNumber: number;
  runAttempt: number;
  createdAt: number;
}

export interface WorkflowRunJob {
  name: string;
  status: string;
  conclusion: string;
  /** Names of the steps that failed, in run order. */
  failedSteps: string[];
}

/** A read GitHub answered with 404: the workflow, run, or repository does
 * not exist or this credential cannot see it. Polling again will not help. */
export class WorkflowRunNotFoundError extends Error {}

function toRun(raw: any): WorkflowRun {
  return {
    id: Number(raw?.id) || 0,
    name: String(raw?.name || raw?.display_title || "workflow"),
    status: String(raw?.status || ""),
    conclusion: String(raw?.conclusion || ""),
    url: String(raw?.html_url || ""),
    headBranch: String(raw?.head_branch || ""),
    headSha: String(raw?.head_sha || ""),
    event: String(raw?.event || ""),
    runNumber: Number(raw?.run_number) || 0,
    runAttempt: Number(raw?.run_attempt) || 1,
    createdAt: Date.parse(String(raw?.created_at || "")) || 0,
  };
}

/** Failed step conclusions, matching how a failed job is classified. */
export const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "startup_failure",
]);

async function githubRest(
  repo: string,
  path: string,
  consumer: string,
): Promise<any> {
  const credential = await githubInstallationCredential({ repo });
  if (!credential)
    throw new Error("The selected GitHub bot credential is unavailable");
  if (await ghRateLimited("rest", credential))
    throw new Error("GitHub REST is rate-limited for this credential");
  const response = await fetchWithTimeout(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${credential.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opensession",
    },
  });
  const body = (await response.json().catch(() => null)) as any;
  if (response.status === 404)
    throw new WorkflowRunNotFoundError(
      String(body?.message || "Not Found") +
        ` (${path.split("?")[0]}). Check the repository, workflow, and run id.`,
    );
  if (!response.ok) {
    const message = String(body?.message || `GitHub REST ${response.status}`);
    if (
      (response.status === 403 || response.status === 429) &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        isGhRateLimitMsg(message))
    ) {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      await noteGhRateLimited(
        consumer,
        Number.isFinite(reset) ? reset : undefined,
        "rest",
        credential,
      );
    }
    throw new Error(message);
  }
  return body;
}

export async function getWorkflowRun(
  repo: string,
  runId: number,
): Promise<WorkflowRun> {
  return toRun(
    await githubRest(
      repo,
      `/repos/${repo}/actions/runs/${runId}`,
      "agent-wait:workflow-run",
    ),
  );
}

/** Whether a ref names a full commit sha rather than a branch or tag. */
export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/**
 * The newest runs of a workflow (file name such as `release.yml`, or its
 * numeric id) for a branch, tag, or commit sha. GitHub reports a tag push's
 * tag as the run's `head_branch`, so the `branch` filter covers tags too.
 */
export async function listWorkflowRuns(
  repo: string,
  workflow: string,
  ref: string,
): Promise<WorkflowRun[]> {
  const filter = ref
    ? isCommitSha(ref)
      ? `&head_sha=${encodeURIComponent(ref)}`
      : `&branch=${encodeURIComponent(ref)}`
    : "";
  const body = await githubRest(
    repo,
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=20${filter}`,
    "agent-wait:workflow-runs",
  );
  const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  return runs.map(toRun);
}

/** The latest attempt's jobs, with the steps that failed. */
export async function listWorkflowRunJobs(
  repo: string,
  runId: number,
): Promise<WorkflowRunJob[]> {
  const body = await githubRest(
    repo,
    `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    "agent-wait:workflow-jobs",
  );
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  return jobs.map((job: any) => ({
    name: String(job?.name || "job"),
    status: String(job?.status || ""),
    conclusion: String(job?.conclusion || ""),
    failedSteps: (Array.isArray(job?.steps) ? job.steps : [])
      .filter((step: any) => FAILED_CONCLUSIONS.has(String(step?.conclusion)))
      .map((step: any) => String(step?.name || "step")),
  }));
}
