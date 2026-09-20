import { getConfigAsync } from "./config";
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeSessionFile, UnifiedSession } from "./types";

const home = join(tmpdir(), `session-cache-followups-${crypto.randomUUID()}`);
const sessionsDir = join(home, ".opensession-sessions");
const prior = {
  HOME: process.env.HOME,
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_CONFIG: process.env.OPENSESSION_CONFIG,
};
let priorSessionsDir: string;
let cache: typeof import("./session-cache");
let kernel: typeof import("./session-kernel");
let index: typeof import("./session-list-store");
let rows: typeof import("./session-row-events");

function doc(
  id: string,
  extra: Partial<NativeSessionFile> = {},
): NativeSessionFile {
  return {
    id,
    claudeSessionId: "",
    branch: "main",
    worktreeDir: "",
    createdBy: "Ada",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActivity: "2026-09-01T00:00:00.000Z",
    title: id,
    model: "fallback",
    ...extra,
  };
}
const pathFor = (id: string) => join(sessionsDir, `${id}.json`);
const writeDoc = (id: string, data: unknown) =>
  fs.writeFileSync(pathFor(id), JSON.stringify(data));

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
  cache = await import("./session-cache");
  kernel = await import("./session-kernel");
  index = await import("./session-list-store");
  rows = await import("./session-row-events");
  index.__setSessionListStoreForTest(new index.SessionListStore(":memory:"));
  const { nativeSessionListRowFromData } = await import("./sessions");
  await index.upsertIndexedSessions(
    [
      nativeSessionListRowFromData(doc("publish-canonical"), ["publish-alias"]),
      nativeSessionListRowFromData(doc("publish-race"), ["publish-race-alias"]),
      nativeSessionListRowFromData(doc("../invalid"), ["invalid-alias"]),
    ],
    "include",
  );
  await cache.getCachedSessionsAsync("include");
});
afterEach(() => rows.__resetSessionRowPublishesForTest());
afterAll(async () => {
  index.__setSessionListStoreForTest(undefined);
  (await import("./paths")).__setSessionsDirForTest(priorSessionsDir);
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("external publication reads the canonical file asynchronously and preserves alias overlays", async () => {
  const id = "publish-canonical";
  await cache.updateSessionFile(id, () => doc(id));
  // This publisher also serves writes outside the facade: do not silently
  // substitute the older catalog copy for the externally changed file.
  writeDoc(id, doc(id, { model: "external-model" }));
  (await import("./title-overrides")).setTitleOverride(
    "publish-alias",
    "Alias title",
  );
  const read = spyOn(fs, "readFileSync");
  const exists = spyOn(fs, "existsSync");
  try {
    await cache.publishSessionChange("publish-alias");
    expect(read.mock.calls.filter(([path]) => path === pathFor(id))).toEqual(
      [],
    );
    expect(exists.mock.calls.filter(([path]) => path === pathFor(id))).toEqual(
      [],
    );
  } finally {
    read.mockRestore();
    exists.mockRestore();
  }
  expect(await index.indexedSession(id)).toMatchObject({
    id,
    model: "external-model",
    title: "Alias title",
    aliasIds: ["publish-alias"],
  });
  expect(rows.__scheduledSessionRowsForTest()).toContain(id);
  expect(rows.__scheduledSessionRowsForTest()).not.toContain("publish-alias");
});

test.each(["slack", "linear"] as const)(
  "%s publication keeps source fields and no-id sidecar extras",
  async (source) => {
    const key =
      source === "slack" ? "C0FOLLOW-1789056158.000001" : "followup-branch";
    const id = `${source}-${key}`;
    const dir = join(home, `.${source}-sessions`);
    const sourcePath = join(dir, `${key}.json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        branch: key,
        title: "Source title",
        model: "source-model",
        claudeSessionId: "source-engine",
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    writeDoc(id, {
      workspaceId: "ws-followup",
      title: "stale",
      model: "stale",
    });
    const read = spyOn(fs, "readFileSync");
    const exists = spyOn(fs, "existsSync");
    const stat = spyOn(fs, "statSync");
    try {
      await cache.publishSessionChange(id);
      for (const spy of [read, exists, stat])
        expect(
          spy.mock.calls.filter(
            ([path]) => path === sourcePath || path === pathFor(id),
          ),
        ).toEqual([]);
    } finally {
      read.mockRestore();
      exists.mockRestore();
      stat.mockRestore();
    }
    expect(await index.indexedSession(id)).toMatchObject({
      id,
      source,
      title: source === "slack" ? "Source title" : key,
      model: "source-model",
      claudeSessionId: "source-engine",
      workspaceId: "ws-followup",
    });
  },
);

test("missing and invalid canonical publications perform no unsafe lookup", async () => {
  const read = spyOn(fsp, "readFile");
  try {
    await cache.publishSessionChange("invalid-alias");
    expect(read).not.toHaveBeenCalled();
    await cache.publishSessionChange("missing");
    expect(await index.indexedSession("missing")).toBeNull();
    expect(rows.__scheduledSessionRowsForTest()).toEqual([
      "invalid-alias",
      "missing",
    ]);
  } finally {
    read.mockRestore();
  }
});

test("external alias publication holds the canonical lock until the index write completes", async () => {
  const id = "publish-race";
  await cache.updateSessionFile(id, () => doc(id, { model: "old" }));
  rows.__resetSessionRowPublishesForTest();
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  class GatedIndex extends index.SessionListStore {
    override upsert(row: UnifiedSession): void {
      if (row.id !== id || row.model !== "old") return super.upsert(row);
      reached.resolve();
      // The compatibility backend awaits a promise just as it awaits a worker reply.
      return gate.promise.then(() => super.upsert(row)) as unknown as void;
    }
  }
  const healthy = index.__setSessionListStoreForTest(
    new GatedIndex(":memory:"),
  )!;
  let publication: Promise<void> | undefined;
  let writer: Promise<void> | undefined;
  try {
    publication = cache.publishSessionChange("publish-race-alias");
    await reached.promise;
    expect(rows.__scheduledSessionRowsForTest()).toEqual([]);
    writer = cache.updateSessionFile(id, (data) => ({ ...data, model: "new" }));
    await Bun.sleep(0);
    expect(
      (await kernel.sessionMetadata({ op: "get", sessionId: id }))?.rev,
    ).toBe(1);
    gate.resolve();
    await Promise.all([publication, writer]);
    expect(await index.indexedSession(id)).toMatchObject({
      model: "new",
      aliasIds: ["publish-race-alias"],
    });
  } finally {
    gate.resolve();
    await Promise.all([publication, writer]);
    index.__setSessionListStoreForTest(healthy);
  }
});

test("publication failures are caught without announcing a stale or removed row", async () => {
  const id = "publish-failure";
  writeDoc(id, doc(id));
  const store = index.__setSessionListStoreForTest(undefined)!;
  index.__setSessionListStoreForTest(store);
  const upsert = spyOn(store, "upsert").mockImplementation(() => {
    throw new Error("index unavailable");
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await cache.publishSessionChange(id);
    expect(rows.__scheduledSessionRowsForTest()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    upsert.mockRestore();
    warn.mockRestore();
  }
  await cache.publishSessionChange(id);
  expect(rows.__scheduledSessionRowsForTest()).toEqual([id]);
});

test("retry observes committed metadata rather than a stale export, without synchronous reads", async () => {
  const id = "retry-committed";
  await cache.updateSessionFile(id, () =>
    doc(id, { autoFallbackModel: "original" }),
  );
  writeDoc(id, doc(id)); // export trails the actor, with no fallback marker
  const read = spyOn(fs, "readFileSync");
  const exists = spyOn(fs, "existsSync");
  try {
    expect(await cache.retryAutoFallbackModel(id)).toMatchObject({
      fromModel: "fallback",
      model: "original",
    });
    expect(read.mock.calls.filter(([path]) => path === pathFor(id))).toEqual(
      [],
    );
    expect(exists.mock.calls.filter(([path]) => path === pathFor(id))).toEqual(
      [],
    );
  } finally {
    read.mockRestore();
    exists.mockRestore();
  }
  const stored = await kernel.sessionMetadata({ op: "get", sessionId: id });
  expect(JSON.parse(stored!.doc)).toMatchObject({ model: "original" });
  expect(JSON.parse(stored!.doc)).not.toHaveProperty("autoFallbackModel");
  expect(await cache.retryAutoFallbackModel(id)).toBeUndefined();
});

test.each(["original", null])(
  "fallback %s stays selected until one hour, then retries only once",
  async (original) => {
    const id = `retry-cooldown-${original}`;
    const switchedAt = Date.now();
    await cache.updateSessionFile(id, () =>
      doc(id, { model: original ?? undefined }),
    );
    const entry = {
      model: "fallback",
      from: original ?? undefined,
      at: new Date(switchedAt).toISOString(),
      by: "auto-switch — out of credits",
    };
    expect(
      await cache.persistAutoModelSwitch({
        sessionId: id,
        expectedModel: original ?? undefined,
        model: "fallback",
        entry,
      }),
    ).toBe(true);
    const before = await kernel.sessionMetadata({ op: "get", sessionId: id });
    const now = spyOn(Date, "now").mockReturnValue(
      switchedAt + 60 * 60 * 1000 - 1,
    );
    try {
      expect(await cache.retryAutoFallbackModel(id)).toBeUndefined();
      expect(await cache.retryAutoFallbackModel(id)).toBeUndefined();
      // Skipped retries do not write metadata, clear the marker, or add notices.
      expect(
        await kernel.sessionMetadata({ op: "get", sessionId: id }),
      ).toEqual(before);
      now.mockReturnValue(switchedAt + 60 * 60 * 1000);
      expect(await cache.retryAutoFallbackModel(id)).toMatchObject({
        fromModel: "fallback",
        model: original ?? (await import("./models")).getDefaultModel(),
      });
      expect(await cache.retryAutoFallbackModel(id)).toBeUndefined();
      const stored = JSON.parse(
        (await kernel.sessionMetadata({ op: "get", sessionId: id }))!.doc,
      );
      expect(stored.modelHistory).toHaveLength(2);
      expect(stored.autoFallbackModel).toBeUndefined();

      // If the probe fails again, it starts a fresh cooldown.
      expect(
        await cache.persistAutoModelSwitch({
          sessionId: id,
          expectedModel: original ?? undefined,
          model: "fallback",
          entry: { ...entry, at: new Date(Date.now()).toISOString() },
        }),
      ).toBe(true);
      expect(await cache.retryAutoFallbackModel(id)).toBeUndefined();
      now.mockReturnValue(switchedAt + 2 * 60 * 60 * 1000);
      expect(await cache.retryAutoFallbackModel(id)).toBeDefined();
    } finally {
      now.mockRestore();
    }
  },
);

test("a newer fallback with unchanged models restarts the cooldown during retry", async () => {
  const id = "retry-cooldown-race";
  const entry = {
    model: "fallback",
    from: "original",
    at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    by: "auto-switch — out of credits",
  };
  await cache.updateSessionFile(id, () =>
    doc(id, {
      autoFallbackModel: "original",
      modelHistory: [entry],
    }),
  );
  const { withSessionMutationLock } = await import("./session-mutation-lock");
  const gate = Promise.withResolvers<void>();
  const holder = withSessionMutationLock(id, () => gate.promise);
  const newerFallback = cache.updateSessionFile(id, (data) => ({
    ...data,
    modelHistory: [
      ...(data.modelHistory ?? []),
      { ...entry, at: new Date().toISOString() },
    ],
  }));
  const retry = cache.retryAutoFallbackModel(id);
  try {
    await Bun.sleep(0);
  } finally {
    gate.resolve();
  }
  await Promise.all([holder, newerFallback]);
  expect(await retry).toBeUndefined();
  const stored = JSON.parse(
    (await kernel.sessionMetadata({ op: "get", sessionId: id }))!.doc,
  );
  expect(stored.model).toBe("fallback");
  expect(stored.autoFallbackModel).toBe("original");
  expect(stored.modelHistory).toHaveLength(2);
});

test("retry seeds legacy metadata asynchronously and preserves an inherited default", async () => {
  const id = "retry-legacy";
  writeDoc(id, doc(id, { autoFallbackModel: null }));
  const read = spyOn(fs, "readFileSync");
  try {
    expect(await cache.retryAutoFallbackModel(id)).toMatchObject({
      model: (await import("./models")).getDefaultModel(),
    });
    expect(read.mock.calls.filter(([path]) => path === pathFor(id))).toEqual(
      [],
    );
  } finally {
    read.mockRestore();
  }
  const stored = JSON.parse(
    (await kernel.sessionMetadata({ op: "get", sessionId: id }))!.doc,
  );
  expect(stored).not.toHaveProperty("model");
  expect(stored).not.toHaveProperty("autoFallbackModel");
});

test("missing, malformed and invalid retry observations do not create metadata", async () => {
  writeDoc("retry-no-marker", doc("retry-no-marker"));
  fs.writeFileSync(pathFor("retry-malformed"), "{");
  for (const id of [
    "retry-missing",
    "retry-malformed",
    "retry-no-marker",
    "../escape",
  ]) {
    expect(await cache.retryAutoFallbackModel(id)).toBeUndefined();
    expect(
      await kernel.sessionMetadata({ op: "get", sessionId: id }),
    ).toBeNull();
  }
});

test.each(["model", "autoFallbackModel"] as const)(
  "a concurrent explicit change to %s wins over retry",
  async (field) => {
    const id = `retry-race-${field}`;
    await cache.updateSessionFile(id, () =>
      doc(id, { autoFallbackModel: "original" }),
    );
    const { withSessionMutationLock } = await import("./session-mutation-lock");
    const gate = Promise.withResolvers<void>();
    const holder = withSessionMutationLock(id, () => gate.promise);
    const human = cache.updateSessionFile(id, (data) => ({
      ...data,
      [field]: "human",
    }));
    const retry = cache.retryAutoFallbackModel(id);
    try {
      // Both operations have yielded, while the human's write owns the next slot.
      await Bun.sleep(0);
    } finally {
      gate.resolve();
    }
    await Promise.all([holder, human]);
    expect(await retry).toBeUndefined();
    expect(
      JSON.parse(
        (await kernel.sessionMetadata({ op: "get", sessionId: id }))!.doc,
      )[field],
    ).toBe("human");
  },
);

test("an unavailable metadata worker does not fall back to a file", async () => {
  const id = "retry-unavailable";
  writeDoc(id, doc(id, { autoFallbackModel: "original" }));
  const metadata = spyOn(kernel, "sessionMetadata").mockRejectedValue(
    new Error("worker unavailable"),
  );
  const read = spyOn(fsp, "readFile");
  try {
    expect(await cache.retryAutoFallbackModel(id)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  } finally {
    metadata.mockRestore();
    read.mockRestore();
  }
});

test("a CAS conflict cannot report an automatic retry that never committed", async () => {
  const id = "retry-conflict";
  await cache.updateSessionFile(id, () =>
    doc(id, { autoFallbackModel: "original" }),
  );
  const store = kernel.__sessionKernelStoreForTest();
  const put = store.putSessionMetadata.bind(store);
  let raced = false;
  const spy = spyOn(store, "putSessionMetadata").mockImplementation(
    (request) => {
      if (request.sessionId === id && !raced) {
        raced = true;
        put({
          ...request,
          requestId: crypto.randomUUID(),
          doc: JSON.stringify(doc(id, { model: "human" })),
        });
      }
      return put(request);
    },
  );
  try {
    expect(await cache.retryAutoFallbackModel(id)).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
  expect(raced).toBe(true);
  expect(
    JSON.parse(
      (await kernel.sessionMetadata({ op: "get", sessionId: id }))!.doc,
    ),
  ).toMatchObject({ model: "human" });
});
