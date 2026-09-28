/**
 * Framed pages (the Browser and Portal tabs) that outlive the pane showing
 * them. An iframe reloads whenever its element leaves the document or moves
 * within it, so these frames live in one app-wide layer (KeptFrameLayer) that
 * never reorders them. A pane marks where its page goes with a slot element,
 * and the layer lays the frame over that slot. Once no slot shows a frame it
 * stays loaded, hidden, until it is one of more than KEPT_FRAME_LIMIT frames
 * and the least recently shown.
 */

export const KEPT_FRAME_LIMIT = 3;

export interface KeptFrameSpec {
  /** The URL the owning pane asks for. */
  url: string;
  /** Names the page in the loading status ("Loading Preview environment"). */
  name: string;
  title: string;
  allow?: string;
  sandbox?: string;
}

export interface KeptFrame extends KeptFrameSpec {
  key: string;
  /** What the frame loaded: the pane's URL, or one typed in its address bar. */
  address: string;
  /** Bumped by Reload so the frame remounts on the same address. */
  nonce: number;
  loading: boolean;
  slot: HTMLElement | null;
  /** Recency for eviction. Order in `frames` never changes (see above). */
  shownAt: number;
}

/** The frame key for a workspace's Browser or Portal view-tab. */
export function keptFrameKey(kind: "staging" | "portal", scope: string) {
  return `${kind}:${scope}`;
}

let frames: readonly KeptFrame[] = [];
let clock = 0;
const listeners = new Set<() => void>();

function commit(next: readonly KeptFrame[]) {
  frames = next;
  for (const listener of listeners) listener();
}

function update(key: string, change: (frame: KeptFrame) => KeptFrame) {
  const current = getKeptFrame(key);
  if (!current) return;
  const next = change(current);
  if (next === current) return;
  commit(frames.map((frame) => (frame === current ? next : frame)));
}

/** Drops the least recently shown frames that no slot is showing. */
function evict(list: readonly KeptFrame[]): readonly KeptFrame[] {
  const excess = list.length - KEPT_FRAME_LIMIT;
  if (excess <= 0) return list;
  const drop = new Set(
    list
      .filter((frame) => !frame.slot)
      .sort((a, b) => a.shownAt - b.shownAt)
      .slice(0, excess)
      .map((frame) => frame.key),
  );
  return drop.size ? list.filter((frame) => !drop.has(frame.key)) : list;
}

export function subscribeKeptFrames(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getKeptFrames() {
  return frames;
}

export function getKeptFrame(key: string): KeptFrame | undefined {
  return frames.find((frame) => frame.key === key);
}

/**
 * Shows the frame for `key` in `slot`, creating it on first use. A pane that
 * now asks for a different URL than the frame was opened with starts over on
 * the new one; the same URL keeps whatever the frame navigated to.
 */
export function showKeptFrame(
  key: string,
  spec: KeptFrameSpec,
  slot: HTMLElement,
) {
  const shownAt = ++clock;
  const existing = getKeptFrame(key);
  if (!existing) {
    commit(
      evict([
        ...frames,
        {
          ...spec,
          key,
          address: spec.url,
          nonce: 0,
          loading: true,
          slot,
          shownAt,
        },
      ]),
    );
    return;
  }
  update(key, (frame) => ({
    ...frame,
    ...spec,
    ...(frame.url === spec.url
      ? null
      : { address: spec.url, nonce: frame.nonce + 1, loading: true }),
    slot,
    shownAt,
  }));
}

/** The slot went away; the frame stays loaded and hidden. */
export function hideKeptFrame(key: string, slot: HTMLElement) {
  const frame = getKeptFrame(key);
  if (!frame || frame.slot !== slot) return;
  commit(evict(frames.map((f) => (f.key === key ? { ...f, slot: null } : f))));
}

/** Loads `address` in the frame, or reloads it when it is already there. */
export function loadKeptFrame(key: string, address: string) {
  update(key, (frame) => ({
    ...frame,
    address,
    nonce: frame.nonce + 1,
    loading: true,
  }));
}

export function keptFrameLoaded(key: string) {
  update(key, (frame) =>
    frame.loading ? { ...frame, loading: false } : frame,
  );
}

/** Closing the tab unloads its page. */
export function dropKeptFrame(key: string) {
  if (getKeptFrame(key)) commit(frames.filter((frame) => frame.key !== key));
}

/** Test seam: forget every frame. */
export function resetKeptFrames() {
  clock = 0;
  commit([]);
}
