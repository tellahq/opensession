import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bulk sweep's staleness rules are pure bookkeeping over the host's
// answers, so these tests drive the real refresh with a stubbed PrHost:
// prHostFor() hands back the githubPrHost object itself, so replacing its
// methods reaches the sweep without mocking a module for the whole test run.
let stateDir: string;
let priorStateDir: string | undefined;
let priorConfig: string | undefined;
let priorGhBackoff: number | undefined;
let openPrsByRepo = new Map<string, any[] | null>();
let onListOpenPrs: ((ghRepo: string) => void | Promise<void>) | undefined;
let priorHost: Record<string, unknown> = {};

const REPO_A = "tellahq/pr-cache-authority";
const REPO_B = "tellahq/pr-cache-inflight";

beforeAll(async () => {
  stateDir = join(tmpdir(), `opensession-pr-cache-test-${crypto.randomUUID()}`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({
      repos: {
        prCacheA: { repo: process.cwd(), ghRepo: REPO_A, label: "A" },
        prCacheB: { repo: process.cwd(), ghRepo: REPO_B, label: "B" },
      },
    }),
  );
  // Keep every write (the snapshot after a sweep) inside the scratch root.
  priorStateDir = process.env.OPENSESSION_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = stateDir;
  priorConfig = process.env.OPENSESSION_CONFIG;
  process.env.OPENSESSION_CONFIG = join(stateDir, "config.json");
  // Another test file may have parked a backoff; the sweep must run.
  priorGhBackoff = (
    await import("../../packages/core/opensession-server/src/server/github-limit")
  ).__setGhBackoffForTest(0);
  const host = (
    await import("../../packages/core/opensession-server/src/server/pr-host")
  ).githubPrHost as any;
  for (const method of ["listOpenPrs", "listRecentPrs", "changedSince"])
    priorHost[method] = host[method];
  // Default null: a repo no test set up must never become authoritative, or
  // its 10-minute coalescing window makes the NEXT sweep skip its open query.
  host.listOpenPrs = async (ghRepo: string) => {
    await onListOpenPrs?.(ghRepo);
    return openPrsByRepo.get(ghRepo) ?? null;
  };
  host.listRecentPrs = async () => [];
  host.changedSince = async () => ({ changed: true });
});

afterAll(async () => {
  const host = (
    await import("../../packages/core/opensession-server/src/server/pr-host")
  ).githubPrHost as any;
  for (const [method, fn] of Object.entries(priorHost)) host[method] = fn;
  if (priorGhBackoff !== undefined)
    (
      await import("../../packages/core/opensession-server/src/server/github-limit")
    ).__setGhBackoffForTest(priorGhBackoff);
  if (priorStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = priorStateDir;
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = priorConfig;
  rmSync(stateDir, { recursive: true, force: true });
});

function prPayload(
  number: number,
  branch: string,
  extra: Record<string, unknown> = {},
): any {
  return {
    pull_request: {
      number,
      html_url: `https://github.com/x/y/pull/${number}`,
      title: `PR ${number}`,
      state: "open",
      draft: false,
      head: { ref: branch },
      user: { login: "someone" },
      created_at: "2026-08-16T10:00:00Z",
      updated_at: "2026-08-16T10:00:00Z",
      ...extra,
    },
  };
}

function bulkOpenPr(number: number, branch: string): any {
  return {
    url: `https://github.com/x/y/pull/${number}`,
    state: "OPEN",
    number,
    title: `PR ${number}`,
    isDraft: false,
    headRefName: branch,
    author: { login: "someone" },
    createdAt: "2026-08-16T10:00:00Z",
    updatedAt: "2026-08-16T10:00:00Z",
    reviewRequests: [],
    latestReviews: [],
    assignees: [],
  };
}

describe("PR bulk cache staleness rules", () => {
  it("keeps a pending merge overlay when the sweep never queried that repo", async () => {
    const prCache =
      await import("../../packages/core/opensession-server/src/server/pr-cache");
    // Prime the cache timestamp first: getPrsByRepo is stale-while-revalidate,
    // so an unprimed read would fire its own sweep underneath the assertions.
    openPrsByRepo.set(REPO_A, null);
    await prCache.refreshPrCache();
    // Seed an open row without a sweep, so no repo is ever authoritative here.
    prCache.applyPrWebhookToBulkCache(
      REPO_A,
      "pull_request",
      prPayload(11, "feat-a"),
    );
    prCache.markCachedPrMerged(REPO_A, "feat-a");
    expect(prCache.getPrsByRepo().get("prCacheA")?.get("feat-a")?.state).toBe(
      "MERGED",
    );

    // A sweep that could not read this repo's open list is not authoritative
    // over it, so it must not retire the merge overlay.
    openPrsByRepo.set(REPO_A, null);
    await prCache.refreshPrCache();

    // An out-of-order delivery (queued before the merge) re-opens the row.
    prCache.applyPrWebhookToBulkCache(
      REPO_A,
      "pull_request",
      prPayload(11, "feat-a"),
    );
    openPrsByRepo.set(REPO_A, null);
    await prCache.refreshPrCache();
    expect(prCache.getPrsByRepo().get("prCacheA")?.get("feat-a")?.state).toBe(
      "MERGED",
    );
  });

  it("does not revert a webhook merge with data a sweep fetched before it", async () => {
    const prCache =
      await import("../../packages/core/opensession-server/src/server/pr-cache");
    prCache.applyPrWebhookToBulkCache(
      REPO_B,
      "pull_request",
      prPayload(22, "feat-b"),
    );
    // The sweep reads the open list (PR still open there), and only then does
    // the merge webhook land. The write-through has to register an overlay or
    // this in-flight sweep silently reverts it.
    openPrsByRepo.set(REPO_B, [bulkOpenPr(22, "feat-b")]);
    onListOpenPrs = (ghRepo) => {
      if (ghRepo !== REPO_B) return;
      onListOpenPrs = undefined;
      prCache.applyPrWebhookToBulkCache(
        REPO_B,
        "pull_request",
        prPayload(22, "feat-b", {
          state: "closed",
          merged: true,
          merged_at: "2026-08-16T11:00:00Z",
        }),
      );
    };
    await prCache.refreshPrCache();
    expect(prCache.getPrsByRepo().get("prCacheB")?.get("feat-b")?.state).toBe(
      "MERGED",
    );
  });
});
