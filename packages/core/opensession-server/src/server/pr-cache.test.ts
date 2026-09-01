import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrInfo } from "./pr-cache";

let stateRoot: string;
let priorStateDir: string | undefined;
let priorConfig: string | undefined;

// A ghRepo no other config in the suite carries: the close/merge tombstones
// live on globalThis and are shared with every other test file in the process.
const GH_REPO = "tellahq/pr-cache-merge-test";

beforeAll(() => {
  stateRoot = join(
    tmpdir(),
    `opensession-pr-cache-test-${crypto.randomUUID()}`,
  );
  mkdirSync(stateRoot, { recursive: true });
  // prRepos() filters out repos without a ghRepo, so the merge mark can only
  // resolve a repo id when one is configured. OPENSESSION_CONFIG is re-read
  // per call, so this reaches pr-cache even if another file loaded it first.
  writeFileSync(
    join(stateRoot, "config.json"),
    JSON.stringify({
      repos: {
        prcachetest: {
          repo: "/home/ubuntu/projects/opensession",
          ghRepo: GH_REPO,
          label: "PR cache test",
        },
      },
    }),
  );
  priorConfig = process.env.OPENSESSION_CONFIG;
  process.env.OPENSESSION_CONFIG = join(stateRoot, "config.json");
  priorStateDir = process.env.OPENSESSION_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = stateRoot;
});

afterAll(() => {
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = priorConfig;
  if (priorStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = priorStateDir;
  // Tombstones are parked on globalThis — drop this file's before another
  // test file's sweep sees them.
  const closeState = (globalThis as any).__opensessionPrCloseState;
  for (const key of [...(closeState?.merged?.keys() || [])])
    if (String(key).startsWith(GH_REPO)) closeState.merged.delete(key);
  rmSync(stateRoot, { recursive: true, force: true });
});

function openRow(number: number, branch: string): PrInfo {
  return {
    url: `https://github.com/${GH_REPO}/pull/${number}`,
    state: "OPEN",
    number,
    title: `PR ${branch}`,
    isDraft: true,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "",
    author: "jfrolich",
    createdAt: "2026-08-16T09:00:00.000Z",
    updatedAt: "2026-08-16T09:00:00.000Z",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "MERGEABLE",
    reviewRequested: [],
    reviewedBy: [],
    assignees: [],
  };
}

describe("markCachedPrMerged", () => {
  it("still applies on the next sweep when the cache had no row for the branch", async () => {
    const prCache = await import("./pr-cache");
    const closeState = (globalThis as any).__opensessionPrCloseState;
    // The generation an in-flight sweep would have captured before the merge:
    // its pre-merge OPEN row must not win.
    const refreshGeneration = closeState.generation;

    // No cached row for this branch — the stack-merge case, where the layer
    // belongs to another session and was never swept into this cache.
    prCache.markCachedPrMerged(GH_REPO, "stack-layer-2");

    const swept = new Map([
      [
        "prcachetest",
        new Map([["stack-layer-2", openRow(777, "stack-layer-2")]]),
      ],
    ]);
    prCache.__applyPrCloseTombstonesForTest(swept, refreshGeneration);

    const row = swept.get("prcachetest")?.get("stack-layer-2");
    expect(row?.state).toBe("MERGED");
    expect(row?.isDraft).toBe(false);
  });

  it("lets a sweep that started after the merge clear the tombstone", async () => {
    const prCache = await import("./pr-cache");
    const closeState = (globalThis as any).__opensessionPrCloseState;

    prCache.markCachedPrMerged(GH_REPO, "stack-layer-3");
    // A sweep begun after the mark is authoritative: it saw GitHub's own
    // answer, so the overlay is dropped rather than pinning the row forever.
    const refreshGeneration = closeState.generation;

    const swept = new Map([
      [
        "prcachetest",
        new Map([["stack-layer-3", openRow(778, "stack-layer-3")]]),
      ],
    ]);
    // Authoritative: the sweep actually re-queried this repo, so the overlay
    // may be dropped. A sweep that skipped the repo keeps it (covered in
    // pr-cache-staleness.test.ts).
    prCache.__applyPrCloseTombstonesForTest(
      swept,
      refreshGeneration,
      new Set(["prcachetest"]),
    );

    expect(swept.get("prcachetest")?.get("stack-layer-3")?.state).toBe("OPEN");
  });
});
