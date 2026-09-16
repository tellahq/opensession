/** Worker entrypoint. Reverse callbacks carry descriptors/ref, never secrets. */
import { randomUUID } from "node:crypto";
import { openTrustedHostConnections } from "./service";
import {
  CONNECTION_METHODS,
  type ConnectionRequest,
  type Coordinator,
  type CoordinatorMethod,
} from "./worker-protocol";
declare const self: Worker;
let service: ReturnType<typeof openTrustedHostConnections> | undefined;
let pending = 0;
const callbacks = new Map<
  string,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function callback<K extends CoordinatorMethod>(
  method: K,
  ...args: Parameters<Coordinator[K]>
): ReturnType<Coordinator[K]> {
  const work = new Promise<unknown>((resolve, reject) => {
    if (
      callbacks.size >= 64 ||
      Buffer.byteLength(JSON.stringify(args)) > 65536
    ) {
      reject(new Error("Coordinator unavailable"));
      return;
    }
    const callbackId = randomUUID();
    const timer = setTimeout(() => {
      callbacks.delete(callbackId);
      reject(new Error("Coordinator timed out"));
    }, 60_000);
    callbacks.set(callbackId, { resolve, reject, timer });
    self.postMessage({ type: "coordinator", callbackId, method, args });
  });
  return work as ReturnType<Coordinator[K]>;
}
self.onmessage = async (event: MessageEvent<any>) => {
  const data = event.data;
  if (data.type === "coordinator-result") {
    const item = callbacks.get(data.callbackId);
    if (!item) return;
    callbacks.delete(data.callbackId);
    clearTimeout(item.timer);
    if (data.error) item.reject(new Error("Coordinator rejected operation"));
    else item.resolve(data.result);
    return;
  }
  const { id, request, directory } = data as {
    id: string;
    request: ConnectionRequest;
    directory: string;
  };
  if (data.close) {
    try {
      if (pending || callbacks.size) throw new Error("Worker busy");
      if (service) await (await service).close();
      self.postMessage({ id, result: null });
    } catch {
      self.postMessage({ id, error: true });
    }
    return;
  }
  if (++pending > 64) {
    pending--;
    self.postMessage({ id, error: true });
    return;
  }
  try {
    const repositoryMethod = (request as { method: string }).method;
    if (
      !CONNECTION_METHODS.includes(request.method) &&
      repositoryMethod !== "register" &&
      repositoryMethod !== "resolveCredential"
    )
      throw new Error("Unknown method");
    if (Buffer.byteLength(JSON.stringify(request)) > 65536)
      throw new Error("Request exceeds limit");
    service ??= openTrustedHostConnections({
      directory,
      transport: (url, init) => fetch(url, init),
      coordinator: data.coordinated
        ? {
            register: (descriptor) => callback("register", descriptor),
            assertCurrent: (owner, descriptor) =>
              callback("assertCurrent", owner, descriptor),
            revoke: (ref) => callback("revoke", ref),
            reconcile: (ref, install, repos, revision) =>
              callback("reconcile", ref, install, repos, revision),
          }
        : undefined,
    });
    const opened = await service;
    const target =
      repositoryMethod === "register" ||
      repositoryMethod === "resolveCredential"
        ? opened.repositories
        : opened.connections;
    if (!target) throw new Error("Repository coordinator unavailable");
    const method = (
      target as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >
    )[request.method];
    if (!method) throw new Error("Unknown method");
    const result = await method(...request.args);
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
      throw new Error("Response exceeds limit");
    self.postMessage({ id, result });
  } catch {
    self.postMessage({ id, error: true });
  } finally {
    pending--;
  }
};
