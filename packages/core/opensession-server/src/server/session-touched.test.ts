import { describe, expect, test } from "bun:test";
import {
  TOUCHED_CACHE_MAX_ENTRIES,
  __clearTouchedCacheForTest,
  __touchedCacheSizeForTest,
  sessionTouchedPaths,
} from "./session-touched";

describe("session touched-paths cache", () => {
  test("does not keep an entry for every session ever polled", async () => {
    __clearTouchedCacheForTest();
    for (let i = 0; i < TOUCHED_CACHE_MAX_ENTRIES + 50; i++)
      await sessionTouchedPaths(
        {
          id: `session-${i}`,
          transcriptPath: `/nonexistent/session-${i}.jsonl`,
        },
        "/worktrees/acme",
      );
    expect(__touchedCacheSizeForTest()).toBe(TOUCHED_CACHE_MAX_ENTRIES);
    __clearTouchedCacheForTest();
  });
});
