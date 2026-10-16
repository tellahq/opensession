import { workerEntry } from "../../runner-host/exe";
/** Gateway RPC only, no credential-file or GitHub I/O. Token-bearing resolution
 * is internal runtime API; never expose it through HTTP/MCP dispatch. */
import { randomUUID } from "node:crypto";
import {
  COORDINATOR_METHODS,
  type Coordinator,
  type CoordinatorMethod,
  type PersonalRepositoryClient,
  type RepositoryService,
} from "./worker-protocol";
import { stateDir, stateContext } from "../paths";
import type {
  ConnectionMethod,
  PersonalConnectionService,
} from "./worker-protocol";
type SharedClientState = {
  coordinator?: Coordinator;
  client?: PersonalRepositoryClient & { close(): Promise<void> };
};
function sharedState(): SharedClientState {
  const global = globalThis as typeof globalThis & {
    __personalGithubClients?: Map<string, SharedClientState>;
  };
  const states = (global.__personalGithubClients ??= new Map());
  const key = JSON.stringify(stateContext());
  let state = states.get(key);
  if (!state) {
    state = {};
    states.set(key, state);
  }
  return state;
}
/** Gateway boot/hot reload may update callback functions without losing the
 * worker, its owner lanes or consumer provenance. Stage3 preserves callback
 * serialization across coordinator instances. Never downgrade a live worker. */
export function installPersonalRepositoryCoordinator(value: Coordinator): void {
  if (
    !value ||
    COORDINATOR_METHODS.some((method) => typeof value[method] !== "function")
  )
    throw new Error("Complete personal repository coordinator required");
  const state = sharedState();
  if (state.client && !state.coordinator)
    throw new Error(
      "Gateway restart required to upgrade an already-started connection-only worker",
    );
  state.coordinator = value;
}
export function personalConnectionClient(): PersonalRepositoryClient {
  const state = sharedState();
  return (state.client ??= createPersonalConnectionWorkerClient(
    stateDir("personal-github"),
    () => state.coordinator,
  ));
}
export function createPersonalConnectionWorkerClient(
  directory: string,
  coordinatorSource?: Coordinator | (() => Coordinator | undefined),
): PersonalRepositoryClient & { close(): Promise<void> } {
  const getCoordinator =
    typeof coordinatorSource === "function"
      ? coordinatorSource
      : () => coordinatorSource;
  const coordinated = !!getCoordinator();
  const worker = new Worker(
    workerEntry(
      "personal-github-connection-worker.js",
      new URL("./connection-worker.ts", import.meta.url).href,
    ),
    { type: "module" },
  );
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let failed = false;
  const failure = () => {
    failed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Personal connection worker unavailable"));
    }
    pending.clear();
  };
  worker.onerror = failure;
  worker.addEventListener("close", failure);
  let callbackCount = 0;
  worker.onmessage = async (event: MessageEvent<any>) => {
    if (event.data.type === "coordinator") {
      const { callbackId, method, args } = event.data as {
        callbackId: string;
        method: CoordinatorMethod;
        args: unknown[];
      };
      const coordinator = getCoordinator();
      if (
        !coordinator ||
        !COORDINATOR_METHODS.includes(method) ||
        callbackCount >= 64 ||
        !Array.isArray(args) ||
        Buffer.byteLength(JSON.stringify(args)) > 65536
      ) {
        worker.postMessage({
          type: "coordinator-result",
          callbackId,
          error: true,
        });
        return;
      }
      callbackCount++;
      try {
        const result = await (
          coordinator[method] as (...args: unknown[]) => Promise<unknown>
        ).apply(coordinator, args);
        if (Buffer.byteLength(JSON.stringify(result ?? null)) > 65536)
          throw new Error("Coordinator response exceeds limit");
        worker.postMessage({ type: "coordinator-result", callbackId, result });
      } catch {
        worker.postMessage({
          type: "coordinator-result",
          callbackId,
          error: true,
        });
      } finally {
        callbackCount--;
      }
      return;
    }
    const item = pending.get(event.data.id);
    if (!item) return;
    pending.delete(event.data.id);
    clearTimeout(item.timer);
    if (event.data.error)
      item.reject(new Error("Personal connection worker unavailable"));
    else item.resolve(event.data.result);
  };
  function invoke(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (
        failed ||
        pending.size >= 64 ||
        Buffer.byteLength(JSON.stringify(args)) > 65536
      ) {
        reject(new Error("Personal connection worker unavailable"));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Personal connection request timed out"));
      }, 180_000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({
        id,
        directory,
        coordinated,
        request: { method, args },
      });
    });
  }
  const client = {
    repositoryAdmission: coordinated,
    register(
      ...args: Parameters<RepositoryService["register"]>
    ): ReturnType<RepositoryService["register"]> {
      return invoke("register", args) as ReturnType<
        RepositoryService["register"]
      >;
    },
    resolveCredential(
      ...args: Parameters<RepositoryService["resolveCredential"]>
    ): ReturnType<RepositoryService["resolveCredential"]> {
      return invoke("resolveCredential", args) as ReturnType<
        RepositoryService["resolveCredential"]
      >;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          worker.terminate();
          reject(new Error("Worker close timed out"));
        }, 5000);
        pending.set(id, { resolve: () => resolve(), reject, timer });
        worker.postMessage({ id, close: true });
      });
      worker.terminate();
    },
    call<K extends ConnectionMethod>(
      method: K,
      ...args: Parameters<PersonalConnectionService[K]>
    ): ReturnType<PersonalConnectionService[K]> {
      const result = invoke(method, args);
      return result as ReturnType<PersonalConnectionService[K]>;
    },
  };
  return client;
}
