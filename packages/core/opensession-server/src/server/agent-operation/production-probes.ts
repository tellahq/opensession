import type { AgentHostReadinessObservations } from "./readiness";
import type {
  AgentHostReadinessClockStore,
  AgentHostReadinessCollectorDependencies,
} from "./readiness-collector";
import { decodeLinuxUcred } from "../security/transport/linux-peer-credentials";
import type { ProductionSessionKernelReadinessFacade } from "./session-kernel-readiness";

type MaybePromise<T> = T | Promise<T>;
type Read<T> = (signal: AbortSignal) => MaybePromise<T>;

export interface ProductionServiceUidOwner {
  currentProcessUid(signal: AbortSignal): MaybePromise<number>;
  exactServiceUids(signal: AbortSignal): MaybePromise<Readonly<{
    gateway: number;
    executor: number;
    sessionKernel: number;
  }>>;
}

/** Accepted AF_UNIX descriptors. The owner keeps descriptor lifetime ownership. */
export interface ProductionPeerCredentialDescriptors {
  readonly gatewaySeenByHost: number;
  readonly hostSeenByGateway: number;
  readonly hostSeenByExecutor: number;
  readonly executorSeenByHost: number;
}

export interface ProductionLinuxPeerCredentialRead {
  readonly bytes: Uint8Array;
  readonly returnedLength: number;
  readonly unixDomain: boolean;
}

/** Narrow getsockopt(SO_PEERCRED) owner over inherited descriptors. */
export interface ProductionLinuxPeerCredentialReader {
  read(fd: number, signal: AbortSignal): MaybePromise<ProductionLinuxPeerCredentialRead>;
}

export interface ProductionGenerationProofOwner {
  activeManifest: Read<AgentHostReadinessObservations["activeGeneration"]>;
  activeSigningKey: Read<AgentHostReadinessObservations["signingPublicKey"]>;
  encryptionKeyAvailable: Read<boolean>;
}

export interface ProductionLedgerReadinessOwner<T> {
  readiness(signal: AbortSignal): MaybePromise<T>;
}

export type { ProductionSessionKernelReadinessFacade } from "./session-kernel-readiness";

export interface ProductionRegistryCapacity {
  readonly size: number;
  readonly capacity: number;
}

export interface ProductionRegistryCapacityFacade {
  capacities(signal: AbortSignal): MaybePromise<Readonly<{
    gatewayGrants: ProductionRegistryCapacity;
    gatewayOperations: ProductionRegistryCapacity;
    hostTurns: ProductionRegistryCapacity;
    hostOperations: ProductionRegistryCapacity;
    hostStreams: ProductionRegistryCapacity;
  }>>;
}

export interface ProductionExternalRouteObservation {
  readonly routeMode: "legacy" | "agent_host_only";
  readonly infrastructureFallback: false;
}

/** Evidence read from the deployed router/control plane, not a component feed. */
export interface ProductionRouteReadinessFacade {
  externalObservation(signal: AbortSignal): MaybePromise<ProductionExternalRouteObservation>;
}

export interface ProductionAgentHostReadinessOwners {
  readonly now: () => number;
  readonly clockStore: AgentHostReadinessClockStore;
  readonly serviceUids: ProductionServiceUidOwner;
  readonly peerCredentials: Readonly<{
    reader: ProductionLinuxPeerCredentialReader;
    descriptors: ProductionPeerCredentialDescriptors;
  }>;
  readonly generation: ProductionGenerationProofOwner;
  readonly hostLedger: ProductionLedgerReadinessOwner<AgentHostReadinessObservations["hostLedger"]>;
  readonly gatewayOperationLedger: ProductionLedgerReadinessOwner<AgentHostReadinessObservations["gatewayOperationLedger"]>;
  readonly sessionKernel: ProductionSessionKernelReadinessFacade;
  readonly route: ProductionRouteReadinessFacade;
  readonly host: ProductionLedgerReadinessOwner<AgentHostReadinessObservations["host"]>;
  readonly registries: ProductionRegistryCapacityFacade;
  readonly capabilities: ProductionLedgerReadinessOwner<AgentHostReadinessObservations["capabilities"]>;
  readonly deadlineMs?: number;
}

