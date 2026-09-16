import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActiveRunRecord } from "./run-journal";

const root = await mkdtemp(join(tmpdir(), "personal-recovery-control-"));
const saved = Object.fromEntries(
  [
    "HOME",
    "OPENSESSION_STATE_DIR",
    "OPENSESSION_CONFIG",
    "OPENSESSION_SESSIONS_DIR",
    "OPENSESSION_RUN_JOURNAL",
  ].map((key) => [key, process.env[key]]),
);
process.env.HOME = root;
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_CONFIG = join(root, "config.json");
process.env.OPENSESSION_SESSIONS_DIR = join(root, "sessions");
delete process.env.OPENSESSION_RUN_JOURNAL;
await mkdir(process.env.OPENSESSION_SESSIONS_DIR);
await writeFile(process.env.OPENSESSION_CONFIG, "{}");
const kernel = await import("./session-kernel");
const { SessionKernelStore } = await import("./session-kernel/store");
const journal = await import("./run-journal");
const privateJournal = await import("./personal-run-journal");
const agent = await import("./agent-runner");
const runState = await import("./run-state");
const { createPersonalRepositoryCoordinator } =
  await import("./personal-repository-coordinator");
const authority = await import("./personal-run-consumers");
const {
  startSessionAudiences,
  withSessionPublication,
  currentPrivateActorFence,
  revokeSessionPublications,
} = await import("./session-audience");
const { currentExecutionAccess } = await import("./application-access");
const { capturePersonalRecoveryContext, withPersonalRecoveryContext } =
  await import("./personal-repo-runtime-recovery");
const { tagHostedEvent } = await import("./host-event-publication");
const { attachHostedRunLifetime } = await import("./host-run-lifetime");
let store: InstanceType<typeof SessionKernelStore>,
  previous: ReturnType<typeof kernel.__setSessionKernelStoreForTest>,
  previousJournal: string;
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previous = kernel.__setSessionKernelStoreForTest(store);
  previousJournal = journal.__setActiveRunsPathForTest(
    join(root, `${crypto.randomUUID()}.json`),
  );
  privateJournal.__resetPersonalRunJournalForTest();
});
afterEach(() => {
  agent.__setLocalHostResumeForTest(null);
  journal.__setActiveRunsPathForTest(previousJournal);
  privateJournal.__resetPersonalRunJournalForTest();
  kernel.__setSessionKernelStoreForTest(previous);
  store.close();
});
afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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
  const binding = { registryId, descriptor },
    id = `private-${crypto.randomUUID()}`,
    hostId = `rh-${crypto.randomUUID()}`;
  store.seedSessionMetadataCatalog([
    {
      sessionId: id,
      doc: JSON.stringify({
        id,
        repo: registryId,
        personalRepo: binding,
        accessScope: { kind: "personal", ownerGithubAccountId: 41 },
      }),
      rev: 1,
      archived: false,
      lastActivityMs: 1,
    },
  ]);
  await startSessionAudiences();
  const run: ActiveRunRecord = {
    runKey: hostId,
    hostId,
    osSessionId: id,
    personalRepo: binding,
    cwd: root,
    prompt: "synthetic",
    mcpServers: [],
    kind: "prompt",
    model: "pi/openai/gpt-6",
    startedAt: new Date().toISOString(),
  };
  await withSessionPublication(
    id,
    41,
    async () => {
      await authority.registerPersonalRunConsumer({
        runKey: run.runKey,
        hostId,
        sessionId: id,
        binding,
      });
      await journal.journalSet(run, async () => {});
    },
    { binding },
  );
  return {
    run,
    consumer: { runKey: run.runKey, hostId, sessionId: id, binding },
  };
}

test("eligible private boot recovery has original source before reattach, on events and terminal settlement", async () => {
  const { run, consumer } = await fixture();
  const source = await capturePersonalRecoveryContext(run);
  const steps: string[] = [];
  const finalized = Promise.withResolvers<void>();
  const transition = spyOn(runState, "transitionRunState").mockImplementation(
    async (_id, event) => {
      if (["reattach_start", "reattach_ok", "turn_end"].includes(event)) {
        expect(currentPrivateActorFence()?.consumer?.hostId).toBe(
          consumer.hostId,
        );
        expect(currentExecutionAccess()?.principal?.githubAccountId).toBe(41);
        steps.push(event);
      }
      return "idle";
    },
  );
  agent.__setLocalHostResumeForTest((actual) => {
    expect(currentPrivateActorFence()?.consumer?.hostId).toBe(consumer.hostId);
    const pending = Promise.resolve(
      (async function* () {
        yield tagHostedEvent(
          { type: "text_chunk", text: "private resumed" },
          source,
        );
        yield tagHostedEvent({ type: "done" }, source);
      })(),
    );
    return attachHostedRunLifetime(pending, {
      finalize: async () => {
        steps.push("finalized");
        finalized.resolve();
      },
    });
  });
  try {
    await agent.resumeInterruptedRuns(
      async (_id, event) => {
        expect(event?.type).toBe("done");
        expect(currentPrivateActorFence()?.consumer?.hostId).toBe(
          consumer.hostId,
        );
        steps.push("settled");
      },
      undefined,
      undefined,
      undefined,
      async (_id, event) => {
        expect(currentPrivateActorFence()?.consumer?.hostId).toBe(
          consumer.hostId,
        );
        steps.push(event.type);
      },
    );
    await finalized.promise;
    expect(steps).toContain("reattach_start");
    expect(steps).toContain("reattach_ok");
    expect(steps).toContain("text_chunk");
    expect(steps).toContain("settled");
    expect(steps.at(-1)).toBe("finalized");
  } finally {
    transition.mockRestore();
  }
}, 10_000);

