import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionKernelStore } from "./session-kernel/store";
import {
  startSessionAudiences,
  refreshSessionAudiences,
  bindSessionPublication,
  sessionAudienceIncarnation,
  revokeSessionPublications,
} from "./session-audience";
import {
  allClients,
  sessionWatchers,
  broadcastToAll,
  broadcastToSession,
  canDeliverSession,
  globalPresenceFrame,
  type WSClientData,
} from "./ws-hub";
import { sessionFeedSnapshot } from "./session-feed";
import { publishTranscript, subscribeTranscript } from "./transcript-bus";

const root = mkdtempSync(join(tmpdir(), "session-audience-"));
const previousEnv = {
  HOME: process.env.HOME,
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_CONFIG: process.env.OPENSESSION_CONFIG,
};
let store: SessionKernelStore, old: SessionKernelStore | undefined;
let stores: SessionKernelStore[];
let oldDir: string;
const unsubs: (() => void)[] = [];
beforeAll(async () => {
  process.env.HOME = root;
  process.env.OPENSESSION_STATE_DIR = root;
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  writeFileSync(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({ repos: { demo: { repo: root, ghRepo: "fixture/demo" } } }),
  );
  mkdirSync(join(root, "sessions"));
  oldDir = (await import("./paths")).__setSessionsDirForTest(
    join(root, "sessions"),
  );
});
beforeEach(async () => {
  store = new (await import("./session-kernel/store")).SessionKernelStore(
    ":memory:",
  );
  stores = [store];
  old = (
    await import("./session-kernel/kernel")
  ).__setSessionKernelStoreForTest(store);
});
afterEach(async () => {
  await Promise.resolve();
  for (const unsub of unsubs.splice(0)) unsub();
  allClients.clear();
  sessionWatchers.clear();
  (await import("./session-kernel/kernel")).__setSessionKernelStoreForTest(old);
  for (const current of stores) current.close();
});
afterAll(async () => {
  (await import("./paths")).__setSessionsDirForTest(oldDir);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
function seed(id: string, owner: number) {
  store.seedSessionMetadataCatalog([
    {
      sessionId: id,
      doc: JSON.stringify({
        id,
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
function socket(owner: number, compatible = true) {
  const frames: Record<string, any>[] = [];
  const data: WSClientData = {
    watchingSessionId: "private",
    user: `owner-${owner}`,
    authUser: `owner-${owner}`,
    authLogin: `owner-${owner}`,
    authGithubAccountId: owner,
    ...(compatible
      ? {
          privacyProtocol: "personal-v1" as const,
          expectedGithubAccountId: owner,
        }
      : {}),
    supportsFeed: true,
    watchAudienceIncarnation: sessionAudienceIncarnation(),
    activeAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  return {
    data,
    frames,
    send: (text: string) => {
      frames.push(JSON.parse(text));
    },
  };
}

test("synchronous private fanout requires owner compatibility and original producer provenance", async () => {
  seed("private", 101);
  seed("shared", 0);
  await startSessionAudiences();
  const a = socket(101),
    b = socket(202),
    legacyA = socket(101, false);
  for (const ws of [a, b, legacyA]) allClients.add(ws);
  sessionWatchers.set("private", new Set([a, b, legacyA]));
  broadcastToSession("private", {
    type: "stream_text",
    sessionId: "private",
    text: "unqualified",
  });
  expect(a.frames).toEqual([]);
  const publish = await bindSessionPublication("private", 101, () => {
    broadcastToAll({ type: "session_created", id: "private" });
    broadcastToSession("private", {
      type: "stream_start",
      sessionId: "private",
    });
    broadcastToSession("private", {
      type: "stream_text",
      sessionId: "private",
      text: "owner-only",
    });
    broadcastToAll({
      type: "session_updated",
      sessionId: "shared",
      parentSessionId: "private",
    });
  });
  publish();
  expect(a.frames.some((frame) => frame.type === "session_created")).toBe(true);
  expect(a.frames.some((frame) => frame.event?.text === "owner-only")).toBe(
    true,
  );
  expect(a.frames.some((frame) => frame.type === "session_updated")).toBe(
    false,
  );
  expect(b.frames).toEqual([]);
  expect(legacyA.frames).toEqual([]);
  expect(globalPresenceFrame(b).viewing).toEqual([]);
  expect(globalPresenceFrame(a).viewing).toEqual([
    { user: "owner-101", sessionId: "private" },
  ]);
});

test("stream and transcript producers retain order without token-rate authority RPC", async () => {
  seed("private", 101);
  await startSessionAudiences();
  const a = socket(101),
    b = socket(202);
  sessionWatchers.set("private", new Set([a, b]));
  unsubs.push(
    subscribeTranscript("private", (event) => {
      for (const ws of [a, b])
        if (canDeliverSession(ws, "private", true))
          ws.send(JSON.stringify(event.feed));
    }),
  );
  const emit = await bindSessionPublication("private", 101, async () => {
    broadcastToSession("private", {
      type: "stream_start",
      sessionId: "private",
    });
    publishTranscript("private", {
      entries: [
        {
          id: "entry",
          type: "assistant",
          timestamp: "2026-01-01T00:00:00Z",
          content: "committed",
          seq: 1,
          changeSeq: 1,
        },
      ],
      firstSeq: 1,
      lastSeq: 1,
    });
    for (let i = 0; i < 100; i++)
      broadcastToSession("private", {
        type: "stream_text",
        sessionId: "private",
        text: "x",
      });
    await Promise.resolve();
  });
  const rpc = spyOn(await import("./session-kernel"), "sessionMetadata");
  try {
    const before = rpc.mock.calls.length;
    await emit();
    expect(rpc.mock.calls.length).toBe(before);
    const sequences = a.frames
      .filter((frame) => frame.type === "session_feed")
      .map((frame) => frame.feedSeq);
    expect(sequences).toEqual(Array.from({ length: 102 }, (_, i) => i + 1));
    expect(a.frames.at(-1)?.event.type).toBe("transcript_append");
    expect(b.frames).toEqual([]);
  } finally {
    rpc.mockRestore();
  }
});

test("revoke and authority replacement cannot upgrade nested or delayed old producer leases", async () => {
  seed("private", 101);
  await startSessionAudiences();
  const a = socket(101);
  sessionWatchers.set("private", new Set([a]));
  const oldEmit = await bindSessionPublication("private", 101, () =>
    broadcastToSession("private", {
      type: "stream_text",
      sessionId: "private",
      text: "old A",
    }),
  );
  const nested = await bindSessionPublication("private", 101, () =>
    bindSessionPublication("private", 101, () => {}),
  );
  revokeSessionPublications(["private"]);
  await expect(nested()).rejects.toThrow("lease expired");
  oldEmit();
  expect(a.frames).toEqual([]);
  const replacement = new (
    await import("./session-kernel/store")
  ).SessionKernelStore(":memory:");
  stores.push(replacement);
  store = replacement;
  (await import("./session-kernel/kernel")).__setSessionKernelStoreForTest(
    replacement,
  );
  seed("private", 202);
  await refreshSessionAudiences(true);
  const b = socket(202);
  sessionWatchers.set("private", new Set([a, b]));
  expect(sessionFeedSnapshot("private").active).toBeNull();
  oldEmit();
  expect(b.frames).toEqual([]);
  await expect(nested()).rejects.toThrow("lease expired");
  const newEmit = await bindSessionPublication("private", 202, () =>
    broadcastToSession("private", {
      type: "stream_text",
      sessionId: "private",
      text: "new B",
    }),
  );
  newEmit();
  expect(b.frames.at(-1)?.event.text).toBe("new B");
  expect(a.frames).toEqual([]);
});

test("captured actor result guard denies a delayed response after source abort", async () => {
  const { capturePrivateActorResultGuard } = await import("./session-audience");
  seed("private-result", 101);
  await startSessionAudiences();
  const controller = new AbortController();
  const capture = await bindSessionPublication(
    "private-result",
    101,
    () => capturePrivateActorResultGuard(),
    { signal: controller.signal },
  );
  const guard = capture();
  expect(() => guard()).not.toThrow();
  controller.abort();
  expect(() => guard()).toThrow("result source lease expired");
  expect(() => capturePrivateActorResultGuard()()).not.toThrow();
});

test("actor client rejects successful delayed transport payload in original revoked producer lifetime", async () => {
  const { SessionKernelActorClient } =
    await import("./session-kernel/actor-client");
  seed("delayed-actor", 101);
  await startSessionAudiences();
  for (const denial of ["abort", "revoke"] as const) {
    let receive: ((event: MessageEvent) => void) | undefined;
    let posted: Record<string, unknown> | undefined;
    const worker = {
      addEventListener(type: string, fn: (event: MessageEvent) => void) {
        if (type === "message") receive = fn;
      },
      postMessage(message: Record<string, unknown>) {
        posted = message;
      },
      terminate() {},
    };
    const client = new SessionKernelActorClient(worker as unknown as Worker);
    const controller = new AbortController();
    const read = await bindSessionPublication(
      "delayed-actor",
      101,
      () =>
        client.callAsync(
          { t: "store", method: "askSnapshot", args: ["delayed-actor"] },
          "delayed private read",
        ),
      { signal: controller.signal },
    );
    const result = read();
    const rejected = result.then(
      () => null,
      (error: unknown) => error,
    );
    expect(posted).toMatchObject({
      access: { fence: { sourceSessionId: "delayed-actor", owner: 101 } },
    });
    if (denial === "abort") controller.abort();
    else revokeSessionPublications(["delayed-actor"]);
    const body = JSON.stringify({
      ok: true,
      result: { secret: "must not resolve" },
    });
    receive!({
      data: {
        t: "call_result",
        rpcId: posted!.rpcId,
        status: 1,
        body,
        length: body.length,
      },
    } as MessageEvent);
    expect(await rejected).toMatchObject({
      message: "Private actor result source lease expired",
    });
    client.terminate();
  }
});

test("revoked producer can still record global exact-lineage cleanup receipts", async () => {
  const { SessionKernelActorClient } =
    await import("./session-kernel/actor-client");
  seed("cleanup-source", 101);
  await startSessionAudiences();
  let receive: ((event: MessageEvent) => void) | undefined;
  const worker = {
    addEventListener(type: string, fn: (event: MessageEvent) => void) {
      if (type === "message") receive = fn;
    },
    postMessage(message: Record<string, unknown>) {
      expect(message).toMatchObject({
        command: { access: { fence: undefined } },
      });
      const body = JSON.stringify({
        ok: true,
        result: { status: "committed", rev: 1 },
      });
      receive!({
        data: {
          t: "call_result",
          rpcId: message.rpcId,
          status: 1,
          body,
          length: body.length,
        },
      } as MessageEvent);
    },
    terminate() {},
  };
  const client = new SessionKernelActorClient(worker as unknown as Worker);
  const cleanup = await bindSessionPublication("cleanup-source", 101, () =>
    client.callAsync(
      {
        t: "reduce",
        command: {
          kind: "catalog_document",
          commandId: "exact-cleanup",
          request: {
            op: "put",
            namespace: "personal_run_retirements_v1",
            key: "exact-physical-key",
            expectedRev: null,
            value: "synthetic exact receipt",
            requestId: "cleanup",
          },
        },
      },
      "exact cleanup",
    ),
  );
  revokeSessionPublications(["cleanup-source"]);
  expect(await cleanup()).toEqual({ status: "committed", rev: 1 });
  client.terminate();
});