function inheritedFd(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid inherited Unix socket descriptor");
  return value;
}

function boundedCapacity(value: ProductionRegistryCapacity): boolean {
  return !!value && Number.isSafeInteger(value.size) && value.size >= 0 &&
    Number.isSafeInteger(value.capacity) && value.capacity > 0 &&
    value.size <= value.capacity;
}

/**
 * Builds the still-unwired production collector dependencies. It performs no
 * work until collection invokes a probe, never owns/closes inherited FDs, and
 * returns only the readiness contract's closed proof shapes.
 */
export function createProductionAgentHostReadinessDependencies(
  owners: Readonly<ProductionAgentHostReadinessOwners>,
): AgentHostReadinessCollectorDependencies {
  const peerUid = async (fd: number, signal: AbortSignal): Promise<number> => {
    const proof = await owners.peerCredentials.reader.read(inheritedFd(fd), signal);
    if (proof.unixDomain !== true) throw new Error("Peer descriptor is not AF_UNIX");
    const credentials = decodeLinuxUcred(proof.bytes, proof.returnedLength);
    if (!Number.isSafeInteger(credentials.pid) || credentials.pid < 1)
      throw new Error("Kernel returned malformed peer credentials");
    return credentials.uid;
  };
  let routeObservation: Promise<ProductionExternalRouteObservation> | undefined;
  const observeRoute = (signal: AbortSignal) => {
    if (routeObservation) return routeObservation;
    const pending = Promise.resolve(owners.route.externalObservation(signal));
    routeObservation = pending;
    void pending.then(
      () => { if (routeObservation === pending) routeObservation = undefined; },
      () => { if (routeObservation === pending) routeObservation = undefined; },
    );
    return pending;
  };

  return Object.freeze({
    now: owners.now,
    clockStore: owners.clockStore,
    ...(owners.deadlineMs === undefined ? {} : { deadlineMs: owners.deadlineMs }),
    probes: Object.freeze({
      currentProcessUid: (signal: AbortSignal) => owners.serviceUids.currentProcessUid(signal),
      serviceUids: (signal: AbortSignal) => owners.serviceUids.exactServiceUids(signal),
      unixPeerUids: async (signal: AbortSignal) => {
        const descriptors = owners.peerCredentials.descriptors;
        const [gatewaySeenByHost, hostSeenByGateway, hostSeenByExecutor, executorSeenByHost] =
          await Promise.all([
            peerUid(descriptors.gatewaySeenByHost, signal),
            peerUid(descriptors.hostSeenByGateway, signal),
            peerUid(descriptors.hostSeenByExecutor, signal),
            peerUid(descriptors.executorSeenByHost, signal),
          ]);
        return Object.freeze({ gatewaySeenByHost, hostSeenByGateway, hostSeenByExecutor, executorSeenByHost });
      },
      activeGeneration: owners.generation.activeManifest,
      signingPublicKey: owners.generation.activeSigningKey,
      encryptionKeyAvailable: owners.generation.encryptionKeyAvailable,
      hostLedger: (signal: AbortSignal) => owners.hostLedger.readiness(signal),
      gatewayOperationLedger: (signal: AbortSignal) => owners.gatewayOperationLedger.readiness(signal),
      sessionKernel: (signal: AbortSignal) => owners.sessionKernel.readiness(signal),
      routeMode: async (signal: AbortSignal) => (await observeRoute(signal)).routeMode,
      host: (signal: AbortSignal) => owners.host.readiness(signal),
      boundedRegistries: async (signal: AbortSignal) => {
        const capacities = await owners.registries.capacities(signal);
        return Object.freeze({
          gatewayGrants: boundedCapacity(capacities.gatewayGrants),
          gatewayOperations: boundedCapacity(capacities.gatewayOperations),
          hostTurns: boundedCapacity(capacities.hostTurns),
          hostOperations: boundedCapacity(capacities.hostOperations),
          hostStreams: boundedCapacity(capacities.hostStreams),
        });
      },
      infrastructureFallback: async (signal: AbortSignal) =>
        (await observeRoute(signal)).infrastructureFallback,
      capabilities: (signal: AbortSignal) => owners.capabilities.readiness(signal),
    }),
  });
}
