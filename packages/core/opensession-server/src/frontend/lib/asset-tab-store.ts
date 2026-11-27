import { useSyncExternalStore } from "react";

/**
 * The file each session's Assets tab shows. The session viewer picks it, and
 * the tab strip, which is built above the viewer, reads it to name the tab
 * after the file, so the tab says what you are looking at and the toolbar
 * under it only has to hold tools.
 */
const paths = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAssetTabPath(sessionId: string, path: string | null): void {
  if ((paths.get(sessionId) ?? null) === path) return;
  if (path) paths.set(sessionId, path);
  else paths.delete(sessionId);
  for (const listener of listeners) listener();
}

/** The file `sessionId`'s Assets tab shows, or null before it picks one. */
export function useAssetTabPath(sessionId: string | null | undefined) {
  return useSyncExternalStore(subscribe, () =>
    sessionId ? (paths.get(sessionId) ?? null) : null,
  );
}
