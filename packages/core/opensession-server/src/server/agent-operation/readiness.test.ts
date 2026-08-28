import { describe, expect, test } from "bun:test";
import {
  checkAgentHostReadiness,
  type AgentHostReadinessCheckCode,
  type AgentHostReadinessObservations,
} from "./readiness";

const NOW = 2_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function healthy(): AgentHostReadinessObservations {
  return {
    nowMs: NOW,
    previousObservedAtMs: NOW - 1,
    serviceUids: {
      gateway: 1001,
      host: 1002,
      executor: 1003,
      sessionKernel: 1004,
    },
    unixPeerUids: {
      gatewaySeenByHost: 1001,
      hostSeenByGateway: 1002,
      hostSeenByExecutor: 1002,
      executorSeenByHost: 1003,
    },
    activeGeneration: {
      manifestDigest: digest("a"),
      protocolDigest: digest("b"),
      releaseDigest: digest("c"),
      keyringDigest: digest("d"),
      digestsMatchManifest: true,
      activatedAtMs: NOW - HOUR,
      deadlineMs: NOW + 23 * HOUR,
    },
    signingPublicKey: {
      verifiedByActiveKeyring: true,
      notBeforeMs: NOW - HOUR,
      notAfterMs: NOW + HOUR,
    },
    encryptionKeyAvailable: true,
    hostLedger: { schemaVersion: 1, recoveryComplete: true },
    gatewayOperationLedger: {
      schemaVersion: 2,
      recoverActiveComplete: true,
    },
    sessionKernel: { schemaVersion: 32, cancellationAvailable: true },
    routeMode: "agent_host_only",
    host: { active: true, healthy: true, admission: "active" },
    boundedRegistries: {
      gatewayGrants: true,
      gatewayOperations: true,
      hostTurns: true,
      hostOperations: true,
      hostStreams: true,
    },
    infrastructureFallback: false,
    capabilities: { deletion: true, recovery: true, streamAck: true },
  };
}

type MutableObservations = {
  -readonly [Key in keyof AgentHostReadinessObservations]: any;
};

function changed(change: (fixture: MutableObservations) => void) {
  const fixture = structuredClone(healthy()) as MutableObservations;
  change(fixture);
  return fixture as AgentHostReadinessObservations;
}

function expectOnlyFailure(
  code: AgentHostReadinessCheckCode,
  change: (fixture: MutableObservations) => void,
) {
  const health = checkAgentHostReadiness(changed(change));
  expect(health.ready).toBe(false);
  expect(health.admission).toBe("block");
  expect(health.failingChecks).toEqual([code]);
}

