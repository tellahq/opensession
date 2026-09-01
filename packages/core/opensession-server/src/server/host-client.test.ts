import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  HostHandle,
  localRunHostsSupported,
  reconcileUncertainHostEvents,
  retryHostedKernelCall,
  resolveInactiveHostRecovery,
  type HostLauncher,
} from "./host-client";
import { SessionKernelActorError } from "./session-kernel/actor-client";
import type { RunHostMeta, RunHostSpec } from "../runner-host/protocol";
import {
  TranscriptStore,
  __setTranscriptStoreForTest,
} from "./transcript-store";
import {
  transcriptLineAssistantText,
  transcriptLineUser,
} from "./transcript-persistence";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
  __sessionKernelStoreForTest,
} from "./session-kernel";
import { hostRunBusy } from "./host-registry";
import {
  __setActiveRunsPathForTest,
  takeInterruptedRuns,
  type ActiveRunRecord,
} from "./run-journal";

const roots: string[] = [];

function registerTestRun(sessionId: string, runId: string): void {
  const store = __sessionKernelStoreForTest();
  const prior = store.runState(sessionId);
  store.setRunState({
    sessionId,
    state: "running",
    event: "run_registered",
    currentRunId: runId,
    generation:
      prior.currentRunId === runId ? prior.generation : prior.generation + 1,
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function makeHandle(spec: RunHostSpec) {
  const root = mkdtempSync(join(tmpdir(), "host-client-test-"));
  roots.push(root);
  const dir = join(root, spec.hostId);
  mkdirSync(dir);
  const launcher: HostLauncher = {
    alive: () => true,
    newRunDir: (hostId) => join(root, hostId),
    launch: async () => {},
  };
  return new HostHandle(dir, spec, {}, launcher);
}

describe("hosted kernel retry", () => {
  test("waits out retryable lane failures before succeeding", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await retryHostedKernelCall(
      () => {
        calls++;
        if (calls < 3)
          throw new SessionKernelActorError("lane timed out", true);
        return "ok";
      },
      {
        attempts: 3,
        delayMs: 10_100,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([10_100, 10_100]);
  });

  test("does not retry non-retryable authority failures", async () => {
    let calls = 0;
    let waits = 0;
    const error = new SessionKernelActorError("authority lost", false);

    await expect(
      retryHostedKernelCall(
        () => {
          calls++;
          throw error;
        },
        {
          sleep: async () => {
            waits++;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(waits).toBe(0);
  });
});

describe("uncertain host reconciliation", () => {
  test("delivers an offline terminal result before destructive stop", async () => {
    let preserved = false;
    const fake = {
      ended: false,
      connectWithWait: async () => {
        throw new Error("not connectable");
      },
      events: async function* () {},
      executionEvidence: async () => ({
        started: true,
        done: { type: "done", result: "offline complete" },
      }),
      stopAndWait: async (_timeout: number, preserve: boolean) => {
        preserved = preserve;
        fake.ended = true;
        return true;
      },
    };
    const events = reconcileUncertainHostEvents(fake as any, "Sandbox", 0);
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "offline complete",
    });
    expect((await events.next()).done).toBe(true);
    expect(preserved).toBe(true);
  });

  test("re-reads terminal evidence after stop settlement", async () => {
    let reads = 0;
    const fake = {
      ended: false,
      connectWithWait: async () => {
        throw new Error("not connectable");
      },
      events: async function* () {},
      executionEvidence: async () =>
        ++reads === 1
          ? { started: true }
          : {
              started: true,
              done: { type: "done", result: "finished while stopping" },
            },
      stopAndWait: async () => true,
      takeObservedTerminal: () => undefined,
    };
    const events = reconcileUncertainHostEvents(fake as any, "Sandbox", 0);
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "finished while stopping",
    });
    expect((await events.next()).done).toBe(true);
  });

  test("prefers a terminal observed live while stop is settling", async () => {
    let terminal: any;
    const fake = {
      ended: false,
      connectWithWait: async () => {
        throw new Error("not connectable");
      },
      events: async function* () {},
      executionEvidence: async () => ({ started: false }),
      stopAndWait: async () => {
        terminal = { type: "done", result: "live finish" };
        return true;
      },
      takeObservedTerminal: () => {
        const value = terminal;
        terminal = undefined;
        return value;
      },
    };
    const events = reconcileUncertainHostEvents(fake as any, "Sandbox", 0);
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "live finish",
    });
    expect((await events.next()).done).toBe(true);
  });

  test("retained uncertainty is a nonterminal notice", async () => {
    const fake = {
      ended: false,
      connectWithWait: async () => {
        throw new Error("not connectable");
      },
      events: async function* () {},
      executionEvidence: async () => ({ started: false }),
      stopAndWait: async () => false,
    };
    const events = reconcileUncertainHostEvents(fake as any, "Sandbox", 0);
    expect((await events.next()).value).toMatchObject({
      type: "runner_notice",
    });
    fake.ended = true;
    expect((await events.next()).done).toBe(true);
  });
});

describe("local run-host capability", () => {
  test("busy checks consume an offline terminal host receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-terminal-test-"));
    roots.push(root);
    const hostId = `rh-${crypto.randomUUID()}`;
    const dir = join(root, hostId);
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: `os-${crypto.randomUUID()}`,
      prompt: "run once",
      cwd: "/tmp",
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      {
        alive: () => true,
        newRunDir: (id) => join(root, id),
        launch: async () => {},
      },
    );
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        hostId,
        pid: process.pid,
        osSessionId: spec.osSessionId,
        startedAt: new Date().toISOString(),
        done: { type: "done", result: "completed while disconnected" },
      } satisfies RunHostMeta),
    );

    expect(hostRunBusy(hostId)).toBe(false);
    expect((await handle.events().next()).value).toMatchObject({
      type: "done",
      result: "completed while disconnected",
    });
    expect(handle.ended).toBe(true);
  });

  test("requires Linux, a booted systemd, systemctl, and sudo", () => {
    const commands = (command: string) =>
      ["systemctl", "sudo"].includes(command) ? `/usr/bin/${command}` : null;
    expect(localRunHostsSupported("linux", true, commands)).toBe(true);
    expect(localRunHostsSupported("darwin", true, commands)).toBe(false);
    expect(localRunHostsSupported("linux", false, commands)).toBe(false);
    expect(localRunHostsSupported("linux", true, () => null)).toBe(false);
  });

  test("keeps hermetic fixtures off the live run-host installation", () => {
    const previous = process.env.OPENSESSION_TEST_IN_PROCESS_RUNS;
    process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = "1";
    try {
      expect(localRunHostsSupported("linux", true, () => "/usr/bin/tool")).toBe(
        false,
      );
    } finally {
      if (previous === undefined)
        delete process.env.OPENSESSION_TEST_IN_PROCESS_RUNS;
      else process.env.OPENSESSION_TEST_IN_PROCESS_RUNS = previous;
    }
  });

  test("keeps a fresh host out of the boot recovery claim", async () => {
    const hostId = `rh-${crypto.randomUUID()}`;
    const osSessionId = `os-${crypto.randomUUID()}`;
    const spec: RunHostSpec = {
      hostId,
      osSessionId,
      prompt: "run once",
      cwd: "/tmp",
    };
    const handle = makeHandle(spec);
    const journalRoot = mkdtempSync(join(tmpdir(), "host-claim-test-"));
    roots.push(journalRoot);
    const journalPath = join(journalRoot, "active-runs.json");
    const previousJournal = __setActiveRunsPathForTest(journalPath);
    const record: ActiveRunRecord = {
      runKey: hostId,
      hostId,
      osSessionId,
      prompt: spec.prompt,
      cwd: spec.cwd,
      kind: "prompt",
      startedAt: new Date().toISOString(),
    };
    writeFileSync(journalPath, JSON.stringify({ [hostId]: record }));

    try {
      expect(hostRunBusy(hostId)).toBe(true);
      expect(await takeInterruptedRuns()).toEqual([]);
    } finally {
      handle.abandon();
      __setActiveRunsPathForTest(previousJournal);
    }
  });
});

