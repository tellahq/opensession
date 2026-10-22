/**
 * Whether a merged PR is live yet, shared by the server and the web UI. The
 * records come from server/pr-deploy-state.ts.
 */

export interface PrDeployRecord {
  repoId: string;
  prNumber: number;
  state: "deploying" | "deployed" | "failed";
  at: string;
}

/** A deploy that never reported back stops holding the card after this long,
 *  the same window the webhook keeps waiting for it. */
export const PR_DEPLOY_WAIT_MS = 48 * 60 * 60 * 1000;

/** True while the PR's change is merged but not live yet. */
export function awaitingPrDeploy(
  records: PrDeployRecord[] | undefined,
  pr: { repoId?: string; prNumber?: number },
  now = Date.now(),
): boolean {
  const record = records?.findLast(
    (candidate) =>
      candidate.prNumber === pr.prNumber &&
      (!pr.repoId || candidate.repoId === pr.repoId),
  );
  if (!record || record.state === "deployed") return false;
  if (record.state === "failed") return true;
  return now - Date.parse(record.at) < PR_DEPLOY_WAIT_MS;
}
