import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HostConnectionHandlers,
  HostLauncher,
  HandleCallbacks,
} from "./host-client";
import type { RunHostSpec } from "../runner-host/protocol";

const root = await mkdtemp(join(tmpdir(), "host-publication-"));
const saved = {
  HOME: process.env.HOME,
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_CONFIG: process.env.OPENSESSION_CONFIG,
};
process.env.HOME = root;
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_CONFIG = join(root, "config.json");
await writeFile(process.env.OPENSESSION_CONFIG, "{}");
await mkdir(join(root, "sessions"));
const paths = await import("./paths");
const oldDir = paths.__setSessionsDirForTest(join(root, "sessions"));
const { HostHandle } = await import("./host-client");
const { SessionKernelStore } = await import("./session-kernel/store");
const kernel = await import("./session-kernel");
const {
  startSessionAudiences,
  refreshSessionAudiences,
  revokeSessionPublications,
  sessionPublicationAllowed,
  withSessionPublication,
} = await import("./session-audience");
const defaults = await import("./personal-repo-runtime-default");
const { personalRepositoryId } =
  await import("./personal-repository-coordinator");
const persistence = await import("./transcript-persistence");
const { registerPersonalRunConsumer } =
  await import("./personal-run-consumers");
let store: InstanceType<typeof SessionKernelStore>;
let prior: ReturnType<typeof kernel.__setSessionKernelStoreForTest>;
let stores: InstanceType<typeof SessionKernelStore>[];
const handles: InstanceType<typeof HostHandle>[] = [];
let validations: number;
let runtimeSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  stores = [store];
  prior = kernel.__setSessionKernelStoreForTest(store);
  validations = 0;
  runtimeSpy = spyOn(defaults, "personalRepoRuntime").mockResolvedValue({
    resolve: async (
      owner: number,
      registryId: string,
      binding: NonNullable<RunHostSpec["personalRepo"]>,
    ) => {
      expect(owner).toBe(binding.descriptor.ownerGithubAccountId);
      expect(registryId).toBe(binding.registryId);
      validations++;
    },
    assertWorkspace: async (
      owner: number,
      binding: NonNullable<RunHostSpec["personalRepo"]>,
      id: string,
      cwd: string,
    ) => {
      expect(owner).toBe(binding.descriptor.ownerGithubAccountId);
      expect(id).toBe("private");
      expect(cwd).toBe(join(root, "worktree"));
    },
  } as unknown as Awaited<ReturnType<typeof defaults.personalRepoRuntime>>);
});
afterEach(async () => {
  for (const handle of handles.splice(0)) handle.abandon();
  runtimeSpy.mockRestore();
  kernel.__setSessionKernelStoreForTest(prior);
  for (const current of stores) current.close();
});
afterAll(async () => {
  paths.__setSessionsDirForTest(oldDir);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});
