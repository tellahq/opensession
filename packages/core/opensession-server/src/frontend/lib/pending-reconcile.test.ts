import { describe, expect, test } from "bun:test";
import {
  markPendingBusy,
  markPendingStarted,
  type OptimisticPendingPrompt,
  optimisticOutboxFallbacks,
  PENDING_GIVE_UP_MS,
  reconcilePending,
  withoutPendingTranscriptEchoes,
} from "./pending-reconcile";
import type { PromptOutboxItem } from "./prompt-outbox";

const SENT = 1_000_000;
const bubble = (id: string, content: string, user?: string) => ({
  id,
  content,
  user,
  sentAt: SENT,
});
const entry = (content: string, at = SENT) => ({
  type: "user",
  content,
  timestamp: new Date(at).toISOString(),
});

const outboxItem = (
  overrides: Partial<PromptOutboxItem> = {},
): PromptOutboxItem => ({
  clientId: "a",
  sessionId: "session",
  content: "ship it",
  state: "pending",
  attempts: 0,
  createdAt: SENT,
  nextAttemptAt: SENT,
  ...overrides,
});

describe("optimisticOutboxFallbacks", () => {
  test("keeps a pristine idle outbox handoff on the transcript surface", () => {
    expect(
      optimisticOutboxFallbacks([outboxItem()], new Set(), new Set()),
    ).toEqual([
      {
        id: "outbox-a",
        content: "ship it",
        user: undefined,
        sentAt: SENT,
      },
    ]);
  });

  test("does not duplicate a local pending row or a landed delivery", () => {
    expect(
      optimisticOutboxFallbacks(
        [outboxItem()],
        new Set(["outbox-a"]),
        new Set(),
      ),
    ).toEqual([]);
    expect(
      optimisticOutboxFallbacks(
        [outboxItem()],
        new Set(),
        new Set(["outbox-a"]),
      ),
    ).toEqual([]);
  });

  test("leaves real queue placement and retry feedback in the outbox", () => {
    expect(
      optimisticOutboxFallbacks(
        [
          outboxItem({ busyMode: "queue" }),
          outboxItem({ clientId: "b", attempts: 1 }),
          outboxItem({ clientId: "c", state: "failed" }),
        ],
        new Set(),
        new Set(),
      ),
    ).toEqual([]);
  });
});

describe("withoutPendingTranscriptEchoes", () => {
  test("keeps an admission echo off the queue while its bubble is visible", () => {
    const queued = [
      { id: "a", content: "ship it" },
      { id: "b", content: "another message" },
      { content: "legacy message" },
    ];

    expect(
      withoutPendingTranscriptEchoes(queued, [bubble("outbox-a", "ship it")]),
    ).toEqual([queued[1], queued[2]]);
  });

  test("also hides an echo after the server confirms the turn started", () => {
    expect(
      withoutPendingTranscriptEchoes(
        [{ id: "a" }],
        [{ ...bubble("outbox-a", "ship it"), serverStarted: true }],
      ),
    ).toEqual([]);
  });

  test("does not match non-outbox optimistic rows to queue ids", () => {
    const queued = [{ id: "pending-initial-session" }];
    expect(
      withoutPendingTranscriptEchoes(queued, [
        bubble("pending-initial-session", "ship it"),
      ]),
    ).toEqual(queued);
  });
});

describe("markPendingStarted", () => {
  const started: OptimisticPendingPrompt = {
    id: "outbox-a",
    content: "ship it",
    user: "michiel",
    sentAt: SENT,
  };

  test("moves a stale busy send from the queue back to the transcript", () => {
    expect(
      markPendingStarted([{ ...started, busyMode: "queue" as const }], started),
    ).toEqual([{ ...started, serverStarted: true }]);
  });

  test("restores a bubble claimed by the transient admission queue", () => {
    expect(markPendingStarted([], started)).toEqual([
      { ...started, serverStarted: true },
    ]);
  });

  test("leaves an already-confirmed transcript bubble alone", () => {
    const current = [{ ...started, serverStarted: true as const }];
    expect(markPendingStarted(current, started)).toBe(current);
  });
});

describe("markPendingBusy", () => {
  const delivered: OptimisticPendingPrompt = {
    id: "outbox-a",
    content: "ship it",
    user: "michiel",
    sentAt: SENT,
  };

  test("moves a stale idle send to its authoritative queue surface", () => {
    expect(markPendingBusy([delivered], delivered, "queue")).toEqual([
      { ...delivered, busyMode: "queue" },
    ]);
  });

  test("restores a queued row if an early admission echo claimed it", () => {
    expect(markPendingBusy([], delivered, "steer")).toEqual([
      { ...delivered, busyMode: "steer" },
    ]);
  });
});

