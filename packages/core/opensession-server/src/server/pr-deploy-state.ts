/**
 * pr-deploy-state: whether a session's merged PR is live yet.
 *
 * For a repo with `deploymentTracking`, a merge does not mean people can use
 * the change: the Deploy workflow still has to finish. The "Send to Slack"
 * card announces the change, so it waits for that. The GitHub webhook
 * (agents/github/session-notify.ts) records "deploying" on every session that
 * owns the PR at merge, then "deployed" or "failed" when a deploy reports.
 * A PR with no record (a repo without deploy tracking) counts as live at merge.
 */

import { updateSessionFile } from "./session-cache";
import type { SessionPrDeploy } from "./types";

export { awaitingPrDeploy } from "../shared/pr-deploy";

const MAX_RECORDS = 10;

/** Fold one deploy update into a session's records. A PR already deployed
 *  stays deployed: a newer deploy that included it may finish before the
 *  PR's own run, which then reports cancelled or failed. */
export function withPrDeploy(
  records: SessionPrDeploy[] | undefined,
  next: SessionPrDeploy,
): SessionPrDeploy[] {
  const list = records || [];
  const current = list.find(
    (record) =>
      record.repoId === next.repoId && record.prNumber === next.prNumber,
  );
  if (current?.state === "deployed" && next.state !== "deployed") return list;
  return [
    ...list.filter((record) => record !== current),
    // A later update keeps the time the wait started.
    current && next.state !== "deploying" ? { ...next, at: current.at } : next,
  ].slice(-MAX_RECORDS);
}

export async function recordPrDeploy(
  sessionIds: string[],
  deploy: SessionPrDeploy,
): Promise<void> {
  for (const sessionId of sessionIds) {
    await updateSessionFile(sessionId, (data) => ({
      ...data,
      prDeploys: withPrDeploy(data.prDeploys, deploy),
    })).catch((error) =>
      console.warn(
        `[github] couldn't record the deploy of PR #${deploy.prNumber} on ${sessionId}:`,
        error,
      ),
    );
  }
}
