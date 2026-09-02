#!/usr/bin/env bun
/**
 * Real-browser regression for transcript reading stability.
 *
 * Drives the deterministic hydration fixture in Chrome, desktop and phone,
 * and asserts what a reader would notice: following holds while history
 * hydrates, a gesture leaves the live edge, prepended history and growth
 * above the reader never move what they are reading, tail growth appears
 * beneath them, and a phone fling is never cancelled by a correction.
 *
 * An in-page probe (transcript-scroll-probe.ts) checks the frames between
 * those settle points: the entry at the viewport top moves only by what the
 * reader scrolled, no two writers fight inside one frame, rows never glide,
 * and hydrated history never fades in.
 *
 * The target server must serve the current frontend bundle. Without
 * OPENSESSION_URL an isolated fixture server starts on an ephemeral port.
 *
 * usage: OPENSESSION_URL=http://127.0.0.1:3850 bun packages/core/opensession-server/src/frontend/tools/transcript-scroll-regression.ts
 */
import {
  acquireCdpBrowser,
  cdpSender,
  closeCdpTarget,
  releaseCdpBrowser,
} from "../../../../../../scripts/lib/cdp-browser";
import { localAutomationToken } from "../../../../../../scripts/lib/local-auth";
import {
  describeWrites,
  findOpposingWrites,
  findPrematureTouchWrites,
  findReaderDisplacements,
  findRowArrivalAnimations,
  findRowGeometryTransitions,
  momentumScrolls,
  TRANSCRIPT_SCROLL_PROBE_SOURCE,
  unscriptedWrites,
  writeDelta,
  type ProbeWindow,
} from "./transcript-scroll-probe";

type Snapshot = {
  event: number;
  totalEvents: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  bottomGap: number;
  anchorId: string | null;
  anchorTop: number;
};

type ViewportResult = {
  width: number;
  viewportHeight: number;
  followingSteps: number;
  readerSteps: number;
  prependGrowth: number;
  compensations: number;
  growthInRow: number;
  growthInRowAbove: number;
  tailGrowth: number;
  maxAnchorDrift: number;
  fling: { travel: number; growth: number; correction: number } | null;
};

