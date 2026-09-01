import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EXECUTOR_PROTOCOL_VERSION } from "@tellahq/opensession-protocol/executor";
import type { RunHostSpec } from "../runner-host/protocol";
import {
  HOST_META_NAME,
  HOST_SPEC_NAME,
  runHostsDir,
} from "../runner-host/protocol";
import { writeJsonAtomic } from "../server/shared/atomic-write";
import {
  ExecutorCoordinator,
  type ExecutorCoordinatorDeps,
} from "./coordinator";

const roots: string[] = [];
const TOKEN = "test-executor-token";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "executor-coordinator-"));
  roots.push(root);
  const hostId = "rh-019d2a5f-4ac8-7000-8000-123456789abc";
  const dir = join(runHostsDir(root), hostId);
  mkdirSync(dir, { recursive: true });
  const spec: RunHostSpec = {
    hostId,
    osSessionId: "os-test",
    prompt: "test",
    cwd: "/tmp",
    mcpServers: [],
  };
  const specPath = join(dir, HOST_SPEC_NAME);
  writeJsonAtomic(specPath, spec);
  const specHash = new Bun.CryptoHasher("sha256")
    .update(readFileSync(specPath))
    .digest("hex");
  return { root, hostId, dir, specPath, specHash };
}

function requestId(): string {
  return crypto.randomUUID();
}

