import { withSessionScopeFence } from "./session-scope-coverage";
import { sessionMetadata } from "./session-kernel";
import type { AccessPrincipal } from "../shared/access-scope";
/**
 * Gateway facade for the materialized session-list index.
 *
 * The SQLite index (session-list-sqlite.ts) is a derived projection of the
 * session catalog, not authoritative metadata. Its I/O runs on a dedicated
 * Bun Worker (session-list-worker.ts) so no HTTP handler, WebSocket frame or
 * timer on the gateway thread ever blocks on a database read or write. Every
 * operation here returns a promise.
 *
 * Ordering: requests are answered in the order they were posted, so a read
 * issued after a write observes it without any extra synchronisation.
 * Failure: when the worker dies, every pending request rejects and the next
 * request starts a fresh worker. Lifecycle: nothing is created at import;
 * the worker starts on the first call and is keyed by the state context, so
 * a repointed OPENSESSION_STATE_DIR gets its own worker and database.
 */

import { stateContext, type StateContext } from "./paths";
import { workerEntry } from "../runner-host/exe";
import {
  type SessionListDebugAction,
  type SessionListStoreArgs,
  type SessionListStoreMethod,
  type SessionListStoreResult,
  type SessionListWorkerRequest,
  type SessionListWorkerResponse,
} from "./session-list-protocol";
import { SessionListStore, type SessionListSlice } from "./session-list-sqlite";
import { shareWorkspacePrRefs } from "./session-pr-target";
import type { UnifiedSession } from "./types";

export { SessionListStore, type SessionListSlice };

/** More than this many unanswered requests means the worker is wedged or the
 * gateway is flooding it; refuse instead of growing the heap without bound. */
export const SESSION_LIST_MAX_PENDING = 4096;
/** A single store call that takes this long is treated as a dead worker. */
const SESSION_LIST_REQUEST_TIMEOUT_MS = 60_000;

export class SessionListIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionListIndexError";
  }
}

interface SessionListBackend {
  call<M extends SessionListStoreMethod>(
    method: M,
    args: SessionListStoreArgs<M>,
  ): Promise<SessionListStoreResult<M>>;
  debug(action: SessionListDebugAction): Promise<void>;
  /** Stop accepting requests; release the worker once nothing is pending. */
  retire(): void;
  terminate(): void;
  readonly pendingCount: number;
}

/** In-process backend for tests that own a `SessionListStore`. Calls run
 * synchronously at post time, which is trivially FIFO. */
class LocalSessionListBackend implements SessionListBackend {
  constructor(readonly store: SessionListStore) {}
  call<M extends SessionListStoreMethod>(
    method: M,
    args: SessionListStoreArgs<M>,
  ): Promise<SessionListStoreResult<M>> {
    try {
      const fn = this.store[method] as (
        ...params: SessionListStoreArgs<M>
      ) => SessionListStoreResult<M>;
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

/** Bun workers expose ref/unref; the DOM Worker type does not declare them. */
type WorkerHandle = Worker & {
  ref(): void;
  unref(): void;
  addEventListener(type: "close", listener: () => void): void;
};

function sessionListWorkerUrl(): string | URL {
  return workerEntry(
    "session-list-worker.js",
    new URL("./session-list-worker.ts", import.meta.url).href,
  );
}

/** Worker-backed backend: one thread, one database, FIFO request ids. */
class WorkerSessionListBackend implements SessionListBackend {
  private worker: WorkerHandle | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private retired = false;

  constructor(readonly context: StateContext) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  call<M extends SessionListStoreMethod>(
    method: M,
    args: SessionListStoreArgs<M>,
  ): Promise<SessionListStoreResult<M>> {
    return this.post((id) => ({
      t: "call",
      id,
      method,
      args: args as unknown[],
    })) as Promise<SessionListStoreResult<M>>;
  }

  debug(action: SessionListDebugAction): Promise<void> {
    return this.post((id) => ({ t: "debug", id, ...action })).then(
      () => undefined,
    );
  }

  private post(
    build: (id: number) => SessionListWorkerRequest,
  ): Promise<unknown> {
    if (this.retired)
      return Promise.reject(
        new SessionListIndexError("Session list index was repointed"),
      );
    if (this.pending.size >= SESSION_LIST_MAX_PENDING)
      return Promise.reject(
        new SessionListIndexError(
          `Session list index has ${this.pending.size} pending requests`,
        ),
      );
    let worker: WorkerHandle;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new SessionListIndexError(String(error)),
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new SessionListIndexError(
            `Session list index request timed out after ${SESSION_LIST_REQUEST_TIMEOUT_MS}ms`,
          ),
        );
      }, SESSION_LIST_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      // Hold the process open while an answer is owed; an idle worker must
      // not keep a script or test alive.
      worker.ref();
      worker.postMessage(build(id));
    });
  }

  private ensureWorker(): WorkerHandle {
    if (this.worker) return this.worker;
    const worker = new Worker(sessionListWorkerUrl(), {
      type: "module",
    }) as WorkerHandle;
    worker.addEventListener("message", (event: MessageEvent) => {
      if (this.worker !== worker) return;
      this.settle(event.data as SessionListWorkerResponse);
    });
    worker.addEventListener("error", (event) => {
      if (this.worker !== worker) return;
      // Bun's message carries a source excerpt around an `error: ...` line;
      // keep that line, or the first one when the shape differs.
      const lines = (event.message || "unknown error").split("\n");
      const message =
        lines.find((line) => line.startsWith("error: "))?.slice(7) ?? lines[0];
      this.fail(
        new SessionListIndexError(
          `Session list index worker failed: ${message}`,
        ),
      );
    });
    worker.addEventListener("messageerror", () => {
      if (this.worker !== worker) return;
      this.fail(
        new SessionListIndexError(
          "Session list index worker sent an invalid message",
        ),
      );
    });
    worker.addEventListener("close", () => {
      if (this.worker !== worker) return;
      this.fail(new SessionListIndexError("Session list index worker exited"));
    });
    worker.unref();
    worker.postMessage({
      t: "open",
      context: this.context,
    } satisfies SessionListWorkerRequest);
    this.worker = worker;
    return worker;
  }

  private settle(response: SessionListWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.t === "error")
      pending.reject(new SessionListIndexError(response.message));
    else pending.resolve(response.value);
    this.afterSettle();
  }

  private afterSettle(): void {
    if (this.pending.size > 0) return;
    if (this.retired) this.terminate();
    else this.worker?.unref();
  }

  /** The worker is gone or wedged: reject every pending request and drop
   * it. The next request spawns a fresh worker (which reopens the index). */
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
        `[session-list] ${error.message}; rejected ${pending.length} pending request(s)`,
      );
  }

  retire(): void {
    this.retired = true;
    if (this.pending.size === 0) this.terminate();
  }

  terminate(): void {
    this.fail(new SessionListIndexError("Session list index worker stopped"));
  }
}

