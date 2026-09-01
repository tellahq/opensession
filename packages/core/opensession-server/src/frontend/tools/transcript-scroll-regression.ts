#!/usr/bin/env bun
/**
 * Real-browser regression for indexed transcript hydration and follow intent.
 *
 * The target server must serve the current frontend bundle. The fixture is
 * network-free and advances only when this runner asks for the next slice.
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
  tailGrowth: number;
  maxAnchorDrift: number;
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
      return response.result.value as T;
    };
    const settle = () =>
      evaluate<void>(
        `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 40))))`,
      );
    const snapshot = (expectedAnchor?: string | null) =>
      evaluate<Snapshot>(`(() => {
        const scroller = document.querySelector("[data-transcript-motion-scroller]");
        const root = document.querySelector("[data-virtual-transcript]");
        const player = document.querySelector("[data-transcript-motion-event]");
        const lab = document.querySelector("[data-transcript-motion-events]");
        if (!scroller || !root || !player || !lab) throw new Error("hydration fixture is not mounted");
        const box = scroller.getBoundingClientRect();
        const expectedId = ${JSON.stringify(expectedAnchor ?? null)};
        const expected = expectedId
          ? [...root.querySelectorAll("[data-eid]:not([data-transcript-key])")]
              .find(node => node.getAttribute("data-eid") === expectedId)
          : null;
        const visible = [...root.querySelectorAll("[data-eid]:not([data-transcript-key])")]
          .map(node => ({ node, rect: node.getBoundingClientRect() }))
          .filter(({ rect }) => rect.height > 0 && rect.bottom > box.top + 1 && rect.top < box.bottom - 1)
          .sort((left, right) => right.rect.bottom - left.rect.bottom || right.rect.top - left.rect.top);
        const anchor = expected
          ? { node: expected, rect: expected.getBoundingClientRect() }
          : visible[0];
        return {
          event: Number(player.dataset.transcriptMotionEvent || 0),
          totalEvents: Number(lab.dataset.transcriptMotionEvents || 0),
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          bottomGap: Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
          anchorId: anchor?.node.getAttribute("data-eid") ?? null,
          anchorTop: anchor ? anchor.rect.top - box.top : 0,
        };
      })()`);
    const step = async (expectedAnchor?: string | null) => {
      const advanced = await evaluate<boolean>(
        `window.__transcriptMotionControl?.step?.() ?? false`,
      );
      assert(advanced, "hydration fixture ran out of steps");
      await settle();
      return snapshot(expectedAnchor);
    };

    try {
      await send("Page.enable");
      await send("Network.enable");
      await send("Runtime.enable");
      await send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.scale,
        mobile: viewport.mobile,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
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
          `Boolean(window.__transcriptMotionControl?.step && document.querySelector("[data-virtual-transcript]"))`,
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

      // Partial-prefix growth and two keyed prepends while following.
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

      let rect: { x: number; y: number } | null = null;
      const gestureDeadline = performance.now() + 30_000;
      while (!rect && performance.now() < gestureDeadline) {
        rect = await evaluate<{ x: number; y: number } | null>(`(() => {
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
        if (!rect) await Bun.sleep(100);
      }
      assert(rect, "fixture remained obstructed for 30 seconds");
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: rect.x,
        y: rect.y,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: rect.x,
        y: rect.y,
        deltaX: 0,
        deltaY: -500,
      });
      await settle();
      current = await snapshot();
      assert(
        current.bottomGap > 100,
        `reader gesture did not leave the live edge: ${JSON.stringify(current)}`,
      );
      assert(current.anchorId, "reader has no visible transcript anchor");

      let maxAnchorDrift = 0;
      let prependGrowth = 0;
      let readerSteps = 0;
      while (current.event < totalEvents - 1) {
        const before = current;
        current = await step(before.anchorId);
        const drift =
          before.anchorId === current.anchorId
            ? Math.abs(current.anchorTop - before.anchorTop)
            : Number.POSITIVE_INFINITY;
        maxAnchorDrift = Math.max(maxAnchorDrift, drift);
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
          drift <= 1.5,
          `visible anchor drifted ${drift.toFixed(1)}px during prepend at ${viewport.width}px: ${JSON.stringify({ before, after: current })}`,
        );
      }
      assert(
        prependGrowth > fixedViewportHeight,
        "incremental history did not grow enough to exercise anchoring",
      );

      // A small upward gesture must disengage following even inside TanStack's
      // former 120px geometry threshold. Growing the tail must not move the
      // reader or change the viewport height.
      await evaluate<void>(`window.__transcriptMotionControl.followLatest()`);
      await settle();
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: rect.x,
        y: rect.y,
        deltaX: 0,
        deltaY: -48,
      });
      await settle();
      const beforeTail = await snapshot();
      assert(
        beforeTail.bottomGap > 1 && beforeTail.bottomGap < 120,
        `near-end gesture landed at ${beforeTail.bottomGap}px`,
      );
      const afterTail = await step(beforeTail.anchorId);
      const tailDrift =
        beforeTail.anchorId === afterTail.anchorId
          ? Math.abs(afterTail.anchorTop - beforeTail.anchorTop)
          : Number.POSITIVE_INFINITY;
      const tailGrowth = afterTail.scrollHeight - beforeTail.scrollHeight;
      assert(tailGrowth > 100, `tail grew only ${tailGrowth}px`);
      assert(
        afterTail.clientHeight === fixedViewportHeight,
        `viewport height changed during tail growth: ${fixedViewportHeight} -> ${afterTail.clientHeight}`,
      );
      assert(
        beforeTail.anchorId === afterTail.anchorId && tailDrift <= 1.5,
        `near-end reader moved during tail growth (${tailDrift.toFixed(1)}px): ${JSON.stringify({ beforeTail, afterTail })}`,
      );
      assert(
        Math.abs(afterTail.scrollTop - beforeTail.scrollTop - tailGrowth) <=
          1.5,
        `near-end scrollTop did not track ${tailGrowth}px of growth above the anchor`,
      );
      assert(
        Math.abs(afterTail.bottomGap - beforeTail.bottomGap) <= 1.5,
        `near-end bottom gap changed ${Math.abs(afterTail.bottomGap - beforeTail.bottomGap).toFixed(1)}px`,
      );

      results.push({
        width: viewport.width,
        viewportHeight: fixedViewportHeight,
        followingSteps,
        readerSteps,
        prependGrowth,
        tailGrowth,
        maxAnchorDrift,
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
