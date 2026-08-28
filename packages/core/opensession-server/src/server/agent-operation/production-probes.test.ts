import { describe, expect, test } from "bun:test";
import { checkAgentHostReadiness } from "./readiness";
import { collectAgentHostReadinessObservations } from "./readiness-collector";
import {
  createProductionAgentHostReadinessDependencies,
  type ProductionAgentHostReadinessOwners,
} from "./production-probes";

const NOW = 2_000_000_000_000;
const digest = (value: string) => `sha256:${value.repeat(64)}`;

type MutableOwners = {
  -readonly [K in keyof ProductionAgentHostReadinessOwners]: ProductionAgentHostReadinessOwners[K]
};

function fixture(): MutableOwners {
  const peerUids = new Map([[10, 1001], [11, 1002], [12, 1002], [13, 1003]]);
  const credentialBytes = (pid: number, uid: number, gid: number) => {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, pid, true); view.setUint32(4, uid, true); view.setUint32(8, gid, true);
    return bytes;
  };
  const reader = {
    read(fd: number) {
      const uid = peerUids.get(fd);
      if (uid === undefined) throw new Error("not an inherited AF_UNIX descriptor");
      return { bytes: credentialBytes(fd + 100, uid, uid), returnedLength: 12, unixDomain: true };
    },
  };
  return {
    now: () => NOW,
    deadlineMs: 50,
    clockStore: { load: () => NOW - 1, retainAtLeast: () => {} },
    serviceUids: {
      currentProcessUid: () => 1002,
      exactServiceUids: () => ({ gateway: 1001, executor: 1003, sessionKernel: 1004 }),
    },
    peerCredentials: {
      reader,
      descriptors: {
        gatewaySeenByHost: 10,
        hostSeenByGateway: 11,
        hostSeenByExecutor: 12,
        executorSeenByHost: 13,
      },
    },
    generation: {
      activeManifest: () => ({
        manifestDigest: digest("a"), protocolDigest: digest("b"),
        releaseDigest: digest("c"), keyringDigest: digest("d"),
        digestsMatchManifest: true, activatedAtMs: NOW - 1_000, deadlineMs: NOW + 1_000,
      }),
      activeSigningKey: () => ({
        verifiedByActiveKeyring: true, notBeforeMs: NOW - 1_000, notAfterMs: NOW + 1_000,
      }),
      encryptionKeyAvailable: () => true,
    },
    hostLedger: { readiness: () => ({ schemaVersion: 1, recoveryComplete: true }) },
    gatewayOperationLedger: { readiness: () => ({ schemaVersion: 2, recoverActiveComplete: true }) },
    sessionKernel: { readiness: () => ({ schemaVersion: 32, cancellationAvailable: true }) },
    route: { externalObservation: () => ({
      routeMode: "agent_host_only", infrastructureFallback: false,
    }) },
    host: { readiness: () => ({ active: true, healthy: true, admission: "active" }) },
    registries: {
      capacities: () => ({
        gatewayGrants: { size: 1, capacity: 10 }, gatewayOperations: { size: 1, capacity: 10 },
        hostTurns: { size: 1, capacity: 10 }, hostOperations: { size: 1, capacity: 10 },
        hostStreams: { size: 1, capacity: 10 },
      }),
    },
    capabilities: { readiness: () => ({ deletion: true, recovery: true, streamAck: true }) },
  };
}

async function health(owners: ProductionAgentHostReadinessOwners) {
  const dependencies = createProductionAgentHostReadinessDependencies(owners);
  return checkAgentHostReadiness(await collectAgentHostReadinessObservations(dependencies));
}