describe("Agent Host readiness contract", () => {
  test("returns the exact bounded healthy fixture", () => {
    expect(checkAgentHostReadiness(healthy())).toEqual({
      contractVersion: 1,
      ready: true,
      admission: "allow",
      routeMode: "agent_host_only",
      failingChecks: [],
      capabilities: { deletion: true, recovery: true, streamAck: true },
    });
  });

  const cases: Array<
    readonly [
      string,
      AgentHostReadinessCheckCode,
      (fixture: MutableObservations) => void,
    ]
  > = [
    ["clock rollback", "clock_rollback", (f) => (f.previousObservedAtMs = NOW + 1)],
    [
      "root gateway UID",
      "gateway_uid_not_distinct_non_root",
      (f) => {
        f.serviceUids.gateway = 0;
        f.unixPeerUids.gatewaySeenByHost = 0;
      },
    ],
    [
      "root Host UID",
      "host_uid_not_distinct_non_root",
      (f) => {
        f.serviceUids.host = 0;
        f.unixPeerUids.hostSeenByGateway = 0;
        f.unixPeerUids.hostSeenByExecutor = 0;
      },
    ],
    [
      "root Executor UID",
      "executor_uid_not_distinct_non_root",
      (f) => {
        f.serviceUids.executor = 0;
        f.unixPeerUids.executorSeenByHost = 0;
      },
    ],
    [
      "root SessionKernel UID",
      "session_kernel_uid_not_distinct_non_root",
      (f) => (f.serviceUids.sessionKernel = 0),
    ],
    [
      "duplicate service UID",
      "service_uids_not_distinct",
      (f) => {
        f.serviceUids.executor = f.serviceUids.host;
        f.unixPeerUids.executorSeenByHost = f.serviceUids.host;
      },
    ],
    ["wrong Host peer at gateway", "gateway_host_peer_uid_mismatch", (f) => (f.unixPeerUids.hostSeenByGateway = 9999)],
    ["wrong gateway peer at Host", "host_gateway_peer_uid_mismatch", (f) => (f.unixPeerUids.gatewaySeenByHost = 9999)],
    ["wrong Executor peer at Host", "host_executor_peer_uid_mismatch", (f) => (f.unixPeerUids.executorSeenByHost = 9999)],
    ["wrong Host peer at Executor", "executor_host_peer_uid_mismatch", (f) => (f.unixPeerUids.hostSeenByExecutor = 9999)],
    ["invalid manifest digest", "generation_manifest_digest_invalid", (f) => (f.activeGeneration.manifestDigest = "sha256:no")],
    ["invalid protocol digest", "generation_protocol_digest_invalid", (f) => (f.activeGeneration.protocolDigest = "sha256:no")],
    ["invalid release digest", "generation_release_digest_invalid", (f) => (f.activeGeneration.releaseDigest = "sha256:no")],
    ["invalid keyring digest", "generation_keyring_digest_invalid", (f) => (f.activeGeneration.keyringDigest = "sha256:no")],
    ["generation digest mismatch", "generation_digest_mismatch", (f) => (f.activeGeneration.digestsMatchManifest = false)],
    ["future generation activation", "generation_activation_in_future", (f) => {
      f.activeGeneration.activatedAtMs = NOW + HOUR;
      f.activeGeneration.deadlineMs = NOW + 2 * HOUR;
    }],
    ["overlong generation", "generation_deadline_invalid", (f) => (f.activeGeneration.deadlineMs += 1)],
    ["stale generation", "generation_stale", (f) => {
      f.activeGeneration.activatedAtMs = NOW - HOUR;
      f.activeGeneration.deadlineMs = NOW;
    }],
    ["unverified signing key", "signing_public_key_not_in_active_keyring", (f) => (f.signingPublicKey.verifiedByActiveKeyring = false)],
    ["invalid signing key window", "signing_public_key_window_invalid", (f) => (f.signingPublicKey.notAfterMs = f.signingPublicKey.notBeforeMs)],
    ["stale signing key", "signing_public_key_not_current", (f) => {
      f.signingPublicKey.notBeforeMs = NOW - 2 * HOUR;
      f.signingPublicKey.notAfterMs = NOW;
    }],
    ["missing encryption key", "encryption_key_unavailable", (f) => (f.encryptionKeyAvailable = false)],
    ["Host ledger schema mismatch", "host_ledger_schema_incompatible", (f) => (f.hostLedger.schemaVersion = 2)],
    ["Host ledger recovery incomplete", "host_ledger_recovery_incomplete", (f) => (f.hostLedger.recoveryComplete = false)],
    ["gateway ledger schema mismatch", "gateway_operation_ledger_schema_incompatible", (f) => (f.gatewayOperationLedger.schemaVersion = 1)],
    ["recoverActive incomplete", "gateway_operation_recovery_incomplete", (f) => (f.gatewayOperationLedger.recoverActiveComplete = false)],
    ["old SessionKernel schema", "session_kernel_schema_incompatible", (f) => (f.sessionKernel.schemaVersion = 31)],
    ["cancellation unavailable", "session_kernel_cancellation_unavailable", (f) => (f.sessionKernel.cancellationAvailable = false)],
    ["unknown route mode", "route_mode_invalid", (f) => (f.routeMode = "mixed")],
    ["inactive Host", "agent_host_inactive", (f) => (f.host.active = false)],
    ["unhealthy Host", "agent_host_unhealthy", (f) => (f.host.healthy = false)],
    ["draining-only Host", "agent_host_admission_draining_only", (f) => (f.host.admission = "draining_only")],
    ["unbounded gateway grants", "gateway_grant_registry_unbounded", (f) => (f.boundedRegistries.gatewayGrants = false)],
    ["unbounded gateway operations", "gateway_operation_registry_unbounded", (f) => (f.boundedRegistries.gatewayOperations = false)],
    ["unbounded Host turns", "host_turn_registry_unbounded", (f) => (f.boundedRegistries.hostTurns = false)],
    ["unbounded Host operations", "host_operation_registry_unbounded", (f) => (f.boundedRegistries.hostOperations = false)],
    ["unbounded Host streams", "host_stream_registry_unbounded", (f) => (f.boundedRegistries.hostStreams = false)],
    ["infrastructure fallback true", "infrastructure_fallback_enabled", (f) => (f.infrastructureFallback = true)],
    ["deletion unavailable", "deletion_capability_unavailable", (f) => (f.capabilities.deletion = false)],
    ["recovery unavailable", "recovery_capability_unavailable", (f) => (f.capabilities.recovery = false)],
    ["stream ACK unavailable", "stream_ack_capability_unavailable", (f) => (f.capabilities.streamAck = false)],
  ];

  for (const [name, code, change] of cases) {
    test(`fails only ${code} for ${name}`, () => expectOnlyFailure(code, change));
  }

  test("legacy mode does not require unwired Host admission state", () => {
    const observations = changed((f) => {
      f.routeMode = "legacy";
      f.host = { active: false, healthy: false, admission: "none" };
      for (const key of Object.keys(f.boundedRegistries))
        f.boundedRegistries[key] = false;
      f.infrastructureFallback = true;
    });
    expect(checkAgentHostReadiness(observations)).toMatchObject({
      ready: true,
      routeMode: "legacy",
      failingChecks: [],
    });
  });

  test("infrastructureFallback must be the boolean false", () => {
    expectOnlyFailure(
      "infrastructure_fallback_enabled",
      (f) => (f.infrastructureFallback = 0),
    );
  });
});
