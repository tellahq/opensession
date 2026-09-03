import { expect, test } from "bun:test";
import { PromptOutbox } from "./prompt-outbox";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function serialLocks() {
  const tails = new Map<string, Promise<void>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const turn = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        turn.then(
          () => undefined,
          () => undefined,
        ),
      );
      return turn;
    },
  };
}

test("persists before returning and delivers each session in order", async () => {
  const storage = memoryStorage();
  const delivered: string[] = [];
  const outbox = new PromptOutbox({
    storage,
    scope: "test",
    deliver: async (_sessionId, body) => {
      delivered.push(body.content);
      return { status: "started", message: "ok" };
    },
  });
  const first = outbox.enqueue({
    sessionId: "s1",
    content: "first",
    files: [{ name: "a", path: "/tmp/a" }],
    contextSessions: ["s2"],
    busyMode: "steer",
  });
  const second = outbox.enqueue({ sessionId: "s1", content: "second" });
  expect(
    JSON.stringify(storage.getItem("opensession-prompt-outbox:v1:test")),
  ).toContain(first.clientId);
  await outbox.flush();
  expect(delivered).toEqual(["first", "second"]);
  expect(outbox.list()).toEqual([]);
  outbox.dispose();
});

test("persists optimistic anchors without sending them to the server", async () => {
  const storage = memoryStorage();
  let delivered:
    | Parameters<
        NonNullable<
          NonNullable<ConstructorParameters<typeof PromptOutbox>[0]>["deliver"]
        >
      >[1]
    | undefined;
  const outbox = new PromptOutbox({
    storage,
    scope: "transcript-anchor",
    deliver: async (_sessionId, body) => {
      delivered = body;
      return { status: "started", message: "ok" };
    },
  });
  outbox.enqueue({
    sessionId: "s1",
    content: "anchored",
    transcriptAfterEntryId: "entry-4",
    transcriptAfterSeq: 4,
  });
  expect(outbox.list("s1")[0]).toMatchObject({
    transcriptAfterEntryId: "entry-4",
    transcriptAfterSeq: 4,
  });
  await outbox.flush();
  expect(delivered).not.toHaveProperty("transcriptAfterEntryId");
  expect(delivered).not.toHaveProperty("transcriptAfterSeq");
  outbox.dispose();
});

test("keeps the item state as the only in-tab send lock", async () => {
  const storage = memoryStorage();
  const delivered: string[] = [];
  let releaseFirst!: () => void;
  const firstDelivery = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseSecond!: () => void;
  const secondDelivery = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const outbox = new PromptOutbox({
    storage,
    scope: "send-lock",
    deliver: async (_sessionId, body) => {
      delivered.push(body.content);
      if (body.content === "first") await firstDelivery;
      if (body.content === "second") releaseSecond();
      return { status: "started", message: "ok" };
    },
  });
  outbox.enqueue({ sessionId: "s1", content: "first" });
  await Promise.resolve();
  expect(outbox.list("s1")[0]?.state).toBe("sending");

  // enqueue reloads storage before appending. It must not rewind the active
  // request to pending or let the second prompt overtake it.
  outbox.enqueue({ sessionId: "s1", content: "second" });
  expect(outbox.list("s1").map((item) => item.state)).toEqual([
    "sending",
    "pending",
  ]);
  expect(delivered).toEqual(["first"]);

  releaseFirst();
  await secondDelivery;
  await Promise.resolve();
  expect(delivered).toEqual(["first", "second"]);
  expect(outbox.list()).toEqual([]);
  outbox.dispose();
});

test("serializes one durable prompt across browser tabs", async () => {
  const storage = memoryStorage();
  const locks = serialLocks();
  let deliveries = 0;
  let deliveryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    deliveryStarted = resolve;
  });
  let releaseDelivery!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  const deliver = async () => {
    deliveries += 1;
    deliveryStarted();
    await held;
    return { status: "started" as const, message: "ok" };
  };
  const firstTab = new PromptOutbox({
    storage,
    locks,
    scope: "cross-tab",
    deliver,
  });
  firstTab.enqueue({ sessionId: "s1", content: "once" });
  const secondTab = new PromptOutbox({
    storage,
    locks,
    scope: "cross-tab",
    deliver,
  });
  const secondFlush = secondTab.flush();

  await started;
  expect(deliveries).toBe(1);
  releaseDelivery();
  await secondFlush;
  await firstTab.flush();

  expect(deliveries).toBe(1);
  expect(firstTab.list()).toEqual([]);
  expect(secondTab.list()).toEqual([]);
  firstTab.dispose();
  secondTab.dispose();
});

test("reports a handled command before retiring its durable row", async () => {
  const outbox = new PromptOutbox({
    storage: memoryStorage(),
    scope: "handled-command",
    deliver: async (_sessionId, body) => ({
      status: "handled",
      message: `Goal pinned: ${body.content}`,
      deliveryId: body.clientId,
    }),
  });
  const deliveries: Array<{
    content: string;
    status: string;
    message: string;
  }> = [];
  outbox.observeDelivery((item, result) =>
    deliveries.push({
      content: item.content,
      status: result.status,
      message: result.message,
    }),
  );
  outbox.enqueue({ sessionId: "s1", content: "/goal ship it" });
  await outbox.flush();
  expect(deliveries).toEqual([
    {
      content: "/goal ship it",
      status: "handled",
      message: "Goal pinned: /goal ship it",
    },
  ]);
  expect(outbox.list()).toEqual([]);
  outbox.dispose();
});

