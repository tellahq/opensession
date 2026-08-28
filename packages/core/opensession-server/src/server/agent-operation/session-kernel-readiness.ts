import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_TRANSPORT_VERSION,
} from "../session-kernel/actor-protocol";
import { SESSION_KERNEL_SCHEMA_VERSION } from "../session-kernel/store";

type MaybePromise<T> = T | Promise<T>;
type BoundedRead = (signal: AbortSignal) => MaybePromise<unknown>;

export interface ProductionSessionKernelReadinessFacade {
  readiness(signal: AbortSignal): MaybePromise<Readonly<{
    schemaVersion: number;
    cancellationAvailable: boolean;
  }>>;
}

export type SessionKernelSchema32CancellationCapability = Readonly<{
  schemaVersion: typeof SESSION_KERNEL_SCHEMA_VERSION;
  durableCancellation: true;
}>;

export interface SessionKernelReadinessOwners {
  /** Bounded projection of the SessionKernel GET /ready response. */
  readonly actorReady: BoundedRead;
  /** Bounded gateway-owned projection of SessionKernel stats. */
  readonly gatewayStats: BoundedRead;
  /** Typed proof that the exact schema-32 cancellation path is available. */
  readonly cancellation: BoundedRead;
  /** Bounded placement summary. It must not contain session ids or paths. */
  readonly actorTranscripts: BoundedRead;
  readonly deadlineMs?: number;
}

export type SessionKernelReadinessDiagnostic =
  | "actor_readiness_unavailable"
  | "actor_version_mismatch"
  | "transport_version_mismatch"
  | "no_ready_lane"
  | "lane_saturation_observed"
  | "lane_restart_observed"
  | "gateway_stats_unavailable"
  | "gateway_schema_mismatch"
  | "cancellation_proof_unavailable"
  | "actor_transcript_proof_unavailable"
  | "actor_transcript_migration_incomplete";

export interface SessionKernelReadinessResult {
  readonly schemaVersion: number;
  readonly cancellationAvailable: boolean;
  /** Fixed, duplicate-free vocabulary. No owner values are reflected here. */
  readonly diagnostics: readonly SessionKernelReadinessDiagnostic[];
}

type Lane = Readonly<{
  index: number;
  ready: boolean;
  restarting: boolean;
  queued: number;
  executing: number;
  turnsCompleted: number;
  queueWaitMsTotal: number;
  busyMsTotal: number;
  timeouts: number;
  restarts: number;
  rejectedFull: number;
  kernelStoreCacheMisses: number;
  kernelStoreCacheEvictions: number;
  transcriptStoreCacheMisses: number;
  transcriptStoreCacheEvictions: number;
  sqliteBusy: number;
}>;

type ActorReady = Readonly<{
  ready: boolean;
  actorVersion: number;
  transportVersion: number;
  workers: Readonly<{ ready: number; capacity: number }>;
  lanes: readonly Lane[];
}>;

type GatewayStats = Readonly<{ schemaVersion: number }>;
type CancellationProof = Readonly<{
  schemaVersion: number;
  durableCancellation: boolean;
}>;
type ActorTranscriptProof = Readonly<{
  placement: "actor";
  migrationComplete: boolean;
  pendingMigrations: number;
}>;

const MAX_DEADLINE_MS = 5_000;
const FAILED = Symbol("session-kernel-readiness-failed");
const LANE_KEYS = [
  "index", "ready", "restarting", "queued", "executing", "turnsCompleted",
  "queueWaitMsTotal", "busyMsTotal", "timeouts", "restarts", "rejectedFull",
  "kernelStoreCacheMisses", "kernelStoreCacheEvictions",
  "transcriptStoreCacheMisses", "transcriptStoreCacheEvictions", "sqliteBusy",
] as const;

/**
 * Builds the production-unwired SessionKernel readiness facade. All live I/O
 * stays with injected bounded owners. Imports and construction perform no I/O.
 */