describe("inactive local host recovery", () => {
  test("does not replay execution evidence without an engine session", () => {
    expect(
      resolveInactiveHostRecovery(
        {
          hostId: "rh-test",
          pid: 123,
          osSessionId: "session-test",
          startedAt: new Date().toISOString(),
        },
        null,
      ),
    ).toEqual({ kind: "uncertain" });
  });

  test("recovers an engine session from metadata or the private journal", () => {
    expect(
      resolveInactiveHostRecovery(
        {
          hostId: "rh-test",
          pid: 123,
          osSessionId: "session-test",
          startedAt: new Date().toISOString(),
          engineSessionId: "engine-meta",
        },
        null,
      ),
    ).toEqual({ kind: "resume", engineSessionId: "engine-meta" });
    expect(
      resolveInactiveHostRecovery(null, {
        runKey: "run-1",
        osSessionId: "session-1",
        claudeSessionId: "engine-journal",
        cwd: "/tmp",
        kind: "prompt",
        startedAt: new Date().toISOString(),
      }),
    ).toEqual({ kind: "resume", engineSessionId: "engine-journal" });
  });

  test("allows replay only when no execution evidence exists", () => {
    expect(resolveInactiveHostRecovery(null, null)).toEqual({ kind: "replay" });
  });
});

function hello(spec: RunHostSpec, selectedModel: string) {
  return {
    t: "hello" as const,
    hostId: spec.hostId,
    pid: 1,
    osSessionId: spec.osSessionId,
    state: "running" as const,
    pendingAsks: [],
    selectedModel,
    effectiveModel: selectedModel,
    transientFallback: false,
  };
}

