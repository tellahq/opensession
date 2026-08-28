const MAX_GENERATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOST_LEDGER_SCHEMA_VERSION = 1;
const GATEWAY_OPERATION_LEDGER_SCHEMA_VERSION = 2;
const MINIMUM_SESSION_KERNEL_SCHEMA_VERSION = 32;

export type AgentHostRouteMode = "legacy" | "agent_host_only";

export interface AgentHostReadinessObservations {
  readonly nowMs: number;
  /** Last clock value retained by the observer, including failed checks. */
  readonly previousObservedAtMs: number;
  readonly serviceUids: Readonly<{
    gateway: number;
    host: number;
    executor: number;
    sessionKernel: number;
  }>;
  readonly unixPeerUids: Readonly<{
    gatewaySeenByHost: number;
    hostSeenByGateway: number;
    hostSeenByExecutor: number;
    executorSeenByHost: number;
  }>;
  readonly activeGeneration: Readonly<{
    manifestDigest: string;
    protocolDigest: string;
    releaseDigest: string;
    keyringDigest: string;
    digestsMatchManifest: boolean;
    activatedAtMs: number;
    deadlineMs: number;
  }>;
  readonly signingPublicKey: Readonly<{
    verifiedByActiveKeyring: boolean;
    notBeforeMs: number;
    notAfterMs: number;
  }>;
  readonly encryptionKeyAvailable: boolean;
  readonly hostLedger: Readonly<{
    schemaVersion: number;
    recoveryComplete: boolean;
  }>;
  readonly gatewayOperationLedger: Readonly<{
    schemaVersion: number;
    recoverActiveComplete: boolean;
  }>;
  readonly sessionKernel: Readonly<{
    schemaVersion: number;
    cancellationAvailable: boolean;
  }>;
  readonly routeMode: unknown;
  readonly host: Readonly<{
    active: boolean;
    healthy: boolean;
    admission: "active" | "draining_only" | "none";
  }>;
  readonly boundedRegistries: Readonly<{
    gatewayGrants: boolean;
    gatewayOperations: boolean;
    hostTurns: boolean;
    hostOperations: boolean;
    hostStreams: boolean;
  }>;
  readonly infrastructureFallback: unknown;
  readonly capabilities: Readonly<{
    deletion: boolean;
    recovery: boolean;
    streamAck: boolean;
  }>;
}

export type AgentHostReadinessCheckCode =
  | "clock_rollback"
  | "gateway_uid_not_distinct_non_root"
  | "host_uid_not_distinct_non_root"
  | "executor_uid_not_distinct_non_root"
  | "session_kernel_uid_not_distinct_non_root"
  | "service_uids_not_distinct"
  | "gateway_host_peer_uid_mismatch"
  | "host_gateway_peer_uid_mismatch"
  | "host_executor_peer_uid_mismatch"
  | "executor_host_peer_uid_mismatch"
  | "generation_manifest_digest_invalid"
  | "generation_protocol_digest_invalid"
  | "generation_release_digest_invalid"
  | "generation_keyring_digest_invalid"
  | "generation_digest_mismatch"
  | "generation_activation_in_future"
  | "generation_deadline_invalid"
  | "generation_stale"
  | "signing_public_key_not_in_active_keyring"
  | "signing_public_key_window_invalid"
  | "signing_public_key_not_current"
  | "encryption_key_unavailable"
  | "host_ledger_schema_incompatible"
  | "host_ledger_recovery_incomplete"
  | "gateway_operation_ledger_schema_incompatible"
  | "gateway_operation_recovery_incomplete"
  | "session_kernel_schema_incompatible"
  | "session_kernel_cancellation_unavailable"
  | "route_mode_invalid"
  | "agent_host_inactive"
  | "agent_host_unhealthy"
  | "agent_host_admission_draining_only"
  | "gateway_grant_registry_unbounded"
  | "gateway_operation_registry_unbounded"
  | "host_turn_registry_unbounded"
  | "host_operation_registry_unbounded"
  | "host_stream_registry_unbounded"
  | "infrastructure_fallback_enabled"
  | "deletion_capability_unavailable"
  | "recovery_capability_unavailable"
  | "stream_ack_capability_unavailable";

export interface AgentHostReadinessHealth {
  readonly contractVersion: 1;
  readonly ready: boolean;
  readonly admission: "allow" | "block";
  readonly routeMode: AgentHostRouteMode | "invalid";
  /** Fixed-vocabulary, duplicate-free, and capped by the contract's check count. */
  readonly failingChecks: readonly AgentHostReadinessCheckCode[];
  readonly capabilities: Readonly<{
    deletion: boolean;
    recovery: boolean;
    streamAck: boolean;
  }>;
}

/**
 * Pure readiness/doctor policy over already-collected observations. It performs
 * no I/O and deliberately returns no observed values, paths, key material,
 * policy handles, or registry contents.
 */
