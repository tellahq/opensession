import { expect, test } from "bun:test";
import {
  advanceSessionListResponseRevision,
  buildAtCurrentSessionListRevision,
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
