import { expect, test } from "bun:test";
import {
  advanceSessionListResponseRevision,
  buildAtCurrentSessionListRevision,
  sessionListResponseRevision,
} from "./session-list-response-revision";

test("returns the first response when no session mutation overlaps it", async () => {
  let builds = 0;

  const result = await buildAtCurrentSessionListRevision(async () => ++builds);

  expect(result.value).toBe(1);
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

  expect(result.value).toBe(2);
  expect(builds).toBe(2);
});

test("continuous mutations return after two builds with a stale revision", async () => {
  let builds = 0;
  const result = await buildAtCurrentSessionListRevision(async () => {
    builds++;
    // A finite guard also makes the old unbounded implementation fail rather
    // than hanging the test process.
    if (builds > 2) throw new Error("unbounded response rebuild");
    advanceSessionListResponseRevision();
    return builds;
  });
  expect(builds).toBe(2);
  expect(result.value).toBe(2);
  expect(result.revision).toBeLessThan(sessionListResponseRevision());
});

test("a failed build propagates without a retry loop", async () => {
  let builds = 0;
  await expect(
    buildAtCurrentSessionListRevision(async () => {
      builds++;
      throw new Error("catalog unavailable");
    }),
  ).rejects.toThrow("catalog unavailable");
  expect(builds).toBe(1);
});
