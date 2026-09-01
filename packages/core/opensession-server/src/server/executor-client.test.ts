import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { executorSocketPath } from "@tellahq/opensession-protocol/executor";
import type { RunHostSpec } from "../runner-host/protocol";
import { HOST_SPEC_NAME, runHostsDir } from "../runner-host/protocol";
import { ExecutorCoordinator } from "../executor/coordinator";
import { startExecutorServer } from "../executor/server";
import { writeJsonAtomic } from "./shared/atomic-write";
import { launchHostViaExecutor } from "./executor-client";

const roots: string[] = [];
const listeners: Array<ReturnType<typeof Bun.listen>> = [];
const TOKEN = "test-executor-token";

afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop(true);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("executor client", () => {
  test("fails closed when the configured executor is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "executor-client-missing-"));
    roots.push(root);
    await expect(
      launchHostViaExecutor("rh-019d2a5f-4ac8-7000-8000-123456789abc", root, {
        socketPath: join(root, "missing.sock"),
        token: TOKEN,
      }),
    ).rejects.toThrow("executor socket is unavailable");
  });

  test("allows direct launch only through the explicit operator bypass", async () => {
    const previous = process.env.OPENSESSION_EXECUTOR;
    process.env.OPENSESSION_EXECUTOR = "0";
    try {
      expect(
        await launchHostViaExecutor("rh-bypass", "/missing", { token: TOKEN }),
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENSESSION_EXECUTOR;
      else process.env.OPENSESSION_EXECUTOR = previous;
    }
  });

  test("negotiates and launches over the private unix socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "executor-client-live-"));
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
    writeJsonAtomic(join(dir, HOST_SPEC_NAME), spec);
    let launches = 0;
    let ready = false;
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      launch: async () => {
        launches++;
        ready = true;
      },
      stop: async () => {},
      unitActive: async () => false,
      hostReady: () => ready,
      hostStarted: () => ready,
      now: () => "2026-08-18T00:00:00.000Z",
    });
    listeners.push(
      await startExecutorServer({
        sessionsDir: root,
        coordinator,
        token: TOKEN,
      }),
    );

    expect(
      await launchHostViaExecutor(hostId, dir, {
        socketPath: executorSocketPath(root),
        token: TOKEN,
      }),
    ).toBe(true);
    expect(launches).toBe(1);
  });

  test("fails closed when a live executor rejects the credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "executor-client-auth-"));
    roots.push(root);
    const hostId = "rh-019d2a5f-4ac8-7000-8000-123456789abc";
    const dir = join(runHostsDir(root), hostId);
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(join(dir, HOST_SPEC_NAME), {
      hostId,
      osSessionId: "os-test",
      prompt: "test",
      cwd: "/tmp",
      mcpServers: [],
    } satisfies RunHostSpec);
    const coordinator = new ExecutorCoordinator(root, TOKEN, {
      launch: async () => {},
      stop: async () => {},
      unitActive: async () => false,
      hostReady: () => false,
      hostStarted: () => false,
      now: () => "2026-08-18T00:00:00.000Z",
    });
    listeners.push(
      await startExecutorServer({
        sessionsDir: root,
        coordinator,
        token: TOKEN,
      }),
    );
    await expect(
      launchHostViaExecutor(hostId, dir, {
        socketPath: executorSocketPath(root),
        token: "wrong-token",
      }),
    ).rejects.toThrow("invalid executor credential");
  });
});
