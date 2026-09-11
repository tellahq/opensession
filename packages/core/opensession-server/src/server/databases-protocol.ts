/**
 * Wire protocol between the gateway's Databases facade (databases.ts) and the
 * worker that owns the SQLite files (databases-worker.ts). Requests carry a
 * monotonically increasing id; the worker answers each in order, so a read
 * posted after a write observes that write.
 */
import type { StateContext } from "./paths";
import type { DatabasesStore } from "./databases-sqlite";

/** The store directory, in the legacy spelling statePath rules resolve:
 *  `~/.opensession/databases` or the isolated state root's `databases`. */
export const DATABASES_STATE_NAME = ".opensession-databases";

/** Store methods the facade may invoke by name. Anything else is refused. */
export const DATABASES_STORE_METHODS = [
  "create",
  "list",
  "get",
  "findByName",
  "listForSession",
  "update",
  "remove",
  "describe",
  "query",
  "rows",
  "exportCsv",
  "exportCopy",
  "execute",
  "insertRows",
] as const;

export type DatabasesStoreMethod = (typeof DATABASES_STORE_METHODS)[number];

export type DatabasesStoreArgs<M extends DatabasesStoreMethod> = Parameters<
  DatabasesStore[M]
>;
export type DatabasesStoreResult<M extends DatabasesStoreMethod> = ReturnType<
  DatabasesStore[M]
>;

/** Test hooks. The worker honours them only under NODE_ENV=test. */
export type DatabasesDebugAction =
  | { action: "stall"; ms: number }
  | { action: "crash" };

export type DatabasesWorkerRequest =
  | { t: "open"; context: StateContext }
  | { t: "call"; id: number; method: DatabasesStoreMethod; args: unknown[] }
  | ({ t: "debug"; id: number } & DatabasesDebugAction);

export type DatabasesWorkerResponse =
  | { t: "result"; id: number; value: unknown }
  | { t: "error"; id: number; name: string; message: string };

export function isDatabasesStoreMethod(
  value: unknown,
): value is DatabasesStoreMethod {
  return (
    typeof value === "string" &&
    (DATABASES_STORE_METHODS as readonly string[]).includes(value)
  );
}
