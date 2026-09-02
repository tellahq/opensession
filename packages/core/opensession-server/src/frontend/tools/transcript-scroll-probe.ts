/**
 * In-page instrumentation for the transcript scroll regression.
 *
 * `installTranscriptScrollProbe` is serialized into the browser before the
 * fixture loads. It records every programmatic scroll write on the transcript
 * scroller with a stack, every scroll and gesture event, every CSS animation
 * or transition that starts inside the scroller, and one sample per animation
 * frame of the entry a reader would be looking at. The pure functions below
 * turn those records into the invariants the regression asserts. They run in
 * the test runner and are unit-tested in isolation.
 */

export type ProbeWrite = {
  t: number;
  /** Records share one counter, so a write and a frame sampled in the same
   * timestamp still order correctly. */
  seq: number;
  phase: string;
  kind: "scrollTop" | "scrollTo" | "scrollBy" | "scrollIntoView";
  before: number;
  /** scrollTop right after the call: the browser clamps a write that runs
   * before the container has grown, so this is the write's real effect. */
  after: number;
  /** Requested scroll position, or null when the write cannot be known ahead
   * of layout (scrollIntoView). */
  target: number | null;
  scripted: boolean;
  stack: string;
};

export type ProbeScroll = { t: number; phase: string; scrollTop: number };

export type ProbeGesture = {
  t: number;
  phase: string;
  type: "wheel" | "touchstart" | "touchmove" | "touchend" | "touchcancel";
};

export type ProbeMotion = {
  t: number;
  phase: string;
  type: "animation" | "transition";
  name: string;
  target: string;
  inRow: boolean;
};

export type ProbeFrame = {
  t: number;
  seq: number;
  phase: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Innermost `[data-eid]` at the viewport top and its offset from it. */
  anchor: string | null;
  anchorTop: number;
  /** Where the previous frame's anchor sits in this frame, so a reader who
   * scrolled a new entry to the top still has one node compared across the
   * pair. Null when that node left the DOM. */
  previousAnchorTop: number | null;
};

export type ProbeWindow = {
  writes: ProbeWrite[];
  scrolls: ProbeScroll[];
  gestures: ProbeGesture[];
  motion: ProbeMotion[];
  frames: ProbeFrame[];
};

export type ReaderDisplacement = {
  t: number;
  phase: string;
  anchor: string;
  scrollDelta: number;
  compensation: number;
  moved: number;
  expected: number;
  deviation: number;
  writes: number;
};

export type OpposingWrites = {
  t: number;
  phase: string;
  first: number;
  second: number;
  stacks: [string, string];
};

export type PrematureWrite = {
  t: number;
  phase: string;
  delta: number;
  sinceTouchEnd: number;
  sinceMomentum: number;
  stack: string;
};

