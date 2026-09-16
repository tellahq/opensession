import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as fsp from "fs/promises";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  HostConnection,
  HostConnectionHandlers,
  HostLauncher,
} from "./host-client";
import type { RunHostMeta, RunHostSpec } from "../runner-host/protocol";
import type { ActiveRunRecord } from "./run-journal";

// Isolate every path the host client and its journal/kernel dependencies
// resolve at import time, so nothing here touches operator state.
const scratch = mkdtempSync(join(tmpdir(), "host-client-test-env-"));
const previousEnv = {
  HOME: process.env.HOME,
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_SESSIONS_DIR: process.env.OPENSESSION_SESSIONS_DIR,
};
process.env.HOME = scratch;
process.env.OPENSESSION_STATE_DIR = scratch;
process.env.OPENSESSION_SESSIONS_DIR = join(scratch, "sessions");
mkdirSync(process.env.OPENSESSION_SESSIONS_DIR, { recursive: true });

const {
  HostHandle,
  hostedEventsWithJournal,
  localRunHostsSupported,
  reconcileUncertainHostEvents,
  retryHostedKernelCall,
  resolveInactiveHostRecovery,
} = await import("./host-client");
const { ExecutorProtocolError } = await import("./executor-client");
const { SessionKernelActorError } =
  await import("./session-kernel/actor-client");
const { TranscriptStore, __setTranscriptStoreForTest } =
  await import("./transcript-store");
const { transcriptLineAssistantText, transcriptLineUser } =
  await import("./transcript-persistence");
const {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
  __sessionKernelStoreForTest,
} = await import("./session-kernel");
const { hostInterruptSteer, hostRetractSteer, hostRunBusy, hostSteer } =
  await import("./host-registry");
const { __setActiveRunsPathForTest, activeRunRecords, takeInterruptedRuns } =
  await import("./run-journal");

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

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