type SessionListIndexState = {
  override?: SessionListBackend;
  worker?: WorkerSessionListBackend;
};

const g = globalThis as typeof globalThis & {
  __osSessionListIndex?: SessionListIndexState;
};

function indexState(): SessionListIndexState {
  return (g.__osSessionListIndex ??= {});
}

function sameContext(a: StateContext, b: StateContext): boolean {
  return a.stateRoot === b.stateRoot && a.home === b.home;
}

/** The backend for the current state context. Resolved per call from plain
 * environment strings (no filesystem probe on this thread); a context change
 * retires the previous worker once its answers are in. */
function sessionListBackend(): SessionListBackend {
  const state = indexState();
  if (state.override) return state.override;
  const context = stateContext();
  if (state.worker && !sameContext(state.worker.context, context)) {
    state.worker.retire();
    state.worker = undefined;
  }
  return (state.worker ??= new WorkerSessionListBackend(context));
}

function callIndex<M extends SessionListStoreMethod>(
  method: M,
  ...args: SessionListStoreArgs<M>
): Promise<SessionListStoreResult<M>> {
  return sessionListBackend().call(method, args);
}

export function scopeProjectionCall<
  M extends
    | "scopeState"
    | "resetScopeReplica"
    | "applyScopeDelta"
    | "upsertScopePage",
>(
  method: M,
  ...args: SessionListStoreArgs<M>
): Promise<SessionListStoreResult<M>> {
  return callIndex(method, ...args);
}

function readIndex<M extends SessionListStoreMethod>(
  method: M,
  ...args: SessionListStoreArgs<M>
): Promise<SessionListStoreResult<M>> {
  return withSessionScopeFence(async () => {
    const value = await callIndex(method, ...args);
    if (Array.isArray(value) && value.length && typeof value[0] === "object")
      shareWorkspacePrRefs(value as UnifiedSession[]);
    else if (method === "get" && value)
      shareWorkspacePrRefs([value as UnifiedSession]);
    else if (method === "getWithVisibilityGroup" && value)
      shareWorkspacePrRefs((value as { group: UnifiedSession[] }).group);
    return value;
  });
}

/** Bootstrap-only pre-merge filtering. It prevents a stale shared payload from
 * lending private PR/workspace fields to a genuinely shared row during folding. */
export function filterCollectionSourceRows(
  rows: UnifiedSession[],
): Promise<UnifiedSession[]> {
  return withSessionScopeFence(async () => {
    const allowed = new Set<string>();
    for (let i = 0; i < rows.length; i += 1000)
      for (const id of await callIndex(
        "filterScopeIds",
        rows.slice(i, i + 1000).map((row) => row.id),
      ))
        allowed.add(id);
    return rows.filter((row) => allowed.has(row.id));
  });
}

async function registerAliases(sessions: UnifiedSession[]): Promise<void> {
  const rows: Array<{ id: string; aliases: string[] }> = [];
  for (const session of sessions) {
    const aliases = session.aliasIds ?? [];
    for (let i = 0; i < aliases.length; i += 64)
      rows.push({ id: session.id, aliases: aliases.slice(i, i + 64) });
  }
  for (let i = 0; i < rows.length; i += 1000)
    await sessionMetadata({
      op: "scope_aliases",
      rows: rows.slice(i, i + 1000),
    });
}

