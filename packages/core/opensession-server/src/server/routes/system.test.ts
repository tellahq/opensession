import { describe, expect, test } from "bun:test";
import { __deadLettersCachesForTest, deadLettersSnapshot } from "./system";

describe("dead letters snapshot cache", () => {
  test("serves the retained snapshot when a later refresh fails", async () => {
    __deadLettersCachesForTest().clear();
    let calls = 0;
    let fail = false;
    const load = () => {
      calls += 1;
      if (fail) throw new Error("actor unavailable");
      return { totals: { outbox: 1 }, page: calls };
    };
    const first = await deadLettersSnapshot(100, 0, load);
    expect(first).toEqual({ totals: { outbox: 1 }, page: 1 });

    // Expire the TTL, then make the actor fail: the last good snapshot is
    // served instead of propagating the error.
    const entry = __deadLettersCachesForTest().get("100:0")!;
    entry.at -= 10_000;
    fail = true;
    await expect(deadLettersSnapshot(100, 0, load)).resolves.toEqual({
      totals: { outbox: 1 },
      page: 1,
    });
  });

  test("keys snapshots by pagination arguments", async () => {
    __deadLettersCachesForTest().clear();
    const load = (_limit: number, offset: number) => ({ offset });
    await expect(deadLettersSnapshot(100, 0, load)).resolves.toEqual({
      offset: 0,
    });
    await expect(deadLettersSnapshot(100, 50, load)).resolves.toEqual({
      offset: 50,
    });
  });

  test("single-flights concurrent refreshes and rate-limits failures", async () => {
    __deadLettersCachesForTest().clear();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = () => {
      calls += 1;
      return gate.then(() => ({ call: calls }));
    };
    const a = deadLettersSnapshot(10, 0, load);
    const b = deadLettersSnapshot(10, 0, load);
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);

    // A failing refresh with no retained value throws but blocks immediate
    // retry hammering until the TTL window passes.
    await expect(
      deadLettersSnapshot(20, 0, () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    const atAfterFailure = __deadLettersCachesForTest().get("20:0")!.at;
    await expect(
      deadLettersSnapshot(20, 0, () => ({ recovered: true })),
    ).rejects.toThrow("down");
    expect(__deadLettersCachesForTest().get("20:0")!.at).toBe(atAfterFailure);

    // After the failure window a refresh succeeds again.
    const entry = __deadLettersCachesForTest().get("20:0")!;
    entry.at -= 10_000;
    await expect(
      deadLettersSnapshot(20, 0, () => ({ recovered: true })),
    ).resolves.toEqual({ recovered: true });
  });
});
