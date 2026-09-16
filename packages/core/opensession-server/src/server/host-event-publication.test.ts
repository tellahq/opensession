import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tagHostedEvent,
  withHostedEventPublication,
} from "./host-event-publication";
import {
  bindHostPublication,
  bindHostPublicationSuccessor,
  hostPublicationContext,
} from "./personal-repo-runtime-publication";
import * as defaults from "./personal-repo-runtime-default";
import { createPersonalRepositoryCoordinator } from "./personal-repository-coordinator";
import {
  registerPersonalRunConsumer,
  confirmPersonalRunPhysicalCompletion,
  requestPersonalRunRetirement,
} from "./personal-run-consumers";
import {
  startSessionAudiences,
  refreshSessionAudiences,
  revokeSessionPublications,
  currentPrivateActorFence,
  withSessionPublication,
} from "./session-audience";
import { currentExecutionAccess } from "./application-access";
import { SessionKernelStore } from "./session-kernel/store";
import * as kernel from "./session-kernel";
import type { RunHostSpec } from "../runner-host/protocol";

const root = await mkdtemp(join(tmpdir(), "host-event-context-"));
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
let store: SessionKernelStore, previous: SessionKernelStore | undefined;
const stores: SessionKernelStore[] = [];
let runtime: ReturnType<typeof spyOn>;
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  stores.push(store);
  previous = kernel.__setSessionKernelStoreForTest(store);
  runtime = spyOn(defaults, "personalRepoRuntime").mockResolvedValue({
    resolve: async () => {},
    assertWorkspace: async () => {},
  } as unknown as Awaited<ReturnType<typeof defaults.personalRepoRuntime>>);
});
afterEach(() => {
  runtime.mockRestore();
  kernel.__setSessionKernelStoreForTest(previous);
  for (const s of stores.splice(0)) s.close();
});
afterAll(async () => {
  paths.__setSessionsDirForTest(oldDir);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const descriptor = {
    kind: "personal" as const,
    ownerGithubAccountId: 41,
    repositoryOwnerGithubAccountId: 41,
    appRecordId: "fixture",
    githubAppId: 1,
    installationId: 2,
    repositoryId: 3,
    accessRevision: 1,
    fullName: "fixture/repo",
  };
  const coordinator = createPersonalRepositoryCoordinator({
    assertReady: async () => {},
    revoke: async () => {},
    reconcile: async () => {},
  });
  const { registryId } = await coordinator.register(descriptor);
  const binding = { registryId, descriptor };
  const doc = {
    id: "private",
    repo: registryId,
    personalRepo: binding,
    accessScope: { kind: "personal", ownerGithubAccountId: 41 },
  };
  store.seedSessionMetadataCatalog([
    {
      sessionId: doc.id,
      doc: JSON.stringify(doc),
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
  ]);
  await startSessionAudiences();
  const a: RunHostSpec = {
    hostId: "rh-019d2a5f-4ac8-7000-8000-123456789abc",
    logicalRunId: "logical",
    osSessionId: "private",
    cwd: root,
    prompt: "fixture",
    personalRepo: binding,
    mcpServers: [],
    proxyMcpServers: [],
  };
  const b = { ...a, hostId: "rh-019d2a5f-4ac8-7000-8000-123456789abd" };
  const consumer = (spec: RunHostSpec) => ({
    runKey: spec.logicalRunId!,
    hostId: spec.hostId,
    sessionId: spec.osSessionId,
    binding,
  });
  await withSessionPublication(
    "private",
    41,
    async () => {
      await registerPersonalRunConsumer(consumer(a));
      await registerPersonalRunConsumer(consumer(b));
    },
    { binding },
  );
  const publication = await bindHostPublication(a);
  return { a, b, consumer, publication };
}

test("queued A remains A after authorized B handoff; retired A drops and B carries exact actor/access proof", async () => {
  const f = await fixture();
  const aEvent = tagHostedEvent(
    { type: "text_chunk", text: "A" },
    hostPublicationContext(f.publication),
  );
  const b = await bindHostPublicationSuccessor(f.publication, f.b);
  const bEvent = tagHostedEvent(
    { type: "text_chunk", text: "B" },
    hostPublicationContext(b),
  );
  f.publication.abort();
  await confirmPersonalRunPhysicalCompletion(f.consumer(f.a));
  let old = 0;
  expect(withHostedEventPublication(aEvent, () => old++, true)).toBeUndefined();
  expect(old).toBe(0);
  const rpc = spyOn(kernel, "sessionMetadata");
  try {
    for (let i = 0; i < 20; i++)
      withHostedEventPublication(
        { ...bEvent },
        () => {
          expect(currentPrivateActorFence()?.consumer?.hostId).toBe(f.b.hostId);
          expect(currentPrivateActorFence()?.consumer?.runKey).toBe(
            f.a.logicalRunId,
          );
          expect(currentExecutionAccess()?.principal?.githubAccountId).toBe(41);
        },
        true,
      );
    expect(rpc.mock.calls.length).toBe(0);
  } finally {
    rpc.mockRestore();
  }
  expect(JSON.stringify(bEvent)).toBe(
    JSON.stringify({ type: "text_chunk", text: "B" }),
  );
});

test("explicit successor can follow physical A abort, but cannot revive A itself", async () => {
  const f = await fixture();
  f.publication.abort();
  const b = await bindHostPublicationSuccessor(f.publication, f.b);
  expect(hostPublicationContext(b).alive()).toBe(true);
  await expect(
    bindHostPublicationSuccessor(f.publication, f.a),
  ).rejects.toThrow("handoff");
});

for (const owner of [41, 42])
  test(`owner/resource authority replacement cannot renew B (owner ${owner})`, async () => {
    const f = await fixture();
    const replacement = new SessionKernelStore(":memory:");
    stores.push(replacement);
    kernel.__setSessionKernelStoreForTest(replacement);
    replacement.seedSessionMetadataCatalog([
      {
        sessionId: "private",
        doc: JSON.stringify({
          id: "private",
          accessScope: { kind: "personal", ownerGithubAccountId: owner },
        }),
        rev: 1,
        archived: false,
        lastActivityMs: 1,
      },
    ]);
    await refreshSessionAudiences(true);
    await expect(
      bindHostPublicationSuccessor(f.publication, f.b),
    ).rejects.toThrow("successor");
  });

test("logical stop denies all physical contexts and future successors; untagged private data never inherits caller authority", async () => {
  const f = await fixture();
  const b = await bindHostPublicationSuccessor(f.publication, f.b);
  await requestPersonalRunRetirement(f.consumer(f.a));
  revokeSessionPublications([f.a.osSessionId]);
  expect(hostPublicationContext(f.publication).alive()).toBe(false);
  expect(hostPublicationContext(b).alive()).toBe(false);
  await expect(
    bindHostPublicationSuccessor(b, {
      ...f.b,
      hostId: "rh-019d2a5f-4ac8-7000-8000-123456789abe",
    }),
  ).rejects.toThrow();
  expect(() =>
    withHostedEventPublication(
      { type: "text_chunk", text: "untagged" },
      () => {},
      true,
    ),
  ).toThrow("no source");
  expect(
    withHostedEventPublication(
      { type: "text_chunk", text: "shared" },
      () => "shared",
    ),
  ).toBe("shared");
});
