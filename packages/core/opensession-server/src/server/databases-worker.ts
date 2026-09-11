/**
 * Bun Worker that owns the Databases store (databases-sqlite.ts).
 *
 * The gateway thread never opens one of these SQLite files. It posts
 * requests through databases.ts; this thread runs the store method and
 * answers in arrival order. The store root comes from the state context the
 * gateway sent with `open`, never from this thread's own environment, so a
 * repointed OPENSESSION_STATE_DIR on the gateway always names the store it
 * expects.
 */
import { statePathIn, type StateContext } from "./paths";
import { DATABASES_STATE_NAME } from "./databases-protocol";
import {
  isDatabasesStoreMethod,
  type DatabasesWorkerRequest,
  type DatabasesWorkerResponse,
} from "./databases-protocol";
import { DatabasesStore } from "./databases-sqlite";

declare const self: Worker;

let context: StateContext | undefined;
let store: DatabasesStore | undefined;

function openStore(): DatabasesStore {
  if (store) return store;
  if (!context) throw new Error("Databases store has no state context");
  store = new DatabasesStore(statePathIn(DATABASES_STATE_NAME, context));
  return store;
}

function reply(response: DatabasesWorkerResponse): void {
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<DatabasesWorkerRequest>) => {
  const request = event.data;
  if (request.t === "open") {
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
        name: "Error",
        message: "Databases debug hooks are test-only",
      });
      return;
    }
    if (request.action === "crash")
      throw new Error("Databases worker crashed on request");
    Bun.sleepSync(request.ms);
    reply({ t: "result", id: request.id, value: null });
    return;
  }
  if (!isDatabasesStoreMethod(request.method)) {
    reply({
      t: "error",
      id: request.id,
      name: "Error",
      message: `Unknown databases method: ${String(request.method)}`,
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
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
