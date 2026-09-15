import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedSession } from "./types";
import type { SessionKernelStore } from "./session-kernel/store";

const root = mkdtempSync(join(tmpdir(), "session-access-boundary-"));
const prior = {
  HOME: process.env.HOME,
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_CONFIG: process.env.OPENSESSION_CONFIG,
};
let previousSessionsDir: string;
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let index: import("./session-list-sqlite").SessionListStore;
let previousIndex: typeof index | undefined;
const privateId = "synthetic-private";
function doc(id: string, accessScope?: unknown) {
  return {
    id,
    title: id,
    accessScope,
    createdBy: "Alice",
    createdAt: "2026-01-01",
    lastActivity: "2026-01-01",
    model: "claude-haiku-4-5",
  };
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
  const sessions = join(root, "sessions");
  mkdirSync(sessions);
  previousSessionsDir = (await import("./paths")).__setSessionsDirForTest(
    sessions,
  );
  const kernel = await import("./session-kernel/kernel");
  store = new (await import("./session-kernel/store")).SessionKernelStore(
    ":memory:",
  );
  previousStore = kernel.__setSessionKernelStoreForTest(store);
  const lists = await import("./session-list-store");
  index = new lists.SessionListStore(":memory:");
  previousIndex = lists.__setSessionListStoreForTest(index);
  // Both the export and warmed merged cache incorrectly claim shared scope.
  // The authoritative catalog must win for the exact id and every alias.
  writeFileSync(
    join(sessions, `${privateId}.json`),
    JSON.stringify(doc(privateId)),
  );
  writeFileSync(join(sessions, "shared.json"), JSON.stringify(doc("shared")));
  writeFileSync(
    join(sessions, "unregistered-private.json"),
    JSON.stringify(
      doc("unregistered-private", {
        kind: "personal",
        ownerGithubAccountId: 101,
      }),
    ),
  );
  index.replaceAll([
    {
      ...doc("shared-canonical"),
      source: "opensession",
      aliasIds: ["shared-asset-alias"],
      branch: null,
      worktreeDir: null,
      startedBy: "Alice",
      isRunning: false,
      transcriptPath: null,
    } as UnifiedSession,
    {
      ...doc(privateId),
      source: "opensession",
      aliasIds: ["stale-alias"],
      branch: null,
      worktreeDir: null,
      startedBy: "Alice",
      isRunning: false,
      transcriptPath: null,
    } as UnifiedSession,
  ]);
  await (await import("./session-cache")).getCachedSessionsAsync("include");
  store.seedSessionMetadataCatalog([
    {
      sessionId: privateId,
      doc: JSON.stringify(
        doc(privateId, { kind: "personal", ownerGithubAccountId: 101 }),
      ),
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
  ]);
});

