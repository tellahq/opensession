/**
 * Bun Worker that owns the memory repository service (memory-repo/service.ts):
 * the derived SQLite index and every git subprocess for memory. The gateway
 * thread never opens the index; it posts requests through memory-repo/client.ts
 * and this thread answers them. Requests for one repository are serialized by
 * the service itself, so a slow push or reindex never blocks the gateway.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  INDEX_METHODS,
  SERVICE_METHODS,
  type MemoryRepoWorkerRequest,
  type MemoryRepoWorkerResponse,
} from "./memory-repo/protocol";
import {
  MemoryRepoError,
  MemoryRepoService,
  type MemoryRepoServiceOptions,
} from "./memory-repo/service";

declare const self: Worker;

let options: MemoryRepoServiceOptions | undefined;
let service: MemoryRepoService | undefined;

function open(): MemoryRepoService {
  if (service) return service;
  if (!options) throw new Error("Memory repository worker was not opened.");
  // The index's directory must exist before SQLite opens it. This is the
  // worker thread, so the synchronous mkdir never blocks the gateway.
  mkdirSync(
    dirname(
      options.indexPath ?? join(options.base, "memory-repo-index.sqlite"),
    ),
    { recursive: true },
  );
  service = new MemoryRepoService(options);
  return service;
}

function reply(response: MemoryRepoWorkerResponse): void {
  self.postMessage(response);
}

self.onmessage = async (event: MessageEvent<MemoryRepoWorkerRequest>) => {
  const request = event.data;
  if (request.t === "open") {
    if (options && options.base !== request.options.base) {
      service?.close();
      service = undefined;
    }
    options = request.options;
    if (service) Object.assign(service.opts, request.options);
    return;
  }
  try {
    const target = open();
    let value: unknown;
    if (request.target === "service") {
      if (!(SERVICE_METHODS as readonly string[]).includes(request.method))
        throw new Error(`Unknown memory service method ${request.method}`);
      const fn = (
        target as unknown as Record<string, (...a: unknown[]) => unknown>
      )[request.method];
      value = await fn.apply(target, request.args);
    } else {
      if (!(INDEX_METHODS as readonly string[]).includes(request.method))
        throw new Error(`Unknown memory index method ${request.method}`);
      const index = target.index as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      value = index[request.method].apply(target.index, request.args);
    }
    reply({ t: "ok", id: request.id, value });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    reply({
      t: "error",
      id: request.id,
      name: err.name,
      message: err.message,
      status: error instanceof MemoryRepoError ? error.status : undefined,
    });
  }
};