/** Runs in the page. Keep it self-contained: it is injected as source. */
export function installTranscriptScrollProbe(): void {
  const SCROLLER = "[data-transcript-motion-scroller]";
  const ROOT = "[data-virtual-transcript]";
  const state = {
    phase: "open",
    scriptedUntil: 0,
    writes: [] as ProbeWrite[],
    scrolls: [] as ProbeScroll[],
    gestures: [] as ProbeGesture[],
    motion: [] as ProbeMotion[],
    frames: [] as ProbeFrame[],
  };
  let seq = 0;
  const isScroller = (node: unknown): node is Element =>
    node instanceof Element && node.matches(SCROLLER);
  const record = <T>(
    node: unknown,
    kind: ProbeWrite["kind"],
    target: number | null,
    run: () => T,
  ): T => {
    if (!isScroller(node)) return run();
    const now = performance.now();
    const stack = (new Error().stack || "")
      .split("\n")
      .slice(3, 8)
      .map((line) => line.trim().replace(/^at /, ""))
      .join(" < ");
    const before = node.scrollTop;
    const result = run();
    state.writes.push({
      t: now,
      seq: ++seq,
      phase: state.phase,
      kind,
      before,
      after: node.scrollTop,
      target,
      scripted: now < state.scriptedUntil,
      stack,
    });
    return result;
  };
  const scrollTop = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  if (scrollTop?.set && scrollTop.get) {
    const set = scrollTop.set;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      enumerable: scrollTop.enumerable,
      get: scrollTop.get,
      set(this: Element, value: number) {
        record(this, "scrollTop", Number(value), () => set.call(this, value));
      },
    });
  }
  const topOf = (args: unknown[]): number | undefined => {
    const first = args[0];
    if (first && typeof first === "object")
      return (first as { top?: number }).top;
    return typeof args[1] === "number" ? args[1] : undefined;
  };
  type Method = (this: Element, ...args: unknown[]) => unknown;
  const scrollTo = Element.prototype.scrollTo as Method;
  Element.prototype.scrollTo = function (this: Element, ...args: unknown[]) {
    const top = topOf(args);
    return record(
      this,
      "scrollTo",
      typeof top === "number" ? top : this.scrollTop,
      () => scrollTo.apply(this, args),
    );
  } as typeof Element.prototype.scrollTo;
  const scrollBy = Element.prototype.scrollBy as Method;
  Element.prototype.scrollBy = function (this: Element, ...args: unknown[]) {
    const top = topOf(args);
    return record(this, "scrollBy", this.scrollTop + (top ?? 0), () =>
      scrollBy.apply(this, args),
    );
  } as typeof Element.prototype.scrollBy;
  const scrollIntoView = Element.prototype.scrollIntoView as Method;
  Element.prototype.scrollIntoView = function (
    this: Element,
    ...args: unknown[]
  ) {
    return record(this.closest(SCROLLER), "scrollIntoView", null, () =>
      scrollIntoView.apply(this, args),
    );
  } as typeof Element.prototype.scrollIntoView;

  document.addEventListener(
    "scroll",
    (event) => {
      if (!isScroller(event.target)) return;
      state.scrolls.push({
        t: performance.now(),
        phase: state.phase,
        scrollTop: event.target.scrollTop,
      });
    },
    true,
  );
  for (const type of [
    "wheel",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
  ] as const) {
    document.addEventListener(
      type,
      () =>
        state.gestures.push({ t: performance.now(), phase: state.phase, type }),
      { capture: true, passive: true },
    );
  }
  const describe = (node: Element) =>
    [
      node.tagName.toLowerCase(),
      ...Array.from(node.classList).slice(0, 4),
    ].join(".");
  const recordMotion = (
    type: ProbeMotion["type"],
    name: string,
    target: EventTarget | null,
  ) => {
    if (!(target instanceof Element) || !target.closest(SCROLLER)) return;
    state.motion.push({
      t: performance.now(),
      phase: state.phase,
      type,
      name,
      target: describe(target),
      inRow: Boolean(target.closest("[data-transcript-key]")),
    });
  };
  document.addEventListener(
    "animationstart",
    (event) => recordMotion("animation", event.animationName, event.target),
    true,
  );
  document.addEventListener(
    "transitionrun",
    (event) => recordMotion("transition", event.propertyName, event.target),
    true,
  );

  const intersects = (rect: DOMRect, top: number) =>
    rect.height > 0 && rect.bottom > top + 1;
  /** The node browser scroll anchoring would hold still: the first row that
   * reaches the viewport top, descended to its innermost entry there. */
  const pick = (): { node: Element; top: number } | null => {
    const scroller = document.querySelector(SCROLLER);
    const root = document.querySelector(ROOT);
    if (!scroller || !root) return null;
    const top = scroller.getBoundingClientRect().top;
    for (const row of root.children) {
      const rowRect = row.getBoundingClientRect();
      if (!intersects(rowRect, top)) continue;
      let picked = row.hasAttribute("data-eid")
        ? { node: row, rect: rowRect }
        : null;
      for (const node of row.querySelectorAll("[data-eid]")) {
        const rect = node.getBoundingClientRect();
        if (!intersects(rect, top)) continue;
        if (picked && !picked.node.contains(node)) break;
        picked = { node, rect };
      }
      return picked ? { node: picked.node, top: picked.rect.top - top } : null;
    }
    return null;
  };
  const locate = (id: string): number | null => {
    const scroller = document.querySelector(SCROLLER);
    if (!scroller) return null;
    const nodes = document.querySelectorAll(
      `${ROOT} [data-eid="${CSS.escape(id)}"]:not([data-transcript-key])`,
    );
    const node = nodes[nodes.length - 1];
    if (!node) return null;
    return (
      node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    );
  };

  let previous: { node: Element; id: string } | null = null;
  const sample = () => {
    requestAnimationFrame(sample);
    const scroller = document.querySelector(SCROLLER);
    if (!scroller) return;
    const picked = pick();
    const box = scroller.getBoundingClientRect();
    let previousAnchorTop: number | null = null;
    if (previous) {
      previousAnchorTop = previous.node.isConnected
        ? previous.node.getBoundingClientRect().top - box.top
        : locate(previous.id);
    }
    const id = picked?.node.getAttribute("data-eid") ?? null;
    state.frames.push({
      t: performance.now(),
      seq: ++seq,
      phase: state.phase,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      anchor: id,
      anchorTop: picked?.top ?? 0,
      previousAnchorTop,
    });
    previous = picked && id ? { node: picked.node, id } : null;
  };
  requestAnimationFrame(sample);

  (
    window as unknown as { __transcriptScrollProbe: unknown }
  ).__transcriptScrollProbe = {
    set phase(value: string) {
      state.phase = value;
    },
    get phase() {
      return state.phase;
    },
    /** Writes in the next `ms` are the script's own, not the app's. */
    markScripted(ms: number) {
      state.scriptedUntil = performance.now() + ms;
    },
    pick() {
      const picked = pick();
      return picked
        ? { id: picked.node.getAttribute("data-eid"), top: picked.top }
        : null;
    },
    locate,
    /** Returns everything recorded since the last take and starts a new
     * window. The last frame carries over so consecutive windows chain. */
    take(): ProbeWindow {
      const lastFrame = state.frames[state.frames.length - 1];
      const window: ProbeWindow = {
        writes: state.writes,
        scrolls: state.scrolls,
        gestures: state.gestures,
        motion: state.motion,
        frames: state.frames,
      };
      state.writes = [];
      state.scrolls = [];
      state.gestures = [];
      state.motion = [];
      state.frames = lastFrame ? [lastFrame] : [];
      return window;
    },
  };
}

