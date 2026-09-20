import { getConfigAsync } from "./config";
/**
 * A committed session document projects straight into the list index and the
 * derived export file. The row comes from the document the compare-and-set
 * accepted, not from reading the file back; the export receipt follows the
 * index write and repair runs from the catalog's bounded pending work index.
 * Runs the metadata facade on the in-process compatibility store with all
 * state under a scratch root.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeSessionFile, UnifiedSession } from "./types";

const home = join(tmpdir(), `session-cache-export-${crypto.randomUUID()}`);
const sessionsDir = join(home, ".opensession-sessions");
const prior = {
  home: process.env.HOME,
  stateDir: process.env.OPENSESSION_STATE_DIR,
  config: process.env.OPENSESSION_CONFIG,
};
let priorSessionsDir: string | undefined;

function sessionDoc(id: string, extra: Partial<NativeSessionFile> = {}) {
  return {
    id,
    title: `Session ${id}`,
    model: "claude-haiku-4-5",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActivity: "2026-09-01T00:00:00.000Z",
    createdBy: "Ada",
    ...extra,
  } as NativeSessionFile;
}

function listRow(id: string, aliasIds: string[] = []): UnifiedSession {
  return {
    ...sessionDoc(id),
    source: "opensession",
    aliasIds,
    archived: false,
    isRunning: false,
    startedBy: "Ada",
    branch: null,
    worktreeDir: null,
    transcriptPath: null,
  } as unknown as UnifiedSession;
}

function sessionPath(id: string): string {
  return join(sessionsDir, `${id}.json`);
}

function fileDoc(id: string): NativeSessionFile {
  return JSON.parse(fs.readFileSync(sessionPath(id), "utf-8"));
}

function tempLeftovers(): string[] {
  return fs.readdirSync(sessionsDir).filter((f) => f.includes(".tmp."));
}

async function catalog(id: string) {
  const { sessionMetadata } = await import("./session-kernel");
  return sessionMetadata({ op: "catalog_get", sessionId: id });
}

async function pendingExports(): Promise<string[]> {
  const { sessionMetadata } = await import("./session-kernel");
  return (await sessionMetadata({ op: "pending_exports", limit: 100 })).map(
    (item) => item.sessionId,
  );
}

/** The projection runs under the writer's lock, so once updateSessionFile
 * resolves the receipt for that revision is already in the catalog. */
async function expectExported(id: string, rev: number): Promise<void> {
  expect((await catalog(id))?.exportedRev).toBe(rev);
}

beforeAll(async () => {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(join(home, "config.json"), JSON.stringify({ repos: {} }));
  process.env.HOME = home;
  process.env.OPENSESSION_STATE_DIR = home;
  process.env.OPENSESSION_CONFIG = join(home, "config.json");
  await getConfigAsync();
  priorSessionsDir = (await import("./paths")).__setSessionsDirForTest(
    sessionsDir,
  );
  const { __setSessionListStoreForTest, SessionListStore } =
    await import("./session-list-store");
  __setSessionListStoreForTest(new SessionListStore(":memory:"));
  const { upsertIndexedSessions } = await import("./session-list-store");
  const { getCachedSessionsAsync, updateSessionFile } =
    await import("./session-cache");
  // Prime the known identity snapshot once, independently of which tests run.
  // Each case owns a separate canonical/alias pair rather than relying on a
  // previous test's writes or a TTL-dependent cache rebuild.
  await upsertIndexedSessions(
    [
      listRow("direct", ["slack-C0DIRECT-1789056158.000001"]),
      listRow("aliased", ["slack-C0ALIAS-1789056158.000001", "alias-native"]),
      listRow("race-canonical", ["race-alias"]),
      listRow("legacy-canon", ["legacy-alias"]),
      listRow("../evil", ["evil-alias"]),
      listRow("plain"),
    ],
    "include",
  );
  await getCachedSessionsAsync("include");
  await updateSessionFile("aliased", () =>
    sessionDoc("aliased", { model: "claude-sonnet-4-5" }),
  );
  await updateSessionFile("race-canonical", () => sessionDoc("race-canonical"));
  (await import("./session-row-events")).__resetSessionRowPublishesForTest();
});

