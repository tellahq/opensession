/**
 * Catalog projection of the github agent's per-PR state: only what the open-PR
 * queue and the PR panel show (is a review running, what did the last one
 * conclude). The agent's state files are its private working store, thousands
 * of them; request paths read this projection in one batched catalog RPC and
 * never open those files.
 *
 * The agent's single writer (state.ts writePrState) publishes here after each
 * write. Existing state is imported once at boot with the other application
 * catalogs (catalog-documents.ts).
 */
import type { GithubPrState, LastReviewState } from "../agents/github/state";
import { catalogDocuments } from "./catalog-documents";
import type { CatalogDocumentSeedRow } from "./session-kernel/catalog-document-protocol";

export const PR_REVIEW_NAMESPACE = "pr-reviews";

export interface PrReviewProjection {
  /** A one-shot review run is in flight (persisted activeRun). */
  reviewRunning: boolean;
  lastReview?: LastReviewState;
}

export function projectPrReview(state: GithubPrState): PrReviewProjection {
  return {
    reviewRunning: state.activeRun?.kind === "review",
    ...(state.lastReview ? { lastReview: state.lastReview } : {}),
  };
}

/** Publish one PR's projection. Callers fire and forget: the catalog
 *  serializes writes per key in call order, and an identical value is not
 *  rewritten. Never rejects. */
export function publishPrReview(
  key: string,
  state: GithubPrState,
): Promise<void> {
  return catalogDocuments(PR_REVIEW_NAMESPACE)
    .set(key, projectPrReview(state))
    .catch((error) =>
      console.warn(
        `[pr-reviews] catalog publish failed for ${key}:`,
        error instanceof Error ? error.message : error,
      ),
    );
}

/** Projections for the given PR keys, in one batched catalog read. */
export async function readPrReviews(
  keys: string[],
): Promise<Map<string, PrReviewProjection>> {
  const out = new Map<string, PrReviewProjection>();
  if (keys.length === 0) return out;
  for (const row of await catalogDocuments(PR_REVIEW_NAMESPACE).getMany([
    ...new Set(keys),
  ]))
    out.set(row.key, row.value as PrReviewProjection);
  return out;
}

/** One-time import source: the projection of every existing state file. */
export async function prReviewSeedRows(): Promise<CatalogDocumentSeedRow[]> {
  const { listPrStateEntriesAsync } = await import("../agents/github/state");
  return (await listPrStateEntriesAsync()).map(({ key, state }) => ({
    key,
    value: JSON.stringify(projectPrReview(state)),
  }));
}

/** Repair after a fresh import: republish PRs whose state changed since
 *  `since`, which covers writes a previous gateway made during the import. */
export async function reconcilePrReviews(since: number): Promise<void> {
  const { listPrStateEntriesChangedSince } =
    await import("../agents/github/state");
  for (const { key, state } of await listPrStateEntriesChangedSince(since))
    await publishPrReview(key, state);
}