export const TRANSCRIPT_SCROLL_PROBE_SOURCE = `(${installTranscriptScrollProbe.toString()})();`;

/** What the write did to scrollTop, clamping included. */
export function writeDelta(write: ProbeWrite): number {
  return write.after - write.before;
}

export function unscriptedWrites(window: ProbeWindow): ProbeWrite[] {
  return window.writes.filter((write) => !write.scripted);
}

/**
 * The entry a reader is looking at moves only by what they scrolled. Between
 * two frames, its offset from the viewport top must change by the reader's
 * own scroll: the scrollTop change minus every programmatic write in between.
 * Uncompensated growth above the reader, a write that undoes their movement,
 * and a write that moves them later all break the equation.
 */
export function findReaderDisplacements(
  window: ProbeWindow,
  tolerance = 1.5,
): ReaderDisplacement[] {
  const found: ReaderDisplacement[] = [];
  const frames = window.frames;
  for (let index = 1; index < frames.length; index++) {
    const from = frames[index - 1]!;
    const to = frames[index]!;
    if (!from.anchor || to.previousAnchorTop === null) continue;
    const writes = window.writes.filter(
      (write) => write.seq > from.seq && write.seq < to.seq,
    );
    // A scripted jump defines a new baseline rather than a correction.
    if (writes.some((write) => write.scripted)) continue;
    const compensation = writes.reduce(
      (sum, write) => sum + writeDelta(write),
      0,
    );
    const scrollDelta = to.scrollTop - from.scrollTop;
    const expected = -(scrollDelta - compensation);
    const moved = to.previousAnchorTop - from.anchorTop;
    const deviation = moved - expected;
    if (Math.abs(deviation) <= tolerance) continue;
    found.push({
      t: to.t,
      phase: to.phase,
      anchor: from.anchor,
      scrollDelta,
      compensation,
      moved,
      expected,
      deviation,
      writes: writes.length,
    });
  }
  return found;
}