describe("production Agent Host readiness probes", () => {
  test("accepts exact Linux SO_PEERCRED UIDs from inherited descriptors", async () => {
    expect(await health(fixture())).toMatchObject({ ready: true, failingChecks: [] });
  });

  test("fails closed when the kernel reports the wrong Unix peer", async () => {
    const owners = fixture();
    owners.peerCredentials = {
      ...owners.peerCredentials,
      reader: { read: () => ({
        bytes: (() => {
          const bytes = new Uint8Array(12); const view = new DataView(bytes.buffer);
          view.setInt32(0, 1, true); view.setUint32(4, 9999, true); view.setUint32(8, 9999, true);
          return bytes;
        })(),
        returnedLength: 12, unixDomain: true,
      }) },
    };
    expect((await health(owners)).failingChecks).toEqual(expect.arrayContaining([
      "host_gateway_peer_uid_mismatch", "gateway_host_peer_uid_mismatch",
      "host_executor_peer_uid_mismatch", "executor_host_peer_uid_mismatch",
    ]));
  });

  test("rejects stale generation and signing-key windows", async () => {
    const owners = fixture();
    owners.generation = {
      ...owners.generation,
      activeManifest: () => ({
        manifestDigest: digest("a"), protocolDigest: digest("b"), releaseDigest: digest("c"),
        keyringDigest: digest("d"), digestsMatchManifest: true,
        activatedAtMs: NOW - 2_000, deadlineMs: NOW - 1,
      }),
      activeSigningKey: () => ({
        verifiedByActiveKeyring: true, notBeforeMs: NOW - 2_000, notAfterMs: NOW - 1,
      }),
    };
    expect((await health(owners)).failingChecks).toEqual(expect.arrayContaining([
      "generation_stale", "signing_public_key_not_current",
    ]));
  });

  test("rejects incomplete ledger recovery and incompatible kernel cancellation", async () => {
    const owners = fixture();
    owners.hostLedger = { readiness: () => ({ schemaVersion: 1, recoveryComplete: false }) };
    owners.gatewayOperationLedger = { readiness: () => ({ schemaVersion: 2, recoverActiveComplete: false }) };
    owners.sessionKernel = { readiness: () => ({ schemaVersion: 31, cancellationAvailable: false }) };
    expect((await health(owners)).failingChecks).toEqual(expect.arrayContaining([
      "host_ledger_recovery_incomplete", "gateway_operation_recovery_incomplete",
      "session_kernel_schema_incompatible", "session_kernel_cancellation_unavailable",
    ]));
  });

  test("derives registry bounds and detects literal infrastructure fallback", async () => {
    const owners = fixture();
    owners.registries = { capacities: () => ({
      gatewayGrants: { size: 11, capacity: 10 }, gatewayOperations: { size: 1, capacity: 10 },
      hostTurns: { size: 1, capacity: 10 }, hostOperations: { size: 1, capacity: 10 },
      hostStreams: { size: 1, capacity: 10 },
    }) };
    owners.route = { externalObservation: () => ({ routeMode: "agent_host_only", infrastructureFallback: true }) as never };
    expect((await health(owners)).failingChecks).toEqual(expect.arrayContaining([
      "gateway_grant_registry_unbounded", "infrastructure_fallback_enabled",
    ]));
  });

  test("is import-inert and redacts owner extras and failures", async () => {
    let calls = 0;
    const owners = fixture();
    owners.serviceUids.currentProcessUid = () => { calls++; return 1002; };
    const dependencies = createProductionAgentHostReadinessDependencies(owners);
    expect(calls).toBe(0);
    owners.generation.activeManifest = () => ({
      manifestDigest: digest("a"), protocolDigest: digest("b"), releaseDigest: digest("c"),
      keyringDigest: digest("d"), digestsMatchManifest: true,
      activatedAtMs: NOW - 1, deadlineMs: NOW + 1,
      secret: "provider-payload", path: "/private/keyring",
    }) as never;
    owners.capabilities.readiness = () => { throw new Error("token /private/config"); };
    const encoded = JSON.stringify(await collectAgentHostReadinessObservations(dependencies));
    expect(calls).toBe(1);
    expect(encoded).not.toContain("provider-payload");
    expect(encoded).not.toContain("/private");
    expect(encoded).not.toContain("token");
  });
});
