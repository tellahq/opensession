import { describe, expect, test } from "bun:test";
import {
  FILE_INDEX_MAX_DIRS,
  __fileIndexCacheForTest,
  searchRepoEntries,
} from "./file-index";
import { readMemoryProbes } from "./memory-probes";
import type { WorkspaceExec } from "./sandbox/workspace-exec";

function fakeExec(files: string[]): WorkspaceExec {
  const exec = async () => ({
    exitCode: 0,
    stdout: files.join("\0"),
    stderr: "",
  });
  return Object.assign(exec, { sandboxed: true, remote: true }) as never;
}

describe("file index cache", () => {
  test("keeps file lists for a bounded number of checkouts", async () => {
    const cache = __fileIndexCacheForTest();
    cache.clear();
    const exec = fakeExec(["src/a.ts", "src/b.ts", "README.md"]);
    // One worktree per session: before the bound, every checkout whose
    // composer ever used "@" kept its whole file list for the process life.
    for (let i = 0; i < FILE_INDEX_MAX_DIRS * 4; i++)
      await searchRepoEntries(`/worktrees/session-${i}`, "a", 5, exec);
    expect(cache.size).toBe(FILE_INDEX_MAX_DIRS);
    const last = `/worktrees/session-${FILE_INDEX_MAX_DIRS * 4 - 1}`;
    expect(cache.has(last)).toBe(true);
    expect(cache.has("/worktrees/session-0")).toBe(false);
    expect(readMemoryProbes()["file-index.cache"]).toMatchObject({
      dirs: FILE_INDEX_MAX_DIRS,
    });
  });

  test("still answers the query that loaded a checkout", async () => {
    __fileIndexCacheForTest().clear();
    const entries = await searchRepoEntries(
      "/worktrees/one",
      "b.ts",
      5,
      fakeExec(["src/a.ts", "src/b.ts"]),
    );
    expect(entries[0]).toEqual({ path: "src/b.ts" });
  });

  test("drops checkouts unused for longer than the retention window", async () => {
    const cache = __fileIndexCacheForTest();
    cache.clear();
    cache.set("/worktrees/stale", {
      files: ["x"],
      dirs: [],
      at: performance.now() - 60 * 60_000,
    });
    await searchRepoEntries("/worktrees/fresh", "", 5, fakeExec(["y"]));
    expect([...cache.keys()]).toEqual(["/worktrees/fresh"]);
  });
});
