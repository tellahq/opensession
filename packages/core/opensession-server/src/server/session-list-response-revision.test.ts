import { describe, expect, test } from "bun:test";
import {
  advanceSessionListResponseRevision,
  buildAtCurrentSessionListRevision,
  buildForSessionListRevision,
} from "./session-list-response-revision";

test("returns the first response when no session mutation overlaps it", async () => {
  let builds = 0;

  const result = await buildAtCurrentSessionListRevision(async () => ++builds);

  expect(result).toBe(1);
  expect(builds).toBe(1);
});

test("rebuilds a response invalidated while it is in flight", async () => {
  let builds = 0;

  const result = await buildAtCurrentSessionListRevision(async () => {
    builds++;
    if (builds === 1) advanceSessionListResponseRevision();
    await Promise.resolve();
    return builds;
  });

  expect(result).toBe(2);
  expect(builds).toBe(2);
});

test("answers with the newest build when every build overlaps a mutation", async () => {
  let builds = 0;

  const result = await buildAtCurrentSessionListRevision(async () => {
    builds++;
    advanceSessionListResponseRevision();
    await Promise.resolve();
    return builds;
  });

  expect(result).toBe(3);
  expect(builds).toBe(3);
});

describe("buildForSessionListRevision", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  test("builds once when a mutation lands mid-build", async () => {
    const slots = new Map();
    let builds = 0;
    const result = await buildForSessionListRevision(slots, "k", async () => {
      builds++;
      advanceSessionListResponseRevision();
      await Promise.resolve();
      return builds;
    });
    expect(result).toBe(1);
    expect(builds).toBe(1);
    expect(slots.size).toBe(0);
  });

  test("a caller with no newer mutation shares the running build", async () => {
    const slots = new Map();
    const gate = deferred<void>();
    let builds = 0;
    const build = async () => {
      builds++;
      await gate.promise;
      return builds;
    };
    const first = buildForSessionListRevision(slots, "k", build);
    const second = buildForSessionListRevision(slots, "k", build);
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(builds).toBe(1);
  });

  test("a caller after a mutation waits for one newer build, shared by later callers", async () => {
    const slots = new Map();
    const gates = [deferred<void>(), deferred<void>()];
    const started: number[] = [];
    const build = async (revision: number) => {
      started.push(revision);
      await gates[started.length - 1]!.promise;
      return started.length;
    };
    const first = buildForSessionListRevision(slots, "k", build);
    advanceSessionListResponseRevision();
    const second = buildForSessionListRevision(slots, "k", build);
    advanceSessionListResponseRevision();
    const third = buildForSessionListRevision(slots, "k", build);
    gates[0]!.resolve();
    expect(await first).toBe(1);
    gates[1]!.resolve();
    expect(await second).toBe(2);
    expect(await third).toBe(2);
    expect(started).toHaveLength(2);
    // The queued build started after both mutations the later callers saw.
    expect(started[1]).toBeGreaterThan(started[0]! + 1);
    expect(slots.size).toBe(0);
  });

  test("keys build independently and a failure releases the slot", async () => {
    const slots = new Map();
    await expect(
      buildForSessionListRevision(slots, "a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(slots.size).toBe(0);
    expect(await buildForSessionListRevision(slots, "a", async () => 7)).toBe(
      7,
    );
  });
});
