import type { openTrustedHostConnections } from "./service";
export type PersonalConnectionService = Awaited<
  ReturnType<typeof openTrustedHostConnections>
>["connections"];
export const CONNECTION_METHODS = [
  "acknowledgeDisclosure",
  "beginManifest",
  "completeManifest",
  "status",
  "startGrant",
  "pollGrant",
  "refresh",
  "disconnect",
] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];
export type ConnectionRequest = {
  [K in ConnectionMethod]: {
    method: K;
    args: Parameters<PersonalConnectionService[K]>;
  };
}[ConnectionMethod];
export interface PersonalConnectionClient {
  call<K extends ConnectionMethod>(
    method: K,
    ...args: Parameters<PersonalConnectionService[K]>
  ): ReturnType<PersonalConnectionService[K]>;
}

export type RepositoryService = NonNullable<
  Awaited<ReturnType<typeof openTrustedHostConnections>>["repositories"]
>;
export interface PersonalRepositoryClient extends PersonalConnectionClient {
  readonly repositoryAdmission: boolean;
  register(
    ...args: Parameters<RepositoryService["register"]>
  ): ReturnType<RepositoryService["register"]>;
  /** Server/runtime only. No HTTP/MCP dispatcher may expose this method. */
  resolveCredential(
    ...args: Parameters<RepositoryService["resolveCredential"]>
  ): ReturnType<RepositoryService["resolveCredential"]>;
}
export const COORDINATOR_METHODS = [
  "register",
  "assertCurrent",
  "revoke",
  "reconcile",
] as const;
export type CoordinatorMethod = (typeof COORDINATOR_METHODS)[number];
export type Coordinator =
  import("./repository-coordinator").PersonalRepositoryCoordinator;
