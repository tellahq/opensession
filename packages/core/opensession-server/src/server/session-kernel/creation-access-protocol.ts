import {
  canAccessScope,
  isGithubAccountId,
  parseAccessScope,
  type AccessScope,
  type AccessPrincipal,
} from "../../shared/access-scope";
import type { PersonalRepoBinding } from "../personal-repo-runtime";
export interface CreationAccessReservation {
  op: "reserve_creation";
  sessionId: string;
  createIdentity: string;
  accessScope: AccessScope;
  principal?: AccessPrincipal;
  binding?: PersonalRepoBinding;
  defaults?: {
    title?: string;
    createdBy?: string;
    createdByLogin?: string;
    model?: string;
  };
}
export interface CreationAccessReservationResult {
  sessionId: string;
  created: boolean;
  document: string | null;
}
export function assertCreationAccessReservation(
  input: CreationAccessReservation,
): void {
  const scope = parseAccessScope(input.accessScope);
  if (
    !scope ||
    input.accessScope === undefined ||
    typeof input.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(input.sessionId) ||
    typeof input.createIdentity !== "string" ||
    !input.createIdentity ||
    input.createIdentity.length > 512 ||
    !canAccessScope(scope, input.principal)
  )
    throw new Error("Session creation unavailable");
  if (scope.kind === "shared" && input.binding)
    throw new Error("Private binding cannot enter shared creation");
  if (scope.kind === "personal") {
    const d = input.binding?.descriptor;
    if (
      !input.binding ||
      typeof input.binding.registryId !== "string" ||
      input.binding.registryId.length > 256 ||
      d?.kind !== "personal" ||
      d.ownerGithubAccountId !== scope.ownerGithubAccountId ||
      d.repositoryOwnerGithubAccountId !== scope.ownerGithubAccountId ||
      ![
        d.githubAppId,
        d.installationId,
        d.repositoryId,
        d.accessRevision,
      ].every(isGithubAccountId)
    )
      throw new Error("Private creation binding unavailable");
  }
}
