import type { AgentHostReadinessObservations } from "./readiness";

type MaybePromise<T> = T | Promise<T>;
type Probe<T> = (signal: AbortSignal) => MaybePromise<T>;

type ServiceUidProofs = Readonly<{
  gateway: number;
  executor: number;
  sessionKernel: number;
}>;

export interface AgentHostReadinessClockStore {
  /** Returns the greatest wall-clock observation durably retained so far. */
  load(signal: AbortSignal): MaybePromise<number | undefined>;
  /** Atomically retains at least this value; implementations must never lower it. */
  retainAtLeast(observedAtMs: number, signal: AbortSignal): MaybePromise<void>;
}

export interface AgentHostReadinessCollectorDependencies {
  readonly now: () => number;
  readonly clockStore: AgentHostReadinessClockStore;
  readonly probes: Readonly<{
    currentProcessUid: Probe<number>;
    serviceUids: Probe<ServiceUidProofs>;
    unixPeerUids: Probe<AgentHostReadinessObservations["unixPeerUids"]>;
    activeGeneration: Probe<AgentHostReadinessObservations["activeGeneration"]>;
    signingPublicKey: Probe<AgentHostReadinessObservations["signingPublicKey"]>;
    encryptionKeyAvailable: Probe<boolean>;
    hostLedger: Probe<AgentHostReadinessObservations["hostLedger"]>;
    gatewayOperationLedger: Probe<AgentHostReadinessObservations["gatewayOperationLedger"]>;
    sessionKernel: Probe<AgentHostReadinessObservations["sessionKernel"]>;
    routeMode: Probe<unknown>;
    host: Probe<AgentHostReadinessObservations["host"]>;
    boundedRegistries: Probe<AgentHostReadinessObservations["boundedRegistries"]>;
    infrastructureFallback: Probe<unknown>;
    capabilities: Probe<AgentHostReadinessObservations["capabilities"]>;
  }>;
  /** One deadline shared by all parallel probes. Clamped to 1..5000ms. */
  readonly deadlineMs?: number;
}

const FAILED = Symbol("agent-host-readiness-probe-failed");
const MAX_DEADLINE_MS = 5_000;

/**
 * Production-unwired observation collection for the detached Agent Host.
 * Every live read is injected. The returned value is a closed, redacted shape
 * suitable for checkAgentHostReadiness; probe errors never escape it.
 */
