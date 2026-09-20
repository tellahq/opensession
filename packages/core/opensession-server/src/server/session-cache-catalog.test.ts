import { getConfigAsync } from "./config";
/**
 * A cold list rebuild reads the catalogs only: the metadata catalog for
 * native rows and agent sidecars, the agent-session projection for Slack and
 * Linear rows. While either is unseeded the rebuild fails bounded (a
 * snapshot-less reader gets SessionListUnavailableError, a reader with a
 * snapshot keeps it); it never reads a session directory. Runs the facades
 * on the in-process compatibility store with all state under a scratch root.
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedSession } from "./types";

const home = join(tmpdir(), `session-cache-catalog-${crypto.randomUUID()}`);
const sessionsDir = join(home, ".opensession-sessions");
const slackDir = join(home, ".slack-sessions");
const linearDir = join(home, ".linear-sessions");
const prior = {
  home: process.env.HOME,
  stateDir: process.env.OPENSESSION_STATE_DIR,
  config: process.env.OPENSESSION_CONFIG,
};
let priorSessionsDir: string | undefined;
let priorGhBackoff: number | undefined;
let priorKernelStore: import("./session-kernel").SessionKernelStore | undefined;
let kernelStore: import("./session-kernel").SessionKernelStore | undefined;

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

const slackKey = "C0C1T4W5M6U-1789056158.043869";
function slackFile(overrides: Record<string, unknown> = {}) {
  return {
    channel: "C0C1T4W5M6U",
    threadTs: "1789056158.043869",
    branch: "investigate-function-timeouts",
    worktreeDir: "/worktrees/tella-fusion-investigate-function-timeouts",
    userId: "Ada",
    claudeSessionId: "engine-slack-v1",
    createdAt: "2026-09-10T16:09:40.241Z",
    lastActivity: "2026-09-10T16:47:08.952Z",
    ...overrides,
  };
}

async function freshKernelStore(): Promise<void> {
  const { SessionKernelStore, __setSessionKernelStoreForTest } =
    await import("./session-kernel");
  kernelStore?.close();
  kernelStore = new SessionKernelStore(":memory:");
  const previous = __setSessionKernelStoreForTest(kernelStore);
  priorKernelStore ??= previous;
}

async function freshListIndex(): Promise<void> {
  const { __setSessionListStoreForTest, SessionListStore } =
    await import("./session-list-store");
  __setSessionListStoreForTest(new SessionListStore(":memory:"));
}

async function resetCatalogState(): Promise<void> {
  const { __resetSessionListCatalogStateForTest } =
    await import("./session-cache");
  __resetSessionListCatalogStateForTest();
}

async function markEverythingComplete(): Promise<void> {
  const { sessionMetadata } = await import("./session-kernel");
  const { markAgentSessionCatalogImportComplete } =
    await import("./agent-session-catalog");
  if (!(await sessionMetadata({ op: "catalog_complete" })))
    await sessionMetadata({ op: "mark_catalog_complete" });
  for (const kind of ["slack", "linear"] as const)
    await markAgentSessionCatalogImportComplete(kind);
}

beforeAll(async () => {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(slackDir, { recursive: true });
  fs.mkdirSync(linearDir, { recursive: true });
  // Rows with a branch resolve their repo during PR enrichment, so the
  // registry needs one repo; the GitHub gate stays closed for the file.
  fs.writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      repos: {
        opensession: {
          repo: "/home/ubuntu/projects/opensession",
          ghRepo: "tellahq/backstage",
          label: "Open Session",
        },
      },
    }),
  );
  process.env.HOME = home;
  process.env.OPENSESSION_STATE_DIR = home;
  process.env.OPENSESSION_CONFIG = join(home, "config.json");
  await getConfigAsync();
  priorGhBackoff = (await import("./github-limit")).__setGhBackoffForTest(
    Date.now() + 60 * 60_000,
  );
  priorSessionsDir = (await import("./paths")).__setSessionsDirForTest(
    sessionsDir,
  );
  await freshKernelStore();
  await freshListIndex();
});

afterAll(async () => {
  const { __setSessionKernelStoreForTest } = await import("./session-kernel");
  __setSessionKernelStoreForTest(priorKernelStore);
  kernelStore?.close();
  (await import("./session-list-store")).__setSessionListStoreForTest(
    undefined,
  );
  if (priorSessionsDir !== undefined)
    (await import("./paths")).__setSessionsDirForTest(priorSessionsDir);
  if (priorGhBackoff !== undefined)
    (await import("./github-limit")).__setGhBackoffForTest(priorGhBackoff);
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

afterEach(async () => {
  (await import("./session-row-events")).__resetSessionRowPublishesForTest();
});

describe("catalog-only list rebuild", () => {
  test("refuses to rebuild from files while the catalogs are unseeded", async () => {
    await resetCatalogState();
    await freshListIndex();
    const { sessionMetadata } = await import("./session-kernel");
    const {
      getCachedSessionsAsync,
      primeSessionListIndex,
      SessionListUnavailableError,
    } = await import("./session-cache");
    const { indexedSessions } = await import("./session-list-store");
    const { markAgentSessionCatalogImportComplete } =
      await import("./agent-session-catalog");

    // A session only the directory knows, and one only the catalog knows.
    fs.writeFileSync(
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
    const listings = spyOn(fs, "readdirSync");
    const dirs = spyOn(fs.promises, "readdir");
    try {
      // Nothing is marked complete: no snapshot, so the failure is bounded.
      expect(await indexedSessions("include")).toBeNull();
      const failure = await getCachedSessionsAsync("include").catch((e) => e);
      expect(failure).toBeInstanceOf(SessionListUnavailableError);
      expect(failure.reason).toContain("seed-session-metadata-catalog");
      expect(failure.reason).toContain("metadata catalog");
      // Boot refuses instead of scanning or guessing.
      const boot = await primeSessionListIndex().catch((e) => e);
      expect(boot).toBeInstanceOf(SessionListUnavailableError);
      expect(await indexedSessions("include")).toBeNull();

      // The metadata catalog alone is not enough: the agent stores must be
      // imported too, or every Slack thread would vanish from the rebuild.
      await sessionMetadata({ op: "mark_catalog_complete" });
      const partial = await getCachedSessionsAsync("include").catch((e) => e);
      expect(partial).toBeInstanceOf(SessionListUnavailableError);
      expect(partial.reason).toContain("slack");
      await markAgentSessionCatalogImportComplete("slack");
      const linearMissing = await getCachedSessionsAsync("include").catch(
        (e) => e,
      );
      expect(linearMissing.reason).toContain("linear");
      await markAgentSessionCatalogImportComplete("linear");

      // Complete: the index fills from the catalogs and the file is not read.
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
      const sessionListings = [...listings.mock.calls, ...dirs.mock.calls]
        .map((call) => String(call[0]))
        .filter((path) =>
          [sessionsDir, slackDir, linearDir].some((dir) =>
            path.startsWith(dir),
          ),
        );
      expect(sessionListings).toEqual([]);
    } finally {
      listings.mockRestore();
      dirs.mockRestore();
    }
  });

  test("assembles Slack and Linear rows from the projection with their sidecars", async () => {
    await resetCatalogState();
    await freshListIndex();
    const { sessionMetadata } = await import("./session-kernel");
    const { seedAgentSessionCatalog } = await import("./agent-session-catalog");
    const { primeSessionListIndex } = await import("./session-cache");
    const { indexedSessions } = await import("./session-list-store");

    // A Slack file only the directory knows must not appear.
    fs.writeFileSync(
      join(slackDir, "C0DISK-1789056158.000001.json"),
      JSON.stringify(
        slackFile({
          channel: "C0DISK",
          threadTs: "1789056158.000001",
          claudeSessionId: "engine-slack-disk",
        }),
      ),
    );
    await seedAgentSessionCatalog("slack", [
      {
        file: `${slackKey}.json`,
        data: slackFile(),
        mtime: "2026-09-10T16:09:40.241Z",
      },
    ]);
    await seedAgentSessionCatalog("linear", [
      {
        file: "eng-42-fix-row.json",
        data: {
          branch: "eng-42-fix-row",
          worktreeDir: "/tmp/linear-row",
          claudeSessionId: "engine-linear-row",
          issueIdentifier: "ENG-42",
          issueTitle: "Fix row",
          updatedAt: "2026-09-10T16:47:08.000Z",
        },
        mtime: "2026-09-10T16:00:00.000Z",
      },
    ]);
    // The natively owned extras committed under the Slack id.
    await sessionMetadata({
      op: "seed_catalog",
      rows: [
        {
          sessionId: `slack-${slackKey}`,
          doc: JSON.stringify({ workspaceId: "ws-slack", title: "ignored" }),
          rev: 1,
          archived: false,
          lastActivityMs: 0,
        },
      ],
    });
    await markEverythingComplete();

    await primeSessionListIndex();
    const rows = await indexedSessions("include");
    const ids = rows?.map((s) => s.id).sort();
    expect(ids).toEqual(
      ["catalog-only", "linear-eng-42-fix-row", `slack-${slackKey}`].sort(),
    );
    expect(rows?.find((s) => s.id === `slack-${slackKey}`)).toMatchObject({
      source: "slack",
      branch: "investigate-function-timeouts",
      claudeSessionId: "engine-slack-v1",
      workspaceId: "ws-slack",
      // The source owns the title; the sidecar copy is never overlaid.
      title: "investigate-function-timeouts",
    });
    expect(rows?.find((s) => s.id === "linear-eng-42-fix-row")).toMatchObject({
      source: "linear",
      title: "ENG-42: Fix row",
      createdAt: "2026-09-10T16:00:00.000Z",
    });
  });

  test("a targeted publish records what it observed, in observation order", async () => {
    const { publishSessionChange } = await import("./session-cache");
    const { indexedSession } = await import("./session-list-store");
    const { agentSessionCatalogSources, mirrorAgentSessionSource } =
      await import("./agent-session-catalog");

    const path = join(slackDir, `${slackKey}.json`);
    fs.writeFileSync(
      path,
      JSON.stringify(slackFile({ claudeSessionId: "engine-slack-v2" })),
    );
    await publishSessionChange(`slack-${slackKey}`);
    expect(await indexedSession(`slack-${slackKey}`)).toMatchObject({
      claudeSessionId: "engine-slack-v2",
    });
    const projected = (await agentSessionCatalogSources("slack")).find(
      (s) => s.file === `${slackKey}.json`,
    );
    expect(projected?.data.claudeSessionId).toBe("engine-slack-v2");

    // An older observation that lands later carries nothing new.
    await mirrorAgentSessionSource("slack", `${slackKey}.json`, {
      source: {
        file: `${slackKey}.json`,
        data: slackFile({ claudeSessionId: "engine-slack-v1" }),
        mtime: "2026-09-10T16:09:40.241Z",
      },
      observedAt: Date.now() - 60_000,
    });
    expect(
      (await agentSessionCatalogSources("slack")).find(
        (s) => s.file === `${slackKey}.json`,
      )?.data.claudeSessionId,
    ).toBe("engine-slack-v2");

    // A deletion recorded after the unlink outranks a read that saw the file
    // just before, whichever lands first.
    const before = Date.now() - 1;
    fs.unlinkSync(path);
    await mirrorAgentSessionSource("slack", `${slackKey}.json`, {
      source: null,
      observedAt: Date.now(),
    });
    await mirrorAgentSessionSource("slack", `${slackKey}.json`, {
      source: {
        file: `${slackKey}.json`,
        data: slackFile({ claudeSessionId: "engine-slack-v2" }),
        mtime: "2026-09-10T16:09:40.241Z",
      },
      observedAt: before,
    });
    expect(
      (await agentSessionCatalogSources("slack")).some(
        (s) => s.file === `${slackKey}.json`,
      ),
    ).toBe(false);
    // The publish of a missing file records the same deletion.
    await publishSessionChange(`slack-${slackKey}`);
    expect(
      (await agentSessionCatalogSources("slack")).some(
        (s) => s.file === `${slackKey}.json`,
      ),
    ).toBe(false);
  });

  test("a projection that cannot be written fails the publish before the index row", async () => {
    const { publishSessionChange } = await import("./session-cache");
    const { indexedSession } = await import("./session-list-store");
    const { SessionKernelStore, __setSessionKernelStoreForTest } =
      await import("./session-kernel");

    const key = "C0FAIL-1789056158.000002";
    fs.writeFileSync(
      join(slackDir, `${key}.json`),
      JSON.stringify(
        slackFile({
          channel: "C0FAIL",
          threadTs: "1789056158.000002",
          claudeSessionId: "engine-slack-fail",
        }),
      ),
    );
    const broken = new SessionKernelStore(":memory:");
    broken.close();
    const live = __setSessionKernelStoreForTest(broken);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await publishSessionChange(`slack-${key}`);
      expect(await indexedSession(`slack-${key}`)).toBeNull();
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("row refresh failed"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      __setSessionKernelStoreForTest(live);
    }
    // With the catalog back, the same publish lands both copies.
    await publishSessionChange(`slack-${key}`);
    expect(await indexedSession(`slack-${key}`)).toMatchObject({
      source: "slack",
      branch: "investigate-function-timeouts",
    });
    const { agentSessionCatalogSources } =
      await import("./agent-session-catalog");
    expect(
      (await agentSessionCatalogSources("slack")).some(
        (s) => s.file === `${key}.json`,
      ),
    ).toBe(true);
  });

  test("an unattached catalog cannot acknowledge a source mirror", async () => {
    const { mirrorAgentSessionSource } =
      await import("./agent-session-catalog");
    const env: Record<string, string | undefined> = process.env;
    const previous = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const error = await mirrorAgentSessionSource("slack", "missing.json", {
        source: null,
        observedAt: Date.now(),
      }).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("catalog is unavailable");
    } finally {
      if (previous === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = previous;
    }
  });

  test("an unreadable source is not mistaken for a deletion", async () => {
    const { readAgentSessionListRowAsync } = await import("./sessions");
    const path = join(home, ".slack-sessions", "corrupt.json");
    fs.writeFileSync(path, "{");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = await readAgentSessionListRowAsync(
        "slack-corrupt",
        undefined,
        undefined,
      ).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Cannot project unreadable");
    } finally {
      warn.mockRestore();
      fs.rmSync(path);
    }
  });

  test("a reader with a snapshot keeps it when the catalogs fail", async () => {
    const { getCachedSessionsAsync, __expireSessionListCacheForTest } =
      await import("./session-cache");
    const { SessionKernelStore, __setSessionKernelStoreForTest } =
      await import("./session-kernel");

    const snapshot = await getCachedSessionsAsync("include");
    expect(snapshot.length).toBeGreaterThan(0);
    // Drop index coverage and make every catalog call fail.
    await freshListIndex();
    __expireSessionListCacheForTest();
    const broken = new SessionKernelStore(":memory:");
    broken.close();
    const live = __setSessionKernelStoreForTest(broken);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const served = await getCachedSessionsAsync("include");
      expect(served.map((s) => s.id)).toEqual(snapshot.map((s) => s.id));
      // The failed rebuild settles in the background; the snapshot stays.
      await Bun.sleep(0);
      await Bun.sleep(0);
      expect(
        (await getCachedSessionsAsync("include")).map((s) => s.id),
      ).toEqual(snapshot.map((s) => s.id));
    } finally {
      warn.mockRestore();
      __setSessionKernelStoreForTest(live);
    }
  });

  test("a new state root refuses to boot until the seed script has run", async () => {
    await resetCatalogState();
    await freshKernelStore();
    await freshListIndex();
    const { sessionMetadata } = await import("./session-kernel");
    const { primeSessionListIndex, SessionListUnavailableError } =
      await import("./session-cache");
    const { seedSessionCatalogsFromFiles } =
      await import("./session-source-scan");
    const { indexedSessions } = await import("./session-list-store");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Empty catalogs prove nothing: this state root holds files the
      // catalogs never saw, and so might any legacy install.
      expect(await sessionMetadata({ op: "catalog_complete" })).toBe(false);
      const boot = await primeSessionListIndex().catch((e) => e);
      expect(boot).toBeInstanceOf(SessionListUnavailableError);
      expect(await sessionMetadata({ op: "catalog_complete" })).toBe(false);
      expect(await indexedSessions("include")).toBeNull();
      // The explicit operator step projects the files and marks the
      // catalogs; only then does the gateway boot, and it lists every file.
      await seedSessionCatalogsFromFiles();
      await primeSessionListIndex();
      const ids = (await indexedSessions("include"))?.map((s) => s.id) ?? [];
      expect(ids).toContain("file-only");
      expect(ids).toContain("slack-C0DISK-1789056158.000001");
    } finally {
      error.mockRestore();
    }
  });

  test("a detail read serves the committed catalog document, falling back to the file", async () => {
    const { sessionMetadata } = await import("./session-kernel");
    const { readNativeSessionAsync } = await import("./session-cache");

    // The catalog holds a newer document than the derived file.
    fs.writeFileSync(
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
    fs.writeFileSync(
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
    const { upsertIndexedSessions } = await import("./session-list-store");
    const { __resetSessionRowPublishesForTest, __scheduledSessionRowsForTest } =
      await import("./session-row-events");
    const { allClients } = await import("./ws-hub");

    await freshListIndex();
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
      }) as unknown as UnifiedSession;
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

  test("the offline seed projects files, sidecars and agent sources, then marks the catalogs", async () => {
    await resetCatalogState();
    await freshKernelStore();
    await freshListIndex();
    const { sessionMetadata } = await import("./session-kernel");
    const { seedSessionCatalogsFromFiles } =
      await import("./session-source-scan");
    const { agentSessionCatalogSources } =
      await import("./agent-session-catalog");
    const { primeSessionListIndex } = await import("./session-cache");
    const { indexedSessions } = await import("./session-list-store");

    fs.writeFileSync(
      join(sessionsDir, "seeded-native.json"),
      sessionDoc("seeded-native", "Seeded native"),
    );
    fs.writeFileSync(
      join(sessionsDir, "slack-C0SEED-1789056158.000003.json"),
      JSON.stringify({ workspaceId: "ws-seeded", rev: 4 }),
    );
    fs.writeFileSync(
      join(sessionsDir, "active-runs.json"),
      JSON.stringify({ runs: [] }),
    );
    fs.writeFileSync(
      join(slackDir, "C0SEED-1789056158.000003.json"),
      JSON.stringify(
        slackFile({
          channel: "C0SEED",
          threadTs: "1789056158.000003",
          claudeSessionId: "engine-slack-seed",
        }),
      ),
    );
    fs.writeFileSync(
      join(slackDir, "message-queue.json"),
      JSON.stringify({ queue: [] }),
    );

    const lines: string[] = [];
    const dry = await seedSessionCatalogsFromFiles({
      dryRun: true,
      log: (line) => lines.push(line),
    });
    expect(dry.native.inserted).toBe(0);
    expect(await sessionMetadata({ op: "catalog_complete" })).toBe(false);

    const summary = await seedSessionCatalogsFromFiles({
      log: (line) => lines.push(line),
    });
    expect(summary.native.sidecars).toBe(1);
    expect(summary.native.inserted).toBeGreaterThanOrEqual(2);
    expect(summary.native.markedComplete).toBe(true);
    expect(summary.agents.slack.markedComplete).toBe(true);
    expect(summary.agents.linear.markedComplete).toBe(true);
    const sidecar = await sessionMetadata({
      op: "catalog_get",
      sessionId: "slack-C0SEED-1789056158.000003",
    });
    expect(sidecar?.rev).toBe(4);
    expect(
      (await agentSessionCatalogSources("slack")).map((s) => s.file),
    ).toContain("C0SEED-1789056158.000003.json");

    await primeSessionListIndex();
    const rows = await indexedSessions("include");
    expect(
      rows?.find((s) => s.id === "slack-C0SEED-1789056158.000003"),
    ).toMatchObject({ source: "slack", workspaceId: "ws-seeded" });
    expect(rows?.some((s) => s.id === "seeded-native")).toBe(true);
    // Re-running seeds nothing and keeps the marks.
    const again = await seedSessionCatalogsFromFiles();
    expect(again.native.inserted).toBe(0);
    expect(again.native.alreadyComplete).toBe(true);

    // The boot-time seed (unlessComplete) trusts the marks and never reaches
    // the source files: a file dropped in after completion is not seen, and
    // the summary reports no scan at all. The operator rescan still walks.
    fs.writeFileSync(
      join(sessionsDir, "after-complete.json"),
      sessionDoc("after-complete", "Written after completion"),
    );
    const bootLines: string[] = [];
    const boot = await seedSessionCatalogsFromFiles({
      unlessComplete: true,
      log: (line) => bootLines.push(line),
    });
    expect(boot.skipped).toBe(true);
    expect(boot.native.rows).toEqual([]);
    expect(boot.native.inserted).toBe(0);
    expect(bootLines).toHaveLength(1);
    expect(bootLines[0]).toContain("nothing to scan");
    expect(
      await sessionMetadata({ op: "catalog_get", sessionId: "after-complete" }),
    ).toBeNull();
    const rescan = await seedSessionCatalogsFromFiles({
      unlessComplete: false,
    });
    expect(rescan.skipped).toBe(false);
    expect(rescan.native.inserted).toBe(1);
  });

  test("the boot-time seed scans when any completion marker is missing", async () => {
    await resetCatalogState();
    await freshKernelStore();
    await freshListIndex();
    const { sessionMetadata } = await import("./session-kernel");
    const { seedSessionCatalogsFromFiles, sessionCatalogsComplete } =
      await import("./session-source-scan");

    expect(await sessionCatalogsComplete()).toEqual({
      metadata: false,
      slack: false,
      linear: false,
    });
    fs.writeFileSync(
      join(sessionsDir, "fresh-native.json"),
      sessionDoc("fresh-native", "Fresh native"),
    );
    const first = await seedSessionCatalogsFromFiles({ unlessComplete: true });
    expect(first.skipped).toBe(false);
    // Earlier tests left files in the shared sessions dir; the fresh one is
    // among the rows this run seeded.
    expect(first.native.inserted).toBeGreaterThanOrEqual(1);
    expect(
      await sessionMetadata({ op: "catalog_get", sessionId: "fresh-native" }),
    ).not.toBeNull();
    expect(first.native.markedComplete).toBe(true);
    expect(await sessionCatalogsComplete()).toEqual({
      metadata: true,
      slack: true,
      linear: true,
    });
    // Only the metadata mark counts as partial: the agent imports alone do
    // not make the catalogs the authority, so the seed still runs.
    await resetCatalogState();
    await freshKernelStore();
    await freshListIndex();
    await sessionMetadata({ op: "mark_catalog_complete" });
    const partial = await seedSessionCatalogsFromFiles({
      unlessComplete: true,
    });
    expect(partial.skipped).toBe(false);
    expect(partial.native.alreadyComplete).toBe(true);
    expect(partial.agents.slack.markedComplete).toBe(true);
  });
});
