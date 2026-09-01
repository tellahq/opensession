import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  SESSION_KERNEL_TRANSPORT_VERSION,
  type KernelActorTransportEnvelope,
} from "./actor-protocol";
import {
  sessionKernelServiceUrl,
  startSessionKernelService,
} from "./actor-service";
import { sessionKernelSessionDbPath } from "./store";
import { SessionKernelActorClient } from "./actor-client";

const token = "test-session-kernel-token";
const stateDir = mkdtempSync(join(tmpdir(), "opensession-kernel-service-"));
let service: Awaited<ReturnType<typeof startSessionKernelService>>;
let serviceEpoch: string | undefined;
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const previousDatabasePath = process.env.OPENSESSION_SESSION_KERNEL_DB_PATH;

beforeAll(async () => {
  process.env.OPENSESSION_STATE_DIR = stateDir;
  service = await startSessionKernelService({
    port: 0,
    token,
    workerCount: 4,
    responseTimeoutMs: 700,
    databasePath: join(stateDir, "sessions", "session-kernel.sqlite"),
  });
});

afterAll(() => {
  service.stop();
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  if (previousDatabasePath === undefined)
    delete process.env.OPENSESSION_SESSION_KERNEL_DB_PATH;
  else process.env.OPENSESSION_SESSION_KERNEL_DB_PATH = previousDatabasePath;
  rmSync(stateDir, { recursive: true, force: true });
});

