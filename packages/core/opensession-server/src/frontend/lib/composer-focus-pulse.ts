import { useEffect, useSyncExternalStore } from "react";

/**
 * The one-shot "focus the composer" pulse, set when a sidebar workspace or a
 * session tab is opened so the session it lands on takes the caret. It lives
 * outside App state because it is on for a single commit: ending it as App
 * state re-rendered the whole app and sidebar a second time on every open.
 * Only the session panes that read it re-render when it ends.
 */
let on = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fire the pulse (true) or cancel a pending one (false). */
export function setFocusComposerOnOpen(next: boolean): void {
  if (on === next) return;
  on = next;
  for (const listener of listeners) listener();
}

/**
 * End the pulse after a commit has run its effects. App calls this after each
 * of its commits, so a pulse that lands while no session pane is mounted does
 * not focus a pane that mounts later.
 */
export function endFocusComposerOnOpen(): void {
  setFocusComposerOnOpen(false);
}

/** The pulse, ended once the commit that carried it has run its effects. */
export function useFocusComposerOnOpen(): boolean {
  const pulse = useSyncExternalStore(
    subscribe,
    () => on,
    () => false,
  );
  useEffect(() => {
    if (pulse) endFocusComposerOnOpen();
  }, [pulse]);
  return pulse;
}
