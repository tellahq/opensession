import { useSyncExternalStore } from "react";
import {
  deferredMergeDeadline,
  deferredMergePhase,
  subscribeDeferredMerges,
  type DeferredMergePhase,
} from "../lib/deferred-merge";

/** Observe the shared five-second merge window for one pull request. */
export function useDeferredMergePhase(key: string | null): DeferredMergePhase {
  // Subscribe to this PR's phase, not the store's global revision. A merge click
  // should update its own control without first re-rendering every mounted PR
  // surface whose phase stayed idle.
  return useSyncExternalStore(
    subscribeDeferredMerges,
    () => deferredMergePhase(key),
    () => deferredMergePhase(key),
  );
}

/** When this PR's scheduled merge fires, or null outside the undo window. */
export function useDeferredMergeDeadline(key: string | null): number | null {
  return useSyncExternalStore(
    subscribeDeferredMerges,
    () => deferredMergeDeadline(key),
    () => deferredMergeDeadline(key),
  );
}