async function rpc(request: KernelActorTransportEnvelope["request"]) {
  if (!serviceEpoch && request.t !== "hello")
    await rpc({
      t: "hello",
      rpcId: "test-handshake",
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
  const response = await fetch(`${service.url}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: SESSION_KERNEL_TRANSPORT_VERSION,
      actorVersion: SESSION_KERNEL_ACTOR_VERSION,
      ...(serviceEpoch ? { serviceEpoch } : {}),
      request,
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, any>;
  if (body.t === "ready") serviceEpoch = body.serviceEpoch;
  return body;
}

describe("session kernel actor service", () => {
  test("absorbs read bursts beyond the bounded mutation mailbox", async () => {
    const isolatedService = await startSessionKernelService({
      port: 0,
      token,
      workerCount: 1,
      responseTimeoutMs: 700,
      mutationMailboxLimit: 8,
      workerUrl: new URL("./testing/mailbox-worker.ts", import.meta.url),
    });
    const call = async (
      request: KernelActorTransportEnvelope["request"],
      epoch?: string,
    ) =>
      fetch(`${isolatedService.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: SESSION_KERNEL_TRANSPORT_VERSION,
          actorVersion: SESSION_KERNEL_ACTOR_VERSION,
          ...(epoch ? { serviceEpoch: epoch } : {}),
          request,
        }),
      });
    try {
      const helloResponse = await call({
        t: "hello",
        rpcId: "mailbox-handshake",
        version: SESSION_KERNEL_ACTOR_VERSION,
      });
      const hello = (await helloResponse.json()) as { serviceEpoch: string };
      expect(helloResponse.status).toBe(200);

      const responses = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          call(
            {
              t: "call",
              rpcId: `burst-read-${index}`,
              outputBytes: 1024,
              request: {
                t: "store",
                method: "turnSnapshot",
                args: ["busy-session"],
              },
            },
            hello.serviceEpoch,
          ),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual(
        Array.from({ length: 40 }, () => 200),
      );

      const mutations = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          call(
            {
              t: "call",
              rpcId: `burst-mutation-${index}`,
              outputBytes: 1024,
              request: {
                t: "store",
                method: "setRunState",
                args: [
                  {
                    sessionId: "busy-session",
                    state: "idle",
                    since: new Date(0).toISOString(),
                    generation: index,
                    changeSeq: index,
                  },
                ],
              },
            },
            hello.serviceEpoch,
          ),
        ),
      );
      expect(mutations.map((response) => response.status).sort()).toEqual(
        [...Array.from({ length: 9 }, () => 200), 429].sort(),
      );
    } finally {
      isolatedService.stop();
    }
  });

  test("runtime work uses session lanes without waiting for an unrelated turn", async () => {
    const isolatedService = await startSessionKernelService({
      port: 0,
      token,
      workerCount: 2,
      responseTimeoutMs: 700,
      workerUrl: new URL("./testing/read-barrier-worker.ts", import.meta.url),
    });
    const call = async (
      request: KernelActorTransportEnvelope["request"],
      epoch?: string,
    ) =>
      fetch(`${isolatedService.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: SESSION_KERNEL_TRANSPORT_VERSION,
          actorVersion: SESSION_KERNEL_ACTOR_VERSION,
          ...(epoch ? { serviceEpoch: epoch } : {}),
          request,
        }),
      });
    try {
      const helloResponse = await call({
        t: "hello",
        rpcId: "read-barrier-handshake",
        version: SESSION_KERNEL_ACTOR_VERSION,
      });
      const hello = (await helloResponse.json()) as { serviceEpoch: string };
      const read = call(
        {
          t: "call",
          rpcId: "slow-session-read",
          outputBytes: 1024,
          request: {
            t: "store",
            method: "turnSnapshot",
            args: ["busy-session"],
          },
        },
        hello.serviceEpoch,
      );
      await Bun.sleep(25);

      const startedAt = Date.now();
      const runtime = await call(
        {
          t: "runtime_work",
          rpcId: "runtime-during-read",
          now: Date.now(),
          timerKinds: [],
          effectKinds: [],
          limit: 100,
        },
        hello.serviceEpoch,
      );
      expect(runtime.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(150);
      expect(await runtime.json()).toMatchObject({
        t: "runtime_work_result",
        timers: [],
        outbox: [],
      });
      expect((await read).status).toBe(200);
    } finally {
      isolatedService.stop();
    }
  });

  test("catalog discovery never opens a candidate session database", async () => {
    const sessionId = `runtime-lane-${crypto.randomUUID()}`;
    const ready = async () =>
      (await (await fetch(`${service.url}/ready`)).json()) as {
        lanes: Array<{
          index: number;
          turnsCompleted: number;
          kernelStoreCacheMisses: number;
        }>;
      };
    const before = await ready();
    const catalogMisses = before.lanes.find(
      (lane) => lane.index === 0,
    )?.kernelStoreCacheMisses;
    await rpc({
      t: "call",
      rpcId: "runtime-lane-schedule",
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "scheduleTimer",
        args: [
          {
            sessionId,
            timerId: "wake",
            kind: "runtime_lane_timer",
            dueAt: Date.now() - 1,
            payload: null,
          },
        ],
      },
    });

    const work = await rpc({
      t: "runtime_work",
      rpcId: "runtime-lane-claim",
      now: Date.now(),
      timerKinds: ["runtime_lane_timer"],
      effectKinds: [],
      limit: 100,
    });
    expect(work).toMatchObject({
      t: "runtime_work_result",
      timers: [expect.objectContaining({ sessionId, timerId: "wake" })],
    });
    const after = await ready();
    expect(
      after.lanes.find((lane) => lane.index === 0)?.kernelStoreCacheMisses,
    ).toBe(catalogMisses);
    expect(
      after.lanes
        .slice(1)
        .some(
          (lane, index) =>
            lane.turnsCompleted >
            (before.lanes[index + 1]?.turnsCompleted ?? 0),
        ),
    ).toBe(true);
  });

  test("restarts the catalog lane instead of the service after a read timeout", async () => {
    const isolatedService = await startSessionKernelService({
      port: 0,
      token,
      workerCount: 1,
      responseTimeoutMs: 100,
      workerUrl: new URL("./testing/read-timeout-worker.ts", import.meta.url),
    });
    try {
      const helloResponse = await fetch(`${isolatedService.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: SESSION_KERNEL_TRANSPORT_VERSION,
          actorVersion: SESSION_KERNEL_ACTOR_VERSION,
          request: {
            t: "hello",
            rpcId: "read-timeout-handshake",
            version: SESSION_KERNEL_ACTOR_VERSION,
          },
        }),
      });
      const hello = (await helloResponse.json()) as { serviceEpoch: string };
      expect(helloResponse.status).toBe(200);

      const timedOut = await fetch(`${isolatedService.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: SESSION_KERNEL_TRANSPORT_VERSION,
          actorVersion: SESSION_KERNEL_ACTOR_VERSION,
          serviceEpoch: hello.serviceEpoch,
          request: {
            t: "call",
            rpcId: "slow-read",
            outputBytes: 1024,
            request: { t: "store", method: "askEntries", args: [] },
          },
        }),
      });
      expect(timedOut.status).toBe(429);
      expect(await timedOut.json()).toMatchObject({
        error: "Session actor lane 0 response timed out",
      });

      let ready: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        ready = await fetch(`${isolatedService.url}/ready`);
        if (ready.status === 200) break;
        await Bun.sleep(10);
      }
      expect(ready?.status).toBe(200);
      expect((await fetch(`${isolatedService.url}/live`)).status).toBe(200);
    } finally {
      isolatedService.stop();
    }
  });

  test("accepts the transport worker's first message immediately", async () => {
    const previousToken = process.env.OPENSESSION_SESSION_KERNEL_TOKEN;
    const previousUrl = process.env.OPENSESSION_SESSION_KERNEL_URL;
    process.env.OPENSESSION_SESSION_KERNEL_TOKEN = token;
    process.env.OPENSESSION_SESSION_KERNEL_URL = service.url;
    const worker = new Worker(
      new URL("../../session-kernel-transport-worker.ts", import.meta.url),
      { type: "module" },
    );
    try {
      const response = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("transport worker handshake timed out")),
            2_000,
          );
          worker.addEventListener("message", (event: MessageEvent) => {
            clearTimeout(timeout);
            resolve(event.data as Record<string, unknown>);
          });
          worker.addEventListener("error", (event) => {
            clearTimeout(timeout);
            reject(new Error(event.message));
          });
        },
      );
      worker.postMessage({
        t: "hello",
        rpcId: "immediate-worker-handshake",
        version: SESSION_KERNEL_ACTOR_VERSION,
      });
      expect(await response).toMatchObject({
        t: "ready",
        rpcId: "immediate-worker-handshake",
        version: SESSION_KERNEL_ACTOR_VERSION,
      });
    } finally {
      worker.terminate();
      if (previousToken === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_TOKEN;
      else process.env.OPENSESSION_SESSION_KERNEL_TOKEN = previousToken;
      if (previousUrl === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_URL;
      else process.env.OPENSESSION_SESSION_KERNEL_URL = previousUrl;
    }
  });

  test("reconnects and re-handshakes after the service incarnation changes", async () => {
    const previousToken = process.env.OPENSESSION_SESSION_KERNEL_TOKEN;
    const previousUrl = process.env.OPENSESSION_SESSION_KERNEL_URL;
    process.env.OPENSESSION_SESSION_KERNEL_TOKEN = token;
    process.env.OPENSESSION_SESSION_KERNEL_URL = service.url;
    const worker = new Worker(
      new URL("../../session-kernel-transport-worker.ts", import.meta.url),
      { type: "module" },
    );
    const client = new SessionKernelActorClient(worker);
    try {
      await client.hello();
      const port = Number(new URL(service.url).port);
      service.stop();
      service = await startSessionKernelService({
        port,
        token,
        responseTimeoutMs: 700,
        databasePath: join(stateDir, "sessions", "session-kernel.sqlite"),
      });
      // rpc() caches the prior incarnation after its first handshake.
      serviceEpoch = undefined;
      await expect(
        client.callAsync(
          { t: "store", method: "creationState", args: ["after-restart"] },
          "creationState",
        ),
      ).resolves.toBeUndefined();
    } finally {
      client.terminate();
      if (previousToken === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_TOKEN;
      else process.env.OPENSESSION_SESSION_KERNEL_TOKEN = previousToken;
      if (previousUrl === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_URL;
      else process.env.OPENSESSION_SESSION_KERNEL_URL = previousUrl;
    }
  });

  test("settles outbox work asynchronously on its session lane", async () => {
    const previousToken = process.env.OPENSESSION_SESSION_KERNEL_TOKEN;
    const previousUrl = process.env.OPENSESSION_SESSION_KERNEL_URL;
    process.env.OPENSESSION_SESSION_KERNEL_TOKEN = token;
    process.env.OPENSESSION_SESSION_KERNEL_URL = service.url;
    const worker = new Worker(
      new URL("../../session-kernel-transport-worker.ts", import.meta.url),
      { type: "module" },
    );
    try {
      const send = (message: Record<string, unknown>) =>
        new Promise<Record<string, any>>((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(new Error(`transport request ${message.rpcId} timed out`)),
            2_000,
          );
          const onMessage = (event: MessageEvent) => {
            const response = event.data as Record<string, any>;
            if (response.rpcId !== message.rpcId) return;
            clearTimeout(timeout);
            worker.removeEventListener("message", onMessage);
            resolve(response);
          };
          worker.addEventListener("message", onMessage);
          worker.postMessage(message);
        });
      const result = (response: Record<string, any>) => {
        expect(response.t).toBe("call_result");
        expect(response.body).toBeString();
        return JSON.parse(response.body as string) as {
          ok: boolean;
          result?: unknown;
          error?: string;
        };
      };
      await send({
        t: "hello",
        rpcId: "async-settlement-hello",
        version: SESSION_KERNEL_ACTOR_VERSION,
      });
      const sessionId = "async-outbox-settlement";
      const enqueued = result(
        await send({
          t: "store",
          rpcId: "async-settlement-enqueue",
          method: "enqueueOutbox",
          args: [
            sessionId,
            "human_ask_deliver",
            { askId: "ask-one", skipUi: false },
            "deliver-one",
          ],
        }),
      );
      expect(enqueued.ok).toBe(true);
      const id = Number(enqueued.result);

      const wrongSession = result(
        await send({
          t: "reduce",
          rpcId: "async-settlement-wrong-session",
          command: {
            kind: "core",
            commandId: crypto.randomUUID(),
            request: { op: "ack_outbox", id, sessionId: "wrong-session" },
          },
        }),
      );
      expect(wrongSession).toMatchObject({
        ok: false,
        error: `Outbox ${id} crossed session ownership`,
      });

      const settled = result(
        await send({
          t: "reduce",
          rpcId: "async-settlement-correct-session",
          command: {
            kind: "core",
            commandId: crypto.randomUUID(),
            request: { op: "ack_outbox", id, sessionId },
          },
        }),
      );
      expect(settled.ok).toBe(true);

      const replayedSettlement = result(
        await send({
          t: "reduce",
          rpcId: "async-settlement-replayed",
          command: {
            kind: "core",
            commandId: crypto.randomUUID(),
            request: { op: "ack_outbox", id, sessionId },
          },
        }),
      );
      expect(replayedSettlement.ok).toBe(true);

      const pending = await send({
        t: "runtime_session_work",
        rpcId: "async-settlement-pending",
        sessionId,
        candidateCount: 1,
        now: Date.now(),
        timerKinds: [],
        effectKinds: ["human_ask_deliver"],
        limit: 100,
      });
      expect(pending.t).toBe("runtime_session_work_result");
      expect(
        (pending as { outbox: Array<{ id: number }> }).outbox.some(
          (item) => item.id === id,
        ),
      ).toBe(false);
    } finally {
      worker.terminate();
      if (previousToken === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_TOKEN;
      else process.env.OPENSESSION_SESSION_KERNEL_TOKEN = previousToken;
      if (previousUrl === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_URL;
      else process.env.OPENSESSION_SESSION_KERNEL_URL = previousUrl;
    }
  });

  test("reports liveness and readiness without exposing the RPC", async () => {
    const live = await fetch(`${service.url}/live`);
    const ready = await fetch(`${service.url}/ready`);
    expect(live.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ready: true,
      component: "session-kernel",
      actorVersion: SESSION_KERNEL_ACTOR_VERSION,
      transportVersion: SESSION_KERNEL_TRANSPORT_VERSION,
    });
    const unauthorized = await fetch(`${service.url}/rpc`, {
      method: "POST",
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);
  });

  test("reports per-lane occupancy and cumulative counters on /ready", async () => {
    // Complete at least one turn so counters have advanced.
    await rpc({
      t: "call",
      rpcId: crypto.randomUUID(),
      outputBytes: 256 * 1024,
      request: { t: "store", method: "stats", args: [] },
    });
    const ready = (await (await fetch(`${service.url}/ready`)).json()) as {
      workers: { capacity: number };
      lanes: Array<Record<string, unknown>>;
    };
    // Catalog lane (index 0) plus every session lane.
    expect(ready.lanes.length).toBe(ready.workers.capacity + 1);
    for (const lane of ready.lanes) {
      expect(lane).toMatchObject({ ready: true, restarting: false });
      expect(typeof lane.index).toBe("number");
      expect(typeof lane.queued).toBe("number");
      expect(typeof lane.executing).toBe("number");
      expect(typeof lane.turnsCompleted).toBe("number");
      expect(typeof lane.queueWaitMsTotal).toBe("number");
      expect(typeof lane.busyMsTotal).toBe("number");
      expect(typeof lane.timeouts).toBe("number");
      expect(typeof lane.restarts).toBe("number");
      expect(typeof lane.rejectedFull).toBe("number");
      expect(typeof lane.kernelStoreCacheMisses).toBe("number");
      expect(typeof lane.kernelStoreCacheEvictions).toBe("number");
      expect(typeof lane.transcriptStoreCacheMisses).toBe("number");
      expect(typeof lane.transcriptStoreCacheEvictions).toBe("number");
      expect(typeof lane.sqliteBusy).toBe("number");
    }
    // The handshake and at least one call ran somewhere: total completed turns
    // across lanes must have advanced.
    const completed = ready.lanes.reduce(
      (total, lane) => total + Number(lane.turnsCompleted),
      0,
    );
    expect(completed).toBeGreaterThan(0);
  });

  test("refuses to send the actor credential off host", () => {
    const previous = process.env.OPENSESSION_SESSION_KERNEL_URL;
    process.env.OPENSESSION_SESSION_KERNEL_URL = "https://example.com/rpc";
    try {
      expect(() => sessionKernelServiceUrl()).toThrow(
        "must use HTTP on 127.0.0.1",
      );
    } finally {
      if (previous === undefined)
        delete process.env.OPENSESSION_SESSION_KERNEL_URL;
      else process.env.OPENSESSION_SESSION_KERNEL_URL = previous;
    }
  });

  test("rejects mixed transport versions before actor dispatch", async () => {
    const response = await fetch(`${service.url}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: SESSION_KERNEL_TRANSPORT_VERSION + 1,
        actorVersion: SESSION_KERNEL_ACTOR_VERSION,
        request: {
          t: "hello",
          rpcId: "wrong-version",
          version: SESSION_KERNEL_ACTOR_VERSION,
        },
      }),
    });
    expect(response.status).toBe(409);
  });

  test("fences actor versions and service incarnations on every call", async () => {
    await rpc({
      t: "hello",
      rpcId: "version-handshake",
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
    expect(await rpc({ t: "stats", rpcId: "fenced-stats" })).toMatchObject({
      t: "stats_result",
      serviceEpoch,
    });
    for (const envelope of [
      {
        version: SESSION_KERNEL_TRANSPORT_VERSION,
        actorVersion: SESSION_KERNEL_ACTOR_VERSION + 1,
        serviceEpoch,
      },
      {
        version: SESSION_KERNEL_TRANSPORT_VERSION,
        actorVersion: SESSION_KERNEL_ACTOR_VERSION,
        serviceEpoch: "stale-service",
      },
    ]) {
      const response = await fetch(`${service.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...envelope,
          request: { t: "stats", rpcId: crypto.randomUUID() },
        }),
      });
      expect(response.status).toBe(409);
    }
  });

  test("rejects a call outside the bounded response budget", async () => {
    const response = await rpc({
      t: "call",
      rpcId: "oversized-output",
      outputBytes: SESSION_KERNEL_MAX_RESPONSE_BYTES + 1,
      request: { t: "store", method: "stats", args: [] },
    });
    expect(response).toMatchObject({
      t: "error",
      error: "Invalid kernel actor response bound",
    });
  });

  test("returns the first committed mutation result when it exceeds the service buffer", async () => {
    const sessionId = "large-service-dispatch";
    const content = "x".repeat(9 * 1024 * 1024);
    const seeded = await rpc({
      t: "call",
      rpcId: "seed-large-service-dispatch",
      outputBytes: 256 * 1024,
      request: {
        t: "reduce",
        command: {
          kind: "delivery",
          commandId: "seed-large-service-dispatch",
          request: {
            op: "set",
            sessionId,
            slot: "queued",
            value: [{ id: "large", content }],
          },
        },
      },
    });
    expect(seeded).toMatchObject({ t: "call_result", status: 1 });

    const claimed = await rpc({
      t: "call",
      rpcId: "claim-large-service-dispatch",
      outputBytes: 8 * 1024 * 1024,
      request: {
        t: "reduce",
        command: {
          kind: "delivery",
          commandId: "claim-large-service-dispatch",
          request: {
            op: "claim_next_dispatch",
            sessionId,
            promptEntryId: "large-entry",
          },
        },
      },
    });
    expect(claimed).toMatchObject({ t: "call_result", status: 1 });
    expect(JSON.parse(claimed.body)).toMatchObject({
      ok: true,
      result: {
        result: {
          kind: "deliver",
          // A one-item batch keeps the queued receipt's durable identity.
          promptEntryId: "large",
          items: [{ id: "large", content }],
        },
      },
    });
  });

  test("a locked session database does not block another session mailbox", async () => {
    for (const sessionId of ["locked-pool-session", "healthy-pool-session"]) {
      const created = await rpc({
        t: "call",
        rpcId: `create-${sessionId}`,
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{ sessionId, state: "idle", event: "seed" }],
        },
      });
      expect(created).toMatchObject({ t: "call_result", status: 1 });
    }

    const isolatedRoot = join(stateDir, "sessions", "session-kernel-sessions");
    const lockedPath = sessionKernelSessionDbPath(
      "locked-pool-session",
      isolatedRoot,
    );
    const healthyPath = sessionKernelSessionDbPath(
      "healthy-pool-session",
      isolatedRoot,
    );
    expect(lockedPath).not.toBe(healthyPath);
    expect(existsSync(lockedPath)).toBe(true);
    expect(existsSync(healthyPath)).toBe(true);

    const lock = new Database(lockedPath);
    lock.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE;");
    try {
      const blocked = rpc({
        t: "call",
        rpcId: "blocked-session-turn",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [
            {
              sessionId: "locked-pool-session",
              state: "running",
              event: "blocked",
              currentRunId: "locked-run",
            },
          ],
        },
      });
      await Bun.sleep(50);

      const startedAt = performance.now();
      const healthy = await rpc({
        t: "call",
        rpcId: "healthy-session-turn",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [
            {
              sessionId: "healthy-pool-session",
              state: "running",
              event: "healthy",
              currentRunId: "healthy-run",
            },
          ],
        },
      });
      expect(healthy).toMatchObject({ t: "call_result", status: 1 });
      expect(performance.now() - startedAt).toBeLessThan(1_000);

      lock.exec("COMMIT;");
      expect(await blocked).toMatchObject({ t: "call_result", status: 1 });
    } finally {
      try {
        lock.exec("ROLLBACK;");
      } catch {}
      lock.close();
    }
  });

  test("Stop keeps reserved capacity and passes queued ordinary turns", async () => {
    const sessionId = "priority-stop-session";
    await rpc({
      t: "call",
      rpcId: "priority-seed",
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "setRunState",
        args: [{ sessionId, state: "idle", event: "seed" }],
      },
    });
    const isolatedRoot = join(stateDir, "sessions", "session-kernel-sessions");
    const lock = new Database(
      sessionKernelSessionDbPath(sessionId, isolatedRoot),
    );
    lock.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE;");
    try {
      const blocked = rpc({
        t: "call",
        rpcId: "priority-blocker",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{ sessionId, state: "running", event: "blocked" }],
        },
      });
      await Bun.sleep(25);
      const ordinary = rpc({
        t: "call",
        rpcId: "priority-ordinary",
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "run_event",
            commandId: "queued-ordinary",
            decision: { sessionId, event: "prompt" },
          },
        },
      }).then(() => "ordinary");
      const stop = rpc({
        t: "call",
        rpcId: "priority-stop",
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "turn",
            commandId: "queued-stop",
            request: {
              op: "request_cancel_command",
              sessionId,
              requestId: "priority-stop-request",
              fallbackRunId: null,
            },
          },
        },
      }).then(() => "stop");

      await blocked;
      expect(await Promise.race([ordinary, stop])).toBe("stop");
      await Promise.all([ordinary, stop]);
    } finally {
      try {
        lock.exec("ROLLBACK;");
      } catch {}
      lock.close();
    }
  });

  test("a global barrier cannot deadlock a later priority turn", async () => {
    const sessionId = "barrier-priority-session";
    await rpc({
      t: "call",
      rpcId: "barrier-seed",
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "setRunState",
        args: [{ sessionId, state: "idle", event: "seed" }],
      },
    });
    const isolatedRoot = join(stateDir, "sessions", "session-kernel-sessions");
    const lock = new Database(
      sessionKernelSessionDbPath(sessionId, isolatedRoot),
    );
    lock.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE;");
    const order: string[] = [];
    try {
      const active = rpc({
        t: "call",
        rpcId: "barrier-active",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{ sessionId, state: "idle", event: "active" }],
        },
      });
      await Bun.sleep(25);
      const ordinary = rpc({
        t: "call",
        rpcId: "barrier-ordinary",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{ sessionId, state: "idle", event: "ordinary" }],
        },
      }).then(() => {
        order.push("ordinary");
      });
      const global = rpc({
        t: "stats",
        rpcId: "barrier-global",
      }).then(() => {
        order.push("global");
      });
      const stop = rpc({
        t: "call",
        rpcId: "barrier-stop",
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "turn",
            commandId: "barrier-stop-command",
            request: {
              op: "request_cancel_command",
              sessionId,
              requestId: "barrier-stop-request",
              fallbackRunId: null,
            },
          },
        },
      }).then(() => {
        order.push("stop");
      });
      await Bun.sleep(50);
      lock.exec("COMMIT;");
      await Promise.all([active, ordinary, global, stop]);
      expect(order).toEqual(["ordinary", "global", "stop"]);
    } finally {
      try {
        lock.exec("ROLLBACK;");
      } catch {}
      lock.close();
    }
  });

  test("runtime discovery does not create a global barrier for a wedged mailbox", async () => {
    const sessionId = "barrier-timeout-session";
    await rpc({
      t: "call",
      rpcId: "barrier-timeout-seed",
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "setRunState",
        args: [{ sessionId, state: "idle", event: "seed" }],
      },
    });
    const isolatedRoot = join(stateDir, "sessions", "session-kernel-sessions");
    const lock = new Database(
      sessionKernelSessionDbPath(sessionId, isolatedRoot),
    );
    lock.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE;");
    try {
      const active = rpc({
        t: "call",
        rpcId: "barrier-timeout-active",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{ sessionId, state: "idle", event: "active" }],
        },
      });
      await Bun.sleep(25);
      const catalogReadStartedAt = Date.now();
      expect(
        await rpc({
          t: "call",
          rpcId: "barrier-timeout-quarantines",
          outputBytes: 256 * 1024,
          request: {
            t: "store",
            method: "quarantinedSessions",
            args: [100, 0],
          },
        }),
      ).toMatchObject({ t: "call_result", status: 1 });
      expect(
        await rpc({
          t: "call",
          rpcId: "barrier-timeout-asks",
          outputBytes: 256 * 1024,
          request: {
            t: "store",
            method: "askEntries",
            args: [],
          },
        }),
      ).toMatchObject({ t: "call_result", status: 1 });
      expect(Date.now() - catalogReadStartedAt).toBeLessThan(400);

      const startedAt = Date.now();
      const response = await fetch(`${service.url}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: SESSION_KERNEL_TRANSPORT_VERSION,
          actorVersion: SESSION_KERNEL_ACTOR_VERSION,
          serviceEpoch,
          request: {
            t: "runtime_work",
            rpcId: "barrier-timeout-global",
            now: Date.now(),
            timerKinds: [],
            effectKinds: [],
            limit: 100,
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(400);
      expect(await response.json()).toMatchObject({
        t: "runtime_work_result",
        timers: [],
        outbox: [],
      });
      lock.exec("COMMIT;");
      expect(await active).toMatchObject({ t: "call_result", status: -1 });
    } finally {
      try {
        lock.exec("ROLLBACK;");
      } catch {}
      lock.close();
    }
  });

  test("priority bursts yield to an ordinary turn", async () => {
    const sessionId = "priority-fairness-session";
    await rpc({
      t: "call",
      rpcId: "fairness-seed",
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "setRunState",
        args: [{ sessionId, state: "idle", event: "seed" }],
      },
    });
    const isolatedRoot = join(stateDir, "sessions", "session-kernel-sessions");
    const lock = new Database(
      sessionKernelSessionDbPath(sessionId, isolatedRoot),
    );
    lock.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE;");
    const order: string[] = [];
    try {
      const active = rpc({
        t: "call",
        rpcId: "fairness-active",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{ sessionId, state: "idle", event: "active" }],
        },
      });
      await Bun.sleep(25);
      const ordinary = rpc({
        t: "call",
        rpcId: "fairness-ordinary",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "setRunState",
          args: [{ sessionId, state: "idle", event: "ordinary" }],
        },
      }).then(() => {
        order.push("ordinary");
      });
      const priority = Array.from({ length: 8 }, (_, index) =>
        rpc({
          t: "call",
          rpcId: `fairness-priority-${index}`,
          outputBytes: 256 * 1024,
          request: {
            t: "reduce",
            command: {
              kind: "turn",
              commandId: `fairness-command-${index}`,
              request: {
                op: "request_cancel_command",
                sessionId,
                requestId: `fairness-request-${index}`,
                fallbackRunId: null,
              },
            },
          },
        }).then(() => {
          order.push(`priority-${index}`);
        }),
      );
      await Bun.sleep(50);
      lock.exec("COMMIT;");
      await Promise.all([active, ordinary, ...priority]);
      expect(order.indexOf("ordinary")).toBe(4);
    } finally {
      try {
        lock.exec("ROLLBACK;");
      } catch {}
      lock.close();
    }
  });

  test("an ambiguous critical settlement quarantines only its session", async () => {
    const sessionId = "ambiguous-critical-session";
    const centralPath = join(stateDir, "sessions", "session-kernel.sqlite");
    const seed = new Database(centralPath);
    seed.run(
      `
      INSERT INTO session_kernel_state
        (session_id, run_state, run_since, last_event, generation, change_seq, updated_at)
      VALUES (?, 'idle', ?, 'legacy-seed', 0, 0, ?)
    `,
      [sessionId, new Date().toISOString(), Date.now()],
    );
    seed.close();
    await rpc({
      t: "call",
      rpcId: "critical-admit",
      outputBytes: 256 * 1024,
      request: {
        t: "reduce",
        command: {
          kind: "gateway",
          commandId: "critical-request-command",
          request: {
            op: "request",
            sessionId,
            requestId: "critical-request",
            operation: "websocket_command",
            identity: { command: "prompt" },
          },
        },
      },
    });
    const lock = new Database(centralPath);
    lock.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE;");
    try {
      const settlement = rpc({
        t: "call",
        rpcId: "critical-settlement",
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "gateway",
            commandId: "critical-complete-command",
            request: {
              op: "complete",
              sessionId,
              requestId: "critical-request",
              operation: "websocket_command",
              result: "done",
            },
          },
        },
      });
      await Bun.sleep(25);
      const retained = rpc({
        t: "call",
        rpcId: "critical-retained-turn",
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "run_event",
            commandId: "critical-retained-command",
            decision: { sessionId, event: "prompt" },
          },
        },
      });
      await Bun.sleep(750);
      lock.exec("COMMIT;");
      const response = await settlement;
      expect(response).toMatchObject({ t: "call_result", status: -1 });
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        code: "session_quarantined",
        sessionId,
      });
      const retainedResponse = await retained;
      expect(retainedResponse).toMatchObject({ t: "call_result", status: -1 });
      expect(JSON.parse(retainedResponse.body)).toMatchObject({
        ok: false,
        code: "session_quarantined",
        sessionId,
      });
      const evidence = new Database(centralPath, { readonly: true });
      expect(
        evidence
          .query(
            "SELECT reason FROM session_kernel_quarantine WHERE session_id = ?",
          )
          .get(sessionId),
      ).toBeTruthy();
      evidence.close();
      expect((await fetch(`${service.url}/ready`)).status).toBe(200);
    } finally {
      try {
        lock.exec("ROLLBACK;");
      } catch {}
      lock.close();
    }
  });

  test("acknowledges a completed command receipt while the session is quarantined", async () => {
    const sessionId = "quarantined-ack-session";
    expect(
      await rpc({
        t: "call",
        rpcId: "quarantined-ack-request",
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "gateway",
            commandId: "quarantined-ack-request-command",
            request: {
              op: "request",
              sessionId,
              requestId: "quarantined-ack-write",
              operation: "websocket_command",
              identity: { command: "prompt" },
            },
          },
        },
      }),
    ).toMatchObject({ t: "call_result", status: 1 });
    expect(
      await rpc({
        t: "call",
        rpcId: "quarantined-ack-complete",
        outputBytes: 256 * 1024,
        request: {
          t: "reduce",
          command: {
            kind: "gateway",
            commandId: "quarantined-ack-complete-command",
            request: {
              op: "complete",
              sessionId,
              requestId: "quarantined-ack-write",
              operation: "websocket_command",
              result: "done",
            },
          },
        },
      }),
    ).toMatchObject({ t: "call_result", status: 1 });
    expect(
      await rpc({
        t: "call",
        rpcId: "quarantined-ack-quarantine",
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "quarantineSession",
          args: [
            sessionId,
            "actor restarted after execution began",
            "transcript:append",
          ],
        },
      }),
    ).toMatchObject({ t: "call_result", status: 1 });

    // Acknowledging only stamps acknowledged_at on an already-completed
    // receipt, so the quarantine fence must not reject it: fencing it turned
    // every quarantined session into an endless client ack-retry loop
    // (`Internal error handling "command_ack"` on every reconnect).
    expect(
      await rpc({
        t: "acknowledge",
        rpcId: "quarantined-ack",
        sessionId,
        requestId: "quarantined-ack-write",
      }),
    ).toMatchObject({ t: "acknowledge_result" });

    const record = await rpc({
      t: "call",
      rpcId: "quarantined-ack-readback",
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "command",
        args: [sessionId, "quarantined-ack-write"],
      },
    });
    expect(record).toMatchObject({ t: "call_result", status: 1 });
    const body = JSON.parse(record.body) as {
      ok: boolean;
      result: { status: string; acknowledgedAt?: number };
    };
    expect(body.ok).toBe(true);
    expect(body.result.status).toBe("completed");
    expect(body.result.acknowledgedAt).toBeGreaterThan(0);
  });

  test("keeps reductions responsive while an executor owns physical work", async () => {
    const active = await rpc({
      t: "call",
      rpcId: "begin-long-effect",
      outputBytes: 256 * 1024,
      request: {
        t: "reduce",
        command: {
          kind: "gateway",
          commandId: "long-effect-admission",
          request: {
            op: "request",
            sessionId: "service-session",
            requestId: "long-effect",
            operation: "websocket_command",
            identity: { command: "prompt" },
          },
        },
      },
    });
    expect(JSON.parse(active.body)).toMatchObject({
      ok: true,
      result: { status: "execute" },
    });

    const startedAt = performance.now();
    const reduction = await rpc({
      t: "call",
      rpcId: "run-reduction",
      outputBytes: 256 * 1024,
      request: {
        t: "reduce",
        command: {
          kind: "run_event",
          commandId: "prompt-reduction",
          decision: { sessionId: "service-session", event: "prompt" },
        },
      },
    });
    expect(reduction).toMatchObject({ t: "call_result", status: 1 });
    expect(JSON.parse(reduction.body)).toMatchObject({
      ok: true,
      result: { accepted: true, to: "starting" },
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);

    await rpc({
      t: "call",
      rpcId: "complete-long-effect",
      outputBytes: 256 * 1024,
      request: {
        t: "reduce",
        command: {
          kind: "gateway",
          commandId: "long-effect-completion",
          request: {
            op: "complete",
            sessionId: "service-session",
            requestId: "long-effect",
            operation: "websocket_command",
            result: "done",
          },
        },
      },
    });
    const command = await rpc({
      t: "call",
      rpcId: "read-command",
      outputBytes: 256 * 1024,
      request: {
        t: "store",
        method: "command",
        args: ["service-session", "long-effect"],
      },
    });
    expect(JSON.parse(command.body)).toMatchObject({
      ok: true,
      result: { status: "completed", result: "done" },
    });
  });
});
