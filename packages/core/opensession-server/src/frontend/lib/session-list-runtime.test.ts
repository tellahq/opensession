import { expect, test } from "bun:test";
import type * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { BrowserSignalStreams } from "./effect-browser-events";
import type { EffectLifecycle } from "./effect-lifecycle";
import { makeSessionListRuntime } from "./session-list-runtime";
import { detachPendingRequest } from "./session-list-state";

const quietStreams: BrowserSignalStreams = {
  visibility: () => Stream.empty,
  focus: () => Stream.empty,
  blur: () => Stream.empty,
  online: () => Stream.empty,
  pageShow: () => Stream.empty,
};

async function drainFibers() {
  await Promise.resolve();
  await Promise.resolve();
}

test("Strict Mode cleanup detaches an aborted request before restart", () => {
  const oldRequest = Promise.resolve();
  const controller = new AbortController();
  const requestRef: { current: Promise<void> | null } = {
    current: oldRequest,
  };
  const abortRef: { current: AbortController | null } = {
    current: controller,
  };

  detachPendingRequest(requestRef, abortRef);
  expect(requestRef.current).toBeNull();
  expect(abortRef.current).toBeNull();
  expect(controller.signal.aborted).toBe(true);

  const replacement = Promise.resolve();
  requestRef.current = replacement;
  if (requestRef.current === oldRequest) requestRef.current = null;
  expect(requestRef.current).toBe(replacement);
});

test("session list construction is inert and start performs the initial poll", async () => {
  let polls = 0;
  const runtime = makeSessionListRuntime({
    streams: quietStreams,
    isVisible: () => true,
  });
  runtime.configure({
    pollInterval: 60_000,
    loadArchived: false,
    loading: true,
    pollLive: async () => {
      polls++;
    },
    pollArchived: async () => {},
  });

  expect(polls).toBe(0);
  const stop = runtime.start();
  await drainFibers();
  expect(polls).toBe(1);
  stop();
});

test("poll interval changes restart the live cadence", () => {
  const runs: string[] = [];
  const cancellations: string[] = [];
  const lifecycle: EffectLifecycle<string> = {
    run(key: string, _effect: Effect.Effect<void>) {
      runs.push(key);
    },
    sleep() {},
    cancel(key: string) {
      cancellations.push(key);
    },
    repeat() {},
    stream<A>(
      _key: string,
      _source: Stream.Stream<A>,
      _action: (value: A) => void,
    ) {},
    acquire() {},
    stop() {},
  };
  const pollLive = async () => {};
  const runtime = makeSessionListRuntime({
    streams: quietStreams,
    isVisible: () => true,
    makeLifecycle: () => lifecycle,
  });
  runtime.configure({
    pollInterval: 60_000,
    loadArchived: false,
    loading: false,
    pollLive,
    pollArchived: async () => {},
  });
  runtime.start();
  runs.length = 0;

  runtime.configure({
    pollInterval: 1_000,
    loadArchived: false,
    loading: false,
    pollLive,
    pollArchived: async () => {},
  });
  expect(cancellations).toEqual(["live-fallback"]);
  expect(runs).toEqual(["live-request"]);

  cancellations.length = 0;
  runs.length = 0;
  runtime.configure({
    pollInterval: 90_000,
    loadArchived: false,
    loading: false,
    pollLive,
    pollArchived: async () => {},
  });
  expect(cancellations).toEqual(["live-fallback"]);
  expect(runs).toEqual(["live-request"]);
});

test("archived polling stays lazy", async () => {
  let archivedPolls = 0;
  const runtime = makeSessionListRuntime({
    streams: quietStreams,
    isVisible: () => true,
  });
  runtime.configure({
    pollInterval: 60_000,
    loadArchived: false,
    loading: false,
    pollLive: async () => {},
    pollArchived: async () => {
      archivedPolls++;
    },
  });
  const stop = runtime.start();
  await drainFibers();
  expect(archivedPolls).toBe(0);

  runtime.configure({
    pollInterval: 60_000,
    loadArchived: true,
    loading: false,
    pollLive: async () => {},
    pollArchived: async () => {
      archivedPolls++;
    },
  });
  await drainFibers();
  expect(archivedPolls).toBe(1);
  stop();
});
