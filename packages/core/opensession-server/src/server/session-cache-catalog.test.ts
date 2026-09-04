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
    expect(indexedSessions("include")).toBeNull();
    const scanned = await getCachedSessionsAsync("include");
    expect(scanned.map((s) => s.id)).toEqual(["file-only"]);

    // Complete: a fresh index fills from the catalog and the file is not read.
    const { __setSessionListStoreForTest, SessionListStore } =
      await import("./session-list-store");
    __setSessionListStoreForTest(new SessionListStore(":memory:"));
    const { invalidateSessionsCache } = await import("./session-cache");
    invalidateSessionsCache();
    await sessionMetadata({ op: "mark_catalog_complete" });
    expect(indexedSessions("include")).toBeNull();

    await primeSessionListIndex();
    const primed = indexedSessions("include");
    expect(primed?.map((s) => s.id)).toEqual(["catalog-only"]);
    expect(primed?.[0]).toMatchObject({
      title: "Only in the catalog",
      source: "opensession",
    });

    // Priming an index that already has coverage is a no-op.
    await primeSessionListIndex();
    expect(indexedSessions("include")?.map((s) => s.id)).toEqual([
      "catalog-only",
    ]);
  });
});