test("unknown or revoked original enrollment cannot drive boot recovery or clear its evidence", async () => {
  const { run, consumer } = await fixture();
  await authority.requestPersonalRunRetirement(consumer);
  let calls = 0;
  agent.__setLocalHostResumeForTest(() => {
    calls++;
    return Promise.resolve("uncertain");
  });
  await agent.resumeInterruptedRuns(() => {
    throw new Error("must not settle stale source");
  });
  expect(calls).toBe(0);
  const row = await kernel.sessionCatalogDocument({
    op: "get",
    namespace: "personal_active_runs_v1",
    key: run.runKey,
  });
  expect(row?.value).toBeDefined();
});

test("post-await revocation and successor mismatch cannot turn an old recovery callback into new authority", async () => {
  const { run, consumer } = await fixture();
  const source = await capturePersonalRecoveryContext(run);
  const release = Promise.withResolvers<void>();
  const original = authority.personalRunRetired;
  const delayed = spyOn(authority, "personalRunRetired").mockImplementation(
    async (c) => {
      await release.promise;
      return original(c);
    },
  );
  let writes = 0;
  try {
    const pending = withPersonalRecoveryContext(run, source, async () => {
      writes++;
    });
    await authority.requestPersonalRunRetirement(consumer);
    revokeSessionPublications([consumer.sessionId]);
    release.resolve();
    await expect(pending).rejects.toThrow("expired");
    expect(writes).toBe(0);
  } finally {
    release.resolve();
    delayed.mockRestore();
  }
  await expect(
    withPersonalRecoveryContext(
      { ...run, hostId: `rh-${crypto.randomUUID()}` },
      source,
      async () => {
        writes++;
      },
    ),
  ).rejects.toThrow();
  expect(writes).toBe(0);
});

test("orphaned physical journal without exact enrollment remains indexed and cannot report/recover", async () => {
  const { run, consumer } = await fixture();
  const orphan = { ...run, hostId: `rh-${crypto.randomUUID()}` };
  await journal.journalSet(orphan, async () => {}, { replaces: consumer });
  let resumed = 0,
    settled = 0;
  agent.__setLocalHostResumeForTest(() => {
    resumed++;
    return Promise.resolve("uncertain");
  });
  await agent.resumeInterruptedRuns(() => {
    settled++;
  });
  expect(resumed).toBe(0);
  expect(settled).toBe(0);
  const row = await kernel.sessionCatalogDocument({
    op: "get",
    namespace: "personal_active_runs_v1",
    key: run.runKey,
  });
  expect(JSON.parse(row!.value!).hostId).toBe(orphan.hostId);
});

test("revocation during awaited reattach_ok preserves counters/evidence and still finalizes attached lifetime", async () => {
  const { run, consumer } = await fixture();
  await journal.journalSet(
    { ...run, resumeAttempts: 2, lastResumeAt: "2026-01-01T00:00:00.000Z" },
    async () => {},
  );
  const finalized = Promise.withResolvers<void>();
  let iterated = 0,
    settled = 0;
  let before: { resumeAttempts: number; lastResumeAt: string } | undefined;
  const mark = spyOn(journal, "journalMarkRecoveryAttachedAsync");
  const transition = spyOn(runState, "transitionRunState").mockImplementation(
    async (_id, event) => {
      if (event === "reattach_ok") {
        const row = await kernel.sessionCatalogDocument({
          op: "get",
          namespace: "personal_active_runs_v1",
          key: run.runKey,
        });
        before = JSON.parse(row!.value!);
        await authority.requestPersonalRunRetirement(consumer);
        revokeSessionPublications([consumer.sessionId]);
      }
      return "idle";
    },
  );
  agent.__setLocalHostResumeForTest(() =>
    attachHostedRunLifetime(
      Promise.resolve(
        (async function* () {
          iterated++;
          yield { type: "done" as const };
        })(),
      ),
      {
        finalize: async () => {
          finalized.resolve();
        },
      },
    ),
  );
  try {
    await agent.resumeInterruptedRuns(() => {
      settled++;
    });
    await finalized.promise;
    expect(mark).not.toHaveBeenCalled();
    expect(iterated).toBe(0);
    expect(settled).toBe(0);
    const row = await kernel.sessionCatalogDocument({
      op: "get",
      namespace: "personal_active_runs_v1",
      key: run.runKey,
    });
    expect(row?.value).toBeDefined();
    const retained = JSON.parse(row!.value!);
    expect(before?.resumeAttempts).toBeGreaterThan(0);
    expect(retained.resumeAttempts).toBe(before!.resumeAttempts);
    expect(retained.lastResumeAt).toBe(before!.lastResumeAt);
  } finally {
    mark.mockRestore();
    transition.mockRestore();
  }
});
