import type { ExecutorProviderId } from "./provider";

export type ExecutorLifecycle =
  | "preparing"
  | "awake"
  | "sleeping"
  | "waking"
  | "needs_attention";

export interface ExecutorProjectState {
  revision: string;
  baseCommit: string;
  durableDelta: string;
}

export interface ExecutorRecord {
  executorId: string;
  sessionId: string;
  provider: ExecutorProviderId;
  resourceId?: string;
  workspaceId?: string;
  /** Generation written into the current provider resource's managed metadata. */
  resourceGeneration?: number;
  /** Monotonic control-plane revision and execution-authority fence. */
  instanceGeneration: number;
  lifecycle: ExecutorLifecycle;
  project: ExecutorProjectState;
  createdAtMs: number;
  updatedAtMs: number;
  error?: string;
}

export interface ExecutorAuditEntry {
  executorId: string;
  generation: number;
  action: "force_destroy";
  operatorId: string;
  reason: string;
  atMs: number;
}

/** Persistence boundary. Implementations must make each operation durable and atomic. */
export interface ExecutorStateStore {
  getByExecutorId(executorId: string): Promise<ExecutorRecord | undefined>;
  getBySessionId(sessionId: string): Promise<ExecutorRecord | undefined>;
  insertIntent(record: ExecutorRecord): Promise<void>;
  compareAndSwap(
    executorId: string,
    expectedGeneration: number,
    next: ExecutorRecord,
  ): Promise<void>;
  delete(executorId: string, expectedGeneration: number): Promise<void>;
  appendAudit(entry: ExecutorAuditEntry): Promise<void>;
}

export class ExecutorStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorStateConflictError";
  }
}

/** Deterministic in-memory store for lifecycle tests. It performs no background work. */
export class InMemoryExecutorStateStore implements ExecutorStateStore {
  readonly #byExecutor = new Map<string, ExecutorRecord>();
  readonly #executorBySession = new Map<string, string>();
  readonly #audit: ExecutorAuditEntry[] = [];

  async getByExecutorId(
    executorId: string,
  ): Promise<ExecutorRecord | undefined> {
    return cloneRecord(this.#byExecutor.get(executorId));
  }

  async getBySessionId(sessionId: string): Promise<ExecutorRecord | undefined> {
    const executorId = this.#executorBySession.get(sessionId);
    return executorId
      ? cloneRecord(this.#byExecutor.get(executorId))
      : undefined;
  }

  async insertIntent(record: ExecutorRecord): Promise<void> {
    assertRecord(record);
    if (this.#byExecutor.has(record.executorId)) {
      throw new ExecutorStateConflictError(
        `Executor ${record.executorId} already exists`,
      );
    }
    if (this.#executorBySession.has(record.sessionId)) {
      throw new ExecutorStateConflictError(
        `session ${record.sessionId} already has a managedExecutor`,
      );
    }
    this.#byExecutor.set(record.executorId, cloneRecord(record)!);
    this.#executorBySession.set(record.sessionId, record.executorId);
  }

  async compareAndSwap(
    executorId: string,
    expectedGeneration: number,
    next: ExecutorRecord,
  ): Promise<void> {
    assertRecord(next);
    const current = this.#byExecutor.get(executorId);
    if (!current || current.instanceGeneration !== expectedGeneration) {
      throw new ExecutorStateConflictError(
        `Executor ${executorId} generation is stale (expected ${expectedGeneration})`,
      );
    }
    if (
      next.executorId !== executorId ||
      next.sessionId !== current.sessionId
    ) {
      throw new ExecutorStateConflictError(
        "Executor and session identity are immutable",
      );
    }
    if (next.instanceGeneration < expectedGeneration) {
      throw new ExecutorStateConflictError(
        "Executor generation cannot decrease",
      );
    }
    this.#byExecutor.set(executorId, cloneRecord(next)!);
  }

  async delete(executorId: string, expectedGeneration: number): Promise<void> {
    const current = this.#byExecutor.get(executorId);
    if (!current || current.instanceGeneration !== expectedGeneration) {
      throw new ExecutorStateConflictError(
        `Executor ${executorId} generation is stale (expected ${expectedGeneration})`,
      );
    }
    this.#byExecutor.delete(executorId);
    this.#executorBySession.delete(current.sessionId);
  }

  async appendAudit(entry: ExecutorAuditEntry): Promise<void> {
    this.#audit.push({ ...entry });
  }

  auditEntries(): readonly ExecutorAuditEntry[] {
    return this.#audit.map((entry) => ({ ...entry }));
  }
}

function cloneRecord(
  record: ExecutorRecord | undefined,
): ExecutorRecord | undefined {
  return record ? { ...record, project: { ...record.project } } : undefined;
}

function assertRecord(record: ExecutorRecord): void {
  if (
    !record.executorId ||
    !record.sessionId ||
    !Number.isSafeInteger(record.instanceGeneration) ||
    record.instanceGeneration < 1 ||
    !Number.isSafeInteger(record.createdAtMs) ||
    !Number.isSafeInteger(record.updatedAtMs)
  ) {
    throw new TypeError("invalid Executor record");
  }
}
