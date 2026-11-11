/**
 * A GitHub deployment on every session-opened PR, so the PR's merge box and
 * timeline carry an "Open in <product>" environment whose "View deployment"
 * button opens the session that opened it.
 *
 * The session comes from the PR body's attribution footer (the same trusted
 * anchor pr-cache uses). The link is always built from this instance's own
 * UI base and the parsed session id, never copied from the body.
 *
 * One deployment per head SHA: a push gets a fresh one (the previous one is
 * marked inactive by GitHub), and webhook redeliveries or body edits on the
 * same head find the existing deployment and stop. Minted on its own
 * deployments-only token, so an App that has not accepted
 * `deployments: write` loses only this link.
 */
import { audit } from "../../server/audit";
import { productMark } from "../../server/config";
import { sessionRefFromPrBody } from "../../server/pr-cache";
import { githubRequest } from "./github-rest";
import { uiSessionUrl } from "./run";

/** PR actions that may introduce a footer or a new head commit. */
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
  headSha: string;
}

/** What to deploy for one pull_request webhook, or null when nothing should. */
export function sessionDeploymentTarget(input: {
  action: string;
  body: string | null | undefined;
  headSha: string | undefined;
  externalFork: boolean;
  state: string | undefined;
}): SessionDeploymentTarget | null {
  if (!DEPLOY_ACTIONS.has(input.action)) return null;
  if (input.externalFork || input.state === "closed") return null;
  if (!input.headSha) return null;
  const sessionId = sessionRefFromPrBody(input.body);
  if (!sessionId) return null;
  return { sessionId, headSha: input.headSha };
}

export async function ensureSessionDeployment(
  ghRepo: string,
  prNumber: number,
  target: SessionDeploymentTarget,
): Promise<void> {
  const environment = sessionDeploymentEnvironment();
  const existing = await githubRequest<Array<{ id: number }>>(
    "GET",
    `/repos/${ghRepo}/deployments?sha=${target.headSha}&environment=${encodeURIComponent(environment)}&per_page=1`,
    undefined,
    { mint: "deployments" },
  );
  if (!existing.ok) {
    warn(ghRepo, prNumber, existing.status, existing.error);
    return;
  }
  if (existing.data?.length) return;

  const created = await githubRequest<{ id: number }>(
    "POST",
    `/repos/${ghRepo}/deployments`,
    {
      ref: target.headSha,
      environment,
      description: `Session that opened PR #${prNumber}`,
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
      auto_inactive: true,
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
    head_sha: target.headSha,
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
