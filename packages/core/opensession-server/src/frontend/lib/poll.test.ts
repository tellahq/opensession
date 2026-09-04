import { expect, test } from "bun:test";
import * as Stream from "effect/Stream";
import { makePollWhileVisible } from "./poll";

async function drainFibers() {
  await Promise.resolve();
  await Promise.resolve();
}

test("visibility polling aborts its in-flight task on stop", async () => {
  let requestSignal: AbortSignal | undefined;
  const pollWhileVisible = makePollWhileVisible({
    streams: { visibility: () => Stream.empty },
    isVisible: () => true,
  });
  const stop = pollWhileVisible((signal) => {
    requestSignal = signal;
    return new Promise<void>(() => {});
  }, 60_000);

  await drainFibers();
  expect(requestSignal?.aborted).toBe(false);
  stop();
  await drainFibers();
  expect(requestSignal?.aborted).toBe(true);
});

test("visibility polling skips work while hidden", async () => {
  let polls = 0;
  const pollWhileVisible = makePollWhileVisible({
    streams: { visibility: () => Stream.empty },
    isVisible: () => false,
  });
  const stop = pollWhileVisible(async () => {
    polls++;
  }, 60_000);

  await drainFibers();
  expect(polls).toBe(0);
  stop();
});
