import {
  type FrameHistory,
  frameEntered,
  frameLoaded,
  frameReturned,
  frameStepped,
  freshFrameHistory,
} from "./frame-history";
import { FRAME_AUDIO_PAUSE } from "./frame-audio";

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
  /** Where the page says it navigated since; see frame-location.ts. */
  location: string | null;
  /** How far Back and Forward can go; see frame-history.ts. */
  history: FrameHistory;
  /** Bumped by Reload so the frame remounts on the same address. */
  nonce: number;
  loading: boolean;
  /** The page says it is playing sound; see frame-audio.ts. */
  audible: boolean;
  slot: HTMLElement | null;
  /** Recency for eviction. Order in `frames` never changes (see above). */
  shownAt: number;
}

/** The frame key for a workspace's Browser or Portal view-tab. */
export function keptFrameKey(kind: "staging" | "portal", scope: string) {
  return `${kind}:${scope}`;
}

/**
 * The scope a session's view tabs, and so its kept frames, live under: its
 * workspace, the isolated worktree it shares, or the lone session.
 */
export function viewTabScope(session: {
  id: string;
  workspaceId?: string | null;
  worktreeDir?: string | null;
}): string {
  return (
    session.workspaceId ||
    (session.worktreeDir?.includes("/worktrees/")
      ? session.worktreeDir
      : session.id)
  );
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
          location: null,
          history: freshFrameHistory(0),
          nonce: 0,
          loading: true,
          audible: false,
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
      : {
          address: spec.url,
          location: null,
          history: freshFrameHistory(frame.history.length),
          nonce: frame.nonce + 1,
          loading: true,
          audible: false,
        }),
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
    location: null,
    history: freshFrameHistory(frame.history.length),
    nonce: frame.nonce + 1,
    loading: true,
    audible: false,
  }));
}

/**
 * The frame element finished a load: its first, which starts its history, or
 * a later one, which is navigation inside the page.
 */
export function keptFrameLoaded(key: string, length: number) {
  update(key, (frame) =>
    frame.loading
      ? { ...frame, loading: false, history: freshFrameHistory(length) }
      : { ...frame, history: frameLoaded(frame.history, length) },
  );
}

/** The page reported where it navigated. */
export function keptFrameNavigated(key: string, location: string) {
  update(key, (frame) =>
    frame.location === location ? frame : { ...frame, location },
  );
}

/** The page reported whether it is playing sound. */
export function keptFrameAudible(key: string, audible: boolean) {
  update(key, (frame) =>
    frame.audible === audible ? frame : { ...frame, audible },
  );
}

/**
 * The scopes (see keptFrameKey) whose Browser or Portal page is playing
 * sound, joined into one string so a subscriber re-renders only when it
 * changes. Scopes never contain a newline.
 */
export function audibleFrameScopes(): string {
  return frames
    .filter((frame) => frame.audible)
    .map((frame) => frame.key.slice(frame.key.indexOf(":") + 1))
    .join("\n");
}

/** Asks every audible page under `scopes` to pause; see frame-audio.ts. */
export function pauseKeptFrames(scopes: ReadonlySet<string>) {
  for (const frame of frames) {
    if (!frame.audible) continue;
    if (!scopes.has(frame.key.slice(frame.key.indexOf(":") + 1))) continue;
    keptFrameElement(frame.key)?.contentWindow?.postMessage(
      { type: FRAME_AUDIO_PAUSE },
      "*",
    );
  }
}

/** Records a Back (-1) or Forward (1) the toolbar sent to the window. */
export function keptFrameStepped(key: string, delta: -1 | 1, length: number) {
  update(key, (frame) => {
    const history = frameStepped(frame.history, delta, length);
    return history === frame.history ? frame : { ...frame, history };
  });
}

export function keptFrameEntered(key: string) {
  update(key, (frame) => {
    const history = frameEntered(frame.history);
    return history === frame.history ? frame : { ...frame, history };
  });
}

export function keptFrameReturned(key: string, length: number) {
  update(key, (frame) => {
    const history = frameReturned(frame.history, length);
    return history === frame.history ? frame : { ...frame, history };
  });
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

/** The iframe a kept frame is showing, from KeptFrameLayer's markup. */
export function keptFrameElement(key: string): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>(
    `[data-kept-frame="${CSS.escape(key)}"] iframe`,
  );
}
