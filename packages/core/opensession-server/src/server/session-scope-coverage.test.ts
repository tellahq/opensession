import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionKernelStore } from "./session-kernel/store";
import type { SessionListStore } from "./session-list-sqlite";
import type { UnifiedSession } from "./types";
const root = mkdtempSync(join(tmpdir(), "scope-coverage-"));
const previous = {
  HOME: process.env.HOME,
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_CONFIG: process.env.OPENSESSION_CONFIG,
};
let oldDir: string, kernel: SessionKernelStore, index: SessionListStore;
let oldKernel: SessionKernelStore | undefined,
  oldIndex: SessionListStore | undefined;
const a = { githubAccountId: 101 },
  b = { githubAccountId: 202 };
function row(id: string, patch: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id,
    title: id,
    source: "opensession",
    claudeSessionId: null,
    worktreeDir: null,
    branch: "same",
    workspaceId: "shared-workspace",
    createdBy: "Alice",
    startedBy: "Alice",
    isRunning: false,
    transcriptPath: null,
    createdAt: "2026-01-01",
    lastActivity: "2026-01-01",
    ...patch,
  };
}
function seed(id: string, owner: number) {
  kernel.seedSessionMetadataCatalog([
    {
      sessionId: id,
      doc: JSON.stringify({
        ...row(id),
        accessScope: owner
          ? { kind: "personal", ownerGithubAccountId: owner }
          : { kind: "shared" },
      }),
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
  ]);
}
beforeAll(async () => {
  process.env.HOME = root;
  process.env.OPENSESSION_STATE_DIR = root;
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  writeFileSync(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({
      repos: { demo: { repo: root, ghRepo: "synthetic/demo" } },
    }),
  );
  mkdirSync(join(root, "sessions"));
  oldDir = (await import("./paths")).__setSessionsDirForTest(
    join(root, "sessions"),
  );
});
beforeEach(async () => {
  kernel = new (await import("./session-kernel/store")).SessionKernelStore(
    ":memory:",
  );
  oldKernel = (
    await import("./session-kernel/kernel")
  ).__setSessionKernelStoreForTest(kernel);
  index = new (await import("./session-list-sqlite")).SessionListStore(
    ":memory:",
  );
  index.replaceAll([]);
  oldIndex = (
    await import("./session-list-store")
  ).__setSessionListStoreForTest(index);
});
afterEach(async () => {
  (await import("./session-list-store")).__setSessionListStoreForTest(oldIndex);
  (await import("./session-kernel/kernel")).__setSessionKernelStoreForTest(
    oldKernel,
  );
  kernel.close();
  index.close();
});
afterAll(async () => {
  (await import("./paths")).__setSessionsDirForTest(oldDir);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("warm shared data cannot outlive private authority; payload scope never authorizes", async () => {
  const cache = await import("./session-cache"),
    lists = await import("./session-list-store");
  index.replaceAll([row("private"), row("shared")]);
  expect((await cache.getCachedSessionsAsync()).map((s) => s.id)).toContain(
    "private",
  );
  seed("private", 101);
  expect((await cache.getCachedSessionsAsync()).map((s) => s.id)).toEqual([
    "shared",
  ]);
  expect(await lists.indexedCount()).toBe(1);
  expect(await lists.indexedCount(b)).toBe(1);
  expect(await lists.indexedCount(a)).toBe(2);
  for (const accessScope of [
    undefined,
    null,
    { kind: "shared" },
    { kind: "personal", ownerGithubAccountId: 202 },
  ]) {
    index.upsert(row("private", { accessScope } as Partial<UnifiedSession>));
    expect(await lists.indexedSession("private")).toBeNull();
    expect(await lists.indexedSession("private", b)).toBeNull();
    expect((await lists.indexedSession("private", a))?.accessScope).toEqual({
      kind: "personal",
      ownerGithubAccountId: 101,
    });
  }
});

test("scope predicates precede ranking/counts, selected archive and workspace grouping", async () => {
  const lists = await import("./session-list-store"),
    { withSessionScopeFence } = await import("./session-scope-coverage");
  for (let i = 0; i < 12; i++) {
    seed(`p${i}`, 101);
    index.upsert(
      row(`p${i}`, {
        automation: "same-goal",
        workspaceId: "private-workspace",
      }),
    );
  }
  seed("archive", 101);
  index.upsert(
    row("archive", { archived: true, workspaceId: "private-workspace" }),
  );
  index.upsert(row("shared", { automation: "same-goal" }));
  const shared = await lists.indexedSidebarSessions("archive", b);
  expect(shared?.map((s) => s.id)).toEqual(["shared"]);
  expect(shared?.[0]?.automationRunCount).toBe(1);
  const own = await lists.indexedSidebarSessions("archive", a);
  expect(own?.some((s) => s.id === "archive")).toBe(true);
  expect(own?.find((s) => s.automation)?.automationRunCount).toBe(13);
  expect(await lists.indexedActiveWorkspaceIds()).toEqual(["shared-workspace"]);
  expect(await lists.indexedWorkspaceMembers("private-workspace")).toEqual([]);
  expect(
    await withSessionScopeFence(async () =>
      index.listWorkspaceMembers("private-workspace", a),
    ),
  ).toHaveLength(13);
  expect(
    await withSessionScopeFence(async () =>
      index.listWorkspace("private-workspace", null, a),
    ),
  ).toHaveLength(1);
});

test("ownership change during enrichment discards the complete result", async () => {
  const { withSessionScopeFence } = await import("./session-scope-coverage");
  index.upsert(row("private"));
  let resume!: () => void, entered!: () => void;
  const waiting = new Promise<void>((done) => {
      entered = done;
    }),
    pause = new Promise<void>((done) => {
      resume = done;
    });
  const read = withSessionScopeFence(async () => {
    const rows = index.list();
    entered();
    await pause;
    return rows;
  });
  await waiting;
  seed("private", 101);
  resume();
  expect(await read).toEqual([]);
  expect(await (await import("./session-list-store")).indexedCount()).toBe(0);
});

test("paged deltas stop at applied rows even with a tombstone between pages", async () => {
  for (let i = 0; i < 5; i++) {
    seed(`p${i}`, 101);
    index.upsert(row(`p${i}`));
  }
  const original = kernel.sessionScopeChanges.bind(kernel);
  let first = true;
  const changes = spyOn(kernel, "sessionScopeChanges").mockImplementation(
    (after) => {
      const page = original(after, 2);
      if (first) {
        first = false;
        kernel.clearSession("p0");
      }
      return page;
    },
  );
  const through: number[] = [],
    apply = index.applyScopeDelta.bind(index);
  const application = spyOn(index, "applyScopeDelta").mockImplementation(
    (expected, delta) => {
      apply(expected, delta);
      through.push(index.scopeState()!.generation);
    },
  );
  try {
    expect(await (await import("./session-list-store")).indexedCount(a)).toBe(
      4,
    );
    expect(through).toEqual([2, 4, 6]);
    expect(index.scopeState()).toMatchObject(kernel.sessionScopeFence());
  } finally {
    changes.mockRestore();
    application.mockRestore();
  }
});

test("authority/replica failure cannot serve warm cache; old deltas cannot revive deletion", async () => {
  const cache = await import("./session-cache"),
    lists = await import("./session-list-store");
  seed("private", 101);
  index.upsert(row("private"));
  await cache.getCachedSessionsAsync();
  const oldDelta = kernel.sessionScopeChanges(0, 1000);
  const unavailable = spyOn(kernel, "sessionScopeFence").mockImplementation(
    () => {
      throw new Error("offline");
    },
  );
  try {
    await expect(cache.getCachedSessionsAsync()).rejects.toThrow("unavailable");
  } finally {
    unavailable.mockRestore();
  }
  const offlineIndex = spyOn(index, "scopeState").mockImplementation(() => {
    throw new Error("worker offline");
  });
  try {
    await expect(cache.getCachedSessionsAsync()).rejects.toThrow("unavailable");
  } finally {
    offlineIndex.mockRestore();
  }
  kernel.clearSession("private");
  expect(await lists.indexedCount(a)).toBe(0);
  expect(() =>
    index.applyScopeDelta({ ...index.scopeState()!, generation: 0 }, oldDelta),
  ).toThrow("Scope replica changed");
  index.resetScopeReplica(oldDelta.fence.incarnation);
  index.applyScopeDelta({ ...index.scopeState()!, generation: 0 }, oldDelta);
  expect(await lists.indexedCount(a)).toBe(0);
});

test("new authority with matching counters cannot reuse old coverage or old payloads", async () => {
  seed("private", 101);
  index.upsert(row("private", { title: "old A data" }));
  const lists = await import("./session-list-store");
  expect(await lists.indexedCount(a)).toBe(1);
  const original = kernel,
    replacement = new (
      await import("./session-kernel/store")
    ).SessionKernelStore(":memory:");
  kernel = replacement;
  seed("private", 202);
  expect(replacement.sessionScopeFence().generation).toBe(
    original.sessionScopeFence().generation,
  );
  (await import("./session-kernel/kernel")).__setSessionKernelStoreForTest(
    replacement,
  );
  try {
    await expect(lists.indexedCount(b)).rejects.toThrow("unavailable");
    expect(await lists.indexedSessions("include", b)).toBeNull();
    expect(index.scopeState()?.incarnation).toBe(
      replacement.sessionScopeFence().incarnation,
    );
  } finally {
    replacement.close();
    kernel = original;
    (await import("./session-kernel/kernel")).__setSessionKernelStoreForTest(
      original,
    );
  }
});

test("persistent aliases deny collisions and tombstones deny exports, reused ids and recovery", async () => {
  const cache = await import("./session-cache");
  seed("private", 101);
  seed("other", 202);
  kernel.registerSessionScopeAliases([
    { id: "private", aliases: ["historical"] },
  ]);
  expect(() =>
    kernel.registerSessionScopeAliases([
      { id: "other", aliases: ["historical"] },
    ]),
  ).toThrow("conflict");
  expect(kernel.sessionMetadataCatalogRead("historical", b)).toEqual({
    status: "denied",
  });
  expect(kernel.sessionMetadataCatalogRead("historical", a).status).toBe(
    "found",
  );
  kernel.clearSession("private");
  writeFileSync(
    join(root, "sessions/private.json"),
    JSON.stringify(row("private")),
  );
  index.upsert(row("private", { aliasIds: ["historical"] }));
  expect(await cache.findSessionAsync("private", a)).toBeUndefined();
  expect(await cache.findSessionAsync("historical", a)).toBeUndefined();
  expect(() => seed("private", 0)).toThrow("Session not found");
  expect(() =>
    kernel.settleSessionMetadataCatalog("private", {
      sessionId: "private",
      doc: JSON.stringify(row("private")),
      rev: 2,
      archived: false,
      lastActivityMs: 1,
      updatedAt: 1,
    }),
  ).toThrow("Session not found");
  expect(() =>
    kernel.registerSessionScopeAliases([
      { id: "other", aliases: ["historical"] },
    ]),
  ).toThrow("conflict");
});

test("synchronous collection access cannot bypass a warm scope fence", async () => {
  const cache = await import("./session-cache");
  index.upsert(row("shared"));
  await cache.getCachedSessionsAsync();
  expect(() => cache.getCachedSessions()).toThrow(
    "Synchronous session collections are not authorized",
  );
});

test("running child holds retain shared children and deny private children and unavailable authority", async () => {
  const runner = await import("./agent-runner");
  const { runningChildCount, sessionMentionsNote } =
    await import("./run-session");
  seed("private-child", 101);
  index.upsert(
    row("private-child", {
      parentSessionId: "parent",
      claudeSessionId: "private-engine",
    }),
  );
  index.upsert(
    row("shared-child", {
      parentSessionId: "parent",
      claudeSessionId: "shared-engine",
    }),
  );
  const busy = spyOn(runner, "isAgentSessionBusy").mockReturnValue(true);
  try {
    expect(await runningChildCount("parent")).toBe(1);
  } finally {
    busy.mockRestore();
  }
  const unavailable = spyOn(kernel, "sessionScopeFence").mockImplementation(
    () => {
      throw new Error("offline");
    },
  );
  try {
    await expect(runningChildCount("parent")).rejects.toThrow("unavailable");
    await expect(
      sessionMentionsNote("Check @session:os-aaaa-1"),
    ).rejects.toThrow("unavailable");
  } finally {
    unavailable.mockRestore();
  }
});

test("chained same-owner canonical merges flatten every alias and retain deletion denial", () => {
  kernel.registerSessionScopeAliases([{ id: "old", aliases: ["engine"] }]);
  kernel.registerSessionScopeAliases([{ id: "new", aliases: ["old"] }]);
  kernel.registerSessionScopeAliases([{ id: "newest", aliases: ["new"] }]);
  const records = kernel.sessionScopeChanges(0, 1000).rows;
  for (const id of ["old", "engine", "new"])
    expect(records.find((row) => row.id === id)?.canonicalId).toBe("newest");
  expect(() =>
    kernel.registerSessionScopeAliases([{ id: "engine", aliases: ["newest"] }]),
  ).toThrow("Session not found");
  kernel.tombstoneSessionScope("newest");
  for (const id of ["old", "engine", "new", "newest"]) {
    expect(kernel.sessionMetadataCatalogRead(id).status).toBe("deleted");
    expect(() => seed(id, 0)).toThrow("Session not found");
  }
});

test("failed catalog/alias mutations roll back scope clocks and claims atomically", () => {
  seed("private", 101);
  const before = kernel.sessionScopeFence();
  expect(() =>
    kernel.seedSessionMetadataCatalog([
      {
        sessionId: "first",
        doc: JSON.stringify(row("first")),
        rev: 1,
        archived: false,
        lastActivityMs: 1,
      },
      {
        sessionId: "private",
        doc: JSON.stringify(row("private")),
        rev: 1,
        archived: false,
        lastActivityMs: 1,
      },
    ]),
  ).toThrow("immutable");
  expect(kernel.sessionMetadataCatalogGet("first")).toBeNull();
  expect(kernel.sessionScopeFence()).toEqual(before);
  expect(() =>
    kernel.registerSessionScopeAliases([
      { id: "intruder", aliases: ["private"] },
    ]),
  ).toThrow("conflict");
  expect(kernel.sessionScopeFence()).toEqual(before);
  expect(kernel.sessionScopeChanges(0, 1000).rows.map((row) => row.id)).toEqual(
    ["private"],
  );
});

test("replica reset with matching authority counters invalidates an in-flight read", async () => {
  const { withSessionScopeFence } = await import("./session-scope-coverage");
  seed("private", 101);
  index.upsert(row("shared", { title: "old" }));
  let attempts = 0;
  const rows = await withSessionScopeFence(async () => {
    const result = index.list();
    if (++attempts === 1) {
      const delta = kernel.sessionScopeChanges(0, 1000);
      index.resetScopeReplica(delta.fence.incarnation);
      index.applyScopeDelta(index.scopeState()!, delta);
      index.upsert(row("shared", { title: "new" }));
    }
    return result;
  });
  expect(attempts).toBe(2);
  expect(rows[0]?.title).toBe("new");
});

test("bootstrap filters stale private rows before they can lend fields to shared siblings", async () => {
  seed("private", 101);
  const { filterCollectionSourceRows } = await import("./session-list-store");
  const source = [
    row("private", { prUrl: "https://synthetic/private" }),
    row("shared"),
  ];
  expect(
    (await filterCollectionSourceRows(source)).map((row) => row.id),
  ).toEqual(["shared"]);
});

test("owner caches never populate shared hints or another principal's snapshot", async () => {
  const cache = await import("./session-cache");
  seed("private-a", 101);
  seed("private-b", 202);
  seed("shared", 0);
  index.replaceAll([row("private-a"), row("private-b"), row("shared")]);
  const ids = (rows: UnifiedSession[]) => rows.map((s) => s.id).sort();
  expect(ids(await cache.getCachedSessionsAsync())).toEqual(["shared"]);
  const mutable = { ...a };
  const pendingA = cache.getCachedSessionsAsync("include", mutable);
  mutable.githubAccountId = b.githubAccountId;
  const [rowsA, rowsB] = await Promise.all([
    pendingA,
    cache.getCachedSessionsAsync("include", b),
  ]);
  expect(ids(rowsA)).toEqual(["private-a", "shared"]);
  expect(ids(rowsB)).toEqual(["private-b", "shared"]);
  expect(ids(await cache.getCachedSessionsAsync("include", a))).toEqual([
    "private-a",
    "shared",
  ]);
  expect(ids(await cache.getCachedSessionsAsync())).toEqual(["shared"]);
  expect(ids(cache.peekCachedSessions())).toEqual(["shared"]);
  await expect(
    cache.getCachedSessionsAsync("include", { githubAccountId: NaN }),
  ).rejects.toThrow("Invalid access principal");
});

test("content invalidation refreshes shared and owner snapshots before TTL expiry", async () => {
  const cache = await import("./session-cache");
  seed("private-a", 101);
  seed("shared", 0);
  index.replaceAll([row("private-a"), row("shared")]);
  await cache.getCachedSessionsAsync();
  await cache.getCachedSessionsAsync("include", a);
  index.upsert(row("private-a", { title: "new private title" }));
  index.upsert(row("shared", { title: "new shared title" }));
  cache.markSessionListStale();
  expect((await cache.getCachedSessionsAsync())[0]?.title).toBe(
    "new shared title",
  );
  const own = await cache.getCachedSessionsAsync("include", a);
  expect(own.find((s) => s.id === "private-a")?.title).toBe(
    "new private title",
  );
  expect(own.find((s) => s.id === "shared")?.title).toBe("new shared title");
});

test("an owner view cannot lend private PR references to its shared rows", async () => {
  const cache = await import("./session-cache");
  seed("private-a", 101);
  seed("shared", 0);
  index.replaceAll([
    row("private-a", {
      prs: [
        {
          repo: "demo",
          branch: "private-branch",
          source: "primary",
          number: 7,
          title: "private title",
        },
      ],
    }),
    row("shared"),
  ]);
  const own = await cache.getCachedSessionsAsync("include", a);
  expect(own.find((s) => s.id === "private-a")?.prs?.[0]?.title).toBe(
    "private title",
  );
  expect(own.find((s) => s.id === "shared")?.prs ?? []).toEqual([]);
  expect((await cache.getCachedSessionsAsync())[0]?.prs ?? []).toEqual([]);
});

test("HTTP lists and conditional responses are partitioned by numeric audience and authority epoch", async () => {
  const { handleSessionsRoutes } = await import("./routes/sessions");
  seed("private-a", 101);
  seed("private-b", 202);
  seed("shared", 0);
  index.replaceAll([row("private-a"), row("private-b"), row("shared")]);
  async function request(owner?: number, etag?: string) {
    const url = new URL("http://fixture/api/sessions");
    return (await handleSessionsRoutes({
      req: new Request(url, {
        headers: {
          ...(owner
            ? {
                "X-OpenSession-Privacy": "personal-v1",
                "X-OpenSession-Expected-GitHub-Account-Id": String(owner),
              }
            : {}),
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
      authUser: owner
        ? { login: `owner-${owner}`, name: "Same name", githubAccountId: owner }
        : null,
    }))!;
  }
  const own = await request(101);
  expect(own.status).toBe(200);
  const etag = own.headers.get("etag")!;
  expect(
    ((await own.json()) as UnifiedSession[]).map((s) => s.id).sort(),
  ).toEqual(["private-a", "shared"]);
  expect(own.headers.get("vary")).toContain("Cookie");
  const other = await request(202, etag);
  expect(other.status).toBe(200);
  expect(other.headers.get("etag")).not.toBe(etag);
  expect(
    ((await other.json()) as UnifiedSession[]).map((s) => s.id).sort(),
  ).toEqual(["private-b", "shared"]);
  const legacy = await request(undefined, etag);
  expect(legacy.status).toBe(200);
  expect(((await legacy.json()) as UnifiedSession[]).map((s) => s.id)).toEqual([
    "shared",
  ]);
  expect((await request(101, etag)).status).toBe(304);
  kernel.tombstoneSession("private-a");
  const after = await request(101, etag);
  expect(after.status).toBe(200);
  expect(((await after.json()) as UnifiedSession[]).map((s) => s.id)).toEqual([
    "shared",
  ]);
});

test("owner-only catalog materialization fills private coverage without scanning shared exports", async () => {
  const cache = await import("./session-cache");
  seed("private-a", 101);
  seed("private-b", 202);
  seed("shared", 0);
  index.replaceAll([row("shared")]);
  const { sessionMetadata } = await import("./session-kernel");
  expect(
    (
      await sessionMetadata({
        op: "catalog_private_page",
        afterSessionId: "",
        limit: 10,
        principal: a,
      })
    ).map((item) => item.sessionId),
  ).toEqual(["private-a"]);
  await cache.primePersonalSessionList(a);
  expect(
    (await cache.getCachedSessionsAsync("include", a)).map((s) => s.id).sort(),
  ).toEqual(["private-a", "shared"]);
  expect(index.get("private-b", b)).toBeNull();
  expect((await cache.getCachedSessionsAsync()).map((s) => s.id)).toEqual([
    "shared",
  ]);
});

test("a private materializer cannot write an old page into a reset replica", async () => {
  const { withSessionScopeFence } = await import("./session-scope-coverage");
  seed("private-a", 101);
  const fence = await withSessionScopeFence(async (fence) => fence);
  index.resetScopeReplica(fence.incarnation);
  expect(() => index.upsertScopePage([row("private-a")], fence)).toThrow(
    "Scope changed before projection write",
  );
  expect(index.get("private-a", a)).toBeNull();
});

test("real repository listing includes only compatible owner's registered personal entries", async () => {
  const { personalRepositoryId } =
    await import("./personal-repository-coordinator");
  const { handleWorkspaceRoutes } = await import("./routes/workspace");
  const privateIds = new Map<number, string>();
  for (const owner of [101, 202]) {
    const descriptor = {
      kind: "personal" as const,
      ownerGithubAccountId: owner,
      repositoryOwnerGithubAccountId: owner,
      appRecordId: `app-${owner}`,
      githubAppId: owner + 1000,
      installationId: owner + 2000,
      repositoryId: owner + 3000,
      accessRevision: 1,
      fullName: `owner-${owner}/private`,
    };
    const id = personalRepositoryId(descriptor);
    privateIds.set(owner, id);
    kernel.repositoryCatalogPut({
      op: "repository_put",
      repositoryId: id,
      expectedRev: null,
      principal: { githubAccountId: owner },
      doc: JSON.stringify({
        id,
        accessScope: { kind: "personal", ownerGithubAccountId: owner },
        personalGithub: descriptor,
        blocked: false,
      }),
    });
  }
  async function list(owner: number, protocol?: string, expected = owner) {
    const url = new URL("http://fixture/api/repos");
    const response = (await handleWorkspaceRoutes({
      req: new Request(url, {
        headers: protocol
          ? {
              "X-OpenSession-Privacy": protocol,
              "X-OpenSession-Expected-GitHub-Account-Id": String(expected),
            }
          : {},
      }),
      url,
      path: url.pathname,
      publicPrefix: "",
      authUser: {
        login: `owner-${owner}`,
        name: "Same name",
        githubAccountId: owner,
      },
    }))!;
    expect(response.headers.get("cache-control")).toContain("no-store");
    return ((await response.json()) as { repos: { id: string }[] }).repos.map(
      (repo) => repo.id,
    );
  }
  expect(await list(101, "personal-v1")).toContain(privateIds.get(101)!);
  expect(await list(101, "personal-v1")).not.toContain(privateIds.get(202)!);
  expect(await list(202, "personal-v1")).toContain(privateIds.get(202)!);
  expect(await list(202, "personal-v1")).not.toContain(privateIds.get(101)!);
  expect(await list(101)).not.toContain(privateIds.get(101)!);
  expect(await list(101, "future")).not.toContain(privateIds.get(101)!);
  await expect(list(202, "personal-v1", 101)).rejects.toMatchObject({
    code: "principal_changed",
  });
});
