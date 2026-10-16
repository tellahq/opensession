import type { PersonalRevocationSink } from "./broker-core";
import type { PersonalRepositoryDescriptor } from "./types";
/** Gateway-owned authoritative catalog/runtime adapter. Callbacks must never
 * re-enter this broker's owner lane. They carry no credentials. */
export interface PersonalRepositoryCoordinator extends PersonalRevocationSink {
  register(
    descriptor: PersonalRepositoryDescriptor,
  ): Promise<{ registryId: string }>;
  assertCurrent(
    owner: number,
    descriptor: PersonalRepositoryDescriptor,
  ): Promise<void>;
}
export type PersonalCredentialKind = "installation-read" | "installation-write";
/** Runtime authority is always narrowed to one numeric repository. */
export function isPersonalCredentialKind(
  value: unknown,
): value is PersonalCredentialKind {
  return value === "installation-read" || value === "installation-write";
}
/** Internal runtime result ONLY. Never serialize through an HTTP/MCP route. */
export interface PersonalRepositoryCredential {
  token: string;
  expiresAt: number | null;
  kind: PersonalCredentialKind;
  ownerGithubAccountId: number;
  appRecordId: string;
  repositoryId: number;
  installationId: number;
  accessRevision: number;
  fullName: string;
}
