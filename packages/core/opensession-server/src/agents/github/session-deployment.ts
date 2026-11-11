/**
 * A GitHub deployment on every session-opened PR, so the PR's merge box and
 * timeline carry an "Open in <product>" environment whose "View deployment"
 * button opens the session that opened it.
 *
 * The session comes from the PR body's attribution footer (the same trusted
 * anchor pr-cache uses). The link is always built from this instance's own
 * UI base and the parsed session id, never copied from the body.
 *
 * One deployment per PR: the link never changes, so it is created on the
 * head branch (not a commit) and later events find it by its payload and
 * stop. Pushes still look, so a PR whose first attempt failed (say, before
 * the App held `deployments: write`) gets its link on the next push. Statuses
 * never auto-inactivate: the environment is shared by every PR, and GitHub
 * would grey out the other PRs' links. Minted on its own deployments-only
 * token, so an App without that permission loses only this link.
 */
import { audit } from "../../server/audit";
import { productMark } from "../../server/config";
import { sessionRefFromPrBody } from "../../server/pr-cache";
import { githubRequest } from "./github-rest";
import { uiSessionUrl } from "./run";

/** PR actions that may introduce a footer, or retry a link that failed. */
const DEPLOY_ACTIONS = new Set([
  "opened",
  "reopened",
  "edited",
  "synchronize",
  "ready_for_review",
]);

export function sessionDeploymentEnvironment(): string {
  return `Open in ${productMark()}`;
}

export interface SessionDeploymentTarget {
  sessionId: string;
  headRef: string;
}

interface DeploymentPayload {
  pr?: number;
  sessionId?: string;
}

/** What to deploy for one pull_request webhook, or null when nothing should. */
export function sessionDeploymentTarget(input: {
  action: string;
  body: string | null | undefined;
  headRef: string | undefined;
  externalFork: boolean;
  state: string | undefined;
}): SessionDeploymentTarget | null {
  if (!DEPLOY_ACTIONS.has(input.action)) return null;
  if (input.externalFork || input.state === "closed") return null;
  if (!input.headRef) return null;
  const sessionId = sessionRefFromPrBody(input.body);
  if (!sessionId) return null;
  return { sessionId, headRef: input.headRef };
}

/** Whether a listed deployment is already this PR's link to this session. A
 *  branch reused by a later PR, or a footer edited to another session, gets
 *  a new one. */
export function isSessionDeploymentFor(
  deployment: { payload?: unknown },
  prNumber: number,
  sessionId: string,
): boolean {
  let payload = deployment.payload as DeploymentPayload | string | undefined;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload) as DeploymentPayload;
    } catch {
      return false;
    }
  }
  return payload?.pr === prNumber && payload?.sessionId === sessionId;
}

export async function ensureSessionDeployment(
  ghRepo: string,
  prNumber: number,
  target: SessionDeploymentTarget,
): Promise<void> {
  const environment = sessionDeploymentEnvironment();
  const existing = await githubRequest<
    Array<{ id: number; payload?: unknown }>
  >(
    "GET",
    `/repos/${ghRepo}/deployments?ref=${encodeURIComponent(target.headRef)}&environment=${encodeURIComponent(environment)}&per_page=10`,
    undefined,
    { mint: "deployments" },
  );
  if (!existing.ok) {
    warn(ghRepo, prNumber, existing.status, existing.error);
    return;
  }
  if (
    existing.data?.some((d) =>
      isSessionDeploymentFor(d, prNumber, target.sessionId),
    )
  )
    return;

  const created = await githubRequest<{ id: number }>(
    "POST",
    `/repos/${ghRepo}/deployments`,
    {
      ref: target.headRef,
      environment,
      description: `Session that opened PR #${prNumber}`,
      payload: { pr: prNumber, sessionId: target.sessionId },
      auto_merge: false,
      // The link is not a build: no commit status gates it.
      required_contexts: [],
      transient_environment: false,
      production_environment: false,
    },
    { mint: "deployments" },
  );
  if (!created.ok || typeof created.data?.id !== "number") {
    warn(ghRepo, prNumber, created.status, created.error);
    return;
  }
  const url = uiSessionUrl(target.sessionId);
  const status = await githubRequest(
    "POST",
    `/repos/${ghRepo}/deployments/${created.data.id}/statuses`,
    {
      state: "success",
      environment_url: url,
      log_url: url,
      description: "Open the session",
      auto_inactive: false,
    },
    { mint: "deployments" },
  );
  if (!status.ok) {
    warn(ghRepo, prNumber, status.status, status.error);
    return;
  }
  audit({
    msg: "session_deployment_posted",
    repo: ghRepo,
    pr_number: prNumber,
    head_ref: target.headRef,
    session_id: target.sessionId,
  });
}

function warn(
  ghRepo: string,
  prNumber: number,
  status: number,
  error: string | undefined,
): void {
  console.warn(
    `[github] session deployment for ${ghRepo}#${prNumber} not posted (${status}): ${error || "unknown"}${status === 403 || status === 0 ? " — the App needs the Deployments: read and write permission" : ""}`,
  );
}
