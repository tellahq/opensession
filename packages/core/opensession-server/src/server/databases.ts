/**
 * Databases: named SQLite files Open Session keeps for sessions and
 * automations, beside Reports in spirit (a durable, browsable thing a run
 * produces) but mutable and long-lived where a report is an append-only
 * document.
 *
 * This is the gateway-side facade. Every SQLite and filesystem operation
 * runs on a dedicated Bun Worker (databases-worker.ts) owning one
 * DatabasesStore (databases-sqlite.ts), so an agent's slow query can never
 * stall an HTTP request or a WebSocket frame on this thread. Requests are
 * answered in the order posted; a dead or wedged worker rejects what it owed
 * and the next call starts a fresh one. Nothing is created at import: the
 * worker starts on the first call and is keyed by the state context, so a
 * repointed OPENSESSION_STATE_DIR gets its own worker and store.
 *
 * Writes broadcast `databases_changed` so open Databases views and session
 * tabs refresh.
 */

import { stateContext, stateDir, type StateContext } from "./paths";
import { workerEntry } from "../runner-host/exe";
import {
  type DatabasesDebugAction,
  type DatabasesStoreArgs,
  type DatabasesStoreMethod,
  type DatabasesStoreResult,
  type DatabasesWorkerRequest,
  type DatabasesWorkerResponse,
} from "./databases-protocol";
import {
  DatabaseLimitError,
  DatabaseNotFoundError,
  DatabasesStore,
  type DatabaseMeta,
  type DatabaseParams,
} from "./databases-sqlite";
import { DatabaseSqlError } from "./database-sql-guard";
import { broadcastToAll } from "./ws-hub";

export { DatabaseSqlError };
export {
  DatabasesStore,
  DatabaseNotFoundError,
  DatabaseLimitError,
  isDatabaseId,
  MAX_DATABASES,
  MAX_DATABASE_BYTES,
  MAX_INSERT_ROWS,
  MAX_QUERY_ROWS,
  MAX_RESULT_BYTES,
  type DatabaseCell,
  type DatabaseColumn,
  type DatabaseMeta,
  type DatabaseParams,
  type DatabaseSchema,
  type DatabaseTable,
  type ExecuteResult,
  type QueryResult,
  type RowsPage,
} from "./databases-sqlite";

/** The store root, resolved per call so a repointed state root wins. */
export function databasesRoot(): string {
  return stateDir("databases");
}

/** Unanswered requests beyond this mean the worker is wedged or flooded. */
export const DATABASES_MAX_PENDING = 1024;
/** A single store call that takes this long is treated as a dead worker.
 *  It doubles as the statement time cap: a runaway query takes the worker
 *  down with it and the next call gets a fresh one. */
export const DATABASES_REQUEST_TIMEOUT_MS = 30_000;

export class DatabasesWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabasesWorkerError";
  }
}

/** Errors the worker reports by name, rebuilt on this side so callers can
 *  branch on the class as if the store were in-process. */
function rebuildError(name: string, message: string): Error {
  switch (name) {
    case "DatabaseNotFoundError": {
      const error = new DatabaseNotFoundError("");
      error.message = message;
      return error;
    }
    case "DatabaseLimitError":
      return new DatabaseLimitError(message);
    case "DatabaseSqlError":
      return new DatabaseSqlError(message);
    case "SQLiteError":
      return new DatabaseSqlError(message);
    default:
      return new DatabasesWorkerError(message);
  }
}

interface DatabasesBackend {
  call<M extends DatabasesStoreMethod>(
    method: M,
    args: DatabasesStoreArgs<M>,
  ): Promise<DatabasesStoreResult<M>>;
  debug(action: DatabasesDebugAction): Promise<void>;
  retire(): void;
  terminate(): void;
  readonly pendingCount: number;
}