let app = process.env.OPENSESSION_URL;
let fixtureServer: ReturnType<typeof Bun.spawn> | undefined;
if (!app) {
  fixtureServer = Bun.spawn(
    ["bun", `${import.meta.dir}/transcript-motion-fixture-server.ts`],
    {
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = fixtureServer.stdout;
  if (!(stdout instanceof ReadableStream))
    throw new Error("fixture server stdout is not readable");
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 60_000;
  let match: RegExpMatchArray | null = null;
  while (!match && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
    match = output.match(/ready on (http:\/\/[^\s]+)/);
  }
  if (!match?.[1]) {
    fixtureServer.kill();
    const stderr = fixtureServer.stderr;
    const error =
      stderr instanceof ReadableStream ? await new Response(stderr).text() : "";
    throw new Error(`fixture server did not start: ${error || output}`);
  }
  app = match[1];
}
const APP = app;
const lease = await acquireCdpBrowser();
const results: ViewportResult[] = [];

function assert<T>(condition: T, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Turn number of a fixture entry id such as `hydration-assistant-12:footer`. */
function turnOf(anchorId: string): {
  role: "user" | "assistant";
  turn: number;
} | null {
  const match = anchorId.match(/^hydration-(user|assistant)-(\d+)/);
  if (!match) return null;
  const role = match[1] === "user" ? "user" : "assistant";
  return { role, turn: Number(match[2]) };
}

function drift(before: Snapshot, after: Snapshot): number {
  return before.anchorId === after.anchorId
    ? Math.abs(after.anchorTop - before.anchorTop)
    : Number.POSITIVE_INFINITY;
}

/** Frame-level invariants for a window in which the reader owns the scroll. */
function expectQuietFrames(window: ProbeWindow, phase: string) {
  const displaced = findReaderDisplacements(window);
  assert(
    displaced.length === 0,
    `${phase}: the entry at the viewport top moved without the reader in ${displaced.length} frame(s): ${JSON.stringify(displaced.slice(0, 3))}\n${describeWrites(unscriptedWrites(window))}`,
  );
  const opposing = findOpposingWrites(window);
  assert(
    opposing.length === 0,
    `${phase}: two writers fought inside one frame: ${JSON.stringify(opposing.slice(0, 3))}`,
  );
  const glides = findRowGeometryTransitions(window);
  assert(
    glides.length === 0,
    `${phase}: rows transitioned their geometry: ${JSON.stringify(glides.slice(0, 3))}`,
  );
  const intoView = unscriptedWrites(window).filter(
    (write) => write.kind === "scrollIntoView",
  );
  assert(
    intoView.length === 0,
    `${phase}: scrollIntoView moved the transcript:\n${describeWrites(intoView)}`,
  );
}

function expectNoWrites(window: ProbeWindow, phase: string) {
  const writes = unscriptedWrites(window);
  assert(
    writes.length === 0,
    `${phase}: scrollTop was written although nothing above the reader changed:\n${describeWrites(writes)}`,
  );
}

try {
  for (const viewport of [
    { width: 1_440, height: 900, scale: 1, mobile: false },
    { width: 390, height: 844, scale: 3, mobile: true },
  ]) {
    const target = await fetch(
      `http://127.0.0.1:${lease.port}/json/new?url=about:blank`,
      { method: "PUT" },
    ).then((response) => response.json());
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("CDP connection failed"));
    });
    const send = cdpSender(socket);
    const evaluate = async <T>(expression: string): Promise<T> => {
      const response = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails)
        throw new Error(
          response.exceptionDetails.exception?.description ||
            response.exceptionDetails.text ||
            "browser evaluation failed",
        );
      return response.result.value;
    };
    const settle = () =>
      evaluate<void>(
        `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 40))))`,
      );
    const probe = {
      phase: (name: string) =>
        evaluate<void>(
          `void (window.__transcriptScrollProbe.phase = ${JSON.stringify(name)})`,
        ),
      /** Writes the script itself causes in the next `ms` are not the app's. */
      scripted: (ms = 400) =>
        evaluate<void>(`window.__transcriptScrollProbe.markScripted(${ms})`),
      take: () =>
        evaluate<ProbeWindow>(`window.__transcriptScrollProbe.take()`),
      pick: () =>
        evaluate<{ id: string; top: number } | null>(
          `window.__transcriptScrollProbe.pick()`,
        ),
    };
    const snapshot = (expectedAnchor?: string | null) =>
      evaluate<Snapshot>(`(() => {
        const scroller = document.querySelector("[data-transcript-motion-scroller]");
        const player = document.querySelector("[data-transcript-motion-event]");
        const lab = document.querySelector("[data-transcript-motion-events]");
        const probe = window.__transcriptScrollProbe;
        if (!scroller || !player || !lab || !probe) throw new Error("hydration fixture is not mounted");
        const expectedId = ${JSON.stringify(expectedAnchor ?? null)};
        const located = expectedId ? probe.locate(expectedId) : null;
        const anchor = located === null ? probe.pick() : { id: expectedId, top: located };
        return {
          event: Number(player.dataset.transcriptMotionEvent || 0),
          totalEvents: Number(lab.dataset.transcriptMotionEvents || 0),
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          bottomGap: Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
          anchorId: anchor?.id ?? null,
          anchorTop: anchor?.top ?? 0,
        };
      })()`);
    const readScrollTop = () =>
      evaluate<number>(
        `document.querySelector("[data-transcript-motion-scroller]").scrollTop`,
      );
    const step = async (expectedAnchor?: string | null) => {
      const advanced = await evaluate<boolean>(
        `window.__transcriptMotionControl?.step?.() ?? false`,
      );
      assert(advanced, "hydration fixture ran out of steps");
      await settle();
      return snapshot(expectedAnchor);
    };
    const grow = async (entryId: string) => {
      const grown = await evaluate<boolean>(
        `window.__transcriptMotionControl?.grow?.(${JSON.stringify(entryId)}) ?? false`,
      );
      assert(grown, `hydration fixture could not grow ${entryId}`);
    };
    const wheel = async (point: { x: number; y: number }, deltaY: number) => {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX: 0,
        deltaY,
      });
      await settle();
    };

    try {
      await send("Page.enable");
      await send("Network.enable");
      await send("Runtime.enable");
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: TRANSCRIPT_SCROLL_PROBE_SOURCE,
      });
      await send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.scale,
        mobile: viewport.mobile,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      });
      if (viewport.mobile)
        await send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 1,
        });
      const token = localAutomationToken();
      if (token)
        await send("Network.setCookie", {
          name: "opensession_auth",
          value: token,
          url: APP,
          path: "/",
        });
      await send("Page.navigate", {
        url: `${APP}/__fixtures/transcript-motion?profile=hydration`,
      });
      await send("Page.bringToFront");
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        const ready = await evaluate<boolean>(
          `Boolean(window.__transcriptMotionControl?.step && window.__transcriptScrollProbe && document.querySelector("[data-virtual-transcript]"))`,
        );
        if (ready) break;
        await Bun.sleep(40);
      }
      await settle();
      // Production can have a one-time announcement dialog above every route.
      // Dismiss it so wheel input reaches the isolated fixture itself.
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Escape",
        code: "Escape",
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
      });
      await settle();

      let current = await snapshot();
      const fixedViewportHeight = current.clientHeight;
      assert(
        current.bottomGap <= 1,
        `opened ${current.bottomGap}px from the end`,
      );
      const totalEvents = current.totalEvents;
      assert(
        totalEvents >= 5,
        "hydration fixture did not expose its event count",
      );
      await probe.take();

      // Partial-prefix growth and two keyed prepends while following.
      await probe.phase("following");
      for (let index = 0; index < 3; index++) {
        current = await step();
        assert(
          current.clientHeight === fixedViewportHeight,
          `viewport height changed during prepend: ${fixedViewportHeight} -> ${current.clientHeight}`,
        );
        assert(
          current.bottomGap <= 1,
          `following ended ${current.bottomGap}px from the end`,
        );
      }
      const followingSteps = current.event;
      const following = await probe.take();
      const followingGlides = findRowGeometryTransitions(following);
      assert(
        followingGlides.length === 0,
        `following: rows transitioned their geometry: ${JSON.stringify(followingGlides.slice(0, 3))}`,
      );

      let point: { x: number; y: number } | null = null;
      const gestureDeadline = performance.now() + 30_000;
      while (!point && performance.now() < gestureDeadline) {
        point = await evaluate<{ x: number; y: number } | null>(`(() => {
          const scroller = document.querySelector("[data-transcript-motion-scroller]");
          const rect = scroller.getBoundingClientRect();
          for (const xRatio of [0.2, 0.5, 0.8]) {
            for (const yRatio of [0.2, 0.5, 0.8]) {
              const x = rect.left + rect.width * xRatio;
              const y = rect.top + rect.height * yRatio;
              if (document.elementFromPoint(x, y)?.closest("[data-transcript-motion-scroller]") === scroller)
                return { x, y };
            }
          }
          return null;
        })()`);
        if (!point) await Bun.sleep(100);
      }
      assert(point, "fixture remained obstructed for 30 seconds");
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });

      // Leaving the live edge is the reader's move alone.
      await probe.phase("leave");
      await wheel(point, -500);
      current = await snapshot();
      assert(
        current.bottomGap > 100,
        `reader gesture did not leave the live edge: ${JSON.stringify(current)}`,
      );
      assert(current.anchorId, "reader has no visible transcript anchor");
      const leave = await probe.take();
      expectNoWrites(leave, "leave");
      expectQuietFrames(leave, "leave");

      // History hydrates above a parked reader: a partial opening prefix,
      // keyed prepends, and a tall row whose estimate misses by a screen.
      await probe.phase("history");
      let maxAnchorDrift = 0;
      let prependGrowth = 0;
      let readerSteps = 0;
      while (current.event < totalEvents - 1) {
        const before = current;
        current = await step(before.anchorId);
        maxAnchorDrift = Math.max(maxAnchorDrift, drift(before, current));
        prependGrowth += Math.max(
          0,
          current.scrollHeight - before.scrollHeight,
        );
        readerSteps++;
        assert(
          current.clientHeight === fixedViewportHeight,
          `viewport height changed during reader prepend: ${fixedViewportHeight} -> ${current.clientHeight}`,
        );
        assert(
          before.anchorId === current.anchorId,
          `visible anchor changed during prepend: ${before.anchorId} -> ${current.anchorId}`,
        );
        assert(
          drift(before, current) <= 1.5,
          `visible anchor drifted ${drift(before, current).toFixed(1)}px during prepend at ${viewport.width}px: ${JSON.stringify({ before, after: current })}`,
        );
      }
      assert(
        prependGrowth > fixedViewportHeight,
        "incremental history did not grow enough to exercise anchoring",
      );
      const history = await probe.take();
      expectQuietFrames(history, "history");
      const arrivals = findRowArrivalAnimations(history);
      assert(
        arrivals.length === 0,
        `history: hydrated rows played arrival motion: ${JSON.stringify(arrivals.slice(0, 3))}`,
      );
      const compensations = unscriptedWrites(history).length;
      assert(
        compensations > 0,
        "history: nothing compensated the prepended history, yet the anchor held; the probe is not seeing the scroller",
      );

      // Growth above the reader that is not a keyed prepend, so TanStack
      // cannot anchor it: first inside the reader's own row (the prompt of
      // the reply they are reading), then in the row above. Park a reply just
      // under the viewport top so both placements are deterministic.
      const parked = current.anchorId ? turnOf(current.anchorId) : null;
      assert(
        parked,
        `reader anchor is not a fixture entry: ${current.anchorId}`,
      );
      const parkedTurn = Math.max(1, parked.turn);
      await probe.scripted();
      await evaluate<void>(`(() => {
        const scroller = document.querySelector("[data-transcript-motion-scroller]");
        const top = window.__transcriptScrollProbe.locate(${JSON.stringify(`hydration-assistant-${parkedTurn}`)});
        if (top === null) throw new Error("reply to park is not mounted");
        scroller.scrollTop += top - 6;
      })()`);
      await settle();
      await probe.take();
      await probe.phase("grow-above");
      current = await snapshot();
      const parkedAnchor = current.anchorId ? turnOf(current.anchorId) : null;
      assert(
        parkedAnchor?.role === "assistant" && parkedAnchor.turn === parkedTurn,
        `could not park a reply at the viewport top: ${JSON.stringify(current)}`,
      );
      const growAbove = async (entryId: string, placement: string) => {
        const before = current;
        assert(before.anchorId, "no reader anchor before growth");
        await grow(entryId);
        await settle();
        current = await snapshot(before.anchorId);
        const growth = current.scrollHeight - before.scrollHeight;
        assert(growth > 40, `${placement}: growth was only ${growth}px`);
        assert(
          drift(before, current) <= 1.5,
          `${placement}: reader moved ${drift(before, current).toFixed(1)}px when ${entryId} grew above them: ${JSON.stringify({ before, after: current })}`,
        );
        return growth;
      };
      const growthInRow = await growAbove(
        `hydration-user-${parkedTurn}`,
        "growth inside the reader's row",
      );
      const growthInRowAbove = await growAbove(
        `hydration-assistant-${parkedTurn - 1}`,
        "growth in the row above",
      );
      expectQuietFrames(await probe.take(), "grow-above");

      // A small upward gesture must disengage following even inside TanStack's
      // former 120px geometry threshold. Growing the tail below the reader
      // must not move what they are reading, must not write scrollTop, and
      // must not change the viewport height: new text appears beneath them.
      await probe.scripted();
      await evaluate<void>(`window.__transcriptMotionControl.followLatest()`);
      await settle();
      await probe.take();
      await probe.phase("tail");
      await wheel(point, -48);
      const beforeTail = await snapshot();
      assert(
        beforeTail.bottomGap > 1 && beforeTail.bottomGap < 120,
        `near-end gesture landed at ${beforeTail.bottomGap}px`,
      );
      const afterTail = await step(beforeTail.anchorId);
      const tailGrowth = afterTail.scrollHeight - beforeTail.scrollHeight;
      assert(tailGrowth > 100, `tail grew only ${tailGrowth}px`);
      assert(
        afterTail.clientHeight === fixedViewportHeight,
        `viewport height changed during tail growth: ${fixedViewportHeight} -> ${afterTail.clientHeight}`,
      );
      assert(
        beforeTail.anchorId === afterTail.anchorId &&
          drift(beforeTail, afterTail) <= 1.5,
        `near-end reader moved during tail growth (${drift(beforeTail, afterTail).toFixed(1)}px): ${JSON.stringify({ beforeTail, afterTail })}`,
      );
      assert(
        Math.abs(afterTail.scrollTop - beforeTail.scrollTop) <= 1.5,
        `near-end scrollTop was written during tail growth: ${beforeTail.scrollTop} -> ${afterTail.scrollTop}`,
      );
      assert(
        Math.abs(afterTail.bottomGap - beforeTail.bottomGap - tailGrowth) <=
          1.5,
        `tail growth of ${tailGrowth}px did not appear below the reader (gap ${beforeTail.bottomGap} -> ${afterTail.bottomGap})`,
      );
      const tail = await probe.take();
      expectNoWrites(tail, "tail");
      expectQuietFrames(tail, "tail");

      // Phone: fling toward history and grow above the reader while the
      // momentum still runs. The correction must wait for the finger and the
      // momentum, then land exactly: the fling is never cancelled and the
      // reader ends where their own travel put them.
      let fling: ViewportResult["fling"] = null;
      if (viewport.mobile) {
        await probe.phase("fling");
        const flingStart = await snapshot();
        assert(flingStart.anchorId, "no reader anchor before the fling");
        await probe.take();
        const x = Math.round(point.x);
        const y = Math.round(point.y);
        await send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (let index = 1; index <= 8; index++) {
          await send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y + index * 40 }],
          });
          await Bun.sleep(16);
        }
        await send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        let previousTop = await readScrollTop();
        let moving = 0;
        for (let index = 0; index < 20 && moving < 2; index++) {
          await Bun.sleep(30);
          const top = await readScrollTop();
          if (top !== previousTop) moving++;
          previousTop = top;
        }
        assert(moving >= 2, "touch fling produced no momentum");
        // The momentum keeps carrying the reader toward history, so grow a
        // reply well above where they are now: it must still be above them
        // when they stop, or there is nothing to correct.
        const midFling = await probe.pick();
        const midTurn = midFling ? turnOf(midFling.id) : null;
        assert(
          midTurn && midTurn.turn >= 3,
          `no fixture entry far enough above the reader mid-fling: ${JSON.stringify(midFling)}`,
        );
        await grow(`hydration-assistant-${midTurn.turn - 3}`);
        const growAt = await evaluate<number>(`performance.now()`);
        let still = 0;
        for (let index = 0; index < 60 && still < 4; index++) {
          await Bun.sleep(40);
          const top = await readScrollTop();
          still = top === previousTop ? still + 1 : 0;
          previousTop = top;
        }
        await Bun.sleep(400);
        await settle();
        const flingEnd = await snapshot(flingStart.anchorId);
        const window = await probe.take();
        const premature = findPrematureTouchWrites(window);
        assert(
          premature.length === 0,
          `fling: a correction landed under the finger or during momentum: ${JSON.stringify(premature.slice(0, 3))}`,
        );
        const carried = momentumScrolls(window).filter(
          (scroll) => scroll.t > growAt,
        );
        assert(
          carried.length >= 2,
          `fling: momentum stopped when the transcript grew (${carried.length} momentum scroll events after growth)`,
        );
        const writes = unscriptedWrites(window);
        const correction = writes.reduce(
          (sum, write) => sum + writeDelta(write),
          0,
        );
        const growth = flingEnd.scrollHeight - flingStart.scrollHeight;
        assert(growth > 40, `fling: growth above the reader was ${growth}px`);
        assert(
          Math.abs(correction - growth) <= 1.5,
          `fling: ${growth}px grew above the reader but corrections total ${correction}px:\n${describeWrites(writes)}`,
        );
        const travel = flingEnd.scrollTop - flingStart.scrollTop - correction;
        assert(
          travel < -100,
          `fling: reader travelled only ${(-travel).toFixed(0)}px toward history`,
        );
        assert(
          flingEnd.anchorId === flingStart.anchorId &&
            Math.abs(flingEnd.anchorTop - flingStart.anchorTop + travel) <= 1.5,
          `fling: the reader did not end where their own travel put them: ${JSON.stringify({ flingStart, flingEnd, travel, correction })}`,
        );
        const flingGlides = findRowGeometryTransitions(window);
        assert(
          flingGlides.length === 0,
          `fling: rows transitioned their geometry: ${JSON.stringify(flingGlides.slice(0, 3))}`,
        );
        fling = { travel, growth, correction };
      }

      results.push({
        width: viewport.width,
        viewportHeight: fixedViewportHeight,
        followingSteps,
        readerSteps,
        prependGrowth,
        compensations,
        growthInRow,
        growthInRowAbove,
        tailGrowth,
        maxAnchorDrift,
        fling,
      });
    } finally {
      socket.close();
      await closeCdpTarget(lease.port, target.id);
    }
  }
} finally {
  await releaseCdpBrowser(lease);
  if (fixtureServer) {
    fixtureServer.kill();
    await fixtureServer.exited;
  }
}

console.log(JSON.stringify({ passed: true, results }, null, 2));