describe("reconcilePending", () => {
  test("the durable prompt id claims its bubble despite normalized content", () => {
    const { landed } = reconcilePending(
      [bubble("outbox-a", "raw prompt with hidden context")],
      [
        {
          id: "a",
          ...entry("visible prompt after server normalization", SENT - 60_000),
        },
      ],
      [],
      SENT,
    );
    expect([...landed]).toEqual(["outbox-a"]);
  });

  test("one batched transcript entry claims every source message by identity", () => {
    const { landed } = reconcilePending(
      [bubble("outbox-a", "again"), bubble("outbox-b", "again")],
      [
        {
          id: "batch-entry",
          ...entry("normalized batch", SENT - 60_000),
          sourceMessageIds: ["a", "b"],
        },
      ],
      [],
      SENT,
    );
    expect([...landed]).toEqual(["outbox-a", "outbox-b"]);
  });

  test("a transcript user entry claims its bubble as landed", () => {
    const { landed, expired } = reconcilePending(
      [bubble("outbox-a", "ship it")],
      [entry("ship it")],
      [],
      SENT,
    );
    expect([...landed]).toEqual(["outbox-a"]);
    expect(expired.size).toBe(0);
  });

  test("an authoritative queue or steer echo claims its busy row", () => {
    const { landed } = reconcilePending(
      [{ ...bubble("outbox-a", "ship it"), busyMode: "queue" }],
      [],
      [{ id: "a", content: "ship it" }],
      SENT,
    );
    expect([...landed]).toEqual(["outbox-a"]);
  });

  test("a transient admission echo does not claim an idle outbox bubble", () => {
    const { landed } = reconcilePending(
      [bubble("outbox-a", "ship it")],
      [],
      [{ id: "a", content: "ship it" }],
      SENT,
    );
    expect(landed.size).toBe(0);
  });

  test("a transient queue echo does not claim a server-started bubble", () => {
    const { landed } = reconcilePending(
      [{ ...bubble("outbox-a", "ship it"), serverStarted: true }],
      [],
      [{ content: "ship it" }],
      SENT,
    );
    expect(landed.size).toBe(0);
  });

  test("the transcript still claims a server-started bubble", () => {
    const { landed } = reconcilePending(
      [{ ...bubble("outbox-a", "ship it"), serverStarted: true }],
      [entry("ship it")],
      [{ content: "ship it" }],
      SENT,
    );
    expect([...landed]).toEqual(["outbox-a"]);
  });

  test("claims are one-to-one: one entry cannot claim two identical bubbles", () => {
    const { landed } = reconcilePending(
      [bubble("outbox-a", "again"), bubble("outbox-b", "again")],
      [entry("again")],
      [],
      SENT,
    );
    expect(landed.size).toBe(1);
  });

  test("the server's attribution prefix still claims the raw bubble", () => {
    const { landed } = reconcilePending(
      [bubble("outbox-a", "ship it", "michiel")],
      [entry("[michiel] ship it")],
      [],
      SENT,
    );
    expect([...landed]).toEqual(["outbox-a"]);
  });

  test("co-released steers joined into one turn claim every bubble", () => {
    const { landed } = reconcilePending(
      [
        bubble("outbox-a", "first", "michiel"),
        bubble("outbox-b", "second", "michiel"),
      ],
      [entry("[michiel] first\n\n[michiel] second")],
      [],
      SENT,
    );
    expect(landed.size).toBe(2);
  });

  test("an entry recorded well before the send does not claim it", () => {
    const { landed } = reconcilePending(
      [bubble("outbox-a", "ship it")],
      [entry("ship it", SENT - 60_000)],
      [],
      SENT,
    );
    expect(landed.size).toBe(0);
  });

  test("an unclaimed bubble expires rather than landing", () => {
    const { landed, expired } = reconcilePending(
      [bubble("outbox-a", "ship it")],
      [],
      [],
      SENT + PENDING_GIVE_UP_MS,
    );
    expect(landed.size).toBe(0);
    expect([...expired]).toEqual(["outbox-a"]);
  });

  test("a young unclaimed bubble is neither landed nor expired", () => {
    const { landed, expired } = reconcilePending(
      [bubble("outbox-a", "ship it")],
      [],
      [],
      SENT + 1_000,
    );
    expect(landed.size).toBe(0);
    expect(expired.size).toBe(0);
  });

  test("non-user entries never claim a bubble", () => {
    const { landed } = reconcilePending(
      [bubble("outbox-a", "ship it")],
      [
        {
          type: "assistant",
          content: "ship it",
          timestamp: new Date(SENT).toISOString(),
        },
      ],
      [],
      SENT,
    );
    expect(landed.size).toBe(0);
  });
});