function bindingFor(owner: number) {
  const descriptor = {
    kind: "personal" as const,
    ownerGithubAccountId: owner,
    repositoryOwnerGithubAccountId: owner,
    appRecordId: "fixture",
    githubAppId: 1,
    installationId: 2,
    repositoryId: 3,
    accessRevision: 1,
    fullName: "fixture/repo",
  };
  return { registryId: personalRepositoryId(descriptor), descriptor };
}
function seed(owner: number, title = "fixture") {
  const binding = owner ? bindingFor(owner) : undefined;
  if (
    binding &&
    !store.repositoryCatalogGet(binding.registryId, { githubAccountId: owner })
  )
    store.repositoryCatalogPut({
      op: "repository_put",
      repositoryId: binding.registryId,
      principal: { githubAccountId: owner },
      expectedRev: null,
      doc: JSON.stringify({
        id: binding.registryId,
        accessScope: { kind: "personal", ownerGithubAccountId: owner },
        personalGithub: binding.descriptor,
        blocked: false,
        consumerSchema: 1,
        activeConsumers: [],
      }),
    });
  store.seedSessionMetadataCatalog([
    {
      sessionId: "private",
      doc: JSON.stringify({
        id: "private",
        title,
        ...(binding ? { repo: binding.registryId, personalRepo: binding } : {}),
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
async function replace(owner: number) {
  store = new SessionKernelStore(":memory:");
  stores.push(store);
  kernel.__setSessionKernelStoreForTest(store);
  seed(owner);
  await refreshSessionAudiences(true);
}
async function producer(
  owner: number,
  cb: HandleCallbacks = {},
  lifecycle: "session" | "auxiliary" = "auxiliary",
) {
  const hostId = `rh-${crypto.randomUUID()}`;
  const spec: RunHostSpec = {
    hostId,
    logicalRunId: hostId,
    mcpServers: [],
    proxyMcpServers: [],
    osSessionId: "private",
    prompt: "fixture",
    cwd: join(root, "worktree"),
    mode: "ask",
    lifecycle,
    transcriptTarget: "session",
    ...(owner ? { personalRepo: bindingFor(owner) } : {}),
  };
  if (
    owner &&
    store
      .sessionScopeChanges(0, 100)
      .rows.some(
        (row) => row.id === "private" && row.owner === owner && !row.deleted,
      )
  ) {
    await withSessionPublication(
      "private",
      owner,
      () =>
        registerPersonalRunConsumer({
          runKey: spec.logicalRunId!,
          hostId: spec.hostId,
          sessionId: "private",
          binding: spec.personalRepo!,
        }),
      { binding: spec.personalRepo },
    );
  }
  let handlers: HostConnectionHandlers;
  const sent: unknown[] = [];
  const launcher: HostLauncher = {
    alive: () => true,
    newRunDir: (id) => join(root, id),
    launch: async () => {},
    connector: () => ({
      connect: async (incoming) => {
        handlers = incoming;
        return {
          send: (msg) => {
            sent.push(msg);
            return true;
          },
          close() {},
        };
      },
    }),
  };
  const handle = new HostHandle(join(root, spec.hostId), spec, cb, launcher);
  handles.push(handle);
  return {
    handle,
    spec,
    sent,
    launcher,
    emit: (msg: Parameters<HostConnectionHandlers["onMsg"]>[0]) =>
      handlers.onMsg(msg),
  };
}

test("host callbacks carry original validated scope synchronously, preserve order and never refresh per token", async () => {
  seed(41);
  await startSessionAudiences();
  const delivered: string[] = [];
  const p = await producer(41, {
    onEngineSession: (id) => {
      expect(sessionPublicationAllowed("private")).toBe(true);
      delivered.push(id);
    },
    onSteerFailed: (text) => {
      expect(sessionPublicationAllowed("private")).toBe(true);
      delivered.push(text);
    },
  });
  await p.handle.connectWithWait(100);
  const rpc = spyOn(kernel, "sessionMetadata");
  try {
    for (let i = 0; i < 100; i++)
      p.emit({ t: "steer_failed", text: String(i) });
    expect(delivered).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
    expect(rpc.mock.calls.length).toBe(0);
    expect(validations).toBe(1);
  } finally {
    rpc.mockRestore();
  }
  const before = store.sessionScopeFence();
  store.putSessionMetadata({
    op: "put",
    sessionId: "private",
    principal: { githubAccountId: 41 },
    requestId: "title-update",
    expectedRev: null,
    rev: 2,
    doc: JSON.stringify({
      id: "private",
      title: "ordinary title update",
      repo: bindingFor(41).registryId,
      personalRepo: bindingFor(41),
      accessScope: { kind: "personal", ownerGithubAccountId: 41 },
    }),
    archived: false,
    lastActivityMs: 2,
  });
  await refreshSessionAudiences();
  expect(store.sessionScopeFence()).toEqual(before);
  p.emit({ t: "steer_failed", text: "same owner" });
  expect(delivered.at(-1)).toBe("same owner");
  await p.handle.connectWithWait(100);
  expect(validations).toBe(1);
});

for (const replacementOwner of [41, 42])
  test(`old host cannot publish or rebind after resource replacement under owner ${replacementOwner}`, async () => {
    seed(41);
    await startSessionAudiences();
    const delivered: string[] = [];
    const p = await producer(41, {
      onSteerFailed: (text) => delivered.push(text),
    });
    await p.handle.connectWithWait(100);
    p.emit({
      t: "event",
      event: { type: "text_chunk", content: "queued old bytes" },
    });
    p.emit({
      t: "event",
      event: { type: "done", content: "queued old terminal" },
    });
    await replace(replacementOwner);
    // Mutating a caller's original spec must not upgrade the captured source.
    p.spec.personalRepo = {
      ...p.spec.personalRepo!,
      descriptor: {
        ...p.spec.personalRepo!.descriptor,
        ownerGithubAccountId: replacementOwner,
      },
    };
    p.emit({ t: "steer_failed", text: "late old bytes" });
    expect(delivered).toEqual([]);
    p.emit({ t: "end", done: { type: "done", content: "old terminal" } });
    const events = [];
    for await (const event of p.handle.events()) events.push(event);
    expect(events).toEqual([]);
    expect(p.handle.takeObservedTerminal()).toBeUndefined();
    await expect(p.handle.connectWithWait(0)).rejects.toThrow(
      "publication unavailable",
    );
    expect(validations).toBe(1);
  });

test("queued transcript persistence rechecks the original lease after async work, and revoked asks cannot answer", async () => {
  seed(41);
  await startSessionAudiences();
  const pending = Promise.withResolvers<void>();
  const ask = Promise.withResolvers<{
    behavior: "allow";
    updatedInput: Record<string, unknown>;
  }>();
  const persisted: string[] = [];
  let started = 0;
  const writer = spyOn(
    persistence,
    "applyForwardedTranscriptStrict",
  ).mockImplementation(async () => {
    started++;
    expect(sessionPublicationAllowed("private")).toBe(true);
    await pending.promise;
    if (sessionPublicationAllowed("private")) persisted.push("bytes");
  });
  const p = await producer(41, { onAskUser: async () => ask.promise });
  try {
    await p.handle.connectWithWait(100);
    p.emit({ t: "ask", askId: "ask", input: {} });
    p.emit({ t: "transcript", engineSessionId: "engine", lines: [] });
    await Promise.resolve();
    await Promise.resolve();
    p.emit({ t: "transcript", engineSessionId: "engine", lines: [] });
    revokeSessionPublications(["private"]);
    pending.resolve();
    ask.resolve({ behavior: "allow", updatedInput: {} });
    await p.handle.waitForPendingProjections();
    await Promise.resolve();
    expect(started).toBe(1);
    expect(persisted).toEqual([]);
    expect(p.sent.some((msg: any) => msg.t === "ask_answer")).toBe(false);
  } finally {
    pending.resolve();
    writer.mockRestore();
  }
});

test("shared hosts retain synchronous delivery but cannot become private producers", async () => {
  seed(0);
  await startSessionAudiences();
  const delivered: string[] = [];
  const p = await producer(0, {
    onSteerFailed: (text) => delivered.push(text),
  });
  await p.handle.connectWithWait(100);
  p.emit({ t: "steer_failed", text: "shared" });
  expect(delivered).toEqual(["shared"]);
  expect(validations).toBe(0);
  await replace(41);
  p.emit({ t: "steer_failed", text: "old shared" });
  expect(delivered).toEqual(["shared"]);
});

test("wrong original owner cannot attach even when a current session owner exists", async () => {
  seed(42);
  await startSessionAudiences();
  const p = await producer(41);
  await expect(p.handle.connectWithWait(100)).rejects.toThrow();
  expect(validations).toBe(1);
});

test("same-incarnation resource rehoming invalidates the old host even for the same owner", async () => {
  seed(41);
  await startSessionAudiences();
  const delivered: string[] = [];
  const p = await producer(41, {
    onSteerFailed: (text) => delivered.push(text),
  });
  await p.handle.connectWithWait(100);
  const before = store.sessionScopeFence();
  store.seedSessionMetadataCatalog([
    {
      sessionId: "replacement",
      doc: JSON.stringify({
        id: "replacement",
        accessScope: { kind: "personal", ownerGithubAccountId: 41 },
      }),
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
  ]);
  store.registerSessionScopeAliases([
    { id: "replacement", aliases: ["private"] },
  ]);
  await refreshSessionAudiences();
  expect(store.sessionScopeFence().incarnation).toBe(before.incarnation);
  expect(store.sessionScopeFence().generation).toBeGreaterThan(
    before.generation,
  );
  p.emit({ t: "steer_failed", text: "same owner, different resource" });
  expect(delivered).toEqual([]);
  await expect(p.handle.connectWithWait(0)).rejects.toThrow(
    "publication unavailable",
  );
  expect(validations).toBe(1);
});

test("private producer cannot attach before audience authority is active", async () => {
  const stateDir = process.env.OPENSESSION_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = join(root, "not-started");
  try {
    const p = await producer(41);
    await expect(p.handle.connectWithWait(100)).rejects.toThrow(
      "publication unavailable",
    );
    expect(validations).toBe(0);
  } finally {
    process.env.OPENSESSION_STATE_DIR = stateDir;
  }
});

test("revoked host cleanup requires ended proof and cannot unregister a successor", async () => {
  const { hostRunBusy } = await import("./host-registry");
  seed(41);
  await startSessionAudiences();
  const old = await producer(41, {}, "session");
  await old.handle.connectWithWait(100);
  await replace(42);
  const successor = await producer(42, {}, "session");
  await successor.handle.connectWithWait(100);
  old.emit({ t: "catchup_complete" });
  expect(old.handle.ended).toBe(false);
  expect(hostRunBusy(old.spec.hostId)).toBe(true);
  old.emit({
    t: "hello",
    hostId: old.spec.hostId,
    osSessionId: "private",
    pid: 0,
    state: "ended",
    pendingAsks: [],
    done: { type: "done", content: "revoked bytes" },
  });
  expect(old.handle.ended).toBe(false);
  old.emit({ t: "catchup_complete" });
  expect(old.handle.ended).toBe(true);
  expect(old.handle.endedAfterCancellation).toBe(true);
  expect(hostRunBusy(old.spec.hostId)).toBe(false);
  expect(hostRunBusy(successor.spec.hostId)).toBe(true);
  expect(hostRunBusy("private")).toBe(true);
  const events = [];
  for await (const event of old.handle.events()) events.push(event);
  expect(events).toEqual([]);
});

test("revoked offline terminal still finalizes an exactly identified absent host without payload", async () => {
  const { hostRunBusy } = await import("./host-registry");
  seed(41);
  await startSessionAudiences();
  const p = await producer(41, {}, "session");
  await p.handle.bindPublication();
  p.launcher.alive = () => false;
  const dir = join(root, p.spec.hostId);
  await mkdir(dir);
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({
      hostId: p.spec.hostId,
      osSessionId: "private",
      pid: 0,
      startedAt: new Date().toISOString(),
      done: { type: "done", content: "offline revoked bytes" },
    }),
  );
  revokeSessionPublications(["private"]);
  expect(await p.handle.observeOfflineTerminal()).toBe(true);
  expect(p.handle.endedAfterCancellation).toBe(true);
  expect(p.handle.takeObservedTerminal()).toBeUndefined();
  expect(hostRunBusy(p.spec.hostId)).toBe(false);
  const events = [];
  for await (const event of p.handle.events()) events.push(event);
  expect(events).toEqual([]);
});

test("rejected token stream requests cancellation once, never a token-rate cleanup/RPC storm", async () => {
  seed(41);
  await startSessionAudiences();
  const p = await producer(41);
  await p.handle.connectWithWait(100);
  await replace(42);
  for (let i = 0; i < 100; i++) p.emit({ t: "steer_failed", text: "stale" });
  expect(p.sent.filter((value: any) => value.t === "cancel")).toHaveLength(1);
});