/** Two writers in one frame cancelling each other: a guess and its undo. */
export function findOpposingWrites(
  window: ProbeWindow,
  withinMs = 20,
  slack = 2,
): OpposingWrites[] {
  const writes = unscriptedWrites(window);
  const found: OpposingWrites[] = [];
  for (let index = 1; index < writes.length; index++) {
    const first = writes[index - 1]!;
    const second = writes[index]!;
    const a = writeDelta(first);
    const b = writeDelta(second);
    if (second.t - first.t > withinMs) continue;
    if (a === 0 || b === 0 || Math.sign(a) === Math.sign(b)) continue;
    if (Math.abs(Math.abs(a) - Math.abs(b)) > slack) continue;
    found.push({
      t: second.t,
      phase: second.phase,
      first: a,
      second: b,
      stacks: [first.stack, second.stack],
    });
  }
  return found;
}

const GEOMETRY_PROPERTIES = new Set([
  "transform",
  "translate",
  "top",
  "bottom",
  "height",
  "min-height",
  "max-height",
  "margin-top",
  "margin-bottom",
  "padding-top",
  "padding-bottom",
]);

/** Rows are positioned by instant scroll compensation. A transition on their
 * geometry glides against it and reads as the transcript moving by itself. */
export function findRowGeometryTransitions(window: ProbeWindow): ProbeMotion[] {
  return window.motion.filter(
    (motion) =>
      motion.type === "transition" &&
      motion.inRow &&
      GEOMETRY_PROPERTIES.has(motion.name),
  );
}

/** Hydrated history is old content. Only live arrivals may fade in. */
export function findRowArrivalAnimations(window: ProbeWindow): ProbeMotion[] {
  return window.motion.filter(
    (motion) =>
      motion.type === "animation" &&
      motion.inRow &&
      /transcript-enter|ghost-in/.test(motion.name),
  );
}

/** Scroll events that the app's own writes did not cause. */
export function momentumScrolls(
  window: ProbeWindow,
  attribution = 40,
): ProbeScroll[] {
  const writes = unscriptedWrites(window);
  return window.scrolls.filter(
    (scroll) =>
      !writes.some(
        (write) => write.t <= scroll.t && scroll.t - write.t <= attribution,
      ),
  );
}

/**
 * A correction must wait for the finger to lift and for momentum to stop:
 * a scrollTop write during either cancels the fling. Every unscripted write
 * after a touch must land after touchend and at least `settleMs` after the
 * last momentum scroll event that preceded it.
 */
export function findPrematureTouchWrites(
  window: ProbeWindow,
  settleMs = 100,
): PrematureWrite[] {
  const touchEnd = window.gestures
    .filter((gesture) => gesture.type === "touchend")
    .at(-1);
  if (!touchEnd) return [];
  const momentum = momentumScrolls(window);
  const found: PrematureWrite[] = [];
  for (const write of unscriptedWrites(window)) {
    const lastMomentum = momentum.filter((scroll) => scroll.t < write.t).at(-1);
    const sinceTouchEnd = write.t - touchEnd.t;
    const sinceMomentum = write.t - (lastMomentum?.t ?? touchEnd.t);
    if (sinceTouchEnd > 0 && sinceMomentum >= settleMs) continue;
    found.push({
      t: write.t,
      phase: write.phase,
      delta: writeDelta(write),
      sinceTouchEnd,
      sinceMomentum,
      stack: write.stack,
    });
  }
  return found;
}

export function describeWrites(writes: ProbeWrite[]): string {
  return writes
    .map(
      (write) =>
        `${write.phase} ${write.kind} ${writeDelta(write).toFixed(0)}px (asked ${write.target === null ? "?" : (write.target - write.before).toFixed(0)}px) @${write.t.toFixed(0)}ms ${write.stack.split(" < ").slice(0, 2).join(" < ")}`,
    )
    .join("\n");
}
