/**
 * The list and sidebar routes serve rows out of the session-list index, and
 * those rows already carry the registry overlays (generated title, rename,
 * manual lane, review request) resolved when they were projected. Reading
 * the registries again per row would put synchronous file stats back on the
 * hot list path, so this pins that a list response and a row publish never
 * call a registry getter. The writers' side of the contract, that every
 * setter republishes its row, is sessions-overlay-publish.test.ts.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedSession } from "../types";

const registryReads = {
  generatedTitle: 0,
  titleOverride: 0,
  statusOverride: 0,
  reviewRequest: 0,
};

// Replace the registries before the route module and its graph load, so a
// getter reached from any path counts. Every named export stays present.
mock.module("../generated-titles", () => ({
  getGeneratedTitle: () => {
    registryReads.generatedTitle++;
    return undefined;
  },
  ensureGeneratedTitle: async () => null,
  startGeneratedTitleSweep: () => {},
}));
mock.module("../title-overrides", () => ({
  getTitleOverride: () => {
    registryReads.titleOverride++;
    return undefined;
  },
  setTitleOverride: () => {},
}));
mock.module("../status-overrides", () => ({
  isManualStatus: (value: unknown) => typeof value === "string",
  getStatusOverride: () => {
    registryReads.statusOverride++;
    return undefined;
  },
  setStatusOverride: () => {},
}));
mock.module("../review-requests", () => ({
  getReviewRequest: () => {
    registryReads.reviewRequest++;
    return undefined;
  },
  setReviewRequest: () => {},
  setReviewAccepted: () => {},
}));

const home = join(tmpdir(), `sessions-indexed-overlays-${crypto.randomUUID()}`);
const sessionsDir = join(home, ".opensession-sessions");
const prior = {
  home: process.env.HOME,
  stateDir: process.env.OPENSESSION_STATE_DIR,
  config: process.env.OPENSESSION_CONFIG,
};
let priorSessionsDir: string | undefined;
let priorStore: unknown;
let priorGhBackoff: number | undefined;

const stored: UnifiedSession = {
  id: "os-stored",
  source: "opensession",
  branch: null,
  worktreeDir: null,
  createdBy: "Ada",
  startedBy: "Ada",
  title: "Stored title",
  titleOverridden: true,
  manualStatus: "review",
  reviewRequest: { to: "Bob", by: "Ada", at: "2026-09-01T00:00:00.000Z" },
  lastActivity: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  isRunning: false,
  transcriptPath: null,
} as UnifiedSession;

function totalReads(): number {
  return Object.values(registryReads).reduce((sum, count) => sum + count, 0);
}

beforeAll(async () => {
  mkdirSync(sessionsDir, { recursive: true });
  // The route graph needs one registered repo at load; the PR cache must
  // never reach `gh` from here, so the GitHub gate is closed for the file.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      repos: {
        opensession: {
          repo: "/home/ubuntu/projects/opensession",
          ghRepo: "tellahq/opensession",
          label: "Open Session",
        },
      },
    }),
  );
  process.env.HOME = home;
  process.env.OPENSESSION_STATE_DIR = home;
  process.env.OPENSESSION_CONFIG = join(home, "config.json");
  priorGhBackoff = (await import("../github-limit")).__setGhBackoffForTest(
    Date.now() + 60 * 60 * 1000,
  );
  priorSessionsDir = (await import("../paths")).__setSessionsDirForTest(
    sessionsDir,
  );
  const { SessionListStore, __setSessionListStoreForTest } =
    await import("../session-list-store");
  priorStore = __setSessionListStoreForTest(new SessionListStore(":memory:"));
  const { upsertIndexedSessions } = await import("../session-list-store");
  await upsertIndexedSessions([stored], "exclude");
});

afterAll(async () => {
  const { __setSessionListStoreForTest } =
    await import("../session-list-store");
  __setSessionListStoreForTest(
    priorStore as Parameters<typeof __setSessionListStoreForTest>[0],
  );
  if (priorSessionsDir !== undefined)
    (await import("../paths")).__setSessionsDirForTest(priorSessionsDir);
  if (priorGhBackoff !== undefined)
    (await import("../github-limit")).__setGhBackoffForTest(priorGhBackoff);
  for (const [key, value] of [
    ["HOME", prior.home],
    ["OPENSESSION_STATE_DIR", prior.stateDir],
    ["OPENSESSION_CONFIG", prior.config],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("indexed list rows keep their stored overlays", () => {
  test("the sidebar list serves the stored overlays without a registry read", async () => {
    const { handleSessionsRoutes } = await import("./sessions");
    const path = "/api/sessions";
    const url = new URL(`http://localhost${path}?archived=exclude`);
    const before = totalReads();
    const response = await handleSessionsRoutes({
      req: new Request(url),
      url,
      path,
      publicPrefix: "/opensession",
    });
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as unknown;
    const rows = (
      Array.isArray(body) ? body : (body as { sessions: unknown[] }).sessions
    ) as UnifiedSession[];
    const row = rows.find((candidate) => candidate.id === stored.id);
    expect(row).toMatchObject({
      title: "Stored title",
      titleOverridden: true,
      manualStatus: "review",
      reviewRequest: { to: "Bob", by: "Ada" },
    });
    expect(totalReads() - before).toBe(0);
  });

  test("a row publish serves the stored overlays without a registry read", async () => {
    const { sidebarRowProjection } = await import("./sessions");
    const before = totalReads();
    const { row } = await sidebarRowProjection(stored, [stored]);
    expect(row).toMatchObject({
      title: "Stored title",
      titleOverridden: true,
      manualStatus: "review",
      reviewRequest: { to: "Bob", by: "Ada" },
    });
    expect(totalReads() - before).toBe(0);
  });

  test("the detail route is the one path that still re-reads the registries", async () => {
    // Also proves the counters above see the route module: a zero there is
    // the list path skipping the getters, not the mocks missing the graph.
    const { sessionDetail } = await import("./sessions");
    const before = totalReads();
    await sessionDetail(stored);
    expect(totalReads() - before).toBeGreaterThan(0);
  });
});
