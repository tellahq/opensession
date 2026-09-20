import { describe, expect, test } from "bun:test";
import { createHostMetricsReader } from "./system-stats";

// Drain only promise continuations, not elapsed wall-clock time.
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("health metrics snapshots", () => {
  test("a wedged census never holds health reads or starts overlapping scans", async () => {
    let calls = 0;
    let resolve!: (value: Record<string, unknown>) => void;
    const read = createHostMetricsReader(() => {
      calls++;
      return new Promise((done) => (resolve = done));
    });
    const initial = read();
    expect(calls).toBe(0);
    expect(initial.error).toBe("Host metrics are warming up");
    await flush();
    for (let i = 0; i < 100; i++) expect(read()).toBe(initial);
    expect(calls).toBe(1);
    resolve({ memory: { availablePct: 80 } });
    await flush();
    expect(read().memory).toEqual({ availablePct: 80 });
    expect(read().collectedAt).toBeString();
  });

  test("serves stale metrics through slow and failed refreshes, then recovers", async () => {
    let now = 0;
    let calls = 0;
    let reject!: (error: Error) => void;
    const read = createHostMetricsReader(
      () => {
        calls++;
        if (calls === 2) return new Promise((_, fail) => (reject = fail));
        return Promise.resolve({ sample: calls });
      },
      () => now,
    );
    read();
    await flush();
    expect(read().sample).toBe(1);
    now = 4_999;
    read();
    await flush();
    expect(calls).toBe(1);
    now = 5_000;
    expect(read().sample).toBe(1);
    await flush();
    now = 100_000;
    expect(read().sample).toBe(1);
    expect(calls).toBe(2);
    reject(new Error("census unavailable"));
    await flush();
    expect(read()).toMatchObject({
      sample: 1,
      refreshError: "Error: census unavailable",
    });
    now += 5_000;
    read();
    await flush();
    expect(read().sample).toBe(3);
    expect(read().refreshError).toBeUndefined();
  });

  test("host metric collection has no synchronous filesystem or subprocess I/O", async () => {
    const source = await Bun.file(
      new URL("./system-stats.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(
      /\b(?:readFile|readdir|statfs|stat|spawn|execFile|exec)Sync\b/,
    );
  });
});