export async function collectAgentHostReadinessObservations(
  dependencies: Readonly<AgentHostReadinessCollectorDependencies>,
): Promise<AgentHostReadinessObservations> {
  const controller = new AbortController();
  const deadlineMs = boundedDeadline(dependencies.deadlineMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof FAILED>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(FAILED);
    }, deadlineMs);
  });
  const signal = controller.signal;
  const run = async <T>(probe: Probe<T>): Promise<T | typeof FAILED> => {
    try {
      return await Promise.race([
        Promise.resolve().then(() => probe(signal)),
        deadline,
      ]);
    } catch {
      return FAILED;
    }
  };

  let nowMs: number;
  try {
    nowMs = dependencies.now();
  } catch {
    nowMs = -1;
  }

  const clockProbe: Probe<number> = async (clockSignal) => {
    const stored = await dependencies.clockStore.load(clockSignal);
    const previous = stored === undefined ? nowMs : stored;
    const retained = validTime(previous)
      ? validTime(nowMs)
        ? Math.max(previous, nowMs)
        : previous
      : validTime(nowMs)
        ? nowMs
        : 0;
    await dependencies.clockStore.retainAtLeast(retained, clockSignal);
    if (!validTime(previous)) throw new Error("invalid retained clock observation");
    return previous;
  };

  const [
    previousObservedAtMs,
    hostUid,
    serviceUids,
    unixPeerUids,
    activeGeneration,
    signingPublicKey,
    encryptionKeyAvailable,
    hostLedger,
    gatewayOperationLedger,
    sessionKernel,
    routeMode,
    host,
    boundedRegistries,
    infrastructureFallback,
    capabilities,
  ] = await Promise.all([
    run(clockProbe),
    run(dependencies.probes.currentProcessUid),
    run(dependencies.probes.serviceUids),
    run(dependencies.probes.unixPeerUids),
    run(dependencies.probes.activeGeneration),
    run(dependencies.probes.signingPublicKey),
    run(dependencies.probes.encryptionKeyAvailable),
    run(dependencies.probes.hostLedger),
    run(dependencies.probes.gatewayOperationLedger),
    run(dependencies.probes.sessionKernel),
    run(dependencies.probes.routeMode),
    run(dependencies.probes.host),
    run(dependencies.probes.boundedRegistries),
    run(dependencies.probes.infrastructureFallback),
    run(dependencies.probes.capabilities),
  ]);
  if (timer !== undefined) clearTimeout(timer);

  return {
    nowMs,
    previousObservedAtMs:
      previousObservedAtMs === FAILED ? -1 : number(previousObservedAtMs, -1),
    serviceUids: {
      gateway: fieldNumber(serviceUids, "gateway", 0),
      host: hostUid === FAILED ? 0 : number(hostUid, 0),
      executor: fieldNumber(serviceUids, "executor", 0),
      sessionKernel: fieldNumber(serviceUids, "sessionKernel", 0),
    },
    unixPeerUids: {
      gatewaySeenByHost: fieldNumber(unixPeerUids, "gatewaySeenByHost", 0),
      hostSeenByGateway: fieldNumber(unixPeerUids, "hostSeenByGateway", 0),
      hostSeenByExecutor: fieldNumber(unixPeerUids, "hostSeenByExecutor", 0),
      executorSeenByHost: fieldNumber(unixPeerUids, "executorSeenByHost", 0),
    },
    activeGeneration: {
      manifestDigest: fieldString(activeGeneration, "manifestDigest", ""),
      protocolDigest: fieldString(activeGeneration, "protocolDigest", ""),
      releaseDigest: fieldString(activeGeneration, "releaseDigest", ""),
      keyringDigest: fieldString(activeGeneration, "keyringDigest", ""),
      digestsMatchManifest: fieldBoolean(activeGeneration, "digestsMatchManifest", false),
      activatedAtMs: fieldNumber(activeGeneration, "activatedAtMs", -1),
      deadlineMs: fieldNumber(activeGeneration, "deadlineMs", -1),
    },
    signingPublicKey: {
      verifiedByActiveKeyring: fieldBoolean(signingPublicKey, "verifiedByActiveKeyring", false),
      notBeforeMs: fieldNumber(signingPublicKey, "notBeforeMs", -1),
      notAfterMs: fieldNumber(signingPublicKey, "notAfterMs", -1),
    },
    encryptionKeyAvailable:
      encryptionKeyAvailable === FAILED ? false : encryptionKeyAvailable === true,
    hostLedger: {
      schemaVersion: fieldNumber(hostLedger, "schemaVersion", 0),
      recoveryComplete: fieldBoolean(hostLedger, "recoveryComplete", false),
    },
    gatewayOperationLedger: {
      schemaVersion: fieldNumber(gatewayOperationLedger, "schemaVersion", 0),
      recoverActiveComplete: fieldBoolean(gatewayOperationLedger, "recoverActiveComplete", false),
    },
    sessionKernel: {
      schemaVersion: fieldNumber(sessionKernel, "schemaVersion", 0),
      cancellationAvailable: fieldBoolean(sessionKernel, "cancellationAvailable", false),
    },
    routeMode: routeMode === FAILED ? undefined : routeMode,
    host: {
      active: fieldBoolean(host, "active", false),
      healthy: fieldBoolean(host, "healthy", false),
      admission: fieldAdmission(host, "admission"),
    },
    boundedRegistries: {
      gatewayGrants: fieldBoolean(boundedRegistries, "gatewayGrants", false),
      gatewayOperations: fieldBoolean(boundedRegistries, "gatewayOperations", false),
      hostTurns: fieldBoolean(boundedRegistries, "hostTurns", false),
      hostOperations: fieldBoolean(boundedRegistries, "hostOperations", false),
      hostStreams: fieldBoolean(boundedRegistries, "hostStreams", false),
    },
    infrastructureFallback:
      infrastructureFallback === FAILED ? true : infrastructureFallback,
    capabilities: {
      deletion: fieldBoolean(capabilities, "deletion", false),
      recovery: fieldBoolean(capabilities, "recovery", false),
      streamAck: fieldBoolean(capabilities, "streamAck", false),
    },
  };
}

function boundedDeadline(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1_000;
  return Math.min(MAX_DEADLINE_MS, Math.max(1, Math.trunc(value!)));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== FAILED && typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function fieldNumber(value: unknown, key: string, fallback: number): number {
  return number(record(value)?.[key], fallback);
}

function fieldString(value: unknown, key: string, fallback: string): string {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" ? candidate : fallback;
}

function fieldBoolean(value: unknown, key: string, fallback: boolean): boolean {
  const candidate = record(value)?.[key];
  return typeof candidate === "boolean" ? candidate : fallback;
}

function fieldAdmission(value: unknown, key: string): "active" | "draining_only" | "none" {
  const candidate = record(value)?.[key];
  return candidate === "active" || candidate === "draining_only" || candidate === "none"
    ? candidate
    : "none";
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