/** In-process backend for tests that own a DatabasesStore. */
class LocalDatabasesBackend implements DatabasesBackend {
  constructor(readonly store: DatabasesStore) {}
  call<M extends DatabasesStoreMethod>(
    method: M,
    args: DatabasesStoreArgs<M>,
  ): Promise<DatabasesStoreResult<M>> {
    try {
      const fn = this.store[method] as (
        ...params: DatabasesStoreArgs<M>
      ) => DatabasesStoreResult<M>;
      return Promise.resolve(fn.apply(this.store, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  debug(): Promise<void> {
    return Promise.resolve();
  }
  retire(): void {}
  terminate(): void {}
  get pendingCount(): number {
    return 0;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkerHandle = Worker & {
  ref(): void;
  unref(): void;
  addEventListener(type: "close", listener: () => void): void;
};

function databasesWorkerUrl(): string | URL {
  return workerEntry(
    "databases-worker.js",
    new URL("./databases-worker.ts", import.meta.url).href,
  );
}

/** Worker-backed backend: one thread, one store, FIFO request ids. */
class WorkerDatabasesBackend implements DatabasesBackend {
  private worker: WorkerHandle | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private retired = false;

  constructor(readonly context: StateContext) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  call<M extends DatabasesStoreMethod>(
    method: M,
    args: DatabasesStoreArgs<M>,
  ): Promise<DatabasesStoreResult<M>> {
    return this.post((id) => ({
      t: "call",
      id,
      method,
      args: args as unknown[],
    })) as Promise<DatabasesStoreResult<M>>;
  }

  debug(action: DatabasesDebugAction): Promise<void> {
    return this.post((id) => ({ t: "debug", id, ...action })).then(
      () => undefined,
    );
  }

  private post(
    build: (id: number) => DatabasesWorkerRequest,
  ): Promise<unknown> {
    if (this.retired)
      return Promise.reject(
        new DatabasesWorkerError("Databases store was repointed"),
      );
    if (this.pending.size >= DATABASES_MAX_PENDING)
      return Promise.reject(
        new DatabasesWorkerError(
          `Databases store has ${this.pending.size} pending requests`,
        ),
      );
    let worker: WorkerHandle;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new DatabasesWorkerError(String(error)),
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new DatabasesWorkerError(
            `Database request timed out after ${DATABASES_REQUEST_TIMEOUT_MS}ms`,
          ),
        );
      }, DATABASES_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      worker.ref();
      worker.postMessage(build(id));
    });
  }

  private ensureWorker(): WorkerHandle {
    if (this.worker) return this.worker;
    const worker = new Worker(databasesWorkerUrl(), {
      type: "module",
    }) as WorkerHandle;
    worker.addEventListener("message", (event: MessageEvent) => {
      if (this.worker !== worker) return;
      this.settle(event.data as DatabasesWorkerResponse);
    });
    worker.addEventListener("error", (event) => {
      if (this.worker !== worker) return;
      const lines = (event.message || "unknown error").split("\n");
      const message =
        lines.find((line) => line.startsWith("error: "))?.slice(7) ?? lines[0];
      this.fail(
        new DatabasesWorkerError(`Databases worker failed: ${message}`),
      );
    });
    worker.addEventListener("messageerror", () => {
      if (this.worker !== worker) return;
      this.fail(
        new DatabasesWorkerError("Databases worker sent an invalid message"),
      );
    });
    worker.addEventListener("close", () => {
      if (this.worker !== worker) return;
      this.fail(new DatabasesWorkerError("Databases worker exited"));
    });
    worker.unref();
    worker.postMessage({
      t: "open",
      context: this.context,
    } satisfies DatabasesWorkerRequest);
    this.worker = worker;
    return worker;
  }

  private settle(response: DatabasesWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.t === "error")
      pending.reject(rebuildError(response.name, response.message));
    else pending.resolve(response.value);
    if (this.pending.size > 0) return;
    if (this.retired) this.terminate();
    else this.worker?.unref();
  }

  private fail(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    if (pending.length)
      console.warn(
        `[databases] ${error.message}; rejected ${pending.length} pending request(s)`,
      );
  }

  retire(): void {
    this.retired = true;
    if (this.pending.size === 0) this.terminate();
  }

  terminate(): void {
    this.fail(new DatabasesWorkerError("Databases worker stopped"));
  }
}

type DatabasesState = {
  override?: DatabasesBackend;
  worker?: WorkerDatabasesBackend;
};

const g = globalThis as typeof globalThis & { __osDatabases?: DatabasesState };

function state(): DatabasesState {
  return (g.__osDatabases ??= {});
}

function backend(): DatabasesBackend {
  const current = state();
  if (current.override) return current.override;
  const context = stateContext();
  if (
    current.worker &&
    (current.worker.context.stateRoot !== context.stateRoot ||
      current.worker.context.home !== context.home)
  ) {
    current.worker.retire();
    current.worker = undefined;
  }
  return (current.worker ??= new WorkerDatabasesBackend(context));
}

function call<M extends DatabasesStoreMethod>(
  method: M,
  ...args: DatabasesStoreArgs<M>
): Promise<DatabasesStoreResult<M>> {
  return backend().call(method, args);
}

function changed(databaseId: string, sessionId?: string): void {
  broadcastToAll({
    type: "databases_changed",
    databaseId,
    ...(sessionId ? { sessionId } : {}),
  });
}

// ---- public API ------------------------------------------------------------

export function createDatabase(
  input: DatabasesStoreArgs<"create">[0],
): Promise<DatabaseMeta> {
  return call("create", input).then((meta) => {
    changed(meta.id, input.sessionId);
    return meta;
  });
}

export function listDatabases(): Promise<DatabaseMeta[]> {
  return call("list");
}

export function getDatabase(id: string): Promise<DatabaseMeta | null> {
  return call("get", id);
}

export function findDatabaseByName(name: string): Promise<DatabaseMeta | null> {
  return call("findByName", name);
}

export function listDatabasesForSession(
  sessionId: string,
): Promise<DatabaseMeta[]> {
  return call("listForSession", sessionId);
}

export function updateDatabase(
  id: string,
  patch: DatabasesStoreArgs<"update">[1],
  sessionId?: string,
): Promise<DatabaseMeta> {
  return call("update", id, patch).then((meta) => {
    changed(meta.id, sessionId);
    return meta;
  });
}

export function deleteDatabase(id: string): Promise<boolean> {
  return call("remove", id).then((removed) => {
    if (removed) changed(id);
    return removed;
  });
}

export function describeDatabase(id: string) {
  return call("describe", id);
}

export function queryDatabase(
  id: string,
  sql: string,
  params?: DatabaseParams,
  limit?: number,
) {
  return call("query", id, sql, params, limit);
}

export function databaseRows(
  id: string,
  table: string,
  options?: DatabasesStoreArgs<"rows">[2],
) {
  return call("rows", id, table, options);
}

export function exportDatabaseCsv(id: string, table: string) {
  return call("exportCsv", id, table);
}

export function exportDatabaseCopy(id: string, destination: string) {
  return call("exportCopy", id, destination);
}

export function executeDatabase(
  id: string,
  sql: string,
  params?: DatabaseParams,
  sessionId?: string,
) {
  return call("execute", id, sql, params, sessionId).then((result) => {
    changed(id, sessionId);
    return result;
  });
}

export function insertDatabaseRows(
  id: string,
  table: string,
  rows: DatabasesStoreArgs<"insertRows">[2],
  options?: DatabasesStoreArgs<"insertRows">[3],
) {
  return call("insertRows", id, table, rows, options).then((result) => {
    changed(id, options?.sessionId);
    return result;
  });
}

// ---- test seams ------------------------------------------------------------

/** Swap the process-wide store for an in-process one. Passing undefined
 *  restores the worker-backed store. */
export function __setDatabasesStoreForTest(
  store: DatabasesStore | undefined,
): void {
  state().override = store ? new LocalDatabasesBackend(store) : undefined;
}

/** Drop the worker (if any) so the next call starts a fresh one. */
export function __resetDatabasesWorkerForTest(): void {
  const current = state();
  current.worker?.terminate();
  current.worker = undefined;
}

export function __databasesDebugForTest(
  action: DatabasesDebugAction,
): Promise<void> {
  return backend().debug(action);
}

export function __databasesPendingForTest(): number {
  return backend().pendingCount;
}