afterAll(async () => {
  (await import("./session-kernel/kernel")).__setSessionKernelStoreForTest(
    previousStore,
  );
  (await import("./session-list-store")).__setSessionListStoreForTest(
    previousIndex,
  );
  (await import("./session-cache")).invalidateSessionsCache();
  store.close();
  index.close();
  (await import("./paths")).__setSessionsDirForTest(previousSessionsDir);
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("catalog denial wins over stale shared exports, warmed cache rows and aliases", async () => {
  const { findSessionAsync, readNativeSessionAsync } =
    await import("./session-cache");
  expect(await readNativeSessionAsync(privateId)).toBeUndefined();
  expect(await findSessionAsync(privateId)).toBeUndefined();
  expect(await findSessionAsync("stale-alias")).toBeUndefined();
  expect(
    await findSessionAsync(privateId, { githubAccountId: 202 }),
  ).toBeUndefined();
  expect(
    (await findSessionAsync(privateId, { githubAccountId: 101 }))?.id,
  ).toBe(privateId);
  expect((await findSessionAsync("shared"))?.id).toBe("shared");
  expect(
    await findSessionAsync("unregistered-private", { githubAccountId: 101 }),
  ).toBeUndefined();
});

test("catalog unavailability is terminal even with an existing shared export or alias cache", async () => {
  const fail = spyOn(store, "sessionMetadataCatalogRead").mockImplementation(
    () => {
      throw new Error("synthetic catalog unavailable");
    },
  );
  try {
    const { findSessionAsync } = await import("./session-cache");
    expect(await findSessionAsync("shared")).toBeUndefined();
    expect(await findSessionAsync(privateId)).toBeUndefined();
    expect(await findSessionAsync("stale-alias")).toBeUndefined();
  } finally {
    fail.mockRestore();
  }
});

test("HTTP guard denies exact-id operation families and explicit query/body selectors", async () => {
  const { handleSessionAccessRoutes, sessionAccessTarget } =
    await import("./routes/session-access");
  for (const suffix of [
    "",
    "/transcript",
    "/entry/e",
    "/assets/raw/a.png",
    "/notes",
    "/diff",
    "/worktree-file",
    "/preview",
    "/prompt",
    "/archive",
    "/move-to-branch",
  ]) {
    const url = new URL(`http://demo/api/sessions/${privateId}${suffix}`);
    const ctx = {
      url,
      path: url.pathname,
      req: new Request(url),
      publicPrefix: "",
      authUser: { login: "alice", name: "Alice", githubAccountId: 101 },
    };
    expect((await handleSessionAccessRoutes(ctx))?.status).toBe(404);
  }
  for (const path of [
    "/api/files",
    "/api/skills",
    "/api/mention-suggestions",
  ]) {
    const url = new URL(`http://demo${path}?session=stale-alias`);
    expect(
      (
        await handleSessionAccessRoutes({
          url,
          path,
          req: new Request(url),
          publicPrefix: "",
        })
      )?.status,
    ).toBe(404);
  }
  const url = new URL("http://demo/api/automations/retrigger");
  const req = new Request(url, {
    method: "POST",
    body: JSON.stringify({
      sessionId: privateId,
      user: "Alice",
      principal: { githubAccountId: 101 },
    }),
  });
  expect(
    (
      await handleSessionAccessRoutes({
        url,
        path: url.pathname,
        req,
        publicPrefix: "",
      })
    )?.status,
  ).toBe(404);
  expect((await req.json()).sessionId).toBe(privateId); // Guard must not consume the handler's body.
  for (const path of [
    "/api/sessions",
    "/api/sessions/search",
    "/api/personal/github/status",
  ]) {
    const url = new URL(`http://demo${path}`);
    expect(
      await sessionAccessTarget({
        url,
        path,
        req: new Request(url),
        publicPrefix: "",
      }),
    ).toBeUndefined();
  }
});

test("WS queue, question and terminal ids cannot bypass session authorization", async () => {
  const { SESSION_SCOPED_WS_OPERATIONS, sharedSessionMessageAllowed } =
    await import("./ws-session-access");
  for (const type of SESSION_SCOPED_WS_OPERATIONS) {
    expect(
      await sharedSessionMessageAllowed({
        type,
        sessionId: privateId,
        user: "Alice",
        principal: { githubAccountId: 101 },
      }),
    ).toBe(false);
    expect(
      await sharedSessionMessageAllowed({
        type,
        queueId: "known-queue",
        questionId: "known-ask",
      }),
    ).toBe(false);
  }
  expect(await sharedSessionMessageAllowed({ type: "cancel" }, privateId)).toBe(
    false,
  );
  expect(
    await sharedSessionMessageAllowed({ type: "watch", sessionId: "shared" }),
  ).toBe(true);
});

test("WS denial happens before watching, mailbox admission, ask resolution or host terminal fallback", async () => {
  const { websocketHandlers } = await import("./ws-handlers");
  for (const type of [
    "watch",
    "prompt",
    "delete_queued_prompt",
    "answer_question",
    "cancel",
    "term_start",
  ]) {
    const sent: string[] = [];
    const socket = {
      data: { watchingSessionId: null, user: null },
      send: (message: string) => sent.push(message),
    };
    await websocketHandlers.message!(
      socket as Parameters<NonNullable<typeof websocketHandlers.message>>[0],
      JSON.stringify({
        type,
        sessionId: privateId,
        queueId: "q",
        questionId: "ask",
      }),
    );
    expect(sent.map((message) => JSON.parse(message))).toEqual([
      { type: "error", message: "Session not found" },
    ]);
    expect(socket.data.watchingSessionId).toBeNull();
    expect(store.sessionMetadata(privateId)).toBeNull();
  }
});

test("the shared config registry never strips a claimed personal scope into shared access", async () => {
  const previous = process.env.OPENSESSION_CONFIG;
  const path = join(root, "scope-config.json");
  writeFileSync(
    path,
    JSON.stringify({
      repos: {
        shared: { repo: root, ghRepo: "synthetic/shared" },
        personal: {
          repo: root,
          ghRepo: "synthetic/personal",
          accessScope: { kind: "personal", ownerGithubAccountId: 101 },
          default: true,
        },
        malformed: {
          repo: root,
          ghRepo: "synthetic/malformed",
          accessScope: null,
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = path;
  try {
    const { configuredRepos, defaultRepo } = await import("./config");
    expect(Object.keys(configuredRepos())).toEqual(["shared"]);
    expect(defaultRepo().id).toBe("shared");
  } finally {
    process.env.OPENSESSION_CONFIG = previous;
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("watch arrival is invalidated by unwatch before deferred authorization resumes", async () => {
  const access = await import("./ws-session-access");
  const { websocketHandlers } = await import("./ws-handlers");
  const pending = deferred<{ allowed: boolean; sessionId?: string }>();
  const auth = spyOn(
    access,
    "authorizeSharedSessionMessage",
  ).mockImplementation((msg) =>
    msg.type === "watch" ? pending.promise : Promise.resolve({ allowed: true }),
  );
  const cache = await import("./session-cache");
  const lookup = spyOn(cache, "findSessionAsync").mockResolvedValue(undefined);
  const sent: string[] = [];
  const socket = {
    data: { watchingSessionId: null, user: null, watchRequest: 0 },
    send: (text: string) => sent.push(text),
  };
  const ws = socket as Parameters<
    NonNullable<typeof websocketHandlers.message>
  >[0];
  try {
    const watch = websocketHandlers.message!(
      ws,
      JSON.stringify({ type: "watch", sessionId: "A" }),
    );
    await websocketHandlers.message!(ws, JSON.stringify({ type: "unwatch" }));
    pending.resolve({ allowed: true, sessionId: "A" });
    await watch;
    expect(lookup).not.toHaveBeenCalled();
    expect(socket.data.watchingSessionId).toBeNull();
    expect(socket.data.watchRequest).toBe(2);
    expect(sent).toEqual([]);
  } finally {
    auth.mockRestore();
    lookup.mockRestore();
  }
});

test("two deferred watch authorizations cannot reverse arrival order", async () => {
  const access = await import("./ws-session-access");
  const { websocketHandlers } = await import("./ws-handlers");
  const a = deferred<{ allowed: boolean }>();
  const b = deferred<{ allowed: boolean }>();
  const auth = spyOn(
    access,
    "authorizeSharedSessionMessage",
  ).mockImplementation((msg) =>
    msg.sessionId === "A" ? a.promise : b.promise,
  );
  const cache = await import("./session-cache");
  const lookup = spyOn(cache, "findSessionAsync").mockResolvedValue(undefined);
  const ws = {
    data: { watchingSessionId: null, user: null },
    send() {},
  } as unknown as Parameters<NonNullable<typeof websocketHandlers.message>>[0];
  try {
    const first = websocketHandlers.message!(
      ws,
      JSON.stringify({ type: "watch", sessionId: "A" }),
    );
    const second = websocketHandlers.message!(
      ws,
      JSON.stringify({ type: "watch", sessionId: "B" }),
    );
    b.resolve({ allowed: true });
    await second;
    a.resolve({ allowed: true });
    await first;
    expect(lookup.mock.calls.map((call) => call[0])).toEqual(["B"]);
  } finally {
    auth.mockRestore();
    lookup.mockRestore();
  }
});

test("id-less cancel freezes and canonicalizes its target before mailbox side effects", async () => {
  const access = await import("./ws-session-access");
  const { websocketHandlers } = await import("./ws-handlers");
  const pending = deferred<{ allowed: boolean; sessionId: string }>();
  const authorized: unknown[] = [];
  const auth = spyOn(
    access,
    "authorizeSharedSessionMessage",
  ).mockImplementation((msg) => {
    authorized.push(msg.sessionId);
    return pending.promise;
  });
  const touched: string[] = [];
  const snapshot = spyOn(store, "turnSnapshot").mockImplementation((id) => {
    touched.push(id);
    throw new Error("synthetic stop before mailbox mutation");
  });
  const ws = {
    data: { watchingSessionId: "alias-A", user: null },
    send() {},
  } as unknown as Parameters<NonNullable<typeof websocketHandlers.message>>[0];
  try {
    const cancel = websocketHandlers.message!(
      ws,
      JSON.stringify({ type: "cancel" }),
    );
    ws.data.watchingSessionId = "B";
    pending.resolve({ allowed: true, sessionId: "canonical-A" });
    await cancel;
    expect(authorized).toEqual(["alias-A"]);
    expect(touched).toEqual(["canonical-A"]);
  } finally {
    auth.mockRestore();
    snapshot.mockRestore();
  }
});

test("canonical reauthorization retains merged aliases for historical asset lookup", async () => {
  const cache = await import("./session-cache");
  const id = "shared-canonical";
  const alias = "shared-asset-alias";
  store.seedSessionMetadataCatalog([
    {
      sessionId: id,
      doc: JSON.stringify(doc(id)),
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
  ]);
  expect((await cache.findSessionAsync(alias))?.aliasIds).toEqual([alias]);
  expect(await cache.sessionIdsForAsync(id)).toEqual([id, alias]);
  expect(await cache.sessionIdsForAsync(alias)).toEqual([id, alias]);
  const assets = await import("./session-assets");
  await assets.writeAsset(
    alias,
    "legacy.txt",
    Buffer.from("synthetic legacy asset"),
  );
  expect(
    (
      await assets.readAssetAcross(
        await cache.sessionIdsForAsync(id),
        "legacy.txt",
      )
    )?.sessionId,
  ).toBe(alias);
});

test("re-scoped shared feed retains producer order without token-rate authority RPC or pending closures", async () => {
  const { broadcastToSession, sessionWatchers, globalPresenceFrame } =
    await import("./ws-hub");
  const { publishTranscript, subscribeTranscript } =
    await import("./transcript-bus");
  const { sessionFeedSnapshot } = await import("./session-feed");
  const id = "synthetic-ordered-feed";
  const blocked = deferred<never>();
  const authority = spyOn(
    store,
    "sessionMetadataCatalogRead",
  ).mockImplementation(() => blocked.promise as never);
  const frames: Array<{ event: { type: string } }> = [];
  const ws = {
    data: { watchingSessionId: id, user: "Alice", supportsFeed: true },
    send: (text: string) => frames.push(JSON.parse(text)),
  };
  sessionWatchers.set(id, new Set([ws]));
  const unsubscribe = subscribeTranscript(id, (event) => {
    frames.push(event.feed!);
  });
  try {
    broadcastToSession(id, { type: "stream_start", sessionId: id });
    for (let i = 0; i < 1000; i++)
      broadcastToSession(id, { type: "stream_text", sessionId: id, text: "x" });
    expect(frames.length).toBe(1001); // All live sends finished synchronously.
    publishTranscript(id, {
      entries: [
        {
          id: "committed",
          type: "assistant",
          content: "x".repeat(1000),
          timestamp: new Date().toISOString(),
          seq: 1,
          changeSeq: 1,
        },
      ],
      firstSeq: 1,
      lastSeq: 1,
    });
    await Promise.resolve();
    expect(frames.at(-1)?.event.type).toBe("transcript_append");
    expect(sessionFeedSnapshot(id).active?.text).toBe("");
    broadcastToSession(id, { type: "stream_done", sessionId: id });
    expect(sessionFeedSnapshot(id).active).toBeNull();
    expect(authority).not.toHaveBeenCalled();
    expect(globalPresenceFrame()).not.toBeInstanceOf(Promise); // No stale awaited handshake.
  } finally {
    unsubscribe();
    sessionWatchers.delete(id);
    authority.mockRestore();
  }
});

test("close invalidates a watch still waiting for authority", async () => {
  const access = await import("./ws-session-access");
  const { websocketHandlers } = await import("./ws-handlers");
  const pending = deferred<{ allowed: boolean }>();
  const auth = spyOn(access, "authorizeSharedSessionMessage").mockReturnValue(
    pending.promise,
  );
  const cache = await import("./session-cache");
  const lookup = spyOn(cache, "findSessionAsync").mockResolvedValue(undefined);
  const ws = {
    data: { watchingSessionId: null, user: null },
    send() {},
  } as unknown as Parameters<NonNullable<typeof websocketHandlers.message>>[0];
  try {
    const watch = websocketHandlers.message!(
      ws,
      JSON.stringify({ type: "watch", sessionId: "A" }),
    );
    websocketHandlers.close!(ws, 1000, "test close");
    pending.resolve({ allowed: true });
    await watch;
    expect(lookup).not.toHaveBeenCalled();
    expect(ws.data.watchingSessionId).toBeNull();
  } finally {
    auth.mockRestore();
    lookup.mockRestore();
  }
});

test("restored synchronous handshake cannot overwrite a newer leave with a delayed snapshot", async () => {
  const { websocketHandlers } = await import("./ws-handlers");
  const { sessionWatchers, allClients, leaveSession, joinSession } =
    await import("./ws-hub");
  const now = Date.now();
  const viewer = {
    data: {
      watchingSessionId: "shared-presence",
      user: "Alice",
      lastSeenAt: now,
      activeAt: now,
    },
    send() {},
  };
  const frames: Array<{ type: string; viewing?: unknown[] }> = [];
  const receiver = {
    data: { watchingSessionId: null, user: "Bob" },
    send: (text: string) => frames.push(JSON.parse(text)),
  } as unknown as Parameters<NonNullable<typeof websocketHandlers.message>>[0];
  const blocked = deferred<never>();
  const authority = spyOn(
    store,
    "sessionMetadataCatalogRead",
  ).mockImplementation(() => blocked.promise as never);
  joinSession(viewer, "shared-presence");
  try {
    expect(websocketHandlers.open!(receiver)).toBeUndefined();
    expect(
      frames.filter((frame) => frame.type === "global_presence").at(-1)
        ?.viewing,
    ).toEqual([{ user: "Alice", sessionId: "shared-presence" }]);
    leaveSession(viewer);
    await Promise.resolve();
    expect(
      frames.filter((frame) => frame.type === "global_presence").at(-1)
        ?.viewing,
    ).toEqual([]);
    expect(authority).not.toHaveBeenCalled();
  } finally {
    authority.mockRestore();
    allClients.delete(receiver);
    sessionWatchers.delete("shared-presence");
  }
});