describe("hosted run journal", () => {
  test("retires a cancelled host that ends without a terminal event", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-quiet-cancel-test-"));
    roots.push(root);
    const journalPath = join(root, "active-runs.json");
    const previousJournal = __setActiveRunsPathForTest(journalPath);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const spec: RunHostSpec = {
      hostId: "rh-quiet-cancel",
      osSessionId: "os-quiet-cancel",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, spec.hostId);
    let receive: HostConnectionHandlers["onMsg"] | undefined;
    const launcher: HostLauncher = {
      alive: () => true,
      newRunDir: (hostId) => join(root, hostId),
      launch: async () => {},
      stop: async () => {},
      connector: () => ({
        connect: async (handlers) => {
          receive = handlers.onMsg;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(
      join(root, spec.hostId),
      spec,
      {},
      launcher,
      spec.hostId,
      1,
    );

    try {
      await handle.connectWithWait(100);
      const events = hostedEventsWithJournal(handle, spec);
      const completion = events.next();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (activeRunRecords().some((run) => run.runKey === spec.hostId)) break;
        await Bun.sleep(1);
      }
      expect(activeRunRecords().some((run) => run.runKey === spec.hostId)).toBe(
        true,
      );
      expect(handle.requestCancel()).toBe(true);
      if (!receive) throw new Error("Host connector did not attach");
      receive({ t: "end" });

      expect(await completion).toEqual({ done: true, value: undefined });
      expect(activeRunRecords().some((run) => run.runKey === spec.hostId)).toBe(
        false,
      );
    } finally {
      handle.abandon();
      __setActiveRunsPathForTest(previousJournal);
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
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
      tagEvent: (event: unknown) => event,
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
      tagEvent: (event: unknown) => event,
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
  test("registry busy checks are pure and offline receipts finish asynchronously", async () => {
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
      model: "pi/anthropic/claude-sonnet-5",
    };
    let alive = true;
    const handle = new HostHandle(
      dir,
      spec,
      {},
      {
        alive: () => alive,
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

    // A receipt on disk is invisible to the registry until the handle itself
    // observes it: busy/steer/cancel lookups read cached state only.
    const spies = [
      spyOn(fs, "existsSync"),
      spyOn(fs, "readFileSync"),
      spyOn(fs, "rmSync"),
      spyOn(fs, "statSync"),
      spyOn(fsp, "readFile"),
      spyOn(fsp, "access"),
      spyOn(fsp, "rm"),
      spyOn(fsp, "stat"),
    ];
    try {
      for (let i = 0; i < 3; i++) {
        expect(hostRunBusy(hostId)).toBe(true);
        expect(hostRunBusy(spec.osSessionId)).toBe(true);
        expect(hostSteer(hostId, "nudge")).toBe(false);
        expect(hostInterruptSteer(hostId, "nudge")).toBe(false);
        expect(await hostRetractSteer([hostId], "steer-1")).toBe(false);
      }
      for (const spy of spies) expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    // The explicit observation is the same fenced path the disconnect loop
    // runs: a receipt on disk never completes a host that is still alive.
    expect(await handle.observeOfflineTerminal()).toBe(false);
    expect(handle.ended).toBe(false);
    expect(hostRunBusy(hostId)).toBe(true);
    expect(existsSync(join(dir, "meta.json"))).toBe(true);

    // Once the host is positively absent, the observation (deduped across
    // callers) consumes the receipt.
    alive = false;
    const first = handle.observeOfflineTerminal();
    const second = handle.observeOfflineTerminal();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(hostRunBusy(hostId)).toBe(false);
    expect(hostRunBusy(spec.osSessionId)).toBe(false);
    expect((await handle.events().next()).value).toMatchObject({
      type: "done",
      result: "completed while disconnected",
    });
    expect(handle.ended).toBe(true);
    await handle.whenFinalized();
    expect(existsSync(dir)).toBe(false);
    expect(await handle.observeOfflineTerminal()).toBe(true);
  });

  test("notices a terminal receipt while disconnected without any query", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-offline-terminal-test-"));
    roots.push(root);
    const hostId = "rh-offline-terminal";
    const dir = join(root, hostId);
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: "os-offline-terminal",
      prompt: "test",
      cwd: "/tmp",
    };
    let handlers: HostConnectionHandlers | undefined;
    let connects = 0;
    let alive = true;
    const launcher: HostLauncher = {
      alive: () => alive,
      newRunDir: (id) => join(root, id),
      launch: async () => {},
      connector: () => ({
        connect: async (nextHandlers) => {
          if (connects++ > 0) throw new Error("host gone");
          handlers = nextHandlers;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    // The socket drops mid-run; the host finishes and exits while detached.
    handlers!.onClose();
    expect(hostRunBusy(hostId)).toBe(true);
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        hostId,
        pid: 1,
        osSessionId: spec.osSessionId,
        startedAt: new Date().toISOString(),
        done: { type: "done", result: "finished offline" },
      } satisfies RunHostMeta),
    );
    alive = false;

    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "finished offline",
    });
    expect((await events.next()).done).toBe(true);
    expect(handle.ended).toBe(true);
    expect(hostRunBusy(hostId)).toBe(false);
    await handle.whenFinalized();
    expect(existsSync(dir)).toBe(false);
  });

  test("keeps a live but unreachable host busy with its receipt unread", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-unreachable-terminal-test-"));
    roots.push(root);
    const hostId = "rh-unreachable-terminal";
    const dir = join(root, hostId);
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: "os-unreachable-terminal",
      prompt: "test",
      cwd: "/tmp",
    };
    let handlers: HostConnectionHandlers | undefined;
    let connects = 0;
    let alive = true;
    const launcher: HostLauncher = {
      alive: () => alive,
      newRunDir: (id) => join(root, id),
      launch: async () => {},
      connector: () => ({
        connect: async (nextHandlers) => {
          if (connects++ > 0) throw new Error("transport broken");
          handlers = nextHandlers;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        hostId,
        pid: 1,
        osSessionId: spec.osSessionId,
        startedAt: new Date().toISOString(),
        done: { type: "done", result: "lingering" },
      } satisfies RunHostMeta),
    );
    handlers!.onClose();

    // A broken transport is not proof the catch-up is undrainable: the handle
    // keeps reconnecting, stays busy, and leaves the spool untouched.
    await Bun.sleep(60);
    expect(connects).toBeGreaterThan(5);
    expect(handle.ended).toBe(false);
    expect(hostRunBusy(hostId)).toBe(true);
    expect(existsSync(join(dir, "meta.json"))).toBe(true);

    // Only a positively absent host releases the offline receipt.
    alive = false;
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "lingering",
    });
    expect((await events.next()).done).toBe(true);
    expect(hostRunBusy(hostId)).toBe(false);
  });

  test("re-reads the receipt a host wrote while liveness was being checked", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-late-receipt-test-"));
    roots.push(root);
    const hostId = "rh-late-receipt";
    const dir = join(root, hostId);
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: "os-late-receipt",
      prompt: "test",
      cwd: "/tmp",
      engineSessionId: "engine-late",
    };
    let handlers: HostConnectionHandlers | undefined;
    let launches = 0;
    const launcher: HostLauncher = {
      alive: (_dir, meta) => {
        // The host writes its receipt and exits during the liveness probe,
        // after the loop's metadata read saw nothing.
        expect(meta?.done).toBeUndefined();
        writeFileSync(
          join(dir, "meta.json"),
          JSON.stringify({
            hostId,
            pid: 1,
            osSessionId: spec.osSessionId,
            startedAt: new Date().toISOString(),
            done: { type: "done", result: "written during probe" },
          } satisfies RunHostMeta),
        );
        return false;
      },
      newRunDir: (id) => join(root, id),
      launch: async () => {
        launches++;
      },
      connector: () => ({
        connect: async (nextHandlers) => {
          handlers = nextHandlers;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    handlers!.onClose();

    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "written during probe",
    });
    expect((await events.next()).done).toBe(true);
    expect(launches).toBe(0);
    expect(hostRunBusy(hostId)).toBe(false);
  });

  test("ignores a receipt left by a different host id", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-foreign-receipt-test-"));
    roots.push(root);
    const hostId = "rh-foreign-receipt";
    const dir = join(root, hostId);
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: "os-foreign-receipt",
      prompt: "test",
      cwd: "/tmp",
    };
    let handlers: HostConnectionHandlers | undefined;
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      launch: async () => {},
      connector: () => ({
        connect: async (nextHandlers) => {
          handlers = nextHandlers;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        hostId: "rh-someone-else",
        pid: 1,
        osSessionId: spec.osSessionId,
        startedAt: new Date().toISOString(),
        done: { type: "done", result: "not ours" },
      } satisfies RunHostMeta),
    );
    handlers!.onClose();

    const delivered: unknown[] = [];
    for await (const event of events) delivered.push(event);
    expect(delivered).toEqual([
      {
        type: "error",
        content: "Run host process died unexpectedly and could not be resumed.",
      },
    ]);
    expect(handle.takeObservedTerminal()).toBeUndefined();
  });

  test("offline receipt cleanup waits behind pending projections", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-pending-projection-test-"));
    roots.push(root);
    const hostId = "rh-pending-projection";
    const dir = join(root, hostId);
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: "os-pending-projection",
      prompt: "test",
      cwd: "/tmp",
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      {
        alive: () => false,
        newRunDir: (id) => join(root, id),
        launch: async () => {},
      },
    );
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        hostId,
        pid: 1,
        osSessionId: spec.osSessionId,
        startedAt: new Date().toISOString(),
        done: { type: "done", result: "after projection" },
      } satisfies RunHostMeta),
    );
    const gate = Promise.withResolvers<void>();
    (handle as any).enqueueProjectionFrame(() => gate.promise);

    const observed = handle.observeOfflineTerminal();
    await Bun.sleep(20);
    expect(handle.ended).toBe(false);
    expect(hostRunBusy(hostId)).toBe(true);
    expect(existsSync(dir)).toBe(true);

    gate.resolve();
    expect(await observed).toBe(true);
    expect(handle.ended).toBe(true);
    expect(hostRunBusy(hostId)).toBe(false);
    await handle.whenFinalized();
    expect(existsSync(dir)).toBe(false);
  });

  test("offline receipt still closes after a failed projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-failed-projection-test-"));
    roots.push(root);
    const hostId = "rh-failed-projection";
    const dir = join(root, hostId);
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: "os-failed-projection",
      prompt: "test",
      cwd: "/tmp",
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      {
        alive: () => false,
        newRunDir: (id) => join(root, id),
        launch: async () => {},
      },
    );
    const events = handle.events();
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        hostId,
        pid: 1,
        osSessionId: spec.osSessionId,
        startedAt: new Date().toISOString(),
        done: { type: "done", result: "finished" },
      } satisfies RunHostMeta),
    );
    (handle as any).enqueueProjectionFrame(() => {
      throw new Error("projection rejected");
    });

    expect(await handle.observeOfflineTerminal()).toBe(true);
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
  });

  test("terminal metadata does not finish a connected ended host before catch-up", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-catchup-fence-test-"));
    roots.push(root);
    const hostId = "rh-catchup-fence";
    const dir = join(root, hostId);
    mkdirSync(dir);
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: "os-catchup-fence",
      prompt: "test",
      cwd: "/tmp",
    };
    registerTestRun(spec.osSessionId, spec.hostId);
    const sent: unknown[] = [];
    const launcher: HostLauncher = {
      alive: () => true,
      newRunDir: (id) => join(root, id),
      launch: async () => {},
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
    const handle = new HostHandle(dir, spec, {}, launcher);
    try {
      await handle.connectWithWait(100);
      writeFileSync(
        join(dir, "meta.json"),
        JSON.stringify({
          hostId,
          pid: 1,
          osSessionId: spec.osSessionId,
          startedAt: new Date().toISOString(),
          done: { type: "done", result: "finished while detached" },
        } satisfies RunHostMeta),
      );
      (handle as any).handleMsg({
        t: "hello",
        hostId: spec.hostId,
        pid: 1,
        osSessionId: spec.osSessionId,
        state: "ended",
        pendingAsks: [],
        done: { type: "done", result: "finished while detached" },
      });

      expect(await handle.observeOfflineTerminal()).toBe(false);
      expect(handle.ended).toBe(false);
      expect(sent).not.toContainEqual({ t: "shutdown" });

      (handle as any).handleMsg({ t: "catchup_complete" });
      await handle.waitForPendingProjections();
      expect(handle.ended).toBe(true);
      expect(sent).toContainEqual({ t: "shutdown" });
    } finally {
      (handle as any).finish();
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("rejects offline evidence captured before a respawn replaced the host", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-evidence-respawn-test-"));
    roots.push(root);
    const oldDir = join(root, "rh-old");
    mkdirSync(oldDir);
    const spec: RunHostSpec = {
      hostId: "rh-old",
      osSessionId: "os-evidence-respawn",
      prompt: "test",
      cwd: "/tmp",
      model: "model-a",
      selectedModel: "model-a",
    };
    const kernelStore = new SessionKernelStore(join(root, "kernel.db"));
    const previousKernel = __setSessionKernelStoreForTest(kernelStore);
    registerTestRun(spec.osSessionId, spec.hostId);
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      writeSpec: async () => {},
      launch: async () => {},
      connector: (_dir, nextSpec) => ({
        connect: async (handlers) => {
          handlers.onMsg(hello(nextSpec, nextSpec.selectedModel!));
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(oldDir, spec, {}, launcher);
    try {
      writeFileSync(
        join(oldDir, "meta.json"),
        JSON.stringify({
          hostId: spec.hostId,
          pid: 1,
          osSessionId: spec.osSessionId,
          startedAt: new Date().toISOString(),
          done: { type: "done", result: "stale receipt" },
        } satisfies RunHostMeta),
      );
      const gate = Promise.withResolvers<void>();
      (handle as any).enqueueProjectionFrame(() => gate.promise);
      const observed = handle.observeOfflineTerminal();
      await Bun.sleep(10);

      // Ownership moves to a replacement host while the evidence is fenced.
      await (handle as any).respawn("engine-1", null);
      expect(handle.currentHostId).not.toBe(spec.hostId);
      gate.resolve();

      expect(await observed).toBe(false);
      expect(handle.ended).toBe(false);
      expect(hostRunBusy(spec.hostId)).toBe(true);
      expect(handle.takeObservedTerminal()).toBeUndefined();
    } finally {
      (handle as any).finish();
      __setSessionKernelStoreForTest(previousKernel);
      kernelStore.close();
    }
  });

  test("delivers one terminal and one cleanup across racing completions", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-terminal-race-test-"));
    roots.push(root);
    const hostId = "rh-terminal-race";
    const dir = join(root, hostId);
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: "os-terminal-race",
      prompt: "test",
      cwd: "/tmp",
    };
    let handlers: HostConnectionHandlers | undefined;
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      launch: async () => {},
      connector: () => ({
        connect: async (nextHandlers) => {
          handlers = nextHandlers;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(dir, spec, {}, launcher);
    await handle.connectWithWait(100);
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        hostId,
        pid: 1,
        osSessionId: spec.osSessionId,
        startedAt: new Date().toISOString(),
        done: { type: "done", result: "raced" },
      } satisfies RunHostMeta),
    );
    const removals = spyOn(fsp, "rm");
    try {
      handlers!.onClose();
      const observations = [
        handle.observeOfflineTerminal(),
        handle.observeOfflineTerminal(),
      ];
      handlers!.onMsg({ t: "end", done: { type: "done", result: "raced" } });
      expect(await Promise.all(observations)).toEqual([true, true]);
      expect(await handle.observeOfflineTerminal()).toBe(true);
      const delivered: unknown[] = [];
      for await (const event of handle.events()) delivered.push(event);
      expect(delivered).toEqual([{ type: "done", result: "raced" }]);
      await handle.whenFinalized();
      expect(removals).toHaveBeenCalledTimes(1);
      expect(existsSync(dir)).toBe(false);
    } finally {
      removals.mockRestore();
    }
  });

  test("a cancel during a blocked spec export finishes once and launches nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-blocked-export-test-"));
    roots.push(root);
    const oldDir = join(root, "rh-export-old");
    mkdirSync(oldDir);
    const spec: RunHostSpec = {
      hostId: "rh-export-old",
      osSessionId: "os-blocked-export",
      prompt: "test",
      cwd: "/tmp",
    };
    const exportGate = Promise.withResolvers<void>();
    const stops: string[] = [];
    let launches = 0;
    let exportedDir = "";
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      writeSpec: async (dir) => {
        exportedDir = dir;
        await exportGate.promise;
      },
      launch: async () => {
        launches++;
      },
      stop: async (hostId) => {
        stops.push(hostId);
      },
      connector: () => ({
        connect: async () => ({ send: () => true, close: () => {} }),
      }),
    };
    const handle = new HostHandle(oldDir, spec, {}, launcher, spec.hostId, 0);
    const events = handle.events();
    const respawn = (handle as any).respawn("engine-1") as Promise<void>;
    await Bun.sleep(5);
    // Ownership of the successor was reserved before the export started.
    expect(handle.currentHostId).not.toBe(spec.hostId);
    expect(hostRunBusy(spec.hostId)).toBe(true);

    expect(handle.requestCancel()).toBe(true);
    await Bun.sleep(5);
    expect(handle.ended).toBe(true);
    // The stop targeted the reserved successor, the only host that could
    // exist from here on.
    expect(stops).toEqual([handle.currentHostId]);

    exportGate.resolve();
    await expect(respawn).rejects.toThrow(
      "respawn abandoned after spec export",
    );
    expect(launches).toBe(0);
    expect(hostRunBusy(spec.hostId)).toBe(false);
    expect(hostRunBusy(handle.currentHostId)).toBe(false);
    expect((await events.next()).done).toBe(true);
    await handle.whenFinalized();
    expect(existsSync(exportedDir)).toBe(false);
  });

  test("a cancel during a blocked launch proves the successor absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-blocked-launch-test-"));
    roots.push(root);
    const oldDir = join(root, "rh-launch-old");
    mkdirSync(oldDir);
    const spec: RunHostSpec = {
      hostId: "rh-launch-old",
      osSessionId: "os-blocked-launch",
      prompt: "test",
      cwd: "/tmp",
    };
    const launchGate = Promise.withResolvers<void>();
    const stops: string[] = [];
    let connects = 0;
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      writeSpec: async () => {},
      launch: async () => {
        await launchGate.promise;
      },
      stop: async (hostId) => {
        stops.push(hostId);
      },
      connector: () => ({
        connect: async () => {
          connects++;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(oldDir, spec, {}, launcher, spec.hostId, 0);
    const respawn = (handle as any).respawn("engine-1") as Promise<void>;
    await Bun.sleep(5);
    const successor = handle.currentHostId;
    expect(handle.requestCancel()).toBe(true);
    await Bun.sleep(20);
    // The dispatch is still in flight: nothing may be proven absent or
    // finalized while the launch can still create the host.
    expect(handle.ended).toBe(false);
    expect(hostRunBusy(spec.osSessionId)).toBe(true);
    expect(stops).toEqual([]);

    launchGate.resolve();
    await expect(respawn).rejects.toThrow("respawn abandoned after launch");
    await Bun.sleep(5);
    expect(handle.ended).toBe(true);
    // Both the cancel backstop and the abandoned respawn proved the launched
    // successor absent; neither attached to it.
    expect(stops).toEqual([successor, successor]);
    expect(connects).toBe(0);
    expect(hostRunBusy(spec.osSessionId)).toBe(false);
  });

  test("a zero-grace stop during a blocked launch settles only after dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-blocked-launch-stop-test-"));
    roots.push(root);
    const oldDir = join(root, "rh-launch-stop-old");
    mkdirSync(oldDir);
    const spec: RunHostSpec = {
      hostId: "rh-launch-stop-old",
      osSessionId: "os-blocked-launch-stop",
      prompt: "test",
      cwd: "/tmp",
    };
    const launchGate = Promise.withResolvers<void>();
    const stops: string[] = [];
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      writeSpec: async () => {},
      launch: async () => {
        await launchGate.promise;
      },
      stop: async (hostId) => {
        stops.push(hostId);
      },
    };
    const handle = new HostHandle(oldDir, spec, {}, launcher);
    const respawn = (handle as any).respawn("engine-1") as Promise<void>;
    await Bun.sleep(5);
    const successor = handle.currentHostId;
    let stopped: boolean | undefined;
    const stopping = handle.stopAndWait(0, true).then((ok) => (stopped = ok));
    await Bun.sleep(30);
    expect(stopped).toBeUndefined();
    expect(handle.ended).toBe(false);
    expect(stops).toEqual([]);

    launchGate.resolve();
    await expect(respawn).rejects.toThrow("respawn abandoned after launch");
    expect(await stopping).toBe(true);
    expect(handle.ended).toBe(true);
    expect(stops).toEqual([successor, successor]);
    expect(hostRunBusy(spec.osSessionId)).toBe(false);
    expect(hostRunBusy(spec.hostId)).toBe(false);
  });

  test("a rejected replacement launch still reports failure and closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-rejected-launch-test-"));
    roots.push(root);
    const dir = join(root, "rh-rejected-launch");
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId: "rh-rejected-launch",
      osSessionId: "os-rejected-launch",
      prompt: "test",
      cwd: "/tmp",
      engineSessionId: "engine-rejected",
    };
    let handlers: HostConnectionHandlers | undefined;
    let launches = 0;
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      writeSpec: async () => {},
      launch: async () => {
        launches++;
        throw new Error("executor rejected the launch");
      },
      connector: () => ({
        connect: async (nextHandlers) => {
          handlers = nextHandlers;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    handlers!.onClose();

    const delivered: unknown[] = [];
    for await (const event of events) delivered.push(event);
    expect(delivered).toEqual([
      {
        type: "error",
        content: "Run host process died unexpectedly and could not be resumed.",
      },
    ]);
    expect(launches).toBe(1);
    expect(handle.ended).toBe(true);
    expect(hostRunBusy(spec.hostId)).toBe(false);
    expect(hostRunBusy(handle.currentHostId)).toBe(false);
  });

  test("an ambiguous replacement launch attaches to the replacement it reserved", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-ambiguous-launch-test-"));
    roots.push(root);
    const dir = join(root, "rh-ambiguous-launch");
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId: "rh-ambiguous-launch",
      osSessionId: "os-ambiguous-launch",
      prompt: "test",
      cwd: "/tmp",
      engineSessionId: "engine-ambiguous",
    };
    const connections = new Map<string, HostConnectionHandlers>();
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      writeSpec: async () => {},
      launch: async () => {
        throw new ExecutorProtocolError("dispatch outcome unknown", true);
      },
      connector: (_dir, nextSpec) => ({
        connect: async (nextHandlers) => {
          connections.set(nextSpec.hostId, nextHandlers);
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    connections.get(spec.hostId)!.onClose();
    await Bun.sleep(40);

    const replacement = handle.currentHostId;
    expect(replacement).not.toBe(spec.hostId);
    expect(connections.has(replacement)).toBe(true);
    expect(handle.ended).toBe(false);
    expect(hostRunBusy(spec.osSessionId)).toBe(true);

    connections
      .get(replacement)!
      .onMsg({ t: "end", done: { type: "done", result: "resumed" } });
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "resumed",
    });
    expect((await events.next()).done).toBe(true);
    expect(hostRunBusy(spec.osSessionId)).toBe(false);
  });

  test("refuses to respawn once a stop is in progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-stop-refuses-respawn-test-"));
    roots.push(root);
    const dir = join(root, "rh-stopping");
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId: "rh-stopping",
      osSessionId: "os-stopping",
      prompt: "test",
      cwd: "/tmp",
    };
    const stopGate = Promise.withResolvers<void>();
    let launches = 0;
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      writeSpec: async () => {},
      launch: async () => {
        launches++;
      },
      stop: async () => {
        await stopGate.promise;
      },
    };
    const handle = new HostHandle(dir, spec, {}, launcher, spec.hostId, 0);
    const stopping = handle.stopAndWait(1, true);
    await Bun.sleep(5);
    await expect((handle as any).respawn("engine-1")).rejects.toThrow(
      "respawn refused",
    );
    stopGate.resolve();
    expect(await stopping).toBe(true);
    expect(handle.ended).toBe(true);
    expect(launches).toBe(0);
    // preserveEvidence: abandoned, the run dir is kept for reconciliation.
    expect(existsSync(dir)).toBe(true);
  });

  test("a dead host found during a blocked stop is not resumed or reported", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-blocked-stop-test-"));
    roots.push(root);
    const dir = join(root, "rh-blocked-stop");
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId: "rh-blocked-stop",
      osSessionId: "os-blocked-stop",
      prompt: "test",
      cwd: "/tmp",
      engineSessionId: "engine-blocked-stop",
    };
    const stopGate = Promise.withResolvers<void>();
    const stops: string[] = [];
    let handlers: HostConnectionHandlers | undefined;
    let launches = 0;
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (id) => join(root, id),
      writeSpec: async () => {},
      launch: async () => {
        launches++;
      },
      stop: async (hostId) => {
        stops.push(hostId);
        await stopGate.promise;
      },
      connector: () => ({
        connect: async (nextHandlers) => {
          handlers = nextHandlers;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    handlers!.onClose();
    const stopping = handle.stopAndWait(1, true);
    // The disconnect loop finds the host dead while the stop is in flight.
    await Bun.sleep(150);
    expect(launches).toBe(0);
    expect(handle.ended).toBe(false);
    expect(stops).toEqual([spec.hostId]);

    stopGate.resolve();
    expect(await stopping).toBe(true);
    expect(handle.ended).toBe(true);
    const delivered: unknown[] = [];
    for await (const event of events) delivered.push(event);
    expect(delivered).toEqual([]);
    expect(launches).toBe(0);
  });

  test("a stalled reconnect attempt neither wedges the loop nor is adopted late", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-stalled-connect-test-"));
    roots.push(root);
    const dir = join(root, "rh-stalled");
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId: "rh-stalled",
      osSessionId: "os-stalled",
      prompt: "test",
      cwd: "/tmp",
    };
    const lateConnection = Promise.withResolvers<HostConnection>();
    let lateHandlers: HostConnectionHandlers | undefined;
    let liveHandlers: HostConnectionHandlers | undefined;
    const closed: string[] = [];
    const sent: Array<{ via: string; msg: unknown }> = [];
    let connects = 0;
    const launcher: HostLauncher = {
      alive: () => true,
      newRunDir: (id) => join(root, id),
      launch: async () => {},
      connector: () => ({
        connect: async (handlers) => {
          connects++;
          if (connects === 1) {
            liveHandlers = handlers;
            return {
              send: (msg) => {
                sent.push({ via: "first", msg });
                return true;
              },
              close: () => closed.push("first"),
            };
          }
          if (connects === 2) {
            // Never settles within the attempt budget.
            lateHandlers = handlers;
            return lateConnection.promise;
          }
          liveHandlers = handlers;
          return {
            send: (msg) => {
              sent.push({ via: "third", msg });
              return true;
            },
            close: () => closed.push("third"),
          };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
      10,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    liveHandlers!.onClose();
    // Attempt 2 stalls past its budget; attempt 3 must still happen.
    await Bun.sleep(60);
    expect(connects).toBe(3);
    expect((handle as any).up).toBe(true);

    // The stalled attempt settles late: closed, not adopted, callbacks dead.
    lateConnection.resolve({
      send: (msg) => {
        sent.push({ via: "late", msg });
        return true;
      },
      close: () => closed.push("late"),
    });
    await Bun.sleep(5);
    expect(closed).toEqual(["late"]);
    lateHandlers!.onMsg({ t: "end", done: { type: "done", result: "stale" } });
    lateHandlers!.onClose();
    expect(handle.ended).toBe(false);
    expect((handle as any).up).toBe(true);

    // The adopted connection still owns the fence.
    liveHandlers!.onMsg({ t: "end", done: { type: "done", result: "live" } });
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "live",
    });
    expect(sent.filter((s) => s.via === "late")).toEqual([]);
    expect(sent.find((s) => s.via === "third")?.msg).toEqual({ t: "shutdown" });
  });

  test("a connection closed while establishing is never adopted", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-closed-establishing-test-"));
    roots.push(root);
    const hostId = "rh-closed-establishing";
    const dir = join(root, hostId);
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId,
      osSessionId: "os-closed-establishing",
      prompt: "test",
      cwd: "/tmp",
    };
    let liveHandlers: HostConnectionHandlers | undefined;
    const closed: string[] = [];
    let alive = true;
    let connects = 0;
    const launcher: HostLauncher = {
      alive: () => alive,
      newRunDir: (id) => join(root, id),
      launch: async () => {},
      connector: () => ({
        connect: async (handlers) => {
          connects++;
          if (connects === 1) {
            liveHandlers = handlers;
            return { send: () => true, close: () => closed.push("first") };
          }
          // The transport drops before the connect promise settles; the host
          // then exits with its receipt.
          handlers.onClose();
          alive = false;
          writeFileSync(
            join(dir, "meta.json"),
            JSON.stringify({
              hostId,
              pid: 1,
              osSessionId: spec.osSessionId,
              startedAt: new Date().toISOString(),
              done: { type: "done", result: "after drop" },
            } satisfies RunHostMeta),
          );
          return { send: () => true, close: () => closed.push("second") };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    liveHandlers!.onClose();

    // The dead connection is closed, not adopted, so the disconnect loop keeps
    // observing and finds the receipt of the now-absent host.
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "after drop",
    });
    expect((await events.next()).done).toBe(true);
    expect(closed).toEqual(["second"]);
    expect(connects).toBe(2);
    expect((handle as any).up).toBe(false);
    expect(hostRunBusy(hostId)).toBe(false);
  });

  test("late callbacks from a rejected connect attempt are ignored", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-rejected-connect-test-"));
    roots.push(root);
    const dir = join(root, "rh-rejected-connect");
    mkdirSync(dir);
    const spec: RunHostSpec = {
      hostId: "rh-rejected-connect",
      osSessionId: "os-rejected-connect",
      prompt: "test",
      cwd: "/tmp",
    };
    let liveHandlers: HostConnectionHandlers | undefined;
    let rejectedHandlers: HostConnectionHandlers | undefined;
    let connects = 0;
    const launcher: HostLauncher = {
      alive: () => true,
      newRunDir: (id) => join(root, id),
      launch: async () => {},
      connector: () => ({
        connect: async (handlers) => {
          connects++;
          if (connects === 2) {
            rejectedHandlers = handlers;
            throw new Error("transport refused");
          }
          liveHandlers = handlers;
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(
      dir,
      spec,
      {},
      launcher,
      spec.hostId,
      5_000,
      1,
    );
    await handle.connectWithWait(100);
    const events = handle.events();
    liveHandlers!.onClose();
    await Bun.sleep(40);
    expect(connects).toBe(3);
    expect((handle as any).up).toBe(true);

    // The rejected attempt's transport speaks up late: nothing listens.
    rejectedHandlers!.onMsg({
      t: "end",
      done: { type: "done", result: "stale" },
    });
    rejectedHandlers!.onClose();
    await Bun.sleep(20);
    expect(handle.ended).toBe(false);
    expect((handle as any).up).toBe(true);
    expect(connects).toBe(3);

    liveHandlers!.onMsg({ t: "end", done: { type: "done", result: "live" } });
    expect((await events.next()).value).toMatchObject({
      type: "done",
      result: "live",
    });
    expect((await events.next()).done).toBe(true);
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