/** Restore the workspace PR projection on independently indexed rows. PRs
 * are workspace state, so a list slice must show them on every member. */
function shared<T extends UnifiedSession[] | null>(rows: T): T {
  if (rows) shareWorkspacePrRefs(rows);
  return rows;
}

/** Swap the process-wide index for an in-process store without opening the
 * default state DB. Passing undefined restores the worker-backed index. */
export function __setSessionListStoreForTest(
  store: SessionListStore | undefined,
): SessionListStore | undefined {
  const state = indexState();
  const previous =
    state.override instanceof LocalSessionListBackend
      ? state.override.store
      : undefined;
  state.override = store ? new LocalSessionListBackend(store) : undefined;
  return previous;
}

/** Drop the worker (if any) so the next call starts a fresh one. */
export function __resetSessionListIndexForTest(): void {
  const state = indexState();
  state.worker?.terminate();
  state.worker = undefined;
}

/** Test-only hooks on the live worker: stall it or crash it. */
export function __sessionListIndexDebugForTest(
  action: SessionListDebugAction,
): Promise<void> {
  return sessionListBackend().debug(action);
}

export function __sessionListIndexPendingForTest(): number {
  return sessionListBackend().pendingCount;
}

/** Whether `slice` has been fully materialized, without moving any rows. */
export function indexedCoverage(slice: SessionListSlice): Promise<boolean> {
  return readIndex("hasCoverage", slice);
}

export function indexedCount(principal?: AccessPrincipal): Promise<number> {
  return readIndex("count", principal);
}

/** Release the worker (operator scripts call this before exiting). The next
 * call would start a fresh one. */
export function closeSessionListIndex(): void {
  const state = indexState();
  state.worker?.retire();
  state.worker = undefined;
}

export function indexedSessions(
  slice: SessionListSlice = "include",
  principal?: AccessPrincipal,
): Promise<UnifiedSession[] | null> {
  return readIndex("listCovered", slice, principal);
}

/** Live rows on any of `branches`, or null while the live slice has no
 * coverage and a branch lookup could miss rows. */
export function indexedLiveSessionsByBranch(
  branches: string[],
): Promise<UnifiedSession[] | null> {
  return readIndex("listLiveByBranchCovered", branches);
}

export function indexedWorkspaceMembers(
  workspaceId: string,
): Promise<UnifiedSession[]> {
  return readIndex("listWorkspaceMembers", workspaceId);
}

export function indexedSidebarSessions(
  selectedSessionId?: string,
  principal?: AccessPrincipal,
): Promise<UnifiedSession[] | null> {
  return readIndex("listSidebarCovered", selectedSessionId, principal);
}

export function indexedWorkspaceMemberSessions(
  workspaceId: string,
): Promise<UnifiedSession[]> {
  return indexedWorkspaceMembers(workspaceId);
}

export function indexedWorkspaceSessions(
  workspaceId: string,
  worktreeDir?: string | null,
): Promise<UnifiedSession[] | null> {
  return readIndex("listWorkspaceCovered", workspaceId, worktreeDir);
}

export function indexedActiveWorkspaceIds(): Promise<string[] | null> {
  return readIndex("activeWorkspaceIdsCovered");
}

export async function upsertIndexedSession(
  session: UnifiedSession,
): Promise<void> {
  await registerAliases([session]);
  return callIndex("upsert", session);
}

export async function upsertIndexedSessions(
  sessions: UnifiedSession[],
  slice?: SessionListSlice,
): Promise<void> {
  await registerAliases(sessions);
  return callIndex("upsertManyCovered", sessions, slice);
}

export async function rebuildSessionListIndex(
  sessions: UnifiedSession[],
): Promise<void> {
  await registerAliases(sessions);
  return callIndex("replaceAll", sessions);
}

export function removeIndexedSession(id: string): Promise<void> {
  return callIndex("remove", id);
}

export function indexedSession(
  id: string,
  principal?: AccessPrincipal,
): Promise<UnifiedSession | null> {
  return readIndex("get", id, principal);
}

export function indexedVisibilityGroup(
  session: UnifiedSession,
): Promise<UnifiedSession[]> {
  return readIndex("listVisibilityGroup", session);
}

/** One session plus its visibility group in a single round trip. */
export function indexedSessionWithVisibilityGroup(
  id: string,
): Promise<{ session: UnifiedSession; group: UnifiedSession[] } | null> {
  return readIndex("getWithVisibilityGroup", id).then((result) => {
    if (!result) return null;

    const session =
      result.group.find((row) => row.id === result.session.id) ??
      result.session;
    return { session, group: result.group };
  });
}

export function setIndexedSessionArchived(
  id: string,
  archived: boolean,
  reason?: string,
): Promise<void> {
  return callIndex("setArchived", id, archived, reason);
}
