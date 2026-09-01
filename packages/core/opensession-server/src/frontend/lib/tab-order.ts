// Per-workspace order of the session tab strip (the "main bar" session tabs).
//
// Unlike pins (a curated, cross-device set stored server-side), a strip's
// left-to-right arrangement is a per-device working-set preference: high churn
// (every drag rewrites it), low value to sync, and one entry per workspace you
// ever touch. So it lives in localStorage, in a single key holding a
// { [workspaceId]: string[] } map, mirroring pins' synchronous-cache + change-
// event shape so callers stay simple and the strip re-renders on commit.
const KEY = "opensession-tab-order";
const CHANGE_EVENT = "opensession-tab-order-changed";

type OrderMap = Record<string, string[]>;

/**
 * Keep every existing tab where it is and append ids that have just appeared.
 * Session and pane tabs use the same rule, so no tab kind gets a privileged side.
 */
export function appendNewTabs(
  previous: readonly string[],
  current: readonly string[],
): string[] {
  const currentSet = new Set(current);
  const previousSet = new Set(previous);
  const added = current.filter((id) => !previousSet.has(id));
  if (added.length === 0) return [...current];
  return [...previous.filter((id) => currentSet.has(id)), ...added];
}

function read(): OrderMap {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return v as OrderMap;
  } catch {
    return {};
  }
}

function write(map: OrderMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota — keep working from the last read in memory */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Order `ids` (a workspace's live session ids, in their natural createdAt order)
 * by the saved arrangement: saved ids first in saved order, then any id not in
 * the saved list appended in natural order — so a freshly-created session lands at
 * the end and an unknown/restored one is never dropped. A stale saved id (a
 * closed session) simply matches nothing. Pure read; persists nothing.
 */
export function applyTabOrder(workspaceId: string, ids: string[]): string[] {
  const saved = read()[workspaceId];
  if (!saved || saved.length === 0) return ids;
  const pos = new Map(saved.map((id, i) => [id, i] as const));
  return ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => {
      const pa = pos.has(a.id) ? (pos.get(a.id) as number) : Infinity;
      const pb = pos.has(b.id) ? (pos.get(b.id) as number) : Infinity;
      return pa !== pb ? pa - pb : a.i - b.i;
    })
    .map((e) => e.id);
}

/**
 * Persist a workspace's new tab order (a drag-drop commit). Stores exactly the
 * given ids for that workspace. Empty `ids` clears the entry so a workspace
 * that no longer has a custom order doesn't linger in the map.
 */
export function saveTabOrder(workspaceId: string, ids: string[]): void {
  if (!workspaceId) return;
  const map = read();
  if (ids.length === 0) delete map[workspaceId];
  else map[workspaceId] = ids;
  write(map);
}

/** Subscribe to order changes (this tab's commits and other tabs' via storage). */
export function onTabOrderChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
