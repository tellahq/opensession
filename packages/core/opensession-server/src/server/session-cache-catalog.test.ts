/**
 * A cold list rebuild reads the metadata catalog once an operator marked it
 * complete, instead of scanning every session file. Runs the metadata facade
 * on the in-process compatibility store with all state under a scratch root.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = join(tmpdir(), `session-cache-catalog-${crypto.randomUUID()}`);
const sessionsDir = join(home, ".opensession-sessions");
const prior = {
  home: process.env.HOME,
  stateDir: process.env.OPENSESSION_STATE_DIR,
  config: process.env.OPENSESSION_CONFIG,
};
let priorSessionsDir: string | undefined;

function sessionDoc(id: string, title: string): string {
  return JSON.stringify({
    id,
    title,
    model: "claude-haiku-4-5",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActivity: "2026-09-01T00:00:00.000Z",
    startedBy: "Ada",
  });
}

beforeAll(async () => {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ repos: {} }));
  process.env.HOME = home;
  process.env.OPENSESSION_STATE_DIR = home;
  process.env.OPENSESSION_CONFIG = join(home, "config.json");
  priorSessionsDir = (await import("./paths")).__setSessionsDirForTest(
    sessionsDir,
  );
});

afterAll(async () => {
  if (priorSessionsDir !== undefined)
    (await import("./paths")).__setSessionsDirForTest(priorSessionsDir);
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

describe("catalog-backed list rebuild", () => {
  test("pages the catalog once it is complete and skips the file scan", async () => {
    const { sessionMetadata } = await import("./session-kernel");
    const { getCachedSessionsAsync, primeSessionListIndex } =
      await import("./session-cache");
    const { indexedSessions } = await import("./session-list-store");

    // A session only the catalog knows, and a file only the directory knows.
    writeFileSync(
      join(sessionsDir, "file-only.json"),
      sessionDoc("file-only", "Only on disk"),
    );
    await sessionMetadata({
      op: "seed_catalog",
      rows: [
        {
          sessionId: "catalog-only",
          doc: sessionDoc("catalog-only", "Only in the catalog"),
          rev: 1,
          archived: false,
          lastActivityMs: Date.parse("2026-09-01T00:00:00.000Z"),
        },
      ],
    });

    // Not complete yet: the rebuild still scans the directory.
    expect(await indexedSessions("include")).toBeNull();
    const scanned = await getCachedSessionsAsync("include");
    expect(scanned.map((s) => s.id)).toEqual(["file-only"]);

    // Complete: a fresh index fills from the catalog and the file is not read.
    const { __setSessionListStoreForTest, SessionListStore } =
      await import("./session-list-store");
    __setSessionListStoreForTest(new SessionListStore(":memory:"));
    const { invalidateSessionsCache } = await import("./session-cache");
    invalidateSessionsCache();
    await sessionMetadata({ op: "mark_catalog_complete" });
    expect(await indexedSessions("include")).toBeNull();

    await primeSessionListIndex();
    const primed = await indexedSessions("include");
    expect(primed?.map((s) => s.id)).toEqual(["catalog-only"]);
    expect(primed?.[0]).toMatchObject({
      title: "Only in the catalog",
      source: "opensession",
    });

    // Priming an index that already has coverage is a no-op.
    await primeSessionListIndex();
    expect((await indexedSessions("include"))?.map((s) => s.id)).toEqual([
      "catalog-only",
    ]);
  });

  test("a detail read serves the committed catalog document, falling back to the file", async () => {
    const { sessionMetadata } = await import("./session-kernel");
    const { readNativeSessionAsync } = await import("./session-cache");

    // The catalog holds a newer document than the derived file.
    writeFileSync(
      join(sessionsDir, "detail.json"),
      sessionDoc("detail", "From the file"),
    );
    const committed = await sessionMetadata({
      op: "put",
      sessionId: "detail",
      requestId: `test:${crypto.randomUUID()}`,
      expectedRev: null,
      rev: 1,
      doc: sessionDoc("detail", "From the catalog"),
      archived: false,
      lastActivityMs: 0,
    });
    expect(committed.status).toBe("committed");
    expect((await readNativeSessionAsync("detail"))?.title).toBe(
      "From the catalog",
    );

    // No catalog row: the file answers.
    writeFileSync(
      join(sessionsDir, "file-detail.json"),
      sessionDoc("file-detail", "Only on disk"),
    );
    expect((await readNativeSessionAsync("file-detail"))?.title).toBe(
      "Only on disk",
    );
    expect(await readNativeSessionAsync("missing")).toBeUndefined();
    expect(await readNativeSessionAsync("../escape")).toBeUndefined();
  });

  test("a PR state change publishes only the rows on that branch", async () => {
    const { publishSessionRowsForBranch } = await import("./session-cache");
    const {
      __setSessionListStoreForTest,
      SessionListStore,
      upsertIndexedSessions,
    } = await import("./session-list-store");
    const { __resetSessionRowPublishesForTest, __scheduledSessionRowsForTest } =
      await import("./session-row-events");
    const { allClients } = await import("./ws-hub");

    __setSessionListStoreForTest(new SessionListStore(":memory:"));
    const row = (id: string, branch: string, archived = false) =>
      ({
        id,
        source: "opensession",
        branch,
        archived,
        title: id,
        createdBy: "Ada",
        startedBy: "Ada",
        lastActivity: "2026-09-01T00:00:00.000Z",
        createdAt: "2026-09-01T00:00:00.000Z",
        isRunning: false,
        worktreeDir: null,
        transcriptPath: null,
      }) as unknown as import("./types").UnifiedSession;
    await upsertIndexedSessions(
      [
        row("pr-a", "feat-x"),
        row("pr-review", "feat-x-os-review"),
        row("pr-archived", "feat-x", true),
        row("pr-other", "main"),
      ],
      "exclude",
    );
    const socket = { data: { sidebarScope: null }, send() {} };
    allClients.add(socket as never);
    try {
      await publishSessionRowsForBranch("feat-x");
      expect(__scheduledSessionRowsForTest().sort()).toEqual([
        "pr-a",
        "pr-review",
      ]);
      __resetSessionRowPublishesForTest();
      await publishSessionRowsForBranch("nobody");
      expect(__scheduledSessionRowsForTest()).toEqual([]);
    } finally {
      allClients.delete(socket as never);
      __resetSessionRowPublishesForTest();
    }
  });
});
