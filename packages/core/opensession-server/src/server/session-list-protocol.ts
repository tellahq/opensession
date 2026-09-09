/**
 * Wire protocol between the gateway's session-list facade
 * (session-list-store.ts) and the worker that owns the SQLite index
 * (session-list-worker.ts). Requests carry a monotonically increasing id;
 * the worker answers each one in order, so a read posted after a write
 * observes that write.
 */
import type { StateContext } from "./paths";
import type { SessionListStore } from "./session-list-sqlite";

/** The index file, resolved with statePath rules inside the worker. */
export const SESSION_LIST_DB_FILE = ".opensession-session-list.db";

/** Store methods the facade may invoke by name. Anything else is refused. */
export const SESSION_LIST_STORE_METHODS = [
  "upsert",
  "upsertMany",
  "upsertManyCovered",
  "replaceAll",
  "markCovered",
  "hasCoverage",
  "remove",
  "get",
  "getWithVisibilityGroup",
  "listVisibilityGroup",
  "setArchived",
  "count",
  "list",
  "listCovered",
  "listLiveByBranch",
  "listLiveByBranchCovered",
  "listWorkspaceMembers",
  "listWorkspace",
  "listWorkspaceCovered",
  "activeWorkspaceIds",
  "activeWorkspaceIdsCovered",
  "listSidebar",
  "listSidebarCovered",
] as const;

export type SessionListStoreMethod =
  (typeof SESSION_LIST_STORE_METHODS)[number];

export type SessionListStoreArgs<M extends SessionListStoreMethod> = Parameters<
  SessionListStore[M]
>;
export type SessionListStoreResult<M extends SessionListStoreMethod> =
  ReturnType<SessionListStore[M]>;

/** Test hooks. The worker honours them only under NODE_ENV=test. */
export type SessionListDebugAction =
  | { action: "stall"; ms: number }
  | { action: "crash" };

export type SessionListWorkerRequest =
  | { t: "open"; context: StateContext }
  | {
      t: "call";
      id: number;
      method: SessionListStoreMethod;
      args: unknown[];
    }
  | ({ t: "debug"; id: number } & SessionListDebugAction);

export type SessionListWorkerResponse =
  | { t: "result"; id: number; value: unknown }
  | { t: "error"; id: number; message: string };

export function isSessionListStoreMethod(
  value: unknown,
): value is SessionListStoreMethod {
  return (
    typeof value === "string" &&
    (SESSION_LIST_STORE_METHODS as readonly string[]).includes(value)
  );
}
