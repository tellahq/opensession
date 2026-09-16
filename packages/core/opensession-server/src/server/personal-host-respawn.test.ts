import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunHostSpec } from "../runner-host/protocol";

test("private respawn durably publishes successor before retiring predecessor; crash still leaves recoverable successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "personal-respawn-"));
  const keys = [
    "HOME",
    "OPENSESSION_STATE_DIR",
    "OPENSESSION_CONFIG",
    "OPENSESSION_SESSIONS_DIR",
    "OPENSESSION_RUN_JOURNAL",
    "CREDENTIALS_DIRECTORY",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.OPENSESSION_STATE_DIR = root;
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  process.env.OPENSESSION_SESSIONS_DIR = join(root, "sessions");
  delete process.env.OPENSESSION_RUN_JOURNAL;
  delete process.env.CREDENTIALS_DIRECTORY;
  await writeFile(process.env.OPENSESSION_CONFIG, "{}");
  await mkdir(process.env.OPENSESSION_SESSIONS_DIR);
  const paths = await import("./paths");
  const previousDir = paths.__setSessionsDirForTest(
    process.env.OPENSESSION_SESSIONS_DIR,
  );
  const kernel = await import("./session-kernel");
  const { SessionKernelStore } = await import("./session-kernel/store");
  const store = new SessionKernelStore(":memory:");
  const previous = kernel.__setSessionKernelStoreForTest(store);
  const { HostHandle, systemdHostLauncher } = await import("./host-client");
  const defaults = await import("./personal-repo-runtime-default");
  const physical = await import("./personal-host-physical");
  const consumers = await import("./personal-run-consumers");
  const { createPersonalRepositoryCoordinator } =
    await import("./personal-repository-coordinator");
  const { startSessionAudiences, withSessionPublication } =
    await import("./session-audience");
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
  const id = "private";
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
  const hostId = "rh-019d2a5f-4ac8-7000-8000-123456789abc";
  const old = { runKey: hostId, hostId, sessionId: id, binding };
  await withSessionPublication(
    id,
    41,
    () => consumers.registerPersonalRunConsumer(old),
    { binding },
  );
  // Use the protocol path rather than assuming the directory's spelling.
  const hosts = (await import("../runner-host/protocol")).runHostsDir(
    join(root, "sessions"),
  );
  const dir = join(hosts, hostId);
  await mkdir(dir, { recursive: true });
  const spec: RunHostSpec = {
    hostId,
    logicalRunId: hostId,
    mcpServers: [],
    proxyMcpServers: [],
    osSessionId: id,
    personalRepo: binding,
    prompt: "fixture",
    cwd: root,
    mode: "code",
    lifecycle: "auxiliary",
  };
  await writeFile(join(dir, "spec.json"), JSON.stringify(spec));
  const order: string[] = [];
  const runtime = spyOn(defaults, "personalRepoRuntime").mockResolvedValue({
    resolve: async () => {},
    assertWorkspace: async () => {},
  } as unknown as Awaited<ReturnType<typeof defaults.personalRepoRuntime>>);
  const stop = spyOn(physical, "stopPersonalPhysicalHost").mockImplementation(
    async (c) => {
      expect(c.hostId).toBe(old.hostId);
      const next = JSON.parse(
        await readFile(join(root, "journal-fixture.json"), "utf8"),
      );
      expect(next.hostId).not.toBe(old.hostId);
      expect(next.runKey).toBe(old.runKey);
      await consumers.assertPersonalRunConsumerEnrolled(next);
      const exported = JSON.parse(
        await readFile(join(hosts, next.hostId, "spec.json"), "utf8"),
      );
      expect(exported.logicalRunId).toBe(old.runKey);
      order.push("old physical absence");
    },
  );
  const launch = spyOn(systemdHostLauncher, "launch").mockImplementation(
    async () => {
      order.push("crash before new launch");
      throw new Error("synthetic crash");
    },
  );
  const originalConnector = systemdHostLauncher.connector;
  const { currentPrivateActorFence } = await import("./session-audience");
  const askGate = Promise.withResolvers<{
    behavior: "allow";
    updatedInput: Record<string, unknown>;
  }>();
  const answerSent = Promise.withResolvers<void>();
  const asks: string[] = [];
  const answers: unknown[] = [];
  const handle = new HostHandle(
    dir,
    spec,
    {
      onAskUser: async () => {
        asks.push(currentPrivateActorFence()!.consumer!.hostId);
        return askGate.promise;
      },
    },
    systemdHostLauncher,
  );
  handle.setHostChangeHandler(async (nextHost) => {
    const next = { ...old, hostId: nextHost };
    await consumers.registerPersonalRunConsumer(next);
    // The production callback awaits journalSet. This durable test writer
    // models that callback without touching any legacy/shared journal file.
    await writeFile(join(root, "journal-fixture.json"), JSON.stringify(next));
    order.push("successor durable");
  });
  try {
    await handle.bindPublication();
    (handle as unknown as { handleMsg(message: unknown): void }).handleMsg({
      t: "ask",
      askId: "restored-question",
      input: { question: "fixture" },
    });
    (handle as unknown as { handleMsg(message: unknown): void }).handleMsg({
      t: "event",
      event: { type: "text_chunk", text: "queued A" },
    });
    await expect(
      (handle as unknown as { respawn(id: string): Promise<void> }).respawn(
        "synthetic-engine",
      ),
    ).rejects.toThrow("synthetic crash");
    expect(order).toEqual([
      "successor durable",
      "old physical absence",
      "crash before new launch",
    ]);
    expect(await consumers.personalRunRetirementConfirmed(old)).toBe(true);
    const next = JSON.parse(
      await readFile(join(root, "journal-fixture.json"), "utf8"),
    );
    expect(await consumers.personalRunRetired(next)).toBe(false);
    await consumers.assertPersonalRunConsumerEnrolled(next);
    expect(await Bun.file(join(hosts, next.hostId, "spec.json")).exists()).toBe(
      true,
    );
    // A second same-lineage physical attempt succeeds. The queued A event
    // must not be reinterpreted as output from the now-current producer.
    let incoming!: import("./host-client").HostConnectionHandlers;
    systemdHostLauncher.connector = () => ({
      connect: async (handlers) => {
        incoming = handlers;
        return {
          send: (message) => {
            if (message.t === "ask_answer") {
              answers.push(message);
              answerSent.resolve();
            }
            return true;
          },
          close() {},
        };
      },
    });
    stop.mockImplementation(async (c) => {
      expect(c.hostId).toBe(next.hostId);
      const checkpoint = JSON.parse(
        await readFile(join(root, "journal-fixture.json"), "utf8"),
      );
      expect(checkpoint.hostId).not.toBe(next.hostId);
      await consumers.assertPersonalRunConsumerEnrolled(checkpoint);
    });
    launch.mockImplementation(async () => {});
    await (handle as unknown as { respawn(id: string): Promise<void> }).respawn(
      "synthetic-engine",
    );
    const finalHost = handle.currentHostId;
    incoming.onMsg({
      t: "event",
      event: { type: "text_chunk", text: "current B" },
    });
    incoming.onMsg({
      t: "ask",
      askId: "restored-question",
      input: { question: "fixture" },
    });
    askGate.resolve({ behavior: "allow", updatedInput: { answer: "fixture" } });
    await answerSent.promise;
    expect(asks).toEqual([old.hostId, finalHost]);
    expect(answers).toHaveLength(1);
    incoming.onMsg({ t: "end", done: { type: "done" } });
    const { withHostedEventPublication } =
      await import("./host-event-publication");
    const events = [];
    for await (const event of handle.events()) {
      withHostedEventPublication(
        event,
        () =>
          expect(currentPrivateActorFence()?.consumer?.hostId).toBe(finalHost),
        true,
      );
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["text_chunk", "done"]);
    expect(events[0]?.text).toBe("current B");
    // Stream end is not the caller's postprocessing acknowledgement.
    withHostedEventPublication(
      events.at(-1)!,
      () =>
        expect(currentPrivateActorFence()?.consumer?.hostId).toBe(finalHost),
      true,
    );
    expect(
      await consumers.personalRunRetirementConfirmed({
        ...old,
        hostId: finalHost,
      }),
    ).toBe(false);
  } finally {
    askGate.resolve({ behavior: "allow", updatedInput: {} });
    handle.abandon();
    if (originalConnector) systemdHostLauncher.connector = originalConnector;
    else delete systemdHostLauncher.connector;
    launch.mockRestore();
    stop.mockRestore();
    runtime.mockRestore();
    kernel.__setSessionKernelStoreForTest(previous);
    store.close();
    paths.__setSessionsDirForTest(previousDir);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