test("keeps a retryable failed head item and exposes it for retry or editing", async () => {
  const storage = memoryStorage();
  let fail = true;
  const outbox = new PromptOutbox({
    storage,
    scope: "failure",
    deliver: async () => {
      if (fail) throw new Error("offline");
      return { status: "queued", message: "ok" };
    },
  });
  const item = outbox.enqueue({ sessionId: "s1", content: "draft" });
  await outbox.flush();
  expect(outbox.list("s1")[0]).toMatchObject({
    clientId: item.clientId,
    state: "pending",
    attempts: 1,
    error: "offline",
  });
  fail = false;
  outbox.edit(item.clientId, { content: "edited" });
  await outbox.flush();
  expect(outbox.list()).toEqual([]);
  outbox.dispose();
});

test("marks a rejected delivery failed without losing its editable payload", async () => {
  const outbox = new PromptOutbox({
    storage: memoryStorage(),
    scope: "rejected",
    deliver: async () => {
      throw Object.assign(new Error("Session not found"), { status: 404 });
    },
  });
  const item = outbox.enqueue({
    sessionId: "missing",
    content: "keep this",
    user: "Ada",
  });
  await outbox.flush();
  expect(outbox.list()).toEqual([
    expect.objectContaining({
      clientId: item.clientId,
      state: "failed",
      content: "keep this",
      user: "Ada",
    }),
  ]);
  outbox.discard(item.clientId);
  expect(outbox.list()).toEqual([]);
  outbox.dispose();
});

test("a terminally rejected item does not block a later follow-up", async () => {
  const delivered: string[] = [];
  const outbox = new PromptOutbox({
    storage: memoryStorage(),
    scope: "rejected-head",
    deliver: async (_sessionId, body) => {
      delivered.push(body.content);
      if (body.content === "bad image") {
        throw Object.assign(new Error("Unsupported image"), { status: 400 });
      }
      return { status: "queued", message: "ok" };
    },
  });
  const failed = outbox.enqueue({ sessionId: "s1", content: "bad image" });
  await outbox.flush();
  outbox.enqueue({ sessionId: "s1", content: "follow up" });
  await outbox.flush();

  expect(delivered).toEqual(["bad image", "follow up"]);
  expect(outbox.list("s1")).toEqual([
    expect.objectContaining({ clientId: failed.clientId, state: "failed" }),
  ]);
  outbox.dispose();
});

test("resumes a persisted send after the tab that started it closes", async () => {
  const storage = memoryStorage();
  storage.setItem(
    "opensession-prompt-outbox:v1:resume",
    JSON.stringify({
      version: 1,
      items: [
        {
          clientId: "stable-id",
          sessionId: "s1",
          content: "resume",
          state: "sending",
          attempts: 0,
          createdAt: 1,
          nextAttemptAt: 1,
        },
      ],
    }),
  );
  const outbox = new PromptOutbox({
    storage,
    scope: "resume",
    deliver: async () => ({ status: "started", message: "ok" }),
  });
  expect(outbox.list()[0]?.state).toBe("pending");
  await outbox.flush();
  expect(outbox.list()).toEqual([]);
  outbox.dispose();
});

test("keeps retryable outages pending beyond the backoff cap", async () => {
  let now = 1;
  const outbox = new PromptOutbox({
    storage: memoryStorage(),
    scope: "long-outage",
    now: () => now,
    deliver: async () => {
      throw new Error("offline");
    },
  });
  outbox.enqueue({ sessionId: "s1", content: "eventually" });
  for (let attempt = 0; attempt < 8; attempt++) {
    now += 60_000;
    await outbox.flush();
  }
  expect(outbox.list()[0]?.state).toBe("pending");
  expect(outbox.list()[0]?.attempts).toBeGreaterThan(5);
  outbox.dispose();
});

test("does not retain an item in memory when durable storage rejects it", () => {
  const outbox = new PromptOutbox({
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    },
    scope: "quota",
  });
  expect(() =>
    outbox.enqueue({ sessionId: "s1", content: "keep in composer" }),
  ).toThrow("quota exceeded");
  expect(outbox.list()).toEqual([]);
  outbox.dispose();
});

// The browser's own DOMException names setItem and a storage key, which reads
// like a cap on attachments and tells nobody what to do about it.
test("says what a full store means, in place of the browser's message", () => {
  const outbox = new PromptOutbox({
    storage: {
      getItem: () => null,
      setItem: () => {
        throw Object.assign(
          new Error("Failed to execute 'setItem' on 'Storage'"),
          {
            name: "QuotaExceededError",
          },
        );
      },
    },
    scope: "quota-copy",
  });
  expect(() => outbox.enqueue({ sessionId: "s1", content: "hi" })).toThrow(
    "No room left to save this message for delivery. Discard a failed message to make space.",
  );
  outbox.dispose();
});

test("keeps memory in step with storage when a state change cannot be written", async () => {
  const stored = JSON.stringify({
    version: 1,
    items: [
      {
        clientId: "c1",
        sessionId: "s1",
        content: "unsent",
        state: "pending",
        attempts: 0,
        createdAt: 1,
        nextAttemptAt: 1,
      },
    ],
  });
  let delivered = 0;
  const outbox = new PromptOutbox({
    storage: {
      getItem: () => stored,
      setItem: () => {
        throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
      },
    },
    scope: "rollback",
    deliver: async () => {
      delivered++;
      return { status: "started", message: "ok" };
    },
  });
  // The pending → sending transition can't be persisted. The flush must not
  // reject, and the item must stay pending rather than sit in a "sending"
  // state no reload can see. Nothing is sent it couldn't record having sent.
  await outbox.flush();
  expect(delivered).toBe(0);
  expect(outbox.list()[0]?.state).toBe("pending");
  expect(JSON.parse(stored).items[0].state).toBe("pending");
  outbox.dispose();
});
