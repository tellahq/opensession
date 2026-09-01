const KEY = "opensession-tab-splits";
const CHANGE_EVENT = "opensession-tab-splits-changed";

/**
 * A workspace's split: the tab strip is cut into two bars, each with its own
 * tabs, its own active tab and its own "+".
 *
 * Membership is stored sparsely — only the RIGHT bar lists its ids. Every other
 * live tab belongs to the left bar. Tabs come and go from outside this model
 * (a new sibling session, an archived one, a Review pane opening), so a sparse
 * assignment means arrivals land somewhere sensible without this record having
 * to be kept in sync, and a departure is just an id that no longer resolves.
 */
export type TabSplit = {
  /** Tab ids in the right bar, in bar order. */
  right: string[];
  /** Active tab per bar; falls back to the bar's first tab when unset/stale. */
  leftActive?: string;
  rightActive?: string;
  /** Left bar's share of the width, 0.2–0.8. */
  ratio: number;
};

type SplitMap = Record<string, TabSplit>;

/** The pre-groups shape: exactly one tab per side, folded into one combined tab. */
type LegacySplit = { leftId: string; rightId: string; ratio: number };

function isLegacy(
  value: Record<string, unknown>,
): value is LegacySplit & Record<string, unknown> {
  return typeof value.leftId === "string" && typeof value.rightId === "string";
}

/** Legacy records read as a right bar holding the tab that was dragged out. */
function migrate(value: LegacySplit): TabSplit {
  return {
    right: [value.rightId],
    leftActive: value.leftId,
    rightActive: value.rightId,
    ratio: value.ratio,
  };
}

function validSplit(value: unknown): value is TabSplit {
  if (!value || typeof value !== "object") return false;
  const split = value as Partial<TabSplit>;
  return (
    Array.isArray(split.right) &&
    split.right.length > 0 &&
    split.right.every((id) => typeof id === "string" && !!id) &&
    new Set(split.right).size === split.right.length &&
    (split.leftActive === undefined || typeof split.leftActive === "string") &&
    (split.rightActive === undefined ||
      typeof split.rightActive === "string") &&
    typeof split.ratio === "number" &&
    Number.isFinite(split.ratio)
  );
}

function normalize(value: unknown): TabSplit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const split = isLegacy(record) ? migrate(record) : record;
  return validSplit(split) ? split : null;
}

function read(): SplitMap {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: SplitMap = {};
    for (const [workspaceId, entry] of Object.entries(value)) {
      const split = normalize(entry);
      if (split) out[workspaceId] = split;
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: SplitMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clampSplitRatio(ratio: number): number {
  return Math.min(0.8, Math.max(0.2, ratio));
}

/** A lone tab is already named by the pane header, so only a real choice or a
 *  two-column split earns a tab strip. Workers render below their parent and
 *  never own workspace tabs. */
export function shouldShowTabStrip(
  tabCount: number,
  inSplit = false,
  viewingWorker = false,
): boolean {
  return !viewingWorker && (inSplit || tabCount > 1);
}

export function getTabSplit(workspaceId: string): TabSplit | null {
  const split = read()[workspaceId];
  return split ? { ...split, ratio: clampSplitRatio(split.ratio) } : null;
}

export function saveTabSplit(workspaceId: string, split: TabSplit): void {
  if (!workspaceId || !validSplit(split)) return;
  const map = read();
  map[workspaceId] = { ...split, ratio: clampSplitRatio(split.ratio) };
  write(map);
}

export function clearTabSplit(workspaceId: string): void {
  if (!workspaceId) return;
  const map = read();
  if (!(workspaceId in map)) return;
  delete map[workspaceId];
  write(map);
}

/** Both bars, resolved against the tabs that actually exist right now. */
export type ResolvedSplit = {
  left: string[];
  right: string[];
  leftActive: string;
  rightActive: string;
  ratio: number;
};

/**
 * Project the stored split onto the live tabs. Returns null when there is no
 * split to render — no record, or one bar has been emptied (its last tab was
 * closed or dragged across), which is what collapses a split back to one bar.
 *
 * `liveIds` sets the left bar's order (it is the strip's own order); the right
 * bar keeps the order tabs were added to it.
 */
export function resolveSplit(
  split: TabSplit | null,
  liveIds: string[],
): ResolvedSplit | null {
  if (!split) return null;
  const live = new Set(liveIds);
  const right = split.right.filter((id) => live.has(id));
  if (!right.length) return null;
  const inRight = new Set(right);
  const left = liveIds.filter((id) => !inRight.has(id));
  if (!left.length) return null;
  const active = (ids: string[], want?: string) =>
    want && ids.includes(want) ? want : ids[0];
  return {
    left,
    right,
    leftActive: active(left, split.leftActive),
    rightActive: active(right, split.rightActive),
    ratio: clampSplitRatio(split.ratio),
  };
}

export function onTabSplitChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
