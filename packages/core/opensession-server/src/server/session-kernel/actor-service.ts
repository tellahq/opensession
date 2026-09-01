import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_REQUEST_BYTES,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  SESSION_KERNEL_MAX_TRANSPORT_REQUESTS,
  SESSION_KERNEL_TRANSPORT_VERSION,
  isCriticalSettlementCommand,
  type KernelActorServiceCall,
  type KernelActorResponse,
  type KernelActorTransportEnvelope,
} from "./actor-protocol";
import {
  isReadReducer,
  isPrioritySessionActorRequest,
  sessionActorServiceRoute,
} from "./actor-routing";
import { READ_METHODS } from "./store-routing";
import { workerEntry } from "../../runner-host/exe";
import { chooseSessionLane, type LaneLoad } from "./lane-placement";
import type { SessionKernelStoreHostMetrics } from "./store-host";
import { runtimeGeneration } from "../runtime-generation";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3849;
const RUNTIME_GENERATION = runtimeGeneration();
// Must remain below the gateway transport's 8s fail-stop budget, including
// quarantine/restart bookkeeping after an ambiguous lane turn.
const ACTOR_RESPONSE_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_WORKERS = Math.min(
  32,
  Math.max(4, availableParallelism()),
);
// Mailboxes absorb short ingress bursts; actor turns must still remain bounded
// and fast. Control traffic has its own reserved class so stop/steer cannot be
// stranded behind ordinary projections. Operators may tune these independently
// without rebuilding the service.
const DEFAULT_MUTATION_SESSION_TURNS = 64;
const DEFAULT_READ_SESSION_TURNS = 128;
const DEFAULT_PRIORITY_SESSION_TURNS = 32;
const MAX_PRIORITY_BURST = 4;
const MAX_GLOBAL_TURNS = 64;
const GLOBAL_BARRIER_TIMEOUT_MS = 100;
const RESERVED_PRIORITY_TURNS = 64;
const DEFAULT_LANE_QUEUE = 64;
const RESERVED_LANE_PRIORITY_TURNS = 4;

class RetryableActorHostError extends Error {
  readonly retryable = true;
}

type Pending = {
  resolve: (response: KernelActorResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  originalRpcId: string;
  request: KernelActorTransportEnvelope["request"];
  readOnly: boolean;
  criticalSessionId?: string;
  /** When the turn started executing on the worker (lane busy-time metric). */
  startedAt: number;
};

type RuntimeWorkRequest = {
  t: "runtime_work";
  rpcId: string;
  now: number;
  timerKinds: string[];
  effectKinds: string[];
  limit: number;
  additionalOutboxGroups?: Array<{ effectKinds: string[]; limit: number }>;
  activeOutbox?: Array<{ id: number; sessionId: string }>;
  activeOutboxRecheckAt?: number;
};

type SlotTurn = {
  request: KernelActorTransportEnvelope["request"];
  allowUnready: boolean;
  priority: boolean;
  enqueuedAt: number;
  resolve: (response: KernelActorResponse) => void;
  reject: (error: Error) => void;
};

/** Cumulative per-lane counters. Monotonic for the service lifetime — they
 * deliberately survive lane restarts so operators can see instability. */
type LaneMetrics = {
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
};

const EMPTY_WORKER_METRICS: SessionKernelStoreHostMetrics = {
  kernelStoreCacheMisses: 0,
  kernelStoreCacheEvictions: 0,
  transcriptStoreCacheMisses: 0,
  transcriptStoreCacheEvictions: 0,
  sqliteBusy: 0,
};

type KernelActorWorkerResponse = KernelActorResponse & {
  workerMetrics?: SessionKernelStoreHostMetrics;
};

type WorkerSlot = {
  index: number;
  generation: number;
  pending: Map<string, Pending>;
  queue: SlotTurn[];
  worker?: Worker;
  ready: boolean;
  restarting: boolean;
  priorityBurst: number;
  metrics: LaneMetrics;
  workerMetrics: SessionKernelStoreHostMetrics;
};

type QueuedSessionTurn = {
  request: KernelActorTransportEnvelope["request"];
  readOnly: boolean;
  barrier: number;
  gate: Promise<void>;
  resolve: (response: KernelActorResponse) => void;
  reject: (error: Error) => void;
  settled: () => void;
};

type SessionMailbox = {
  running: boolean;
  /** Chosen once when the mailbox activates and kept until it drains. */
  slot: WorkerSlot;
  normal: QueuedSessionTurn[];
  priority: QueuedSessionTurn[];
  priorityBurst: number;
  /** Only mutations participate in the next global compatibility barrier.
   * Read-only transcript/range turns are safe to overlap with catalog work;
   * making the barrier wait for them let a busy viewer stall every durable
   * timer and outbox effect in the service. */
  mutationTail: Promise<void>;
};

export type SessionKernelServiceOptions = {
  host?: string;
  port?: number;
  token?: string;
  workerUrl?: string | URL;
  /** Bounded session execution lanes. A separate catalog lane is always kept. */
  workerCount?: number;
  responseTimeoutMs?: number;
  /** Explicit isolated/dev database path inherited by Worker isolates. */
  databasePath?: string;
  mutationMailboxLimit?: number;
  readMailboxLimit?: number;
  priorityMailboxLimit?: number;
  laneQueueLimit?: number;
};

function mailboxLimit(
  explicit: number | undefined,
  envName: string,
  fallback: number,
): number {
  const value = explicit ?? Number(process.env[envName] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 4_096)
    throw new Error(`${envName} must be an integer between 1 and 4096`);
  return value;
}

export function sessionKernelServiceUrl(): string {
  const value =
    process.env.OPENSESSION_SESSION_KERNEL_URL ??
    `http://${process.env.OPENSESSION_SESSION_KERNEL_HOST ?? DEFAULT_HOST}:${process.env.OPENSESSION_SESSION_KERNEL_PORT ?? DEFAULT_PORT}`;
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== DEFAULT_HOST)
    throw new Error("Session kernel service URL must use HTTP on 127.0.0.1");
  return url.origin;
}