export function createSessionKernelReadinessFacade(
  owners: Readonly<SessionKernelReadinessOwners>,
): Readonly<{
  readiness(signal: AbortSignal): Promise<SessionKernelReadinessResult>;
}> {
  return Object.freeze({
    async readiness(parentSignal: AbortSignal): Promise<SessionKernelReadinessResult> {
      const controller = new AbortController();
      const abort = () => controller.abort();
      parentSignal.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<typeof FAILED>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(FAILED);
        }, boundedDeadline(owners.deadlineMs));
      });
      const read = async (owner: BoundedRead): Promise<unknown | typeof FAILED> => {
        if (parentSignal.aborted) return FAILED;
        try {
          return await Promise.race([
            Promise.resolve().then(() => owner(controller.signal)),
            deadline,
          ]);
        } catch {
          return FAILED;
        }
      };

      const [actorRaw, statsRaw, cancellationRaw, transcriptsRaw] = await Promise.all([
        read(owners.actorReady),
        read(owners.gatewayStats),
        read(owners.cancellation),
        read(owners.actorTranscripts),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);

      const diagnostics: SessionKernelReadinessDiagnostic[] = [];
      const add = (code: SessionKernelReadinessDiagnostic) => {
        if (!diagnostics.includes(code)) diagnostics.push(code);
      };
      const actor = decodeActorReady(actorRaw);
      const stats = decodeGatewayStats(statsRaw);
      const cancellation = decodeCancellationProof(cancellationRaw);
      const transcripts = decodeActorTranscriptProof(transcriptsRaw);

      let actorCompatible = true;
      if (!actor) {
        add("actor_readiness_unavailable");
        actorCompatible = false;
      } else {
        if (actor.actorVersion !== SESSION_KERNEL_ACTOR_VERSION) {
          add("actor_version_mismatch");
          actorCompatible = false;
        }
        if (actor.transportVersion !== SESSION_KERNEL_TRANSPORT_VERSION) {
          add("transport_version_mismatch");
          actorCompatible = false;
        }
        const sessionLanes = actor.lanes.filter((lane) => lane.index !== 0);
        const readyLanes = sessionLanes.filter((lane) => lane.ready);
        const laneProof = actor.ready && actor.workers.ready >= 1 &&
          readyLanes.length >= 1 && actor.workers.ready === readyLanes.length &&
          actor.workers.capacity === sessionLanes.length;
        if (!laneProof) {
          add("no_ready_lane");
          actorCompatible = false;
        }
        if (actor.lanes.some((lane) => lane.queued > 0 || lane.rejectedFull > 0))
          add("lane_saturation_observed");
        if (actor.lanes.some((lane) => lane.restarting || lane.restarts > 0))
          add("lane_restart_observed");
      }

      let schemaCompatible = true;
      if (!stats) {
        add("gateway_stats_unavailable");
        schemaCompatible = false;
      } else if (stats.schemaVersion !== SESSION_KERNEL_SCHEMA_VERSION) {
        add("gateway_schema_mismatch");
        schemaCompatible = false;
      }

      const cancellationAvailable = !!cancellation &&
        cancellation.schemaVersion === SESSION_KERNEL_SCHEMA_VERSION &&
        cancellation.durableCancellation === true;
      if (!cancellationAvailable) add("cancellation_proof_unavailable");

      let transcriptComplete = true;
      if (!transcripts) {
        add("actor_transcript_proof_unavailable");
        transcriptComplete = false;
      } else if (!transcripts.migrationComplete || transcripts.pendingMigrations !== 0) {
        add("actor_transcript_migration_incomplete");
        transcriptComplete = false;
      }

      const ready = actorCompatible && schemaCompatible &&
        cancellationAvailable && transcriptComplete;
      return Object.freeze({
        schemaVersion: ready ? SESSION_KERNEL_SCHEMA_VERSION : 0,
        cancellationAvailable,
        diagnostics: Object.freeze(diagnostics),
      });
    },
  });
}

function decodeActorReady(value: unknown): ActorReady | undefined {
  const object = exactRecord(value, [
    "ready", "actorVersion", "transportVersion", "workers", "lanes",
  ]);
  if (!object || typeof object.ready !== "boolean" ||
      !nonnegativeInteger(object.actorVersion) ||
      !nonnegativeInteger(object.transportVersion) || !Array.isArray(object.lanes))
    return;
  const workers = exactRecord(object.workers, ["ready", "capacity"]);
  if (!workers || !nonnegativeInteger(workers.ready) ||
      !nonnegativeInteger(workers.capacity) || workers.ready > workers.capacity)
    return;
  const lanes: Lane[] = [];
  const indexes = new Set<number>();
  for (const raw of object.lanes) {
    const lane = decodeLane(raw);
    if (!lane || indexes.has(lane.index)) return;
    indexes.add(lane.index);
    lanes.push(lane);
  }
  if (!indexes.has(0)) return;
  return Object.freeze({
    ready: object.ready,
    actorVersion: object.actorVersion,
    transportVersion: object.transportVersion,
    workers: Object.freeze({ ready: workers.ready, capacity: workers.capacity }),
    lanes: Object.freeze(lanes),
  });
}

function decodeLane(value: unknown): Lane | undefined {
  const object = exactRecord(value, LANE_KEYS);
  if (!object || typeof object.ready !== "boolean" ||
      typeof object.restarting !== "boolean") return;
  for (const key of LANE_KEYS) {
    if (key === "ready" || key === "restarting") continue;
    if (!nonnegativeInteger(object[key])) return;
  }
  return Object.freeze(object as Lane);
}

function decodeGatewayStats(value: unknown): GatewayStats | undefined {
  const object = exactRecord(value, ["schemaVersion"]);
  return object && nonnegativeInteger(object.schemaVersion)
    ? Object.freeze({ schemaVersion: object.schemaVersion })
    : undefined;
}

function decodeCancellationProof(value: unknown): CancellationProof | undefined {
  const object = exactRecord(value, ["schemaVersion", "durableCancellation"]);
  return object && nonnegativeInteger(object.schemaVersion) &&
    typeof object.durableCancellation === "boolean"
    ? Object.freeze({
        schemaVersion: object.schemaVersion,
        durableCancellation: object.durableCancellation,
      })
    : undefined;
}

function decodeActorTranscriptProof(value: unknown): ActorTranscriptProof | undefined {
  const object = exactRecord(value, [
    "placement", "migrationComplete", "pendingMigrations",
  ]);
  return object && object.placement === "actor" &&
    typeof object.migrationComplete === "boolean" &&
    nonnegativeInteger(object.pendingMigrations)
    ? Object.freeze({
        placement: "actor",
        migrationComplete: object.migrationComplete,
        pendingMigrations: object.pendingMigrations,
      })
    : undefined;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    return;
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) return;
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function boundedDeadline(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1_000;
  return Math.min(MAX_DEADLINE_MS, Math.max(1, Math.trunc(value!)));
}
