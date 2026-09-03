import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import {
  acquireGatewayActivationLease,
  gatewayRole,
  waitForGatewayActivationIfStandby,
  waitForRuntimePeerGeneration,
  type GatewayPreloadedMessage,
} from "./gateway-activation";

class FakePort extends EventEmitter {
  pid = 42;
  sent: GatewayPreloadedMessage[] = [];
  send = (message: GatewayPreloadedMessage) => {
    this.sent.push(message);
    return true;
  };
}

describe("gateway activation preload barrier", () => {
  test("keeps the compatibility path active by default", async () => {
    expect(gatewayRole({})).toBe("active");
    await expect(
      waitForGatewayActivationIfStandby({ env: {} }),
    ).resolves.toBeUndefined();
  });

  test("rejects unknown roles and unsupervised standby launches", async () => {
    expect(() =>
      gatewayRole({ OPENSESSION_GATEWAY_ROLE: "candidate" }),
    ).toThrow("Invalid OPENSESSION_GATEWAY_ROLE");
    await expect(
      waitForGatewayActivationIfStandby({
        env: { OPENSESSION_GATEWAY_ROLE: "standby" },
        processPort: new FakePort(),
      }),
    ).rejects.toThrow("requires OPENSESSION_GATEWAY_NONCE");
    await expect(
      waitForGatewayActivationIfStandby({
        env: {
          OPENSESSION_GATEWAY_ROLE: "standby",
          OPENSESSION_GATEWAY_NONCE: "nonce-one",
        },
        processPort: {
          pid: 42,
          on() {},
          removeListener() {},
        },
      }),
    ).rejects.toThrow("requires a supervised IPC channel");
  });

  test("announces preload and waits for the exact parent activation", async () => {
    const port = new FakePort();
    let activated = false;
    const waiting = waitForGatewayActivationIfStandby({
      env: {
        OPENSESSION_GATEWAY_ROLE: "standby",
        OPENSESSION_GATEWAY_NONCE: "nonce-one",
      },
      processPort: port,
    }).then(() => {
      activated = true;
    });

    expect(port.sent).toEqual([
      { type: "opensession_gateway_preloaded", nonce: "nonce-one", pid: 42 },
    ]);
    port.emit("message", { type: "unrelated" });
    await Promise.resolve();
    expect(activated).toBe(false);
    port.emit("message", {
      type: "opensession_gateway_activate",
      nonce: "nonce-one",
    });
    await waiting;
    expect(activated).toBe(true);
    expect(port.listenerCount("message")).toBe(0);
  });

  test("entrypoint waits before every production boot effect", async () => {
    const entry = await Bun.file(
      resolve(import.meta.dir, "../../opensession.ts"),
    ).text();
    const prewarm = entry.indexOf("preloadPreparedFrontend()");
    const precheck = entry.indexOf(
      "waitForRuntimePeerGeneration({ timeoutMs: 5_000 })",
    );
    const barrier = entry.indexOf("await waitForGatewayActivationIfStandby()");
    const peers = entry.indexOf("await waitForRuntimePeerGeneration()");
    const lease = entry.indexOf("await acquireGatewayActivationLease");
    const promotedRole = entry.indexOf(
      'process.env.OPENSESSION_GATEWAY_ROLE = "active"',
    );
    expect(prewarm).toBeGreaterThan(0);
    expect(precheck).toBeGreaterThan(prewarm);
    expect(barrier).toBeGreaterThan(precheck);
    expect(peers).toBeGreaterThan(barrier);
    expect(lease).toBeGreaterThan(peers);
    expect(promotedRole).toBeGreaterThan(lease);
    expect(entry).not.toContain("}, 1500);");
    for (const effect of [
      "devInstanceBootError()",
      "startRunRpcServer()",
      "startMcpHttpServer()",
      "startTimerPoisonHeartbeat()",
      "mkdirSync(SESSIONS_DIR",
      "await startSessionKernelActor()",
      "await ensureFrontendBuilt()",
    ]) {
      expect(entry.indexOf(effect)).toBeGreaterThan(promotedRole);
    }
  });

  test("admits effects only when each peer reports its selected generation", async () => {
    const kernel = "a".repeat(40);
    const executor = "b".repeat(40);
    await expect(
      waitForRuntimePeerGeneration({
        env: {
          OPENSESSION_RELEASE_GENERATION: "c".repeat(40),
          OPENSESSION_KERNEL_GENERATION: kernel,
          OPENSESSION_EXECUTOR_GENERATION: executor,
        },
        fetchReady: async () => Response.json({ generation: kernel }),
        readReadyFile: () => JSON.stringify({ pid: 7, generation: executor }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      waitForRuntimePeerGeneration({
        env: { OPENSESSION_RELEASE_GENERATION: "not-a-sha" },
      }),
    ).rejects.toThrow("Invalid runtime peer generation");
  });

  test("holds an OS lease until explicit release", async () => {
    let ended = false;
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const lease = await acquireGatewayActivationLease({
      env: { HOME: "/tmp/test-home" },
      spawn(command) {
        expect(command).toContain(
          "/tmp/test-home/.opensession/deploy/gateway-active.lock",
        );
        return {
          stdin: {
            end() {
              ended = true;
              finish(0);
            },
          },
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("LO"));
              controller.enqueue(new TextEncoder().encode("CKED\n"));
              controller.close();
            },
          }),
          stderr: new Response("").body!,
          exited,
        };
      },
    });
    expect(ended).toBe(false);
    await lease.release();
    expect(ended).toBe(true);
  });

  test("uses the native ownership lock command on Linux and macOS", async () => {
    const commands: string[][] = [];
    const spawn = (command: string[]) => {
      commands.push(command);
      let finish!: (code: number) => void;
      return {
        stdin: { end: () => finish(0) },
        stdout: new Response("LOCKED\n").body!,
        stderr: new Response("").body!,
        exited: new Promise<number>((resolve) => {
          finish = resolve;
        }),
      };
    };
    const env = {
      HOME: "/tmp/test-home",
      OPENSESSION_GATEWAY_LEASE_WAIT_SECS: "7",
    };

    const linux = await acquireGatewayActivationLease({
      env,
      platform: "linux",
      spawn,
    });
    await linux.release();
    const macos = await acquireGatewayActivationLease({
      env,
      platform: "darwin",
      spawn,
    });
    await macos.release();

    expect(commands[0]?.slice(0, 5)).toEqual([
      "flock",
      "-w",
      "7",
      "/tmp/test-home/.opensession/deploy/gateway-active.lock",
      "/bin/sh",
    ]);
    expect(commands[1]?.slice(0, 6)).toEqual([
      "/usr/bin/lockf",
      "-k",
      "-t",
      "7",
      "/tmp/test-home/.opensession/deploy/gateway-active.lock",
      "/bin/sh",
    ]);
  });

  test("fails closed when the active lease is held", async () => {
    await expect(
      acquireGatewayActivationLease({
        env: { HOME: "/tmp/test-home" },
        spawn: () => ({
          stdin: { end() {} },
          stdout: new Response("").body!,
          stderr: new Response("busy").body!,
          exited: Promise.resolve(1),
        }),
      }),
    ).rejects.toThrow("already held");
  });

  test("fails closed on an activation nonce mismatch", async () => {
    const port = new FakePort();
    const waiting = waitForGatewayActivationIfStandby({
      env: {
        OPENSESSION_GATEWAY_ROLE: "standby",
        OPENSESSION_GATEWAY_NONCE: "nonce-one",
      },
      processPort: port,
    });
    port.emit("message", {
      type: "opensession_gateway_activate",
      nonce: "nonce-two",
    });
    await expect(waiting).rejects.toThrow("nonce mismatch");
    expect(port.listenerCount("message")).toBe(0);
  });
});