export async function readSessionKernelCredential(): Promise<string> {
  const inline = process.env.OPENSESSION_SESSION_KERNEL_TOKEN?.trim();
  if (inline) return inline;
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
  const credentialFile = credentialDirectory
    ? `${credentialDirectory}/session-kernel-token`
    : process.env.OPENSESSION_SESSION_KERNEL_TOKEN_FILE;
  if (credentialFile) {
    const value = (await readFile(credentialFile, "utf8")).trim();
    if (value) return value;
  }
  throw new Error("Session kernel service credential is unavailable");
}

function authorized(actual: string | null, token: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(actual.slice(7));
  const expected = Buffer.from(token);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, {
    ...init,
    headers: { "cache-control": "no-store", ...init.headers },
  });
}

function actorFatal(response: KernelActorResponse): boolean {
  if (response.t === "error") return response.fatal === true;
  if (response.t !== "call_result" || !response.body) return false;
  try {
    return (
      (JSON.parse(response.body) as { code?: string }).code === "actor_fatal"
    );
  } catch {
    return false;
  }
}

export async function startSessionKernelService(
  options: SessionKernelServiceOptions = {},
): Promise<{
  stop(options?: { terminateWorkers?: boolean }): void;
  url: string;
}> {
  const host =
    options.host ?? process.env.OPENSESSION_SESSION_KERNEL_HOST ?? DEFAULT_HOST;
  const port =
    options.port ??
    Number(process.env.OPENSESSION_SESSION_KERNEL_PORT ?? DEFAULT_PORT);
  if (host !== DEFAULT_HOST)
    throw new Error("Session kernel service must bind to 127.0.0.1");
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("Invalid session kernel service port");
  const token = options.token ?? (await readSessionKernelCredential());
  const configuredWorkers =
    options.workerCount ??
    Number(
      process.env.OPENSESSION_SESSION_KERNEL_WORKERS ?? DEFAULT_SESSION_WORKERS,
    );
  if (
    !Number.isInteger(configuredWorkers) ||
    configuredWorkers < 1 ||
    configuredWorkers > 32
  )
    throw new Error("Session kernel worker count must be between 1 and 32");
  const responseTimeoutMs =
    options.responseTimeoutMs ?? ACTOR_RESPONSE_TIMEOUT_MS;
  if (!Number.isFinite(responseTimeoutMs) || responseTimeoutMs < 100)
    throw new Error("Invalid session kernel worker timeout");
  const mutationMailboxLimit = mailboxLimit(
    options.mutationMailboxLimit,
    "OPENSESSION_SESSION_KERNEL_MUTATION_MAILBOX",
    DEFAULT_MUTATION_SESSION_TURNS,
  );
  const readMailboxLimit = mailboxLimit(
    options.readMailboxLimit,
    "OPENSESSION_SESSION_KERNEL_READ_MAILBOX",
    DEFAULT_READ_SESSION_TURNS,
  );
  const priorityMailboxLimit = mailboxLimit(
    options.priorityMailboxLimit,
    "OPENSESSION_SESSION_KERNEL_PRIORITY_MAILBOX",
    DEFAULT_PRIORITY_SESSION_TURNS,
  );
  const laneQueueLimit = mailboxLimit(
    options.laneQueueLimit,
    "OPENSESSION_SESSION_KERNEL_LANE_QUEUE",
    DEFAULT_LANE_QUEUE,
  );

  // Worker isolates in this independently supervised process share one writer
  // incarnation. The service mailbox scheduler, not a thread-local token, is
  // the authority that prevents concurrent turns for one session.
  process.env.OPENSESSION_SESSION_KERNEL_OWNER_ID ??= crypto.randomUUID();
  if (options.databasePath)
    process.env.OPENSESSION_SESSION_KERNEL_DB_PATH = options.databasePath;

  const workerUrl =
    options.workerUrl ??
    workerEntry(
      "session-kernel-worker.js",
      new URL("../../session-kernel-worker.ts", import.meta.url).href,
    );
  // Slot zero is reserved for catalog/global compatibility work. Remaining
  // slots are the bounded session execution pool.
  const slots: WorkerSlot[] = Array.from(
    { length: configuredWorkers + 1 },
    (_, index) => ({
      index,
      generation: 0,
      pending: new Map(),
      queue: [],
      ready: false,
      restarting: false,
      priorityBurst: 0,
      metrics: {
        turnsCompleted: 0,
        queueWaitMsTotal: 0,
        busyMsTotal: 0,
        timeouts: 0,
        restarts: 0,
        rejectedFull: 0,
        ...EMPTY_WORKER_METRICS,
      },
      workerMetrics: { ...EMPTY_WORKER_METRICS },
    }),
  );
  const sessionSlots = slots.slice(1);
  const sessionMailboxes = new Map<string, SessionMailbox>();
  let queuedSessionTurns = 0;
  let queuedGlobalTurns = 0;
  let admittedTransportRequests = 0;
  let barrierGeneration = 0;
  let globalGate = Promise.resolve();
  const serviceEpoch = crypto.randomUUID();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let serviceError: Error | undefined;
  let stopping = false;

  function pendingCount(): number {
    return slots.reduce(
      (total, slot) => total + slot.pending.size + slot.queue.length,
      0,
    );
  }

  function criticalSessionId(
    request: KernelActorTransportEnvelope["request"],
  ): string | undefined {
    if (
      request.t !== "call" ||
      request.request.t !== "reduce" ||
      !isCriticalSettlementCommand(request.request.command)
    )
      return undefined;
    const route = sessionActorServiceRoute(request);
    return route.scope === "session" ? route.sessionId : undefined;
  }

  function isReadOnlyRequest(
    request: KernelActorTransportEnvelope["request"],
  ): boolean {
    if (
      request.t === "hello" ||
      request.t === "stats" ||
      request.t === "runtime_catalog_work"
    )
      return true;
    if (request.t !== "call") return false;
    return request.request.t === "store"
      ? READ_METHODS.has(request.request.method)
      : isReadReducer(request.request.command);
  }

  function stopSlot(
    slot: WorkerSlot,
    error: Error,
    retainQueue = false,
  ): Pending[] {
    slot.ready = false;
    const worker = slot.worker;
    slot.worker = undefined;
    worker?.terminate();
    const active = [...slot.pending.values()];
    for (const entry of active) clearTimeout(entry.timer);
    slot.pending.clear();
    if (!retainQueue) {
      for (const entry of active) entry.reject(error);
      for (const turn of slot.queue.splice(0)) turn.reject(error);
    }
    return active;
  }

  function failService(error: Error): void {
    if (serviceError) return;
    serviceError = error;
    console.error("Session kernel actor service failed", error);
    for (const slot of slots) stopSlot(slot, error);
    server?.stop(true);
  }

  function sessionQuarantinedResponse(
    entry: Pending,
    sessionId: string,
    reason: string,
  ): KernelActorResponse {
    const body = JSON.stringify({
      ok: false,
      error: reason,
      code: "session_quarantined",
      sessionId,
    });
    return {
      t: "call_result",
      rpcId: entry.originalRpcId,
      status: -1,
      length: Buffer.byteLength(body),
      body,
    };
  }

  async function quarantineAmbiguousSession(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    const response = await sendToSlot(
      slots[0],
      {
        t: "call",
        rpcId: crypto.randomUUID(),
        outputBytes: 256 * 1024,
        request: {
          t: "store",
          method: "quarantineSession",
          args: [sessionId, reason, "actor_lane_ambiguity"],
        },
      },
      false,
      true,
    );
    if (response.t !== "call_result" || response.status !== 1 || !response.body)
      throw new Error(`Failed to quarantine ambiguous session ${sessionId}`);
    const body = JSON.parse(response.body) as { ok?: boolean };
    if (!body.ok)
      throw new Error(`Failed to quarantine ambiguous session ${sessionId}`);
  }

  function restartSessionSlot(
    slot: WorkerSlot,
    error: Error,
    generation: number,
  ): void {
    if (
      stopping ||
      serviceError ||
      generation !== slot.generation ||
      slot.restarting
    )
      return;
    const active = [...slot.pending.values()];
    const safeCatalogReadRestart =
      slot.index === 0 &&
      active.length > 0 &&
      active.every((entry) => entry.readOnly);
    // The catalog lane owns placement authority. An interrupted mutation can
    // make routing settlement ambiguous, so it must still fail-stop the
    // service. A timed-out read has no commit ambiguity and can be retried on a
    // fresh worker without changing the service epoch.
    if (slot.index === 0 && !safeCatalogReadRestart) {
      failService(error);
      return;
    }
    if (safeCatalogReadRestart)
      console.warn(
        "Restarting session kernel catalog lane after read failure",
        error,
      );
    slot.restarting = true;
    slot.metrics.restarts += 1;
    stopSlot(slot, error, true);
    void (async () => {
      const critical = active.filter((entry) => entry.criticalSessionId);
      const ordinary = active.filter((entry) => !entry.criticalSessionId);
      for (const entry of ordinary)
        entry.reject(new RetryableActorHostError(error.message));
      for (const sessionId of new Set(
        critical.map((entry) => entry.criticalSessionId!),
      ))
        await quarantineAmbiguousSession(sessionId, error.message);
      for (const entry of critical) {
        const sessionId = entry.criticalSessionId!;
        entry.resolve(
          sessionQuarantinedResponse(entry, sessionId, error.message),
        );
      }
      if (stopping || serviceError) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
      slot.restarting = false;
      await startSlot(slot);
      pumpSlot(slot);
    })().catch((restartError) => {
      failService(
        restartError instanceof Error
          ? restartError
          : new Error(String(restartError)),
      );
    });
  }

  function pumpSlot(slot: WorkerSlot): void {
    if (slot.pending.size > 0 || !slot.worker) return;
    let index = -1;
    if (!slot.ready) {
      // A restart handshake is an infrastructure prerequisite, not actor work.
      // It must bypass fairness state retained from the failed generation.
      index = slot.queue.findIndex((turn) => turn.allowUnready);
    } else {
      const priorityIndex = slot.queue.findIndex((turn) => turn.priority);
      const ordinaryIndex = slot.queue.findIndex((turn) => !turn.priority);
      if (
        priorityIndex >= 0 &&
        (ordinaryIndex < 0 || slot.priorityBurst < MAX_PRIORITY_BURST)
      ) {
        index = priorityIndex;
        slot.priorityBurst += 1;
      } else if (ordinaryIndex >= 0) {
        index = ordinaryIndex;
        slot.priorityBurst = 0;
      }
    }
    if (index < 0) return;
    const turn = slot.queue[index]!;
    slot.queue.splice(index, 1);
    const originalRpcId = turn.request.rpcId;
    const rpcId = crypto.randomUUID();
    const generation = slot.generation;
    const startedAt = Date.now();
    slot.metrics.queueWaitMsTotal += Math.max(0, startedAt - turn.enqueuedAt);
    const timer = setTimeout(() => {
      slot.metrics.timeouts += 1;
      const error = new Error(
        `Session actor lane ${slot.index} response timed out`,
      );
      restartSessionSlot(slot, error, generation);
    }, responseTimeoutMs);
    slot.pending.set(rpcId, {
      ...turn,
      timer,
      originalRpcId,
      request: turn.request,
      readOnly: isReadOnlyRequest(turn.request),
      criticalSessionId: criticalSessionId(turn.request),
      startedAt,
    });
    try {
      slot.worker.postMessage({ ...turn.request, rpcId });
    } catch (error) {
      restartSessionSlot(
        slot,
        error instanceof Error ? error : new Error(String(error)),
        generation,
      );
    }
  }

  function sendToSlot(
    slot: WorkerSlot,
    request: KernelActorTransportEnvelope["request"],
    allowUnready = false,
    urgent = false,
  ): Promise<KernelActorResponse> {
    if (serviceError) return Promise.reject(serviceError);
    if (((!slot.ready && !allowUnready) || !slot.worker) && !slot.restarting)
      return Promise.reject(
        new RetryableActorHostError("Session actor lane is unavailable"),
      );
    const priority = urgent || isPrioritySessionActorRequest(request);
    const ordinaryQueued = slot.queue.reduce(
      (count, turn) => count + (turn.priority ? 0 : 1),
      0,
    );
    if (
      pendingCount() >= SESSION_KERNEL_MAX_TRANSPORT_REQUESTS ||
      slot.queue.length >= laneQueueLimit ||
      (!priority &&
        ordinaryQueued >=
          laneQueueLimit -
            Math.min(
              RESERVED_LANE_PRIORITY_TURNS,
              Math.max(0, laneQueueLimit - 1),
            ))
    ) {
      slot.metrics.rejectedFull += 1;
      return Promise.reject(
        new RetryableActorHostError("Session actor lane is full"),
      );
    }
    return new Promise((resolve, reject) => {
      const turn = {
        request,
        allowUnready,
        priority,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      };
      if (urgent) slot.queue.unshift(turn);
      else slot.queue.push(turn);
      pumpSlot(slot);
    });
  }

  function collectWorkerMetrics(
    slot: WorkerSlot,
    current: SessionKernelStoreHostMetrics,
  ): void {
    for (const key of Object.keys(current) as Array<
      keyof SessionKernelStoreHostMetrics
    >) {
      const previous = slot.workerMetrics[key];
      slot.metrics[key] +=
        current[key] >= previous ? current[key] - previous : current[key];
    }
    slot.workerMetrics = current;
  }

  async function startSlot(slot: WorkerSlot): Promise<void> {
    slot.generation += 1;
    const generation = slot.generation;
    slot.workerMetrics = { ...EMPTY_WORKER_METRICS };
    const worker = new Worker(workerUrl, { type: "module" });
    slot.worker = worker;
    slot.ready = false;
    worker.addEventListener(
      "message",
      (event: MessageEvent<KernelActorWorkerResponse>) => {
        if (slot.worker !== worker || generation !== slot.generation) return;
        const { workerMetrics, ...actorResponse } = event.data;
        if (workerMetrics) collectWorkerMetrics(slot, workerMetrics);
        const response = actorResponse as KernelActorResponse;
        const entry = slot.pending.get(response.rpcId);
        if (!entry) return;
        slot.pending.delete(response.rpcId);
        clearTimeout(entry.timer);
        slot.metrics.turnsCompleted += 1;
        slot.metrics.busyMsTotal += Math.max(0, Date.now() - entry.startedAt);
        const restored = { ...response, rpcId: entry.originalRpcId };
        entry.resolve(restored);
        if (actorFatal(response))
          failService(
            new Error("Session kernel catalog authority became ambiguous"),
          );
        else pumpSlot(slot);
      },
    );
    worker.addEventListener("error", (event) =>
      restartSessionSlot(
        slot,
        new Error(`Session actor lane ${slot.index} failed: ${event.message}`),
        generation,
      ),
    );
    worker.addEventListener("messageerror", () =>
      restartSessionSlot(
        slot,
        new Error(
          `Session actor lane ${slot.index} emitted an invalid message`,
        ),
        generation,
      ),
    );
    (
      worker as Worker & {
        addEventListener(type: "close", listener: () => void): void;
      }
    ).addEventListener("close", () =>
      restartSessionSlot(
        slot,
        new Error(`Session actor lane ${slot.index} exited`),
        generation,
      ),
    );
    const hello = await sendToSlot(
      slot,
      {
        t: "hello",
        rpcId: crypto.randomUUID(),
        version: SESSION_KERNEL_ACTOR_VERSION,
      },
      true,
      true,
    );
    if (hello.t !== "ready" || hello.version !== SESSION_KERNEL_ACTOR_VERSION)
      throw new Error(`Session actor lane ${slot.index} handshake failed`);
    slot.ready = true;
  }

  function assignedSessionSlot(sessionId: string): WorkerSlot {
    // Placement is chosen only when a mailbox activates. The mailbox owns the
    // pin until it drains, so queued turns never migrate while a logical actor
    // is live. A later activation may choose the quieter rendezvous candidate.
    const loads: LaneLoad[] = sessionSlots.map((slot) => ({
      // A restarting lane retries quickly; weigh it as a full queue rather
      // than excluding it so both candidates stay usable.
      queued: slot.queue.length + (slot.ready ? 0 : laneQueueLimit),
      executing: slot.pending.size,
    }));
    return sessionSlots[chooseSessionLane(sessionId, loads)]!;
  }

  function pumpSessionMailbox(
    sessionId: string,
    mailbox: SessionMailbox,
  ): void {
    if (mailbox.running) return;
    const priority = mailbox.priority[0];
    const normal = mailbox.normal[0];
    const earliestBarrier = Math.min(
      priority?.barrier ?? Number.POSITIVE_INFINITY,
      normal?.barrier ?? Number.POSITIVE_INFINITY,
    );
    let turn: QueuedSessionTurn | undefined;
    if (
      priority?.barrier === earliestBarrier &&
      (normal?.barrier !== earliestBarrier ||
        mailbox.priorityBurst < MAX_PRIORITY_BURST)
    ) {
      turn = mailbox.priority.shift();
      mailbox.priorityBurst += 1;
    } else if (normal?.barrier === earliestBarrier) {
      turn = mailbox.normal.shift();
      mailbox.priorityBurst = 0;
    }
    if (!turn) {
      if (sessionMailboxes.get(sessionId) === mailbox)
        sessionMailboxes.delete(sessionId);
      return;
    }
    mailbox.running = true;
    void turn.gate
      .then(() => sendToSlot(mailbox.slot, turn.request))
      .then(turn.resolve, turn.reject)
      .finally(() => {
        queuedSessionTurns -= 1;
        mailbox.running = false;
        turn.settled();
        pumpSessionMailbox(sessionId, mailbox);
      });
  }

  function enqueueSession(
    sessionId: string,
    request: KernelActorTransportEnvelope["request"],
    mutation: boolean,
  ): Promise<KernelActorResponse> {
    let mailbox = sessionMailboxes.get(sessionId);
    if (!mailbox) {
      mailbox = {
        running: false,
        slot: assignedSessionSlot(sessionId),
        normal: [],
        priority: [],
        priorityBurst: 0,
        mutationTail: Promise.resolve(),
      };
      sessionMailboxes.set(sessionId, mailbox);
    }
    const priority = isPrioritySessionActorRequest(request);
    const readOnly = !mutation;
    const queuedForClass = priority
      ? mailbox.priority.length
      : mailbox.normal.reduce(
          (count, turn) => count + Number(turn.readOnly === readOnly),
          0,
        );
    const classLimit = priority
      ? priorityMailboxLimit
      : readOnly
        ? readMailboxLimit
        : mutationMailboxLimit;
    if (queuedForClass >= classLimit) {
      return Promise.reject(
        new RetryableActorHostError(
          priority
            ? "Session priority mailbox is full"
            : readOnly
              ? "Session read mailbox is full"
              : "Session mailbox is full",
        ),
      );
    }

    queuedSessionTurns += 1;
    let settleTail!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleTail = resolve;
    });
    if (mutation)
      mailbox.mutationTail = mailbox.mutationTail.then(() => settled);
    const response = new Promise<KernelActorResponse>((resolve, reject) => {
      const turn: QueuedSessionTurn = {
        request,
        readOnly,
        barrier: barrierGeneration,
        gate: globalGate,
        resolve,
        reject,
        settled: settleTail,
      };
      if (priority) mailbox!.priority.push(turn);
      else mailbox!.normal.push(turn);
    });
    pumpSessionMailbox(sessionId, mailbox);
    return response;
  }

  async function resolveOutboxSession(
    id: number,
    urgent = false,
  ): Promise<string> {
    const response = await sendToSlot(
      slots[0],
      {
        t: "call",
        rpcId: crypto.randomUUID(),
        outputBytes: 256 * 1024,
        request: { t: "store", method: "outboxSessionId", args: [id] },
      },
      false,
      urgent,
    );
    if (response.t !== "call_result" || response.status !== 1 || !response.body)
      throw new Error(`Outbox ${id} route could not be resolved`);
    const body = JSON.parse(response.body) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };
    if (!body.ok || typeof body.result !== "string" || !body.result)
      throw new Error(body.error ?? `Outbox ${id} has no session route`);
    return body.result;
  }

  async function runtimeWorkRequest(
    request: RuntimeWorkRequest,
  ): Promise<KernelActorResponse> {
    const catalog = await sendToSlot(slots[0], {
      ...request,
      t: "runtime_catalog_work",
      rpcId: crypto.randomUUID(),
    });
    if (catalog.t !== "runtime_catalog_work_result")
      throw new RetryableActorHostError(
        catalog.t === "error"
          ? catalog.error
          : "Invalid runtime catalog response",
      );

    const activeBySession = new Map<
      string,
      Array<{ id: number; sessionId: string }>
    >();
    for (const item of request.activeOutbox ?? []) {
      const active = activeBySession.get(item.sessionId) ?? [];
      active.push(item);
      activeBySession.set(item.sessionId, active);
    }
    const sessionResults = await Promise.all(
      catalog.sessionIds.map((sessionId) =>
        enqueueSession(
          sessionId,
          {
            t: "runtime_session_work",
            rpcId: crypto.randomUUID(),
            sessionId,
            candidateCount: catalog.sessionIds.length,
            now: request.now,
            timerKinds: request.timerKinds,
            effectKinds: request.effectKinds,
            limit: request.limit,
            additionalOutboxGroups: request.additionalOutboxGroups,
            activeOutbox: activeBySession.get(sessionId) ?? [],
            activeOutboxRecheckAt: request.activeOutboxRecheckAt,
          },
          true,
        ),
      ),
    );

    const timers = [...catalog.timers];
    const outbox = new Map(catalog.outbox.map((item) => [item.id, item]));
    for (const result of sessionResults) {
      if (result.t !== "runtime_session_work_result")
        throw new RetryableActorHostError(
          result.t === "error"
            ? result.error
            : "Invalid session runtime response",
        );
      timers.push(...result.timers);
      for (const item of result.outbox) outbox.set(item.id, item);
    }
    return {
      t: "runtime_work_result",
      rpcId: request.rpcId,
      timers: timers.slice(0, request.limit),
      outbox: [...outbox.values()],
    };
  }

  async function actorRequest(
    request: KernelActorTransportEnvelope["request"],
  ): Promise<KernelActorResponse> {
    if (request.t === "runtime_work")
      return runtimeWorkRequest(request as RuntimeWorkRequest);
    const route = sessionActorServiceRoute(request);
    if (route.scope === "session")
      return enqueueSession(route.sessionId, request, route.mutation);
    if (route.scope === "outbox")
      return enqueueSession(
        await resolveOutboxSession(
          route.id,
          isPrioritySessionActorRequest(request),
        ),
        request,
        route.mutation,
      );
    if (route.scope === "catalog_read") return sendToSlot(slots[0], request);

    if (request.t === "hello") return sendToSlot(slots[0], request);
    if (queuedGlobalTurns >= MAX_GLOBAL_TURNS)
      throw new RetryableActorHostError(
        "Session kernel catalog mailbox is full",
      );
    queuedGlobalTurns += 1;
    const active = [...sessionMailboxes.values()].map(
      (mailbox) => mailbox.mutationTail,
    );
    const operation = globalGate
      .catch(() => {})
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (active.length === 0) {
              resolve();
              return;
            }
            const timeout = setTimeout(() => {
              reject(
                new RetryableActorHostError(
                  `Session kernel global barrier timed out waiting for ${active.length} mailbox(es)`,
                ),
              );
            }, GLOBAL_BARRIER_TIMEOUT_MS);
            void Promise.all(active).then(
              () => {
                clearTimeout(timeout);
                resolve();
              },
              (error) => {
                clearTimeout(timeout);
                reject(error);
              },
            );
          }),
      )
      .then(() => sendToSlot(slots[0], request));
    globalGate = operation.then(
      () => {},
      () => {},
    );
    barrierGeneration += 1;
    void operation
      .finally(() => {
        queuedGlobalTurns -= 1;
      })
      .catch(() => {});
    return operation;
  }

  try {
    // Serialize catalog/schema opening. Session turns use the pool only after
    // every lane has acquired the shared actor-host writer incarnation.
    for (const slot of slots) await startSlot(slot);
  } catch (error) {
    stopping = true;
    for (const slot of slots)
      stopSlot(slot, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  server = Bun.serve({
    hostname: host,
    port,
    idleTimeout: 15,
    maxRequestBodySize: SESSION_KERNEL_MAX_REQUEST_BYTES,
    async fetch(request) {
      const url = new URL(request.url);
      const ready =
        !serviceError &&
        slots[0].ready &&
        sessionSlots.some((slot) => slot.ready);
      if (request.method === "GET" && url.pathname === "/live")
        return json(
          { live: !serviceError, version: SESSION_KERNEL_TRANSPORT_VERSION },
          { status: serviceError ? 503 : 200 },
        );
      if (request.method === "GET" && url.pathname === "/ready")
        return json(
          {
            ready,
            actorVersion: SESSION_KERNEL_ACTOR_VERSION,
            transportVersion: SESSION_KERNEL_TRANSPORT_VERSION,
            generation: RUNTIME_GENERATION,
            component: "session-kernel",
            workers: {
              ready: sessionSlots.filter((slot) => slot.ready).length,
              capacity: sessionSlots.length,
            },
            // Per-lane occupancy and cumulative counters. Index 0 is the
            // catalog lane; the rest are session execution lanes. Counters are
            // monotonic for the service lifetime so operators can compute
            // rates and spot lane skew, timeout storms, and restart churn.
            lanes: slots.map((slot) => ({
              index: slot.index,
              ready: slot.ready,
              restarting: slot.restarting,
              queued: slot.queue.length,
              executing: slot.pending.size,
              ...slot.metrics,
            })),
          },
          { status: ready ? 200 : 503 },
        );
      if (request.method !== "POST" || url.pathname !== "/rpc")
        return json({ error: "Not found" }, { status: 404 });
      if (!authorized(request.headers.get("authorization"), token))
        return json({ error: "Unauthorized" }, { status: 401 });
      if (!ready)
        return json(
          { error: serviceError?.message ?? "Actor pool is not ready" },
          { status: 503 },
        );
      const declaredLength = Number(request.headers.get("content-length") ?? 0);
      if (declaredLength > SESSION_KERNEL_MAX_REQUEST_BYTES)
        return json({ error: "Request is too large" }, { status: 413 });
      let text: string;
      try {
        text = await request.text();
      } catch {
        return json({ error: "Invalid request body" }, { status: 400 });
      }
      if (Buffer.byteLength(text) > SESSION_KERNEL_MAX_REQUEST_BYTES)
        return json({ error: "Request is too large" }, { status: 413 });
      let envelope: KernelActorTransportEnvelope;
      try {
        envelope = JSON.parse(text) as KernelActorTransportEnvelope;
      } catch {
        return json({ error: "Invalid JSON" }, { status: 400 });
      }
      if (envelope.version !== SESSION_KERNEL_TRANSPORT_VERSION)
        return json(
          { error: "Unsupported session kernel transport version" },
          { status: 409 },
        );
      if (envelope.actorVersion !== SESSION_KERNEL_ACTOR_VERSION)
        return json(
          { error: "Unsupported session kernel actor version" },
          { status: 409 },
        );
      if (
        envelope.request?.t !== "hello" &&
        envelope.serviceEpoch !== serviceEpoch
      )
        return json(
          { error: "Session kernel service incarnation changed" },
          { status: 409 },
        );
      if (!envelope.request || typeof envelope.request.rpcId !== "string")
        return json({ error: "Invalid RPC envelope" }, { status: 400 });
      const priority =
        envelope.request.t === "hello" ||
        isPrioritySessionActorRequest(envelope.request);
      const admissionLimit = priority
        ? SESSION_KERNEL_MAX_TRANSPORT_REQUESTS
        : SESSION_KERNEL_MAX_TRANSPORT_REQUESTS - RESERVED_PRIORITY_TURNS;
      if (admittedTransportRequests >= admissionLimit)
        return json(
          { error: "Session kernel transport is full" },
          { status: 429 },
        );
      admittedTransportRequests += 1;
      try {
        // Supervision issuer fields are never accepted from or rewritten for the
        // gateway. A future trusted actor construction injects the issuer out of band.
        const response = await actorRequest(envelope.request);
        const body = JSON.stringify({ ...response, serviceEpoch });
        if (Buffer.byteLength(body) > SESSION_KERNEL_MAX_RESPONSE_BYTES + 1024)
          return json({ error: "Response is too large" }, { status: 507 });
        return new Response(body, {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
          },
        });
      } catch (error) {
        const retryable =
          error instanceof RetryableActorHostError ||
          (!!error && typeof error === "object" && "retryable" in error);
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: serviceError ? 503 : retryable ? 429 : 500 },
        );
      } finally {
        admittedTransportRequests -= 1;
      }
    },
  });

  const runningServer = server;
  return {
    url: runningServer.url.origin,
    stop(stopOptions = {}) {
      if (stopping) return;
      stopping = true;
      runningServer.stop(true);
      if (stopOptions.terminateWorkers === false) return;
      const error = new Error("Session kernel service stopped");
      for (const slot of slots) stopSlot(slot, error);
    },
  };
}
