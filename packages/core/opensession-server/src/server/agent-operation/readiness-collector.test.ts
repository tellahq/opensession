import { describe, expect, test } from "bun:test";
import {
  collectAgentHostReadinessObservations,
  type AgentHostReadinessCollectorDependencies,
} from "./readiness-collector";
import { checkAgentHostReadiness } from "./readiness";

const NOW = 2_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const digest = (character: string) => `sha256:${character.repeat(64)}`;

type MutableProbes = {
  -readonly [Key in keyof AgentHostReadinessCollectorDependencies["probes"]]:
    AgentHostReadinessCollectorDependencies["probes"][Key];
};
type TestDependencies = {
  -readonly [Key in keyof AgentHostReadinessCollectorDependencies]:
    Key extends "probes"
      ? MutableProbes
      : AgentHostReadinessCollectorDependencies[Key];
} & { retained: number[] };

function dependencies(): TestDependencies {
  const retained: number[] = [];
  return {
    retained,
    now: () => NOW,
    deadlineMs: 50,
    clockStore: {
      load: () => NOW - 1,
      retainAtLeast: (value) => { retained.push(value); },
    },
    probes: {
      currentProcessUid: () => 1002,
      serviceUids: () => ({ gateway: 1001, executor: 1003, sessionKernel: 1004 }),
      unixPeerUids: () => ({
        gatewaySeenByHost: 1001,
        hostSeenByGateway: 1002,
        hostSeenByExecutor: 1002,
        executorSeenByHost: 1003,
      }),
      activeGeneration: () => ({
        manifestDigest: digest("a"),
        protocolDigest: digest("b"),
        releaseDigest: digest("c"),
        keyringDigest: digest("d"),
        digestsMatchManifest: true,
        activatedAtMs: NOW - HOUR,
        deadlineMs: NOW + 23 * HOUR,
      }),
      signingPublicKey: () => ({
        verifiedByActiveKeyring: true,
        notBeforeMs: NOW - HOUR,
        notAfterMs: NOW + HOUR,
      }),
      encryptionKeyAvailable: () => true,
      hostLedger: () => ({ schemaVersion: 1, recoveryComplete: true }),
      gatewayOperationLedger: () => ({ schemaVersion: 2, recoverActiveComplete: true }),
      sessionKernel: () => ({ schemaVersion: 32, cancellationAvailable: true }),
      routeMode: () => "agent_host_only",
      host: () => ({ active: true, healthy: true, admission: "active" }),
      boundedRegistries: () => ({
        gatewayGrants: true,
        gatewayOperations: true,
        hostTurns: true,
        hostOperations: true,
        hostStreams: true,
      }),
      infrastructureFallback: () => false,
      capabilities: () => ({ deletion: true, recovery: true, streamAck: true }),
    },
  };
}

async function health(deps = dependencies()) {
  return checkAgentHostReadiness(await collectAgentHostReadinessObservations(deps));
}

