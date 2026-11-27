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

/**
 * How a session promotes one of its assets into its Assets tab, registered by
 * that session's viewer where the tab exists. Transcript surfaces read it to
 * offer "Open as tab" only where it does something.
 */
const tabOpeners = new Map<string, (path: string) => void>();
const tabListeners = new Set<() => void>();

function subscribeTabs(listener: () => void): () => void {
  tabListeners.add(listener);
  return () => tabListeners.delete(listener);
}

export function registerAssetTabOpener(
  sessionId: string,
  open: (path: string) => void,
): () => void {
  tabOpeners.set(sessionId, open);
  for (const listener of tabListeners) listener();
  return () => {
    if (tabOpeners.get(sessionId) !== open) return;
    tabOpeners.delete(sessionId);
    for (const listener of tabListeners) listener();
  };
}

/** Open `path` in `sessionId`'s Assets tab, or null where there is none. */
export function useAssetTabOpener(
  sessionId: string | null,
): ((path: string) => void) | null {
  return useSyncExternalStore(subscribeTabs, () =>
    sessionId ? (tabOpeners.get(sessionId) ?? null) : null,
  );
}
