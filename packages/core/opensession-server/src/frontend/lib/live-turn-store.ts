import { LiveTextBuffer } from "@tellahq/opensession-protocol/live-text";
import { advanceReveal } from "@tellahq/opensession-protocol/stream-cuts";
import {
  countSessionPerf,
  recordSessionPerf,
  startSessionPerfObservers,
} from "./session-performance";
import { randomUUID } from "./random-uuid";

export interface LiveTurnSnapshot {
  text: string;
  live: boolean;
  by: string | null;
  runId: string | null;
  /** This run has painted visible stream text at least once. It stays true
   * across block reconciliation so progress chrome does not flicker back
   * between landed blocks. */
  hasPaintedText: boolean;
  revision: number;
}

const EMPTY: LiveTurnSnapshot = {
  text: "",
  live: false,
  by: null,
  runId: null,
  hasPaintedText: false,
  revision: 0,
};

// A shipped chunk is a sentence or a paragraph (the server cuts frames at
// block boundaries); pasting it in one repaint is the jump the reveal exists
// to remove. The pace is proportional to the backlog — a burst types out
// fast, the last words land gently — and a cut only ever falls on a
// word-safe boundary (advanceReveal), so mid-construct markdown never shows.
const CATCH_UP_MS = 400;
// Floor on per-frame progress so a short tail still finishes promptly.
const MIN_REVEAL_STEP = 2;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const scheduleFrame = (callback: FrameRequestCallback): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : (setTimeout(() => callback(performance.now()), 16) as unknown as number);
const cancelFrame = (id: number) => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id);
};

// Placeholder frame id held while scheduleFrame is being called: if the
// callback fires synchronously (a test-installed requestAnimationFrame may),
// flush() nulls `frame` before scheduleFrame returns — and storing the
// returned id over that null would leave a stale id blocking every future
// schedule, silencing the store for good.
const SCHEDULING = -1;

/**
 * The bubble a running turn writes into.
 *
 * What to show is `LiveTextBuffer`'s job (it owns cancelling a block once the
 * durable entry lands, and it is the same class the server's feed and the
 * native app use). What this adds is when to paint: the buffer holds what
 * has arrived, and a per-frame reveal types it out a few words at a time
 * (`advanceReveal`) instead of pasting a whole shipped block in one repaint.
 * The pace scales with the backlog, so the bubble never trails the model by
 * more than about CATCH_UP_MS; landed entries and turn end snap it forward.
 */
export class LiveTurnStore {
  private snapshot: LiveTurnSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private buffer = new LiveTextBuffer();
  private frame: number | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDeltaAt: number | null = null;
  /** How much of the buffer the bubble shows; the reveal walks it forward. */
  private shown = 0;
  private lastFrameAt = 0;
  private instant = prefersReducedMotion();

  constructor() {
    startSessionPerfObservers();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => EMPTY;
  hasText = () => Boolean(this.buffer.text);
  hasPaintedText = () => this.snapshot.hasPaintedText;
  textLength = () => this.buffer.text.length;

  start(by?: string | null, runId?: string) {
    this.cancelTimers();
    this.buffer.reset();
    this.shown = 0;
    this.lastFrameAt = 0;
    this.instant = prefersReducedMotion();
    this.firstDeltaAt = null;
    this.snapshot = {
      text: "",
      live: true,
      by: by ?? null,
      runId: runId ?? randomUUID(),
      hasPaintedText: false,
      revision: this.snapshot.revision + 1,
    };
    this.emit();
  }

  append(text: string, blockId?: string) {
    if (!this.buffer.append(text, blockId)) return;
    countSessionPerf("stream_frames_received");
    if (this.firstDeltaAt === null) this.firstDeltaAt = performance.now();
    if (this.frame === null) {
      this.frame = SCHEDULING;
      const id = scheduleFrame(() => this.flush());
      // A synchronous callback already flushed and cleared the slot.
      if (this.frame === SCHEDULING) this.frame = id;
    }
  }

  /** Blocks that just landed as durable transcript entries. */
  land(entries: Array<{ id?: string; content: string }>) {
    for (const entry of entries) this.buffer.land(entry.content, entry.id);
    // The durable entry supersedes the bubble: snap the reveal so no tail of
    // a landed block keeps typing under the entry that already says it.
    this.shown = this.buffer.text.length;
    this.snapshot = {
      ...this.snapshot,
      text: this.buffer.text,
      revision: this.snapshot.revision + 1,
    };
    this.emit();
  }

  finish() {
    // Snap the tail: the durable entry lands next, and a bubble that keeps
    // typing after the turn ended reads as a stuck run.
    this.shown = this.buffer.text.length;
    this.snapshot = {
      ...this.snapshot,
      text: this.buffer.text,
      hasPaintedText: this.snapshot.hasPaintedText || Boolean(this.buffer.text),
      live: false,
      by: null,
      revision: this.snapshot.revision + 1,
    };
    this.emit();
    if (this.clearTimer !== null) clearTimeout(this.clearTimer);
    const runId = this.snapshot.runId;
    this.clearTimer = setTimeout(() => {
      if (this.snapshot.runId === runId && !this.snapshot.live) this.clear();
    }, 5_000);
  }

  clear() {
    this.cancelTimers();
    this.buffer.reset();
    this.shown = 0;
    this.lastFrameAt = 0;
    this.snapshot = {
      ...EMPTY,
      revision: this.snapshot.revision + 1,
    };
    this.emit();
  }

  private flush() {
    if (this.frame !== null && this.frame !== SCHEDULING) {
      cancelFrame(this.frame);
    }
    this.frame = null;
    const target = this.buffer.text;
    if (this.shown >= target.length) {
      // Caught up (or the buffer shrank under us via land): nothing to type.
      this.shown = target.length;
      this.lastFrameAt = 0;
      return;
    }
    if (this.instant) {
      this.shown = target.length;
    } else {
      const now = performance.now();
      const dt =
        this.lastFrameAt > 0 ? Math.min(now - this.lastFrameAt, 100) : 17;
      this.lastFrameAt = now;
      const backlog = target.length - this.shown;
      const budget = Math.max(
        MIN_REVEAL_STEP,
        Math.round((backlog * dt) / CATCH_UP_MS),
      );
      this.shown = advanceReveal(target, this.shown, budget);
    }
    const receivedAt = this.firstDeltaAt;
    this.firstDeltaAt = null;
    this.snapshot = {
      ...this.snapshot,
      text: target.slice(0, this.shown),
      hasPaintedText: true,
      revision: this.snapshot.revision + 1,
    };
    countSessionPerf("stream_paints");
    if (receivedAt !== null) {
      recordSessionPerf(
        "first_delta_to_paint_ms",
        performance.now() - receivedAt,
      );
    }
    this.emit();
    // Keep typing until the bubble has caught the buffer up.
    if (this.shown < target.length) {
      this.frame = SCHEDULING;
      const id = scheduleFrame(() => this.flush());
      if (this.frame === SCHEDULING) this.frame = id;
    } else {
      this.lastFrameAt = 0;
    }
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private cancelTimers() {
    if (this.frame !== null && this.frame !== SCHEDULING) {
      cancelFrame(this.frame);
    }
    if (this.clearTimer !== null) clearTimeout(this.clearTimer);
    this.frame = null;
    this.clearTimer = null;
  }
}
