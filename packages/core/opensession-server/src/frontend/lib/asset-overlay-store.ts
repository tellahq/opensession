import { useSyncExternalStore } from "react";

/**
 * The asset open over a session, shared between that session's viewer (which
 * draws the overlay) and the app router (which mirrors it into the URL as
 * `/session/<id>/asset/<path>` and opens it again from such a link). One value,
 * because only the session on screen hosts an overlay.
 */
type OpenAsset = { sessionId: string; path: string } | null;

let current: OpenAsset = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: OpenAsset): void {
  if (current?.sessionId === next?.sessionId && current?.path === next?.path)
    return;
  current = next;
  for (const listener of listeners) listener();
}

/** Open `path` over `sessionId`, or close that session's overlay. */
export function setOpenAsset(sessionId: string, path: string | null): void {
  if (path) publish({ sessionId, path });
  else if (current?.sessionId === sessionId) publish(null);
}

/**
 * Follow a route change: a link naming an asset opens it, and moving to another
 * session drops the previous session's overlay. The same session without an
 * asset keeps whatever is open, since the URL only trails the overlay.
 */
export function syncOpenAssetWithRoute(
  sessionId: string | null,
  asset: string | undefined,
): void {
  if (sessionId && asset) publish({ sessionId, path: asset });
  else if (current && current.sessionId !== sessionId) publish(null);
}

/** The asset open over `sessionId`, or null. */
export function useOpenAssetPath(sessionId: string | null): string | null {
  return useSyncExternalStore(subscribe, () =>
    sessionId && current?.sessionId === sessionId ? current.path : null,
  );
}

/** The asset open over `sessionId` right now, read outside React (a click). */
export function openAssetPathFor(sessionId: string): string | null {
  return current?.sessionId === sessionId ? current.path : null;
}

export function getOpenAssetForTest(): OpenAsset {
  return current;
}