describe("HostHandle model recovery", () => {
  test("reports an engine id recovered from the initial host snapshot", () => {
    const spec: RunHostSpec = {
      hostId: "rh-workflow-early-init",
      osSessionId: "os-parent",
      lifecycle: "auxiliary",
      transcriptTarget: "none",
      prompt: "review",
      cwd: "/tmp",
    };
    const reported: string[] = [];
    const handle = new HostHandle("/tmp/rh-workflow-early-init", spec, {
      onEngineSession: (id) => reported.push(id),
    });

    (handle as any).handleMsg({
      ...hello(spec, "pi/openai/gpt-5.6-sol"),
      engineSessionId: "pi-before-attach",
    });
    (handle as any).handleMsg({
      ...hello(spec, "pi/openai/gpt-5.6-sol"),
      engineSessionId: "pi-before-attach",
    });

    expect(reported).toEqual(["pi-before-attach"]);
    expect((handle as any).engineSessionId).toBe("pi-before-attach");
    (handle as any).finish();
  });

  test("reuses a steer id for transcript rows forwarded by an older host", () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-steer-id-test-"));
    roots.push(root);
    const dir = join(root, "rh-steer-id");
    mkdirSync(dir);
    const handle = new HostHandle(
      dir,
      {
        hostId: "rh-steer-id",
        osSessionId: "os-steer-id",
        prompt: "keep working",
        cwd: "/tmp",
        model: "pi/anthropic/claude-sonnet-5",
      },
      {},
    );
    (handle as any).pendingSteerTranscripts.push({
      id: "delivery-one",
      text: "[Kent] check the tests",
    });
    const [promptLine, line] = (handle as any).alignSteerTranscriptIds([
      {
        type: "user",
        uuid: "opening-prompt",
        message: {
          role: "user",
          content: [{ type: "text", text: "keep working" }],
        },
      },
      {
        type: "user",
        uuid: "old-host-random-id",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Kent] check the tests" }],
        },
      },
    ]);
    expect(promptLine.uuid).toBe("opening-prompt");
    expect(line.uuid).toBe("delivery-one");
    expect((handle as any).pendingSteerTranscripts).toEqual([]);
    (handle as any).finish();
  });

  test("waits for the host to confirm an exact steer retraction", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-retract-test-"));
    roots.push(root);
    const dir = join(root, "rh-retract");
    mkdirSync(dir);
    const sent: any[] = [];
    let handlers: { onMsg(msg: any): void; onClose(): void } | undefined;
    const launcher: HostLauncher = {
      alive: () => true,
      newRunDir: (hostId) => join(root, hostId),
      launch: async () => {},
      connector: () => ({
        connect: async (nextHandlers) => {
          handlers = nextHandlers;
          return {
            send: (message) => {
              sent.push(message);
              return true;
            },
            close: () => {},
          };
        },
      }),
    };
    const spec: RunHostSpec = {
      hostId: "rh-retract",
      osSessionId: "os-retract",
      prompt: "keep working",
      cwd: "/tmp",
      model: "pi/anthropic/claude-sonnet-5",
    };
    const handle = new HostHandle(dir, spec, {}, launcher);
    await handle.connectWithWait(100);

    const retraction = (handle as any).ctl.retractSteer("steer-2");
    const request = sent.find((message) => message.t === "retract_steer");
    expect(request).toMatchObject({ t: "retract_steer", steerId: "steer-2" });
    handlers!.onMsg({
      t: "steer_retracted",
      requestId: request.requestId,
      steerId: "steer-2",
      retracted: true,
    });
    expect(await retraction).toBe(true);
    (handle as any).finish();
  });

  test("acknowledges a terminal event so the detached host can exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-terminal-test-"));
    roots.push(root);
    const dir = join(root, "rh-terminal");
    mkdirSync(dir);
    const sent: unknown[] = [];
    let handlers: { onMsg(msg: any): void; onClose(): void } | undefined;
    const launcher: HostLauncher = {
      alive: () => true,
      newRunDir: (hostId) => join(root, hostId),
      launch: async () => {},
      connector: () => ({
        connect: async (nextHandlers) => {
          handlers = nextHandlers;
          return {
            send: (message) => {
              sent.push(message);
              return true;
            },
            close: () => {},
          };
        },
      }),
    };
    const spec: RunHostSpec = {
      hostId: "rh-terminal",
      osSessionId: "os-terminal",
      prompt: "finish once",
      cwd: "/tmp",
    };
    const handle = new HostHandle(dir, spec, {}, launcher);
    await handle.connectWithWait(100);
    const events = handle.events();
    handlers!.onMsg({
      t: "event",
      event: { type: "done", result: "PI_SURVIVED_RESTART" },
    });
    handlers!.onMsg({
      t: "end",
      done: { type: "done", result: "PI_SURVIVED_RESTART" },
    });

    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "PI_SURVIVED_RESTART",
    });
    expect((await events.next()).done).toBe(true);
    expect(sent).toContainEqual({ t: "shutdown" });
    expect(handle.ended).toBe(true);
  });

  test("applies proxied transcript frames in the server store", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-transcript-test-"));
    roots.push(root);
    const store = new TranscriptStore(join(root, "transcripts.db"), {
      actorOwned: true,
    });
    const previous = __setTranscriptStoreForTest(store);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const spec: RunHostSpec = {
      hostId: "rh-transcript",
      osSessionId: "os-transcript",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, spec.hostId);
    const handle = makeHandle(spec);
    try {
      (handle as any).handleMsg({
        t: "transcript",
        engineSessionId: spec.osSessionId,
        lines: [transcriptLineUser("hello", "prompt-1")],
      });
      await handle.waitForPendingProjections();

      expect(store.readTail(spec.osSessionId, 10).entries).toMatchObject([
        { id: "prompt-1", type: "user", content: "hello" },
      ]);
    } finally {
      (handle as any).finish();
      __setTranscriptStoreForTest(previous);
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("keeps auxiliary worker frames out of the parent session", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-auxiliary-test-"));
    roots.push(root);
    const store = new TranscriptStore(join(root, "transcripts.db"), {
      actorOwned: true,
    });
    const previous = __setTranscriptStoreForTest(store);
    const spec: RunHostSpec = {
      hostId: "rh-workflow-worker",
      osSessionId: "os-parent-session",
      lifecycle: "auxiliary",
      transcriptTarget: "none",
      prompt: "review",
      cwd: "/tmp",
    };
    const handle = makeHandle(spec);
    try {
      expect(hostRunBusy(spec.osSessionId)).toBe(false);
      (handle as any).handleMsg({
        t: "transcript",
        engineSessionId: "engine-workflow-worker",
        lines: [transcriptLineUser("inspect", "workflow-prompt")],
      });
      await handle.waitForPendingProjections();

      expect(store.readTail("engine-workflow-worker", 10).entries).toEqual([]);
      expect(store.readTail(spec.osSessionId, 10).entries).toEqual([]);
    } finally {
      (handle as any).finish();
      __setTranscriptStoreForTest(previous);
    }
  });

  test("closes after an end frame that follows a failed transcript projection", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "host-client-projection-failure-test-"),
    );
    roots.push(root);
    const store = new TranscriptStore(join(root, "transcripts.db"), {
      actorOwned: true,
    });
    const applyActorRequest = store.applyActorRequest.bind(store);
    (store as any).applyActorRequest = (request: { op?: string }) => {
      if (request.op === "append") throw new Error("projection rejected");
      return applyActorRequest(request as any);
    };
    const previous = __setTranscriptStoreForTest(store);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const spec: RunHostSpec = {
      hostId: "rh-projection-failure",
      osSessionId: "os-projection-failure",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, spec.hostId);
    const handle = makeHandle(spec);
    const events = handle.events();
    let steerFailures = 0;
    (handle as any).cb.onSteerFailed = () => steerFailures++;
    try {
      (handle as any).handleMsg({
        t: "transcript",
        engineSessionId: spec.osSessionId,
        lines: [transcriptLineUser("hello", "prompt-1")],
      });
      await (handle as any).projectionTail;
      expect((handle as any).projectionTail).toBeUndefined();

      // The failure is permanent even after the active tail has drained.
      (handle as any).handleMsg({ t: "steer_failed", text: "late frame" });
      await (handle as any).projectionTail;
      expect(steerFailures).toBe(0);

      // Terminal cleanup still runs through the permanent failed fence.
      (handle as any).handleMsg({
        t: "end",
        done: { type: "done", result: "finished" },
      });

      expect((await events.next()).value).toMatchObject({
        type: "error",
        content: "Run host projection failed: projection rejected",
      });
      expect((await events.next()).value).toMatchObject({
        type: "done",
        result: "finished",
      });
      expect((await events.next()).done).toBe(true);
      await expect(handle.waitForPendingProjections()).rejects.toThrow(
        "projection rejected",
      );
      expect(handle.ended).toBe(true);
    } finally {
      (handle as any).finish();
      __setTranscriptStoreForTest(previous);
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("serializes consecutive transcript frames through exact actor receipts", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "host-client-transcript-order-test-"),
    );
    roots.push(root);
    const store = new TranscriptStore(join(root, "transcripts.db"), {
      actorOwned: true,
    });
    const previous = __setTranscriptStoreForTest(store);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const spec: RunHostSpec = {
      hostId: "rh-transcript-order",
      osSessionId: "os-transcript-order",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, spec.hostId);
    const handle = makeHandle(spec);
    try {
      for (const [id, content] of [
        ["prompt-1", "first"],
        ["prompt-2", "second"],
      ]) {
        (handle as any).handleMsg({
          t: "transcript",
          engineSessionId: spec.osSessionId,
          lines: [transcriptLineUser(content, id)],
        });
      }
      await handle.waitForPendingProjections();
      expect(store.readTail(spec.osSessionId, 10).entries).toMatchObject([
        { id: "prompt-1", content: "first" },
        { id: "prompt-2", content: "second" },
      ]);
    } finally {
      (handle as any).finish();
      __setTranscriptStoreForTest(previous);
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("applies transcript frames after the run settled (reattach backfill)", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "host-client-settled-transcript-test-"),
    );
    roots.push(root);
    const store = new TranscriptStore(join(root, "transcripts.db"), {
      actorOwned: true,
    });
    const previous = __setTranscriptStoreForTest(store);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const spec: RunHostSpec = {
      hostId: "rh-settled",
      osSessionId: "os-settled-transcript",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, spec.hostId);
    // The restart/settle race: the run goes idle BEFORE the host's
    // reattach hello replays its transcript history (2026-08-21
    // os-01a02469 — the turn's closing summary was lost this way).
    kernelStore.setRunState({
      sessionId: spec.osSessionId,
      state: "idle",
      event: "turn_end",
    });
    const handle = makeHandle(spec);
    try {
      (handle as any).handleMsg({
        t: "transcript",
        engineSessionId: spec.osSessionId,
        lines: [transcriptLineUser("late summary", "prompt-late")],
      });
      await handle.waitForPendingProjections();
      expect(store.readTail(spec.osSessionId, 10).entries).toMatchObject([
        { id: "prompt-late", type: "user", content: "late summary" },
      ]);
    } finally {
      (handle as any).finish();
      __setTranscriptStoreForTest(previous);
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("waits for an ended host's transcript catch-up before closing", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-ended-catchup-test-"));
    roots.push(root);
    const store = new TranscriptStore(join(root, "transcripts.db"), {
      actorOwned: true,
    });
    const previous = __setTranscriptStoreForTest(store);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const spec: RunHostSpec = {
      hostId: "rh-ended-catchup",
      osSessionId: "os-ended-catchup",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, spec.hostId);
    const handle = makeHandle(spec);
    const sent: unknown[] = [];
    (handle as any).conn = {
      send: (message: unknown) => {
        sent.push(message);
        return true;
      },
      close: () => {},
    };
    try {
      (handle as any).handleMsg({
        t: "hello",
        hostId: spec.hostId,
        pid: 1,
        osSessionId: spec.osSessionId,
        state: "ended",
        pendingAsks: [],
        done: { type: "done", result: "finished while detached" },
      });

      expect(handle.ended).toBe(false);
      expect(sent).not.toContainEqual({ t: "shutdown" });

      (handle as any).handleMsg({
        t: "transcript",
        engineSessionId: spec.osSessionId,
        lines: [transcriptLineAssistantText("final summary", "summary-late")],
      });
      (handle as any).handleMsg({ t: "catchup_complete" });
      await handle.waitForPendingProjections();

      expect(store.readTail(spec.osSessionId, 10).entries).toMatchObject([
        { id: "summary-late", type: "assistant", content: "final summary" },
      ]);
      expect(handle.ended).toBe(true);
      expect(sent).toContainEqual({ t: "shutdown" });
    } finally {
      (handle as any).finish();
      __setTranscriptStoreForTest(previous);
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("rejects transcript frames while a different live run owns the session", () => {
    const root = mkdtempSync(
      join(tmpdir(), "host-client-superseded-transcript-test-"),
    );
    roots.push(root);
    const store = new TranscriptStore(join(root, "transcripts.db"), {
      actorOwned: true,
    });
    const previous = __setTranscriptStoreForTest(store);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const spec: RunHostSpec = {
      hostId: "rh-zombie",
      osSessionId: "os-superseded-transcript",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, "rh-newer");
    const handle = makeHandle(spec);
    try {
      (handle as any).handleMsg({
        t: "transcript",
        engineSessionId: spec.osSessionId,
        lines: [transcriptLineUser("zombie", "prompt-zombie")],
      });
      expect(store.readTail(spec.osSessionId, 10).entries).toEqual([]);
    } finally {
      (handle as any).finish();
      __setTranscriptStoreForTest(previous);
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("rejects transcript frames from a stale host generation", () => {
    const root = mkdtempSync(
      join(tmpdir(), "host-client-stale-transcript-test-"),
    );
    roots.push(root);
    const store = new TranscriptStore(join(root, "transcripts.db"), {
      actorOwned: true,
    });
    const previous = __setTranscriptStoreForTest(store);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const spec: RunHostSpec = {
      hostId: "rh-stale",
      osSessionId: "os-stale-transcript",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, "rh-current");
    let asks = 0;
    let steerFailures = 0;
    const handle = makeHandle(spec);
    (handle as any).cb = {
      onAskUser: async () => {
        asks += 1;
        return null;
      },
      onSteerFailed: () => {
        steerFailures += 1;
      },
    };
    try {
      (handle as any).handleMsg({
        t: "transcript",
        engineSessionId: spec.osSessionId,
        lines: [transcriptLineUser("stale", "prompt-stale")],
      });
      (handle as any).handleMsg({ t: "ask", askId: "stale-ask", input: {} });
      (handle as any).handleMsg({ t: "steer_failed", text: "stale steer" });
      (handle as any).handleMsg({
        t: "event",
        event: { type: "init", sessionId: "engine-stale" },
      });
      (handle as any).handleMsg({
        ...hello(spec, "model-a"),
        pendingAsks: [{ askId: "stale-hello-ask", input: {} }],
      });
      expect(store.readTail(spec.osSessionId, 10).entries).toEqual([]);
      expect(asks).toBe(0);
      expect(steerFailures).toBe(0);
      expect((handle as any).engineSessionId).toBeUndefined();
    } finally {
      (handle as any).finish();
      __setTranscriptStoreForTest(previous);
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("drops an ask answer when ownership changes during the human wait", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "host-client-ask-generation-test-"),
    );
    roots.push(root);
    const dir = join(root, "rh-ask");
    mkdirSync(dir);
    const sent: any[] = [];
    let handlers: { onMsg(msg: any): void; onClose(): void } | undefined;
    const launcher: HostLauncher = {
      alive: () => true,
      newRunDir: (hostId) => join(root, hostId),
      launch: async () => {},
      connector: () => ({
        connect: async (nextHandlers) => {
          handlers = nextHandlers;
          return {
            send: (message) => {
              sent.push(message);
              return true;
            },
            close: () => {},
          };
        },
      }),
    };
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const answer = Promise.withResolvers<any>();
    const spec: RunHostSpec = {
      hostId: "rh-ask",
      osSessionId: "os-ask-generation",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, spec.hostId);
    const handle = new HostHandle(
      dir,
      spec,
      { onAskUser: () => answer.promise },
      launcher,
    );
    try {
      await handle.connectWithWait(100);
      handlers!.onMsg({ t: "ask", askId: "ask-1", input: {} });
      registerTestRun(spec.osSessionId, "rh-successor");
      answer.resolve({ behavior: "allow", updatedInput: {} });
      await Bun.sleep(0);
      expect(sent.some((message) => message.t === "ask_answer")).toBe(false);
    } finally {
      (handle as any).finish();
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("reconciles unix reconnects without duplicating reported switches", async () => {
    const spec: RunHostSpec = {
      hostId: "rh-test",
      osSessionId: "bks-test",
      prompt: "test",
      cwd: "/tmp",
      model: "model-a",
      selectedModel: "model-a",
    };
    const kernelRoot = mkdtempSync(
      join(tmpdir(), "host-client-reconnect-kernel-"),
    );
    roots.push(kernelRoot);
    const kernelStore = new SessionKernelStore(join(kernelRoot, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    registerTestRun(spec.osSessionId, spec.hostId);
    const handle = makeHandle(spec);
    const events = handle.events();

    (handle as any).handleMsg(hello(spec, "model-a"));
    (handle as any).handleMsg({
      t: "event",
      event: {
        type: "model_switch",
        fromModel: "model-a",
        toModel: "model-b",
        switchReason: "out of credits",
        temporaryFallback: false,
      },
    });
    (handle as any).handleMsg(hello(spec, "model-b"));
    (handle as any).handleMsg(hello(spec, "model-c"));
    (handle as any).handleMsg({
      t: "event",
      event: { type: "done", result: "ok" },
    });

    expect((await events.next()).value?.toModel).toBe("model-b");
    expect((await events.next()).value?.toModel).toBe("model-c");
    expect((await events.next()).value?.type).toBe("done");
    (handle as any).finish();
    __setSessionKernelStoreForTest(previousKernel);
    kernelStore.close();
  });

  test("hard-stops a host whose cooperative cancel never settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-cancel-test-"));
    roots.push(root);
    const dir = join(root, "rh-cancel");
    mkdirSync(dir);
    const sent: any[] = [];
    let stopped = 0;
    const launcher: HostLauncher = {
      alive: () => true,
      newRunDir: (hostId) => join(root, hostId),
      launch: async () => {},
      stop: async () => {
        stopped += 1;
      },
      connector: () => ({
        connect: async () => ({
          send: (message) => {
            sent.push(message);
            return true;
          },
          close: () => {},
        }),
      }),
    };
    const spec: RunHostSpec = {
      hostId: "rh-cancel",
      osSessionId: "os-cancel",
      prompt: "test",
      cwd: "/tmp",
    };
    const handle = new HostHandle(dir, spec, {}, launcher, spec.hostId, 1);

    await handle.connectWithWait(100);
    expect(handle.requestCancel()).toBe(true);
    await Bun.sleep(10);

    expect(sent.map((message) => message.t)).toEqual(["cancel", "shutdown"]);
    expect(stopped).toBe(1);
    expect(handle.ended).toBe(true);
  });

  test("respawns with the host's latest fallback state", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-respawn-test-"));
    roots.push(root);
    const oldDir = join(root, "rh-old");
    mkdirSync(oldDir);
    const spec: RunHostSpec = {
      hostId: "rh-old",
      osSessionId: "bks-test",
      prompt: "test",
      cwd: "/tmp",
      model: "model-a",
      selectedModel: "model-a",
    };
    let writtenSpec: RunHostSpec | undefined;
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (hostId) => join(root, hostId),
      writeSpec: async (_dir, nextSpec) => {
        writtenSpec = nextSpec;
      },
      launch: async () => {},
      connector: (_dir, nextSpec) => ({
        connect: async (handlers) => {
          handlers.onMsg(hello(nextSpec, nextSpec.selectedModel!));
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const transcriptStore = new TranscriptStore(join(root, "transcripts.db"), {
      actorOwned: true,
    });
    const previousTranscript = __setTranscriptStoreForTest(transcriptStore);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    registerTestRun(spec.osSessionId, spec.hostId);
    const handle = new HostHandle(oldDir, spec, {}, launcher);
    const meta: RunHostMeta = {
      hostId: spec.hostId,
      pid: 1,
      osSessionId: spec.osSessionId,
      startedAt: new Date().toISOString(),
      selectedModel: "model-b",
      effectiveModel: "model-c",
      transientFallback: true,
    };

    await (handle as any).respawn("engine-1", meta);

    expect(writtenSpec?.selectedModel).toBe("model-b");
    expect(writtenSpec?.model).toBe("model-c");
    expect(writtenSpec?.transientFallback).toBe(true);
    (handle as any).handleMsg({
      t: "transcript",
      engineSessionId: spec.osSessionId,
      lines: [transcriptLineUser("after respawn", "prompt-respawn")],
    });
    await handle.waitForPendingProjections();
    expect(
      transcriptStore.readTail(spec.osSessionId, 10).entries,
    ).toMatchObject([{ id: "prompt-respawn", content: "after respawn" }]);
    (handle as any).finish();
    __setTranscriptStoreForTest(previousTranscript);
    __setSessionKernelStoreForTest(previousKernel);
    kernelStore.close();
  });
});
