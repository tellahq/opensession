/**
 * Bun Worker that owns the materialized session-list SQLite index.
 *
 * The gateway thread never touches this database. It posts one request at a
 * time through session-list-store.ts; this thread runs the store method and
 * answers in arrival order, so the facade's FIFO promise chain is also the
 * database's commit order. The database path is derived from the state
 * context the gateway sent with `open` (plain strings), not from this
 * thread's own environment, so a repointed OPENSESSION_STATE_DIR on the
 * gateway always names the store it expects.
 */
import { statePathIn, type StateContext } from "./paths";
import {
  SESSION_LIST_DB_FILE,
  isSessionListStoreMethod,
  type SessionListWorkerRequest,
  type SessionListWorkerResponse,
} from "./session-list-protocol";
import { SessionListStore } from "./session-list-sqlite";

declare const self: Worker;

let context: StateContext | undefined;
let store: SessionListStore | undefined;

function openStore(): SessionListStore {
  if (store) return store;
  if (!context) throw new Error("Session list index has no state context");
  store = new SessionListStore(statePathIn(SESSION_LIST_DB_FILE, context));
  return store;
}

function reply(response: SessionListWorkerResponse): void {
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<SessionListWorkerRequest>) => {
  const request = event.data;
  if (request.t === "open") {
    // A context change is a different database. Close the current one so a
    // reused worker never answers for the wrong state root.
    if (
      context &&
      (context.stateRoot !== request.context.stateRoot ||
        context.home !== request.context.home)
    ) {
      store?.close();
      store = undefined;
    }
    context = request.context;
    return;
  }
  if (request.t === "debug") {
    if (process.env.NODE_ENV !== "test") {
      reply({
        t: "error",
        id: request.id,
        message: "Session list debug hooks are test-only",
      });
      return;
    }
    if (request.action === "crash")
      throw new Error("Session list index crashed on request");
    Bun.sleepSync(request.ms);
    reply({ t: "result", id: request.id, value: null });
    return;
  }
  if (!isSessionListStoreMethod(request.method)) {
    reply({
      t: "error",
      id: request.id,
      message: `Unknown session list method: ${String(request.method)}`,
    });
    return;
  }
  try {
    const target = openStore();
    const method = target[request.method] as (...args: unknown[]) => unknown;
    const value = method.apply(target, request.args);
    reply({ t: "result", id: request.id, value: value ?? null });
  } catch (error) {
    reply({
      t: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
