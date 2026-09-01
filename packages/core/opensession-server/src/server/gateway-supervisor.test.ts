import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  discoverRuntimePeerGenerations,
  GatewaySupervisor,
  inheritedGatewaySocketFd,
  type ManagedGateway,
  promoteGatewayCurrent,
  readGatewayHandoffTransaction,
  resolveInitialPeerGenerations,
  resolveInitialReleaseRoot,
  spawnGateway,
  writeGatewayHandoffTransaction,
  validateGatewayRelease,
} from "./gateway-supervisor";

function controlledGateway(pid: number, releaseRoot: string, standby = false) {
  let finish!: (code: number) => void;
  let preload!: () => void;
  const events: string[] = [];
  const gateway: ManagedGateway = {
    pid,
    releaseRoot,
    backendPort: 40_000 + pid,
    exited: new Promise<number>((resolve) => {
      finish = resolve;
    }),
    kill(signal = 15) {
      events.push(`kill:${signal}`);
    },
    ...(standby
      ? {
          preloaded: new Promise<void>((resolve) => {
            preload = resolve;
          }),
          activate(nonce: string) {
            events.push(`activate:${nonce}`);
          },
        }
      : {}),
  };
  return { gateway, events, finish, preload };
}

describe("gateway supervisor", () => {
  test("accepts only systemd descriptors addressed to this supervisor", () => {
    expect(
      inheritedGatewaySocketFd({ LISTEN_PID: "42", LISTEN_FDS: "1" }, 42),
    ).toBe(3);
    expect(
      inheritedGatewaySocketFd({ LISTEN_PID: "41", LISTEN_FDS: "1" }, 42),
    ).toBeUndefined();
    expect(
      inheritedGatewaySocketFd({ LISTEN_PID: "42", LISTEN_FDS: "0" }, 42),
    ).toBeUndefined();
  });

  test("discovers independently selected peer generations on supervisor boot", async () => {
    const peers = await discoverRuntimePeerGenerations({
      fetchReady: async () => Response.json({ generation: "a".repeat(40) }),
      readExecutorReady: () => JSON.stringify({ generation: "b".repeat(40) }),
      sleep: async () => {},
      attempts: 1,
    });
    expect(peers).toEqual({ kernel: "a".repeat(40), executor: "b".repeat(40) });
  });

  test("starts source installs without an immutable release pointer", () => {
    const state = mkdtempSync(join(tmpdir(), "opensession-deploy-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "opensession-source-"));
    const sourceEntry = join(
      sourceRoot,
      "packages/core/opensession-server/opensession.ts",
    );
    mkdirSync(join(sourceRoot, "packages/core/opensession-server"), {
      recursive: true,
    });
    writeFileSync(sourceEntry, "");

    expect(resolveInitialReleaseRoot(state, sourceRoot)).toBe(
      realpathSync(sourceRoot),
    );
  });

  test("starts source installs without a separate executor generation", async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "opensession-source-"));
    let discoveries = 0;
    const peers = await resolveInitialPeerGenerations(sourceRoot, async () => {
      discoveries++;
      return { kernel: "a".repeat(40), executor: "b".repeat(40) };
    });

    expect(peers).toEqual({
      kernel: "development",
      executor: "development",
    });
    expect(discoveries).toBe(0);
  });

  test("discovers selected generations for immutable releases", async () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), "opensession-release-"));
    writeFileSync(join(releaseRoot, ".opensession-release"), "c".repeat(40));
    let discoveries = 0;
    const peers = await resolveInitialPeerGenerations(releaseRoot, async () => {
      discoveries++;
      return { kernel: "a".repeat(40), executor: "b".repeat(40) };
    });

    expect(peers).toEqual({ kernel: "a".repeat(40), executor: "b".repeat(40) });
    expect(discoveries).toBe(1);
  });

  test("fast-drains the child before a supervisor service restart", async () => {
    const active = controlledGateway(1, "/releases/current");
    active.gateway.kill = (signal = 15) => {
      active.events.push(`kill:${signal}`);
      active.finish(0);
    };
    const supervisor = new GatewaySupervisor(active.gateway, {
      spawn: () => active.gateway,
      waitReady: async () => {},
      validateRelease: (root) => root,
      promoteCurrent() {},
      quiescePublicListener() {
        active.events.push("listener-quiesced");
      },
    });
    expect(supervisor.status().backendPort).toBe(active.gateway.backendPort);
    const result = await supervisor.drainForSupervisorRestart();
    expect(result.ok).toBe(true);
    expect(active.events).toEqual(["listener-quiesced", "kill:12"]);
    expect(supervisor.backendPort()).toBe(0);
  });

  test("activates a preloaded candidate only after observing the old exit", async () => {
    const old = controlledGateway(1, "/releases/old");
    const candidate = controlledGateway(2, "/releases/new", true);
    const order: string[] = [];
    const publishedPorts: number[] = [];
    let markLive!: () => void;
    const live = new Promise<void>((resolve) => {
      markLive = resolve;
    });
    const supervisor = new GatewaySupervisor(old.gateway, {
      spawn() {
        order.push("spawn-standby");
        return candidate.gateway;
      },
      waitLive: () => live,
      async waitReady() {
        order.push("ready");
      },
      validateRelease(root) {
        return root;
      },
      promoteCurrent(root) {
        order.push(`promote:${root}`);
      },
      publishBackendPort(port) {
        publishedPorts.push(port);
      },
    });

    const handoff = supervisor.handoff({
      type: "handoff",
      releaseRoot: "/releases/new",
      sha: "a".repeat(40),
    });
    await Promise.resolve();
    expect(order).toEqual(["spawn-standby"]);
    expect(old.events).toEqual([]);

    candidate.preload();
    await Bun.sleep(0);
    expect(old.events).toEqual(["kill:12"]);
    expect(candidate.events).toEqual([]);
    expect(supervisor.backendPort()).toBe(0);

    order.push("old-exited");
    old.finish(0);
    await Bun.sleep(0);
    expect(candidate.events[0]?.startsWith("activate:")).toBe(true);
    expect(supervisor.backendPort()).toBe(0);
    expect(publishedPorts).toEqual([old.gateway.backendPort, 0]);
    markLive();
    const result = await handoff;
    expect(result.ok).toBe(true);
    expect(candidate.events[0]?.startsWith("activate:")).toBe(true);
    expect(order).toEqual([
      "spawn-standby",
      "old-exited",
      "promote:/releases/new",
      "ready",
    ]);
    expect(supervisor.activeGateway()).toBe(candidate.gateway);
    expect(supervisor.backendPort()).toBe(candidate.gateway.backendPort);
    expect(publishedPorts).toEqual([
      old.gateway.backendPort,
      0,
      candidate.gateway.backendPort,
    ]);
  });

  test("parks a coordinated candidate until protocol peers are replaced", async () => {
    const old = controlledGateway(1, "/releases/old");
    const candidate = controlledGateway(2, "/releases/new", true);
    const order: string[] = [];
    let selectedPeers: { kernel: string; executor: string } | undefined;
    const supervisor = new GatewaySupervisor(old.gateway, {
      spawn(_root, _role, _nonce, peerGenerations) {
        selectedPeers = peerGenerations;
        return candidate.gateway;
      },
      async waitReady() {
        order.push("ready");
      },
      validateRelease: (root) => root,
      promoteCurrent(root) {
        order.push(`promote:${root}`);
      },
    });
    const preparing = supervisor.prepareCoordinated({
      type: "prepare_coordinated",
      releaseRoot: "/releases/new",
      sha: "e".repeat(40),
      kernelGeneration: "a".repeat(40),
      executorGeneration: "b".repeat(40),
    });
    candidate.preload();
    await Bun.sleep(0);
    expect(old.events).toEqual(["kill:12"]);
    old.finish(0);
    expect((await preparing).ok).toBe(true);
    expect(candidate.events).toEqual([]);
    expect(selectedPeers).toEqual({
      kernel: "a".repeat(40),
      executor: "b".repeat(40),
    });
    expect(supervisor.activeGateway()).toBe(candidate.gateway);
    expect(order).toEqual(["promote:/releases/new"]);

    expect((await supervisor.activateCoordinated()).ok).toBe(true);
    expect(candidate.events[0]?.startsWith("activate:")).toBe(true);
    expect(order).toEqual(["promote:/releases/new", "ready"]);
    expect(supervisor.commitCoordinated().ok).toBe(true);
  });

  test("parks a failed coordinated candidate until previous peers are restored", async () => {
    const old = controlledGateway(1, "/releases/old");
    const candidate = controlledGateway(2, "/releases/new", true);
    const rollback = controlledGateway(3, "/releases/old");
    candidate.gateway.kill = (signal = 15) => {
      candidate.events.push(`kill:${signal}`);
      candidate.finish(1);
    };
    const promotions: string[] = [];
    const supervisor = new GatewaySupervisor(old.gateway, {
      spawn(_root, role) {
        return role === "standby" ? candidate.gateway : rollback.gateway;
      },
      async waitReady(gateway) {
        if (gateway === candidate.gateway)
          throw new Error("target generation failed");
      },
      validateRelease: (root) => root,
      promoteCurrent(root) {
        promotions.push(root);
      },
    });
    const preparing = supervisor.prepareCoordinated({
      type: "prepare_coordinated",
      releaseRoot: "/releases/new",
      sha: "f".repeat(40),
    });
    candidate.preload();
    await Bun.sleep(0);
    old.finish(0);
    expect((await preparing).ok).toBe(true);

    const activation = await supervisor.activateCoordinated();
    expect(activation.ok).toBe(false);
    expect(activation.phase).toBe("rollback-parked");
    expect(promotions).toEqual(["/releases/new"]);
    expect(supervisor.activeGateway()).toBe(candidate.gateway);

    // The deploy controller restores old peers while no gateway is active,
    // then the supervisor may safely admit the old gateway.
    const aborted = await supervisor.abortCoordinated();
    expect(aborted.ok).toBe(true);
    expect(promotions).toEqual(["/releases/new", "/releases/old"]);
    expect(supervisor.activeGateway()).toBe(rollback.gateway);
  });

  test("restores pointer and previous release when an activated gateway-only candidate fails", async () => {
    const old = controlledGateway(1, "/releases/old");
    const candidate = controlledGateway(2, "/releases/new", true);
    const rollback = controlledGateway(3, "/releases/old");
    candidate.gateway.kill = (signal = 15) => {
      candidate.events.push(`kill:${signal}`);
      candidate.finish(1);
    };
    const promotions: string[] = [];
    const supervisor = new GatewaySupervisor(old.gateway, {
      spawn(_root, role) {
        return role === "standby" ? candidate.gateway : rollback.gateway;
      },
      async waitReady(gateway) {
        if (gateway === candidate.gateway)
          throw new Error("candidate boot failed");
      },
      validateRelease: (root) => root,
      promoteCurrent(root) {
        promotions.push(root);
      },
    });
    const handoff = supervisor.handoff({
      type: "handoff",
      releaseRoot: "/releases/new",
      sha: "d".repeat(40),
    });
    candidate.preload();
    await Bun.sleep(0);
    old.finish(0);
    const result = await handoff;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("previous gateway restored");
    expect(promotions).toEqual(["/releases/new", "/releases/old"]);
    expect(supervisor.activeGateway()).toBe(rollback.gateway);
  });

  test("keeps the old gateway active when peer precheck fails", async () => {
    const old = controlledGateway(1, "/releases/old");
    old.gateway.peerGenerations = {
      kernel: "a".repeat(40),
      executor: "b".repeat(40),
    };
    let fail!: (error: Error) => void;
    let selectedPeers: { kernel: string; executor: string } | undefined;
    let precheckPeers = false;
    const candidate = controlledGateway(2, "/releases/new", true);
    candidate.gateway.preloaded = new Promise<void>((_, reject) => {
      fail = reject;
    });
    candidate.gateway.exited = Promise.resolve(1);
    const supervisor = new GatewaySupervisor(old.gateway, {
      spawn(_root, _role, _nonce, peers, precheck) {
        selectedPeers = peers;
        precheckPeers = Boolean(precheck);
        return candidate.gateway;
      },
      waitReady: async () => {},
      validateRelease: (root) => root,
      promoteCurrent() {},
    });
    const handoff = supervisor.handoff({
      type: "handoff",
      releaseRoot: "/releases/new",
      sha: "b".repeat(40),
    });
    fail(new Error("bad import"));
    const result = await handoff;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("before cut-over");
    expect(selectedPeers).toEqual(old.gateway.peerGenerations);
    expect(precheckPeers).toBe(true);
    expect(old.events).toEqual([]);
    expect(supervisor.activeGateway()).toBe(old.gateway);
  });

  test("a real standby process cannot produce effects before IPC activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-standby-"));
    const marker = join(root, "effect.txt");
    const activationModule = join(import.meta.dir, "gateway-activation.ts");
    const entry = join(root, "candidate.ts");
    writeFileSync(
      entry,
      [
        `import { waitForGatewayActivationIfStandby } from ${JSON.stringify(activationModule)};`,
        `import { writeFileSync } from "fs";`,
        `await waitForGatewayActivationIfStandby();`,
        `writeFileSync(${JSON.stringify(marker)}, "activated\\n");`,
        `await new Promise(() => {});`,
      ].join("\n"),
    );

    const candidate = spawnGateway(
      root,
      "standby",
      "integration-nonce",
      undefined,
      false,
      entry,
    );
    await candidate.preloaded!;
    expect(existsSync(marker)).toBe(false);
    candidate.activate!("integration-nonce");
    for (let attempt = 0; attempt < 50 && !existsSync(marker); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(existsSync(marker)).toBe(true);
    candidate.kill(9);
    await candidate.exited;
  });

  test("durably journals handoff authority with atomic replacement", () => {
    const state = mkdtempSync(join(tmpdir(), "gateway-transaction-"));
    writeGatewayHandoffTransaction(
      {
        phase: "parked",
        targetRelease: "/releases/new",
        previousRelease: "/releases/old",
        candidatePid: 42,
        updatedAt: new Date().toISOString(),
      },
      state,
    );
    expect(readGatewayHandoffTransaction(state)).toMatchObject({
      phase: "parked",
      candidatePid: 42,
    });
  });

  test("atomically promotes the runtime pointer inside the handoff transaction", () => {
    const state = mkdtempSync(join(tmpdir(), "gateway-pointer-"));
    const old = join(state, "old");
    const next = join(state, "next");
    mkdirSync(old);
    mkdirSync(next);
    symlinkSync(old, join(state, "current"));
    promoteGatewayCurrent(next, state);
    expect(realpathSync(join(state, "current"))).toBe(realpathSync(next));
  });

  test("validates immutable release ancestry and prepared frontend", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-release-"));
    const releases = join(root, "releases");
    const sha = "c".repeat(40);
    const release = join(releases, sha);
    mkdirSync(join(release, ".frontend-dist"), { recursive: true });
    writeFileSync(join(release, ".opensession-release"), `${sha}\n`);
    writeFileSync(join(release, ".frontend-dist", ".bundle-meta.json"), "{}\n");
    expect(validateGatewayRelease(release, sha, releases)).toBe(
      realpathSync(release),
    );
    expect(() => validateGatewayRelease(root, sha, releases)).toThrow(
      "outside",
    );
    expect(() => validateGatewayRelease(release, "bad", releases)).toThrow(
      "invalid release sha",
    );
  });
});
