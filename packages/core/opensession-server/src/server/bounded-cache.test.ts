import { describe, expect, test } from "bun:test";
import { PR_DIFF_CACHE_LIMITS, pruneWhere, setBounded } from "./bounded-cache";

describe("setBounded", () => {
  test("evicts the least recently written entries past maxEntries", () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 5; i++) setBounded(map, `k${i}`, i, { maxEntries: 3 });
    expect([...map.keys()]).toEqual(["k2", "k3", "k4"]);
    // Rewriting an old key makes it the newest, so it survives the next write.
    setBounded(map, "k2", 20, { maxEntries: 3 });
    setBounded(map, "k5", 5, { maxEntries: 3 });
    expect([...map.keys()]).toEqual(["k4", "k2", "k5"]);
  });

  test("evicts by total weight and never drops the entry just written", () => {
    const map = new Map<string, string>();
    const limits = {
      maxEntries: 100,
      maxWeight: 10,
      weigh: (v: string) => v.length,
    };
    setBounded(map, "a", "xxxx", limits);
    setBounded(map, "b", "xxxx", limits);
    setBounded(map, "c", "xxxx", limits);
    expect([...map.keys()]).toEqual(["b", "c"]);
    setBounded(map, "huge", "x".repeat(50), limits);
    expect([...map.keys()]).toEqual(["huge"]);
  });

  test("a thousand distinct PR diffs stay within the diff cache budget", () => {
    const map = new Map<
      string,
      { data: { patch: string } | null; ts: number }
    >();
    const patch = "+".repeat(1024 * 1024);
    for (let i = 0; i < 1000; i++)
      setBounded(
        map,
        `repo\0branch-${i}`,
        { data: { patch }, ts: i },
        PR_DIFF_CACHE_LIMITS,
      );
    let chars = 0;
    for (const entry of map.values()) chars += entry.data?.patch.length ?? 0;
    expect(map.size).toBeLessThanOrEqual(PR_DIFF_CACHE_LIMITS.maxEntries);
    expect(chars).toBeLessThanOrEqual(PR_DIFF_CACHE_LIMITS.maxWeight);
    expect(map.has("repo\0branch-999")).toBe(true);
  });
});

describe("pruneWhere", () => {
  test("drops only expired entries", () => {
    const map = new Map([
      ["old", 1],
      ["new", 10],
    ]);
    pruneWhere(map, (at) => at < 5);
    expect([...map.keys()]).toEqual(["new"]);
  });
});
