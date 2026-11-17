import { afterEach, describe, expect, test } from "bun:test";
import { SessionKernelActorClient } from "./actor-client";
import type { ModelUsageRecord } from "./usage-protocol";

let client: SessionKernelActorClient | undefined;
afterEach(() => {
  client?.terminate();
  client = undefined;
});

async function actor(): Promise<SessionKernelActorClient> {
  const worker = new Worker(
    new URL("../../session-kernel-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  client = new SessionKernelActorClient(worker);
  await client.hello();
  return client;
}

// `expect(promise).rejects` does not pump Worker messages in bun test.
async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the actor to reject");
}

/** Each test reads its own far-off day, so tests sharing one actor database
 * never see each other's rows. */
function day(): { date: string; at: (hour: number) => number } {
  const offset = Math.floor(Math.random() * 300_000);
  const date = new Date(Date.UTC(2200, 0, 1) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    date,
    at: (hour) => Date.parse(`${date}T00:00:00Z`) + hour * 3_600_000,
  };
}

function record(
  attemptId: string,
  seq: number,
  at: number,
  model = "claude-opus-5",
  output = 10,
): ModelUsageRecord {
  return {
    attemptId,
    seq,
    at,
    model,
    input: 1,
    output,
    cacheRead: 100,
    cacheWrite: 5,
    costUsd: 0.25,
  };
}

describe("actor-owned model usage", () => {
  test("counts a session's requests once per day and model and projects them", async () => {
    const host = await actor();
    const { date, at } = day();
    const sessionId = `os-usage-${crypto.randomUUID()}`;
    const attempt = crypto.randomUUID();
    const batch = [
      record(attempt, 2, at(2), "gpt-6.2-sol", 4),
      record(attempt, 1, at(1)),
      record(attempt, 3, at(3)),
    ];

    expect(
      await host.decideUsageAsync({ op: "record", sessionId, records: batch }),
    ).toBe(3);
    // A host reattach re-sends its history: nothing is counted twice, and the
    // next request in the attempt still counts.
    expect(
      await host.decideUsageAsync({
        op: "record",
        sessionId,
        records: [...batch, record(attempt, 4, at(4))],
      }),
    ).toBe(1);

    const rows = await host.decideUsageAsync({ op: "day", date });
    expect(rows).toEqual([
      {
        sessionId,
        model: "claude-opus-5",
        requests: 3,
        input: 3,
        output: 30,
        cacheRead: 300,
        cacheWrite: 15,
        costUsd: 0.75,
      },
      {
        sessionId,
        model: "gpt-6.2-sol",
        requests: 1,
        input: 1,
        output: 4,
        cacheRead: 100,
        cacheWrite: 5,
        costUsd: 0.25,
      },
    ]);
  });

  test("splits requests across UTC days", async () => {
    const host = await actor();
    const { date, at } = day();
    const sessionId = `os-usage-${crypto.randomUUID()}`;
    const attempt = crypto.randomUUID();
    await host.decideUsageAsync({
      op: "record",
      sessionId,
      records: [record(attempt, 1, at(23)), record(attempt, 2, at(25))],
    });
    const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(
      (await host.decideUsageAsync({ op: "day", date })).map(
        (row) => row.requests,
      ),
    ).toEqual([1]);
    expect(
      (await host.decideUsageAsync({ op: "day", date: next })).map(
        (row) => row.requests,
      ),
    ).toEqual([1]);
  });

  test("counts usage no session owns in the catalog, once", async () => {
    const host = await actor();
    const { date, at } = day();
    const attempt = crypto.randomUUID();
    const records = [record(attempt, 1, at(1)), record(attempt, 2, at(2))];
    expect(
      await host.decideUsageAsync({ op: "record_unowned", label: "", records }),
    ).toBe(2);
    expect(
      await host.decideUsageAsync({ op: "record_unowned", label: "", records }),
    ).toBe(0);
    expect(await host.decideUsageAsync({ op: "day", date })).toEqual([
      expect.objectContaining({ sessionId: "", requests: 2, output: 20 }),
    ]);
  });

  test("a deleted session's late usage is still counted under its id", async () => {
    const host = await actor();
    const { date, at } = day();
    const sessionId = `os-usage-deleted-${crypto.randomUUID()}`;
    const attempt = crypto.randomUUID();
    await host.decideUsageAsync({
      op: "record",
      sessionId,
      records: [record(attempt, 1, at(1))],
    });
    await host.decideCoreAsync({ op: "tombstone", sessionId });
    expect(
      await host.decideUsageAsync({
        op: "record",
        sessionId,
        records: [record(attempt, 1, at(1)), record(attempt, 2, at(2))],
      }),
    ).toBeGreaterThanOrEqual(1);
    const rows = await host.decideUsageAsync({ op: "day", date });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId });
    expect(rows[0]!.requests).toBeGreaterThanOrEqual(2);
  });

  test("rejects malformed usage without failing the actor", async () => {
    const host = await actor();
    const sessionId = `os-usage-${crypto.randomUUID()}`;
    expect(
      await rejection(
        host.decideUsageAsync({
          op: "record",
          sessionId,
          records: [{ ...record("a", 1, 1), seq: 0 }],
        }),
      ),
    ).toMatch(/sequence/);
    expect(
      await rejection(host.decideUsageAsync({ op: "day", date: "yesterday" })),
    ).toMatch(/date/);
    // The actor keeps serving afterwards.
    expect(
      await host.decideUsageAsync({
        op: "record",
        sessionId,
        records: [record(crypto.randomUUID(), 1, Date.now())],
      }),
    ).toBe(1);
  });
});
