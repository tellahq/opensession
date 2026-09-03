import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import type { BrowserSignalStreams } from "./effect-browser-events";
import { effectDelay, type EffectLifecycle } from "./effect-lifecycle";
import {
  makeSessionSocketRuntime,
  type SessionSocketFiber,
} from "./session-socket-runtime";

function controlledStreams(onCreate: () => void): BrowserSignalStreams {
  const empty = () => {
    onCreate();
    return Stream.empty;
  };
  return {
    visibility: empty,
    focus: empty,
    blur: empty,
    online: empty,
    pageShow: empty,
  };
}

function noopCallbacks() {
  return {
    heartbeat: () => {},
    resync: () => {},
    syncPresence: () => {},
    activity: () => {},
    reconnectIdentity: () => {},
    storage: () => {},
  };
}

function installWindowTarget(target: EventTarget): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

let windowTarget = new EventTarget();
let restoreWindow = () => {};
beforeEach(() => {
  windowTarget = new EventTarget();
  restoreWindow = installWindowTarget(windowTarget);
});
afterEach(() => restoreWindow());

describe("session socket Effect lifecycle", () => {
  test("delays are deterministic under TestClock", async () => {
    let fired = false;
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        effectDelay(20_000, () => {
          fired = true;
        }),
      );
      yield* TestClock.adjust(19_999);
      expect(fired).toBe(false);
      yield* TestClock.adjust(1);
      yield* Fiber.join(fiber);
      expect(fired).toBe(true);
    });

    await Effect.runPromise(Effect.provide(program, TestClock.layer()));
  });

  test("construction performs no browser work and exposes a synchronous atom", () => {
    const registry = AtomRegistry.make();
    let streamCount = 0;
    const runtime = makeSessionSocketRuntime({
      registry,
      streams: controlledStreams(() => streamCount++),
      isVisible: () => true,
    });

    expect(streamCount).toBe(0);
    expect(registry.get(runtime.connectedAtom)).toBe(false);
    runtime.setConnected(true);
    expect(registry.get(runtime.connectedAtom)).toBe(true);
  });

  test("start, stop, and Strict Mode style restart are synchronous", () => {
    const registry = AtomRegistry.make();
    let streamCount = 0;
    const runtime = makeSessionSocketRuntime({
      registry,
      streams: controlledStreams(() => streamCount++),
      isVisible: () => true,
    });
    runtime.configure(noopCallbacks());

    const firstStop = runtime.start();
    expect(streamCount).toBe(5);
    runtime.setConnected(true);
    firstStop();
    expect(registry.get(runtime.connectedAtom)).toBe(false);

    const secondStop = runtime.start();
    expect(streamCount).toBe(10);
    secondStop();
    expect(registry.get(runtime.connectedAtom)).toBe(false);
  });

  test("focused startup schedules the initial presence lease", () => {
    const registry = AtomRegistry.make();
    const sleeps: Array<{ key: string; milliseconds: number }> = [];
    const lifecycle: EffectLifecycle<SessionSocketFiber> = {
      run() {},
      sleep(key, milliseconds) {
        sleeps.push({ key, milliseconds });
      },
      cancel() {},
      repeat() {},
      stream() {},
      acquire() {},
      stop() {},
    };
    let runtime!: ReturnType<typeof makeSessionSocketRuntime>;
    runtime = makeSessionSocketRuntime({
      registry,
      streams: controlledStreams(() => {}),
      isVisible: () => true,
      makeLifecycle: () => lifecycle,
    });
    runtime.configure({
      ...noopCallbacks(),
      syncPresence: () =>
        runtime.schedule("presence-idle", 8 * 60_000, () => {}),
    });

    runtime.start();
    expect(sleeps).toContainEqual({
      key: "presence-idle",
      milliseconds: 8 * 60_000,
    });
  });

  test("throwing recurring callbacks are reported and keep running", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "reportError");
    let calls = 0;
    let reports = 0;
    Object.defineProperty(globalThis, "reportError", {
      configurable: true,
      value: () => {
        reports++;
      },
    });
    try {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.forever(
              effectDelay(1_000, () => {
                calls++;
                throw new Error("callback failed");
              }),
            ),
          );
          yield* TestClock.adjust(2_000);
          yield* Fiber.interrupt(fiber);
        }),
      );
      await Effect.runPromise(Effect.provide(program, TestClock.layer()));
      expect(calls).toBe(2);
      expect(reports).toBe(2);
    } finally {
      if (previous) Object.defineProperty(globalThis, "reportError", previous);
      else Reflect.deleteProperty(globalThis, "reportError");
    }
  });

  test("native listeners are synchronously fenced on stop", async () => {
    const registry = AtomRegistry.make();
    let activity = 0;
    const runtime = makeSessionSocketRuntime({
      registry,
      streams: controlledStreams(() => {}),
      isVisible: () => true,
    });
    runtime.configure({
      ...noopCallbacks(),
      activity: () => {
        activity++;
      },
    });
    const stop = runtime.start();
    await Promise.resolve();
    windowTarget.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(activity).toBe(1);

    stop();
    windowTarget.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(activity).toBe(1);
  });

  test("hook cleanup detaches the socket before closing it", async () => {
    const source = await Bun.file(
      new URL("../hooks/useWebSocket.ts", import.meta.url),
    ).text();
    const detach = source.indexOf("wsRef.current = null;");
    const close = source.indexOf("closeTarget?.close();", detach);
    expect(detach).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(detach);
  });
});