export function checkAgentHostReadiness(
  observations: Readonly<AgentHostReadinessObservations>,
): AgentHostReadinessHealth {
  const failures: AgentHostReadinessCheckCode[] = [];
  const require = (condition: boolean, code: AgentHostReadinessCheckCode) => {
    if (!condition) failures.push(code);
  };
  const { serviceUids: uids, unixPeerUids: peers } = observations;
  const now = observations.nowMs;
  const generation = observations.activeGeneration;
  const signingKey = observations.signingPublicKey;
  const validNow = exactTime(now);

  require(
    validNow &&
      exactTime(observations.previousObservedAtMs) &&
      now >= observations.previousObservedAtMs,
    "clock_rollback",
  );
  require(validUid(uids.gateway), "gateway_uid_not_distinct_non_root");
  require(validUid(uids.host), "host_uid_not_distinct_non_root");
  require(validUid(uids.executor), "executor_uid_not_distinct_non_root");
  require(
    validUid(uids.sessionKernel),
    "session_kernel_uid_not_distinct_non_root",
  );
  require(
    new Set([uids.gateway, uids.host, uids.executor, uids.sessionKernel]).size ===
      4,
    "service_uids_not_distinct",
  );

  require(peers.hostSeenByGateway === uids.host, "gateway_host_peer_uid_mismatch");
  require(peers.gatewaySeenByHost === uids.gateway, "host_gateway_peer_uid_mismatch");
  require(peers.executorSeenByHost === uids.executor, "host_executor_peer_uid_mismatch");
  require(peers.hostSeenByExecutor === uids.host, "executor_host_peer_uid_mismatch");

  require(DIGEST.test(generation.manifestDigest), "generation_manifest_digest_invalid");
  require(DIGEST.test(generation.protocolDigest), "generation_protocol_digest_invalid");
  require(DIGEST.test(generation.releaseDigest), "generation_release_digest_invalid");
  require(DIGEST.test(generation.keyringDigest), "generation_keyring_digest_invalid");
  require(generation.digestsMatchManifest === true, "generation_digest_mismatch");
  require(
    validNow && exactTime(generation.activatedAtMs) && generation.activatedAtMs <= now,
    "generation_activation_in_future",
  );
  const generationDeadlineValid =
    exactTime(generation.activatedAtMs) &&
    exactTime(generation.deadlineMs) &&
    generation.deadlineMs > generation.activatedAtMs &&
    generation.deadlineMs - generation.activatedAtMs <=
      MAX_GENERATION_LIFETIME_MS;
  require(generationDeadlineValid, "generation_deadline_invalid");
  require(
    !generationDeadlineValid || (validNow && now < generation.deadlineMs),
    "generation_stale",
  );

  require(
    signingKey.verifiedByActiveKeyring === true,
    "signing_public_key_not_in_active_keyring",
  );
  const signingKeyWindowValid =
    exactTime(signingKey.notBeforeMs) &&
    exactTime(signingKey.notAfterMs) &&
    signingKey.notAfterMs > signingKey.notBeforeMs;
  require(signingKeyWindowValid, "signing_public_key_window_invalid");
  require(
    !signingKeyWindowValid ||
      (validNow && signingKey.notBeforeMs <= now && now < signingKey.notAfterMs),
    "signing_public_key_not_current",
  );
  require(observations.encryptionKeyAvailable === true, "encryption_key_unavailable");

  require(
    observations.hostLedger.schemaVersion === HOST_LEDGER_SCHEMA_VERSION,
    "host_ledger_schema_incompatible",
  );
  require(observations.hostLedger.recoveryComplete === true, "host_ledger_recovery_incomplete");
  require(
    observations.gatewayOperationLedger.schemaVersion ===
      GATEWAY_OPERATION_LEDGER_SCHEMA_VERSION,
    "gateway_operation_ledger_schema_incompatible",
  );
  require(
    observations.gatewayOperationLedger.recoverActiveComplete === true,
    "gateway_operation_recovery_incomplete",
  );
  require(
    Number.isSafeInteger(observations.sessionKernel.schemaVersion) &&
      observations.sessionKernel.schemaVersion >=
        MINIMUM_SESSION_KERNEL_SCHEMA_VERSION,
    "session_kernel_schema_incompatible",
  );
  require(
    observations.sessionKernel.cancellationAvailable === true,
    "session_kernel_cancellation_unavailable",
  );

  const routeMode =
    observations.routeMode === "legacy" ||
    observations.routeMode === "agent_host_only"
      ? observations.routeMode
      : "invalid";
  require(routeMode !== "invalid", "route_mode_invalid");
  if (routeMode === "agent_host_only") {
    require(observations.host.active === true, "agent_host_inactive");
    require(observations.host.healthy === true, "agent_host_unhealthy");
    require(
      observations.host.admission === "active",
      "agent_host_admission_draining_only",
    );
    require(
      observations.boundedRegistries.gatewayGrants === true,
      "gateway_grant_registry_unbounded",
    );
    require(
      observations.boundedRegistries.gatewayOperations === true,
      "gateway_operation_registry_unbounded",
    );
    require(
      observations.boundedRegistries.hostTurns === true,
      "host_turn_registry_unbounded",
    );
    require(
      observations.boundedRegistries.hostOperations === true,
      "host_operation_registry_unbounded",
    );
    require(
      observations.boundedRegistries.hostStreams === true,
      "host_stream_registry_unbounded",
    );
    require(
      observations.infrastructureFallback === false,
      "infrastructure_fallback_enabled",
    );
  }

  const capabilities = Object.freeze({
    deletion: observations.capabilities.deletion === true,
    recovery: observations.capabilities.recovery === true,
    streamAck: observations.capabilities.streamAck === true,
  });
  require(capabilities.deletion, "deletion_capability_unavailable");
  require(capabilities.recovery, "recovery_capability_unavailable");
  require(capabilities.streamAck, "stream_ack_capability_unavailable");

  const ready = failures.length === 0;
  return Object.freeze({
    contractVersion: 1,
    ready,
    admission: ready ? "allow" : "block",
    routeMode,
    failingChecks: Object.freeze(failures),
    capabilities,
  });
}

function validUid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function exactTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
