import { useSyncExternalStore } from "react";

/**
 * A PR action the session has been asked to carry out ("Fix checks" becomes
 * "Fixing…"). Kept outside the strip so the header strip and the workspace
 * summary card, which swap in for each other as the card opens and closes,
 * show the same pending state instead of each forgetting the press.
 */
export interface PendingPrompt {
  label: string;
  /** The headline the action was offered for. Once the PR leaves it (checks
   *  rerun, feedback resolved) the action is over, whatever the session does. */
  headline: string;
  at: number;
}

const pending = new Map<string, PendingPrompt>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function markPromptPending(key: string, prompt: PendingPrompt) {
  pending.set(key, prompt);
  emit();
}

/** Clears `key`, or only `prompt` when given, so a stale timer cannot clear a
 *  newer press. */
export function clearPromptPending(key: string, prompt?: PendingPrompt) {
  const current = pending.get(key);
  if (!current || (prompt && current !== prompt)) return;
  pending.delete(key);
  emit();
}

export function usePromptPending(key: string): PendingPrompt | undefined {
  return useSyncExternalStore(
    subscribe,
    () => pending.get(key),
    () => undefined,
  );
}
