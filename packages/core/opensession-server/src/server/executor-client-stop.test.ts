import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executorSocketPath,
  EXECUTOR_PROTOCOL_VERSION,
} from "@tellahq/opensession-protocol/executor";
import { ExecutorCoordinator } from "../executor/coordinator";
import { startExecutorServer } from "../executor/server";
import { runHostsDir } from "../runner-host/protocol";
import { stopHostViaExecutor } from "./executor-client";
const hostId = "rh-019d2a5f-4ac8-7000-8000-123456789abc",
  token = "synthetic-stop-token";

test("executor stop fences queued launch across timeout, lost reply and reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "executor-stop-"));
  const dir = join(runHostsDir(root), hostId);
  await mkdir(dir, { recursive: true });
  const bytes = JSON.stringify({
    hostId,
    logicalRunId: hostId,
    osSessionId: "fixture",
    prompt: "synthetic",
    cwd: root,
    mcpServers: [],
  });
  await writeFile(join(dir, "spec.json"), bytes);
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    stopped = Promise.withResolvers<void>();
  let ready = false,
    launches = 0,
    stops = 0;
  const coordinator = new ExecutorCoordinator(root, token, {
    launch: async () => {
      launches++;
      entered.resolve();
      await release.promise;
      ready = true;
    },
    stop: async () => {
      stops++;
      ready = false;
      stopped.resolve();
      throw new Error("collected transient unit is no longer loaded");
    },
    unitActive: async () => ready,
    hostReady: () => ready,
    hostStarted: () => ready,
    now: () => new Date().toISOString(),
  });
  const server = await startExecutorServer({
    sessionsDir: root,
    coordinator,
    token,
  });
  const options = {
    socketPath: executorSocketPath(root),
    token,
    timeoutMs: 20,
  };
  try {
    const launch = coordinator.handle({
      t: "launch_host",
      requestId: "lost-launch",
      token,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash: hash,
    });
    await entered.promise;
    await expect(stopHostViaExecutor(hostId, hash, options)).rejects.toThrow(
      "timed out",
    );
    expect(stops).toBe(0);
    release.resolve();
    await launch;
    await stopped.promise;
    await stopHostViaExecutor(hostId, hash, { ...options, timeoutMs: 1000 });
    expect(ready).toBe(false);
    const replay = await coordinator.handle({
      t: "launch_host",
      requestId: "late-replay",
      token,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash: hash,
    });
    expect(replay.ok && replay.status?.state).toBe("stopped");
    expect(launches).toBe(1);
    await expect(
      stopHostViaExecutor(hostId, "f".repeat(64), options),
    ).rejects.toThrow("spec_hash_mismatch");
  } finally {
    release.resolve();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("unknown executor host rejects rather than acknowledging current absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "executor-stop-unknown-"));
  let stops = 0;
  const coordinator = new ExecutorCoordinator(root, token, {
    launch: async () => {},
    stop: async () => {
      stops++;
    },
    unitActive: async () => false,
    hostReady: () => false,
    hostStarted: () => false,
    now: () => new Date().toISOString(),
  });
  const server = await startExecutorServer({
    sessionsDir: root,
    coordinator,
    token,
  });
  try {
    await expect(
      stopHostViaExecutor(hostId, "a".repeat(64), {
        socketPath: executorSocketPath(root),
        token,
      }),
    ).rejects.toThrow("invalid_host");
    expect(stops).toBe(0);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("missing executor and malformed positive receipts fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "executor-stop-receipt-"));
  try {
    await expect(
      stopHostViaExecutor(hostId, "hash", {
        socketPath: join(root, "missing.sock"),
        token,
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
    for (const status of [
      { hostId, specHash: "hash", state: "unknown", ready: false },
      { hostId: "other", specHash: "hash", state: "stopped", ready: false },
      { hostId, specHash: "other", state: "stopped", ready: false },
      { hostId, specHash: "hash", state: "stopped", ready: true },
    ]) {
      const path = join(root, `${crypto.randomUUID()}.sock`);
      const buffers = new Map<object, string>();
      const server = Bun.listen({
        unix: path,
        socket: {
          open(s) {
            buffers.set(s, "");
          },
          data(s, data) {
            const text = (buffers.get(s) ?? "") + data.toString();
            buffers.set(s, text);
            if (!text.includes("\n")) return;
            const request = JSON.parse(text.split("\n")[0]!);
            s.write(
              JSON.stringify({
                requestId: request.requestId,
                ok: true,
                version: EXECUTOR_PROTOCOL_VERSION,
                ...(request.t === "hello" ? { compatible: true } : { status }),
              }) + "\n",
            );
          },
          close(s) {
            buffers.delete(s);
          },
        },
      });
      try {
        await expect(
          stopHostViaExecutor(hostId, "hash", {
            socketPath: path,
            token,
            timeoutMs: 500,
          }),
        ).rejects.toThrow("did not confirm");
      } finally {
        server.stop(true);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