describe("Agent Host readiness observation collector", () => {
  test("collects the healthy contract and retains the current wall clock", async () => {
    const deps = dependencies();
    const observations = await collectAgentHostReadinessObservations(deps);
    expect(checkAgentHostReadiness(observations)).toEqual({
      contractVersion: 1,
      ready: true,
      admission: "allow",
      routeMode: "agent_host_only",
      failingChecks: [],
      capabilities: { deletion: true, recovery: true, streamAck: true },
    });
    expect(observations.serviceUids.host).toBe(1002);
    expect(deps.retained).toEqual([NOW]);
  });

  for (const probeName of [
    "currentProcessUid",
    "serviceUids",
    "unixPeerUids",
    "activeGeneration",
    "signingPublicKey",
    "encryptionKeyAvailable",
    "hostLedger",
    "gatewayOperationLedger",
    "sessionKernel",
    "routeMode",
    "host",
    "boundedRegistries",
    "infrastructureFallback",
    "capabilities",
  ] as const) {
    test(`fails closed when ${probeName} errors`, async () => {
      const deps = dependencies();
      deps.probes[probeName] = (() => { throw new Error("private /secret/path token"); }) as never;
      expect((await health(deps)).ready).toBe(false);
    });

    test(`fails closed when ${probeName} exceeds the shared deadline`, async () => {
      const deps = dependencies();
      deps.deadlineMs = 2;
      deps.probes[probeName] = (() => new Promise(() => {})) as never;
      expect((await health(deps)).ready).toBe(false);
    });
  }

  test("fails closed when either monotonic clock store operation fails", async () => {
    const loadFailure = dependencies();
    loadFailure.clockStore.load = () => { throw new Error("load failed"); };
    expect((await health(loadFailure)).failingChecks).toContain("clock_rollback");

    const retainFailure = dependencies();
    retainFailure.clockStore.retainAtLeast = () => { throw new Error("retain failed"); };
    expect((await health(retainFailure)).failingChecks).toContain("clock_rollback");
  });

  test("detects rollback and never asks the store to lower its retained value", async () => {
    const deps = dependencies();
    deps.now = () => NOW - 10;
    deps.clockStore.load = () => NOW;
    const result = await health(deps);
    expect(result.failingChecks).toContain("clock_rollback");
    expect(deps.retained).toEqual([NOW]);
  });

  test("fails wrong peer, generation, keyring, and incomplete recovery proofs", async () => {
    const deps = dependencies();
    deps.probes.unixPeerUids = () => ({
      gatewaySeenByHost: 9999,
      hostSeenByGateway: 1002,
      hostSeenByExecutor: 1002,
      executorSeenByHost: 1003,
    });
    deps.probes.activeGeneration = () => ({
      manifestDigest: digest("a"),
      protocolDigest: digest("b"),
      releaseDigest: digest("c"),
      keyringDigest: digest("d"),
      digestsMatchManifest: false,
      activatedAtMs: NOW - HOUR,
      deadlineMs: NOW + HOUR,
    });
    deps.probes.signingPublicKey = () => ({
      verifiedByActiveKeyring: false,
      notBeforeMs: NOW - HOUR,
      notAfterMs: NOW + HOUR,
    });
    deps.probes.hostLedger = () => ({ schemaVersion: 1, recoveryComplete: false });
    deps.probes.gatewayOperationLedger = () => ({ schemaVersion: 2, recoverActiveComplete: false });
    expect((await health(deps)).failingChecks).toEqual(expect.arrayContaining([
      "host_gateway_peer_uid_mismatch",
      "generation_digest_mismatch",
      "signing_public_key_not_in_active_keyring",
      "host_ledger_recovery_incomplete",
      "gateway_operation_recovery_incomplete",
    ]));
  });

  test("preserves legacy versus agent_host_only Host requirements", async () => {
    const legacy = dependencies();
    legacy.probes.routeMode = () => "legacy";
    legacy.probes.host = () => ({ active: false, healthy: false, admission: "none" });
    legacy.probes.boundedRegistries = () => ({
      gatewayGrants: false,
      gatewayOperations: false,
      hostTurns: false,
      hostOperations: false,
      hostStreams: false,
    });
    legacy.probes.infrastructureFallback = () => true;
    expect((await health(legacy)).ready).toBe(true);

    const hostOnly = dependencies();
    hostOnly.probes.host = legacy.probes.host;
    expect((await health(hostOnly)).ready).toBe(false);
  });

  test("requires infrastructureFallback to be the literal false", async () => {
    const deps = dependencies();
    deps.probes.infrastructureFallback = () => 0;
    expect((await health(deps)).failingChecks).toContain("infrastructure_fallback_enabled");
  });

  test("redacts extra probe fields and never returns errors, secrets, or paths", async () => {
    const deps = dependencies();
    deps.probes.activeGeneration = () => ({
      ...(dependencies().probes.activeGeneration(new AbortController().signal) as object),
      privateKey: "super-secret",
      manifestPath: "/private/generation.json",
    }) as never;
    deps.probes.host = () => ({
      active: true,
      healthy: true,
      admission: "active",
      socketPath: "/private/host.sock",
      credential: "super-secret",
    }) as never;
    const encoded = JSON.stringify(await collectAgentHostReadinessObservations(deps));
    expect(encoded).not.toContain("super-secret");
    expect(encoded).not.toContain("/private/");
    expect(encoded).not.toContain("privateKey");
    expect(encoded).not.toContain("socketPath");
  });

  test("module import is inert until collection is invoked", async () => {
    let calls = 0;
    const deps = dependencies();
    deps.now = () => { calls++; return NOW; };
    expect(calls).toBe(0);
    await collectAgentHostReadinessObservations(deps);
    expect(calls).toBe(1);
  });
});