describe("ExecutorCoordinator", () => {
  test("negotiates the exact supported protocol", async () => {
    const { root } = fixture();
    const coordinator = new ExecutorCoordinator(root, TOKEN, inertDeps());
    const ok = await coordinator.handle({
      t: "hello",
      requestId: requestId(),
      token: TOKEN,
      minVersion: EXECUTOR_PROTOCOL_VERSION,
      maxVersion: EXECUTOR_PROTOCOL_VERSION,
    });
    expect(ok).toMatchObject({ ok: true, compatible: true });

    const rejected = await coordinator.handle({
      t: "hello",
      requestId: requestId(),
      token: TOKEN,
      minVersion: EXECUTOR_PROTOCOL_VERSION + 1,
      maxVersion: EXECUTOR_PROTOCOL_VERSION + 1,
    });
    expect(rejected).toMatchObject({
      ok: false,
      code: "unsupported_version",
    });
  });

  test("rejects requests without the executor credential", async () => {
    const { root } = fixture();
    const coordinator = new ExecutorCoordinator(root, TOKEN, inertDeps());
    const response = await coordinator.handle({
      t: "hello",
      requestId: requestId(),
      token: "wrong-token",
      minVersion: EXECUTOR_PROTOCOL_VERSION,
      maxVersion: EXECUTOR_PROTOCOL_VERSION,
    });
    expect(response).toMatchObject({ ok: false, code: "invalid_request" });
  });

  test("launch is idempotent by host id and spec hash", async () => {
    const { root, hostId, specHash } = fixture();
    let launches = 0;
    let ready = false;
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        launches++;
        ready = true;
      },
      hostReady: () => ready,
    });
    const launch = () =>
      coordinator.handle({
        t: "launch_host",
        requestId: requestId(),
        token: TOKEN,
        version: EXECUTOR_PROTOCOL_VERSION,
        hostId,
        specHash,
      });

    expect(await launch()).toMatchObject({
      ok: true,
      status: { state: "started", ready: true },
    });
    expect(await launch()).toMatchObject({
      ok: true,
      status: { state: "started", ready: true },
    });
    expect(launches).toBe(1);
  });

  test("concurrent duplicate launches share one effect", async () => {
    const { root, hostId, specHash } = fixture();
    let launches = 0;
    let ready = false;
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        launches++;
        await Bun.sleep(10);
        ready = true;
      },
      hostReady: () => ready,
    });
    const responses = await Promise.all(
      [1, 2].map(() =>
        coordinator.handle({
          t: "launch_host",
          requestId: requestId(),
          token: TOKEN,
          version: EXECUTOR_PROTOCOL_VERSION,
          hostId,
          specHash,
        }),
      ),
    );
    expect(responses.every((response) => response.ok)).toBe(true);
    expect(launches).toBe(1);
  });

  test("serializes stop behind an in-flight launch", async () => {
    const { root, hostId, specHash } = fixture();
    let releaseLaunch!: () => void;
    const launchStarted = Promise.withResolvers<void>();
    const launchReleased = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const effects: string[] = [];
    let ready = false;
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        effects.push("launch");
        launchStarted.resolve();
        await launchReleased;
        ready = true;
      },
      stop: async () => {
        effects.push("stop");
        ready = false;
      },
      hostReady: () => ready,
    });
    const launch = coordinator.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    await launchStarted.promise;
    const stop = coordinator.handle({
      t: "stop_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    await Bun.sleep(5);
    expect(effects).toEqual(["launch"]);
    releaseLaunch();
    expect(await launch).toMatchObject({ ok: true });
    expect(await stop).toMatchObject({
      ok: true,
      status: { state: "stopped", ready: false },
    });
    expect(effects).toEqual(["launch", "stop"]);
  });

  test("proves a failed launch was cleaned up before allowing fallback", async () => {
    const { root, hostId, specHash } = fixture();
    let active = false;
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        active = true;
        throw new Error("systemd-run lost its reply");
      },
      stop: async () => {
        active = false;
      },
      unitActive: async () => active,
    });
    const response = await coordinator.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    expect(response).toMatchObject({ ok: false, code: "launch_failed" });
    expect(active).toBe(false);
  });

  test("reports uncertainty when cleanup cannot prove the host absent", async () => {
    const { root, hostId, specHash } = fixture();
    let active = false;
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        active = true;
        throw new Error("systemd-run lost its reply");
      },
      stop: async () => {
        throw new Error("systemctl unavailable");
      },
      unitActive: async () => active,
    });
    const response = await coordinator.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    expect(response).toMatchObject({ ok: false, code: "launch_uncertain" });
    const retry = await coordinator.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    expect(retry).toMatchObject({ ok: false, code: "launch_uncertain" });
  });

  test("does not allow fallback after a host process was observed", async () => {
    const { root, hostId, dir, specHash } = fixture();
    let active = false;
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        active = true;
        writeJsonAtomic(join(dir, HOST_META_NAME), {
          hostId,
          pid: process.pid,
          osSessionId: "os-test",
          startedAt: "2026-08-18T00:00:00.000Z",
        });
        throw new Error("systemd-run lost its reply");
      },
      stop: async () => {
        active = false;
      },
      unitActive: async () => active,
      hostStarted: () => true,
    });
    const response = await coordinator.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    expect(response).toMatchObject({ ok: false, code: "launch_uncertain" });
    const status = await coordinator.handle({
      t: "host_status",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    expect(status).toMatchObject({ ok: true, status: { state: "uncertain" } });
  });

  test("continues a persisted starting launch after executor replacement", async () => {
    const { root, hostId, dir, specHash } = fixture();
    writeJsonAtomic(join(dir, "executor.json"), {
      hostId,
      specHash,
      state: "starting",
      unit: `bks-run-${hostId}`,
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
    let ready = false;
    let launches = 0;
    const replacement = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        launches++;
        ready = true;
      },
      hostReady: () => ready,
    });
    const response = await replacement.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    expect(response).toMatchObject({
      ok: true,
      status: { state: "started", ready: true },
    });
    expect(launches).toBe(1);
  });

  test("does not replay a persisted starting launch with execution evidence", async () => {
    const { root, hostId, dir, specHash } = fixture();
    writeJsonAtomic(join(dir, "executor.json"), {
      hostId,
      specHash,
      state: "starting",
      unit: `bks-run-${hostId}`,
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
    let launches = 0;
    const replacement = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        launches++;
      },
      hostStarted: () => true,
    });
    const response = await replacement.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    expect(response).toMatchObject({ ok: false, code: "launch_uncertain" });
    expect(launches).toBe(0);
  });

  test("rejects new launch admission during shutdown", async () => {
    const { root, hostId, specHash } = fixture();
    const coordinator = new ExecutorCoordinator(root, TOKEN, inertDeps());
    coordinator.closeAdmission();
    const response = await coordinator.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    expect(response).toMatchObject({ ok: false, code: "invalid_request" });
  });

  test("refuses a reused host id with another spec hash", async () => {
    const { root, hostId, specHash } = fixture();
    let ready = false;
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        ready = true;
      },
      hostReady: () => ready,
    });
    await coordinator.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash,
    });
    const response = await coordinator.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash: "0".repeat(64),
    });
    expect(response).toMatchObject({
      ok: false,
      code: "spec_hash_mismatch",
    });
  });

  test("verifies the persisted spec bytes before launching", async () => {
    const { root, hostId } = fixture();
    let launches = 0;
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      ...inertDeps(),
      launch: async () => {
        launches++;
      },
    });
    const response = await coordinator.handle({
      t: "launch_host",
      requestId: requestId(),
      token: TOKEN,
      version: EXECUTOR_PROTOCOL_VERSION,
      hostId,
      specHash: "f".repeat(64),
    });
    expect(response).toMatchObject({
      ok: false,
      code: "spec_hash_mismatch",
    });
    expect(launches).toBe(0);
  });
});

function inertDeps(): ExecutorCoordinatorDeps {
  return {
    launch: async () => {},
    stop: async () => {},
    unitActive: async () => false,
    hostReady: () => false,
    hostStarted: () => false,
    now: () => "2026-08-18T00:00:00.000Z",
  };
}