afterEach(async () => {
  (await import("./session-row-events")).__resetSessionRowPublishesForTest();
});

afterAll(async () => {
  (await import("./session-list-store")).__setSessionListStoreForTest(
    undefined,
  );
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
  fs.rmSync(home, { recursive: true, force: true });
});

describe("committed session metadata export", () => {
  test("projects the committed document with its aliases and overlays without re-reading the file", async () => {
    const { updateSessionFile, peekCachedSessions } =
      await import("./session-cache");
    const { indexedSession } = await import("./session-list-store");
    const { setTitleOverride } = await import("./title-overrides");

    // Only the known identity snapshot records this merged Slack thread.
    const id = "direct";
    const alias = "slack-C0DIRECT-1789056158.000001";
    expect(peekCachedSessions().find((s) => s.id === id)?.aliasIds).toEqual([
      alias,
    ]);
    setTitleOverride(alias, "Renamed under the alias");

    // The first write seeds the actor document from the (absent) legacy file.
    await updateSessionFile(id, () => sessionDoc(id));
    await expectExported(id, 1);

    const reads = spyOn(fs, "readFileSync");
    const exists = spyOn(fs, "existsSync");
    try {
      await updateSessionFile(id, (data) => ({
        ...data,
        model: "claude-sonnet-4-5",
      }));
      await expectExported(id, 2);
      const path = sessionPath(id);
      const touched = (calls: unknown[][]) =>
        calls.filter((args) => args[0] === path);
      expect(touched(reads.mock.calls)).toEqual([]);
      expect(touched(exists.mock.calls)).toEqual([]);
    } finally {
      reads.mockRestore();
      exists.mockRestore();
    }

    // The row carries the committed fields, the aliases and the alias overlay.
    expect(await indexedSession(id)).toMatchObject({
      id,
      model: "claude-sonnet-4-5",
      title: "Renamed under the alias",
      titleOverridden: true,
      aliasIds: [alias],
    });
    // The file carries the same revision the catalog acknowledged.
    expect(fileDoc(id)).toMatchObject({
      id,
      model: "claude-sonnet-4-5",
      rev: 2,
    });
    expect(await pendingExports()).not.toContain(id);
    expect(tempLeftovers()).toEqual([]);
  });

  test("a write under a merged alias resolves the canonical row from its committed document without synchronous reads", async () => {
    const { updateSessionFile } = await import("./session-cache");
    const { indexedSession } = await import("./session-list-store");
    const { __scheduledSessionRowsForTest } =
      await import("./session-row-events");

    // `alias-native` was deduped into `aliased` by the last assembly. Writing
    // its own file must not index a second row for it, nor drop the aliases
    // from the canonical row: the canonical session decides, as the targeted
    // publish path always did, here from its committed catalog document.
    // `legacy-alias` was deduped into `legacy-canon`, which the catalog has
    // never seen: its legacy file is the source, read asynchronously.
    const alias = "alias-native";
    fs.writeFileSync(
      sessionPath("legacy-canon"),
      JSON.stringify(sessionDoc("legacy-canon", { title: "canon on disk" })),
    );
    const reads = spyOn(fs, "readFileSync");
    const exists = spyOn(fs, "existsSync");
    try {
      await updateSessionFile(alias, () =>
        sessionDoc(alias, { title: "mine" }),
      );
      await updateSessionFile("legacy-alias", () =>
        sessionDoc("legacy-alias", { title: "also mine" }),
      );
      // Neither the written files nor the canonical documents are read
      // synchronously; the runtime enrichment's active-runs probe is not a
      // session document.
      const docs = [alias, "aliased", "legacy-alias", "legacy-canon"].map(
        sessionPath,
      );
      const touched = (calls: unknown[][]) =>
        calls.filter((args) => docs.includes(args[0] as string));
      expect(touched(reads.mock.calls)).toEqual([]);
      expect(touched(exists.mock.calls)).toEqual([]);
    } finally {
      reads.mockRestore();
      exists.mockRestore();
    }
    await expectExported(alias, 1);
    await expectExported("legacy-alias", 1);
    expect(fileDoc(alias)).toMatchObject({ id: alias, title: "mine", rev: 1 });
    expect(await indexedSession(alias)).toBeNull();
    expect(await indexedSession("aliased")).toMatchObject({
      id: "aliased",
      model: "claude-sonnet-4-5",
      aliasIds: ["slack-C0ALIAS-1789056158.000001", alias],
    });
    expect(await indexedSession("legacy-alias")).toBeNull();
    expect(await indexedSession("legacy-canon")).toMatchObject({
      id: "legacy-canon",
      title: "canon on disk",
      aliasIds: ["legacy-alias"],
    });
    expect(__scheduledSessionRowsForTest()).toEqual(
      expect.arrayContaining(["aliased", "legacy-canon"]),
    );
  });

  test("a canonical id no reader would open is looked up nowhere and owns no row", async () => {
    const { updateSessionFile, peekCachedSessions } =
      await import("./session-cache");
    const { isAgentSessionId, isNativeSessionId } = await import("./sessions");
    const kernel = await import("./session-kernel");
    const { __setSessionListStoreForTest, indexedSession } =
      await import("./session-list-store");
    const { __scheduledSessionRowsForTest } =
      await import("./session-row-events");

    // The readers' id rules, which the projection applies before any lookup:
    // dotted Slack thread keys are agent ids, path-shaped keys are neither.
    expect(isNativeSessionId("slack-C0SIDE-1789056158.000009")).toBe(false);
    expect(isAgentSessionId("slack-C0SIDE-1789056158.000009")).toBe(true);
    expect(isAgentSessionId("linear-team/branch")).toBe(false);
    expect(isAgentSessionId("slack-")).toBe(false);
    expect(isNativeSessionId("../evil")).toBe(false);
    expect(isAgentSessionId("../evil")).toBe(false);

    const canon = "../evil";
    const alias = "evil-alias";
    expect(peekCachedSessions().find((s) => s.id === canon)?.aliasIds).toEqual([
      alias,
    ]);
    const store = __setSessionListStoreForTest(undefined)!;
    __setSessionListStoreForTest(store);
    const upsert = spyOn(store, "upsert");
    const metadata = spyOn(kernel, "sessionMetadata");
    const reads = spyOn(fs, "readFileSync");
    const exists = spyOn(fs, "existsSync");
    const readsAsync = spyOn(fsp, "readFile");
    const stats = spyOn(fsp, "stat");
    try {
      await updateSessionFile(alias, () =>
        sessionDoc(alias, { title: "under a bad canonical" }),
      );
      expect(upsert.mock.calls.map(([row]) => row.id)).not.toContain(canon);
      expect(
        metadata.mock.calls
          .map(([request]) => request)
          .filter((request) => request.op === "get")
          .map((request) => request.sessionId),
      ).toEqual([alias]);
      const evil = (calls: unknown[][]) =>
        calls.filter((args) => String(args[0]).includes("evil.json"));
      expect(evil(reads.mock.calls)).toEqual([]);
      expect(evil(exists.mock.calls)).toEqual([]);
      expect(evil(readsAsync.mock.calls)).toEqual([]);
      expect(evil(stats.mock.calls)).toEqual([]);
    } finally {
      for (const spy of [upsert, metadata, reads, exists, readsAsync, stats])
        spy.mockRestore();
    }
    // The alias's own commit and export are unaffected; its publish names
    // the id that was written, as the targeted publish does.
    expect(fileDoc(alias)).toMatchObject({ id: alias, rev: 1 });
    await expectExported(alias, 1);
    expect(await indexedSession(alias)).toBeNull();
    expect(__scheduledSessionRowsForTest()).toContain(alias);
  });

  test("a Slack sidecar write projects the agent-owned row with the committed extras, without synchronous reads", async () => {
    const { touchNativeSession } = await import("./session-cache");
    const { indexedSession } = await import("./session-list-store");

    // The Slack loop owns this thread's file; the sidecar the facade writes
    // under the unified id carries only the natively owned extras and has
    // no `id` of its own.
    const key = "C0SIDE-1789056158.000009";
    const id = `slack-${key}`;
    const slackDir = join(home, ".slack-sessions");
    const slackPath = join(slackDir, `${key}.json`);
    fs.mkdirSync(slackDir, { recursive: true });
    fs.writeFileSync(
      slackPath,
      JSON.stringify({
        channel: "C0SIDE",
        threadTs: "1789056158.000009",
        userId: "Grace Hopper",
        title: "Thread title",
        claudeSessionId: "engine-owned",
        model: "claude-haiku-4-5",
        createdAt: "2026-09-02T00:00:00.000Z",
        lastActivity: "2026-09-02T01:00:00.000Z",
      }),
    );

    const reads = spyOn(fs, "readFileSync");
    const exists = spyOn(fs, "existsSync");
    try {
      await touchNativeSession(id, {
        workspaceId: "ws-1",
        slackThreads: [{ channel: "C0SIDE", threadTs: "1789056158.000009" }],
        // Source-owned fields in a sidecar are stale copies: the row keeps
        // the Slack file's own values.
        title: "sidecar title",
        model: "sidecar-model",
      });
      const touched = (calls: unknown[][]) =>
        calls.filter(
          (args) => args[0] === sessionPath(id) || args[0] === slackPath,
        );
      expect(touched(reads.mock.calls)).toEqual([]);
      expect(touched(exists.mock.calls)).toEqual([]);
    } finally {
      reads.mockRestore();
      exists.mockRestore();
    }

    expect(fileDoc(id)).not.toHaveProperty("id");
    expect(await indexedSession(id)).toMatchObject({
      id,
      source: "slack",
      title: "Thread title",
      model: "claude-haiku-4-5",
      claudeSessionId: "engine-owned",
      startedBy: "Grace",
      lastActivity: "2026-09-02T01:00:00.000Z",
      slackThread: { channel: "C0SIDE", threadTs: "1789056158.000009" },
      workspaceId: "ws-1",
      slackThreads: [{ channel: "C0SIDE", threadTs: "1789056158.000009" }],
    });
    await expectExported(id, 1);
  });

  test("an agent row with empty timestamps still uses its file time", async () => {
    const { readAgentSessionListRowAsync } = await import("./sessions");
    const key = "C0EMPTY-1789056158.000010";
    const dir = join(home, ".slack-sessions");
    const path = join(dir, `${key}.json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path, JSON.stringify({ createdAt: "", lastActivity: "" }));
    const expected = fs.statSync(path).mtime.toISOString();
    const row = await readAgentSessionListRowAsync(
      `slack-${key}`,
      undefined,
      undefined,
    );
    expect(row?.createdAt).toBe(expected);
    expect(row?.lastActivity).toBe(expected);
  });

  test("an alias projection delayed past a newer canonical commit cannot overwrite the newer row", async () => {
    const { updateSessionFile, peekCachedSessions } =
      await import("./session-cache");
    const { sessionMetadata } = await import("./session-kernel");
    const { __setSessionListStoreForTest, SessionListStore, indexedSession } =
      await import("./session-list-store");

    // The alias projection reads the canonical document, then writes the
    // row. Hold that write open and commit a newer canonical revision in
    // the gap: the canonical commit must wait for the projection, so the
    // newer row lands last. The pair has its own seeded identity and document,
    // so this case also runs without any earlier test.
    const canon = "race-canonical";
    const alias = "race-alias";
    expect(
      peekCachedSessions().find((s) => s.id === canon)?.aliasIds,
    ).toContain(alias);
    const before = (await sessionMetadata({ op: "get", sessionId: canon }))!
      .rev;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let onReached = () => {};
    const reached = new Promise<void>((resolve) => (onReached = resolve));
    let gated = false;
    const posted: Array<string | null | undefined> = [];
    class GatedIndex extends SessionListStore {
      override upsert(session: UnifiedSession): void {
        if (session.id !== canon) return super.upsert(session);
        posted.push(session.model);
        if (!gated) return super.upsert(session);
        gated = false;
        onReached();
        // The local backend awaits a returned promise like a worker reply.
        return gate.then(() => super.upsert(session)) as unknown as void;
      }
    }
    const healthy = __setSessionListStoreForTest(new GatedIndex(":memory:"))!;
    try {
      await updateSessionFile(canon, (data) => ({ ...data, model: "m-v1" }));

      gated = true;
      const aliasWrite = updateSessionFile(alias, (data) => ({
        ...data,
        title: "alias doc",
      }));
      await reached;
      const canonWrite = updateSessionFile(canon, (data) => ({
        ...data,
        model: "m-v2",
      }));
      // The alias projection holds the canonical row's lock: the newer
      // commit cannot start until it is done.
      await Bun.sleep(0);
      expect(
        (await sessionMetadata({ op: "get", sessionId: canon }))?.rev,
      ).toBe(before + 1);

      release();
      await Promise.all([aliasWrite, canonWrite]);
      expect(await indexedSession(canon)).toMatchObject({
        id: canon,
        model: "m-v2",
        aliasIds: [alias],
      });
      expect(await indexedSession(alias)).toBeNull();
    } finally {
      __setSessionListStoreForTest(healthy);
    }

    // The projection's stale read landed, then the newer commit's row.
    expect(posted).toEqual(["m-v1", "m-v1", "m-v2"]);
    expect((await sessionMetadata({ op: "get", sessionId: canon }))?.rev).toBe(
      before + 2,
    );
    await expectExported(canon, before + 2);
    expect((await catalog(alias))?.exportedRev).toBe(
      (await sessionMetadata({ op: "get", sessionId: alias }))!.rev,
    );
  });

  test("concurrent writers post index rows in commit order and the last commit wins", async () => {
    const { updateSessionFile } = await import("./session-cache");
    const { sessionMetadata } = await import("./session-kernel");
    const { __setSessionListStoreForTest, indexedSession } =
      await import("./session-list-store");

    const id = "burst";
    const store = __setSessionListStoreForTest(undefined)!;
    __setSessionListStoreForTest(store);
    const posted: string[] = [];
    const upsert = spyOn(store, "upsert");
    try {
      await Promise.all(
        Array.from({ length: 6 }, (_, n) =>
          updateSessionFile(id, (data) => ({
            ...sessionDoc(id),
            ...data,
            id,
            title: `write ${n + 1}`,
            writes: ((data as { writes?: number }).writes ?? 0) + 1,
          })),
        ),
      );
      await expectExported(id, 6);
      for (const [row] of upsert.mock.calls)
        if (row.id === id) posted.push(row.title);
    } finally {
      upsert.mockRestore();
    }

    // The lock serializes commits and holds until each row is indexed, so
    // the index sees them in revision order.
    expect(posted).toEqual([1, 2, 3, 4, 5, 6].map((n) => `write ${n}`));
    const stored = await sessionMetadata({ op: "get", sessionId: id });
    expect(stored?.rev).toBe(6);
    expect(JSON.parse(stored!.doc)).toMatchObject({
      title: "write 6",
      writes: 6,
    });
    expect(fileDoc(id)).toMatchObject({ title: "write 6", writes: 6, rev: 6 });
    expect(await indexedSession(id)).toMatchObject({ title: "write 6" });
    expect((await catalog(id))?.exportedRev).toBe(6);
    expect(await pendingExports()).not.toContain(id);
    expect(tempLeftovers()).toEqual([]);
  });

  test("a compare-and-set conflict re-applies the mutator on the committed truth", async () => {
    const { updateSessionFile } = await import("./session-cache");
    const { sessionMetadata } = await import("./session-kernel");
    const { indexedSession } = await import("./session-list-store");

    const id = "contended";
    await updateSessionFile(id, () => sessionDoc(id, { title: "base" }));
    await expectExported(id, 1);

    // Another writer (a different gateway generation, in production) commits
    // between this writer's read and its put. The compatibility store commits
    // synchronously, so the mutator itself can play that writer once.
    let raced = false;
    const seen: string[] = [];
    await updateSessionFile(id, (data) => {
      seen.push(data.title!);
      if (!raced) {
        raced = true;
        void sessionMetadata({
          op: "put",
          sessionId: id,
          requestId: `race:${crypto.randomUUID()}`,
          expectedRev: 1,
          rev: 2,
          doc: JSON.stringify({
            ...sessionDoc(id, { title: "out of band" }),
            rev: 2,
          }),
          archived: false,
          lastActivityMs: 0,
        });
      }
      return { ...data, model: "claude-opus-4-1" };
    });

    // The first attempt saw "base", the retry saw the out-of-band commit.
    expect(seen).toEqual(["base", "out of band"]);
    const stored = await sessionMetadata({ op: "get", sessionId: id });
    expect(stored?.rev).toBe(3);
    expect(JSON.parse(stored!.doc)).toMatchObject({
      title: "out of band",
      model: "claude-opus-4-1",
      rev: 3,
    });
    expect(fileDoc(id)).toMatchObject({ title: "out of band", rev: 3 });
    await expectExported(id, 3);
    expect(await indexedSession(id)).toMatchObject({
      title: "out of band",
      model: "claude-opus-4-1",
    });
  });

  test("a failed file export keeps the commit pending, leaves no temp file, and boot repair re-exports it", async () => {
    const { updateSessionFile, reconcileSessionMetadataExports } =
      await import("./session-cache");
    const { sessionMetadata } = await import("./session-kernel");
    const { indexedSession } = await import("./session-list-store");

    // A directory squatting on the export path makes the rename fail after
    // the actor already committed the document. It appears from inside the
    // mutator, after the (absent) legacy seed was read and before the put.
    const id = "export-fails";
    await expect(
      updateSessionFile(id, () => {
        fs.mkdirSync(sessionPath(id));
        return sessionDoc(id, { title: "committed" });
      }),
    ).rejects.toThrow();
    expect((await sessionMetadata({ op: "get", sessionId: id }))?.rev).toBe(1);
    expect((await catalog(id))?.exportedRev).toBe(0);
    expect(await pendingExports()).toContain(id);
    expect(await indexedSession(id)).toBeNull();
    expect(tempLeftovers()).toEqual([]);

    fs.rmdirSync(sessionPath(id));
    expect(await reconcileSessionMetadataExports()).toBe(1);
    expect(fileDoc(id)).toMatchObject({ id, title: "committed", rev: 1 });
    expect(await indexedSession(id)).toMatchObject({ id, title: "committed" });
    expect((await catalog(id))?.exportedRev).toBe(1);
    expect(await pendingExports()).not.toContain(id);
    expect(await reconcileSessionMetadataExports()).toBe(0);
  });

  test("a failed index write publishes nothing and withholds the receipt until repair", async () => {
    const { updateSessionFile, reconcileSessionMetadataExports } =
      await import("./session-cache");
    const { __setSessionListStoreForTest, SessionListStore, indexedSession } =
      await import("./session-list-store");
    const { __scheduledSessionRowsForTest } =
      await import("./session-row-events");

    const id = "index-fails";
    const healthy = __setSessionListStoreForTest(undefined)!;
    class BrokenIndex extends SessionListStore {
      override upsert(): void {
        throw new Error("index unavailable");
      }
    }
    __setSessionListStoreForTest(new BrokenIndex(":memory:"));
    try {
      // The write itself succeeds: the document is committed and exported.
      await updateSessionFile(id, () => sessionDoc(id, { title: "unindexed" }));
      expect(fileDoc(id)).toMatchObject({ id, title: "unindexed", rev: 1 });
      // The projection ran under the writer's lock: it must not publish a
      // row it could not write, nor acknowledge an export whose row never
      // reached the index.
      expect(__scheduledSessionRowsForTest()).not.toContain(id);
      expect((await catalog(id))?.exportedRev).toBe(0);
      expect(await pendingExports()).toContain(id);
    } finally {
      __setSessionListStoreForTest(healthy);
    }

    expect(await reconcileSessionMetadataExports()).toBe(1);
    expect(await indexedSession(id)).toMatchObject({ id, title: "unindexed" });
    expect(__scheduledSessionRowsForTest()).toContain(id);
    expect((await catalog(id))?.exportedRev).toBe(1);
    expect(await pendingExports()).not.toContain(id);
  });

  test("a failed receipt is repaired from the pending work index", async () => {
    const { updateSessionFile, reconcileSessionMetadataExports } =
      await import("./session-cache");
    const { __sessionKernelStoreForTest } = await import("./session-kernel");
    const { indexedSession } = await import("./session-list-store");

    const id = "receipt-fails";
    const receipt = spyOn(
      __sessionKernelStoreForTest(),
      "markSessionMetadataExported",
    ).mockImplementationOnce(() => {
      throw new Error("catalog unavailable");
    });
    try {
      await updateSessionFile(id, () =>
        sessionDoc(id, { title: "acked late" }),
      );
      expect(receipt).toHaveBeenCalledTimes(1);
    } finally {
      receipt.mockRestore();
    }
    // File and row are already current; only the marker trails.
    expect(fileDoc(id)).toMatchObject({ id, title: "acked late", rev: 1 });
    expect(await indexedSession(id)).toMatchObject({ id, title: "acked late" });
    expect((await catalog(id))?.exportedRev).toBe(0);
    expect(await pendingExports()).toContain(id);

    expect(await reconcileSessionMetadataExports()).toBe(1);
    expect((await catalog(id))?.exportedRev).toBe(1);
    expect(await pendingExports()).not.toContain(id);
  });

  test("a receipt delayed past a newer commit never acknowledges that newer revision", async () => {
    const { updateSessionFile } = await import("./session-cache");
    const { __sessionKernelStoreForTest } = await import("./session-kernel");

    // Hold every receipt so the older one can be replayed after the newer
    // commit, in either order.
    const id = "delayed-receipt";
    const store = __sessionKernelStoreForTest();
    const original = store.markSessionMetadataExported.bind(store);
    const held: Array<[string, number]> = [];
    const receipt = spyOn(
      store,
      "markSessionMetadataExported",
    ).mockImplementation((sessionId: string, rev: number) => {
      held.push([sessionId, rev]);
    });
    try {
      await updateSessionFile(id, () => sessionDoc(id, { title: "first" }));
      await updateSessionFile(id, (data) => ({ ...data, title: "second" }));
    } finally {
      receipt.mockRestore();
    }
    expect(held).toEqual([
      [id, 1],
      [id, 2],
    ]);
    expect(fileDoc(id)).toMatchObject({ title: "second", rev: 2 });
    expect((await catalog(id))?.exportedRev).toBe(0);

    // The older receipt lands after the newer commit: it names only its own
    // revision, so the session stays in the pending work index.
    original(id, 1);
    expect((await catalog(id))?.exportedRev).toBe(1);
    expect(await pendingExports()).toContain(id);
    // The newer receipt settles it; replaying the older one afterwards is a
    // no-op because the marker is monotonic.
    original(id, 2);
    original(id, 1);
    expect((await catalog(id))?.exportedRev).toBe(2);
    expect(await pendingExports()).not.toContain(id);
  });

  test("a legacy file seeds the first actor commit and is then derived", async () => {
    const { updateSessionFile } = await import("./session-cache");
    const { sessionMetadata } = await import("./session-kernel");

    const id = "legacy";
    fs.writeFileSync(
      sessionPath(id),
      JSON.stringify(sessionDoc(id, { title: "from disk", branch: "keep-me" })),
    );
    await updateSessionFile(id, (data) => ({ ...data, model: "gpt-5" }));
    const stored = await sessionMetadata({ op: "get", sessionId: id });
    expect(stored?.rev).toBe(1);
    expect(JSON.parse(stored!.doc)).toMatchObject({
      title: "from disk",
      branch: "keep-me",
      model: "gpt-5",
    });
    expect(fileDoc(id)).toMatchObject({
      branch: "keep-me",
      model: "gpt-5",
      rev: 1,
    });
    await expectExported(id, 1);
  });
});
