import { expect, test } from "bun:test";
import {
  prepareAndInterruptQueuedPrompt,
  prepareAndSteerQueuedPrompt,
  type QueuedSteerDeps,
} from "./queued-steer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("rejects a prepared steer when a replacement run wins during actor await", async () => {
  let target = { token: "run-old", runId: "run-old", generation: 4 };
  const prepared = deferred<{ id: string; content: string }>();
  const steered: string[] = [];
  const rejected: string[] = [];
  const deps: QueuedSteerDeps = {
    target: () => target,
    prepare: async () => prepared.promise,
    steer: (token) => {
      steered.push(token);
      return true;
    },
    accept: async () => true,
    reject: async (_sessionId, itemId) => {
      rejected.push(itemId);
      return true;
    },
  };

  const result = prepareAndSteerQueuedPrompt(
    {
      sessionId: "session-1",
      itemId: "item-1",
      text: "hello",
    },
    deps,
  );
  target = { token: "run-new", runId: "run-new", generation: 5 };
  prepared.resolve({ id: "item-1", content: "hello" });

  expect(await result).toBe("rejected");
  expect(steered).toEqual([]);
  expect(rejected).toEqual(["item-1"]);
});

test("surfaces an unconfirmed fenced rejection", async () => {
  let target = { token: "run-old", runId: "run-old", generation: 4 };
  const deps: QueuedSteerDeps = {
    target: () => target,
    prepare: async () => ({ id: "item-1", content: "hello" }),
    steer: () => true,
    accept: async () => true,
    reject: async () => false,
  };
  const result = prepareAndSteerQueuedPrompt(
    {
      sessionId: "session-1",
      itemId: "item-1",
      text: "hello",
    },
    deps,
  );
  target = { token: "run-new", runId: "run-new", generation: 5 };

  await expect(result).rejects.toThrow("fenced rejection");
});

test("does not interrupt a successor that wins during actor preparation", async () => {
  let target = { token: "run-old", runId: "run-old", generation: 4 };
  const prepared = deferred<{ id: string; content: string }>();
  const interrupted: string[] = [];
  const deps: QueuedSteerDeps = {
    target: () => target,
    prepare: async () => prepared.promise,
    steer: (token) => {
      interrupted.push(token);
      return true;
    },
    accept: async () => true,
    reject: async () => true,
  };
  const result = prepareAndInterruptQueuedPrompt(
    {
      sessionId: "session-1",
      itemId: "item-1",
      text: "hello",
    },
    deps,
  );
  target = { token: "run-new", runId: "run-new", generation: 5 };
  prepared.resolve({ id: "item-1", content: "hello" });

  expect(await result).toBe("target_changed");
  expect(interrupted).toEqual([]);
});

test("publishes the sent transcript receipt before touching the runner", async () => {
  const order: string[] = [];
  const deps: QueuedSteerDeps = {
    target: () => ({ token: "run-exact", runId: "run-exact", generation: 2 }),
    prepare: async (_sessionId, itemId, _target, item) => ({
      ...(item || { content: "hello" }),
      id: itemId,
    }),
    prepared: async (_sessionId, itemId, item) => {
      order.push(`transcript:${item.promptEntryId}:${itemId}`);
    },
    steer: () => {
      order.push("runner");
      return true;
    },
    accept: async () => true,
    reject: async () => true,
  };

  expect(
    await prepareAndSteerQueuedPrompt(
      {
        sessionId: "session-1",
        itemId: "item-1",
        item: { content: "hello" },
        text: "hello",
      },
      deps,
    ),
  ).toBe("steered");
  expect(order).toEqual(["transcript:item-1:item-1", "runner"]);
});

test("restores actor ownership when transcript admission fails", async () => {
  const rejected: string[] = [];
  const deps: QueuedSteerDeps = {
    target: () => ({ token: "run-exact", runId: "run-exact", generation: 2 }),
    prepare: async () => ({ id: "item-1", content: "hello" }),
    prepared: async () => {
      throw new Error("transcript unavailable");
    },
    steer: () => true,
    accept: async () => true,
    reject: async (_sessionId, itemId) => {
      rejected.push(itemId);
      return true;
    },
  };

  await expect(
    prepareAndSteerQueuedPrompt(
      {
        sessionId: "session-1",
        itemId: "item-1",
        text: "hello",
      },
      deps,
    ),
  ).rejects.toThrow("transcript unavailable");
  expect(rejected).toEqual(["item-1"]);
});

test("steers and accepts only the captured immutable run token", async () => {
  const steered: string[] = [];
  const deps: QueuedSteerDeps = {
    target: () => ({ token: "run-exact", runId: "run-exact", generation: 2 }),
    prepare: async () => ({ id: "item-1", content: "hello" }),
    steer: (token) => {
      steered.push(token);
      return true;
    },
    accept: async () => true,
    reject: async () => true,
  };
  expect(
    await prepareAndSteerQueuedPrompt(
      {
        sessionId: "session-1",
        itemId: "item-1",
        text: "hello",
      },
      deps,
    ),
  ).toBe("steered");
  expect(steered).toEqual(["run-exact"]);
});
