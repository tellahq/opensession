import { createHash } from "node:crypto";
import { isGithubAccountId } from "../shared/access-scope";
import type { PersonalRepositoryDescriptor } from "./personal-github/types";
function unavailable(): never {
  throw new Error("Personal repository unavailable");
}
export function validatePersonalRepositoryDescriptor(
  value: PersonalRepositoryDescriptor,
): PersonalRepositoryDescriptor {
  if (
    !value ||
    value.kind !== "personal" ||
    !isGithubAccountId(value.ownerGithubAccountId) ||
    !isGithubAccountId(value.githubAppId) ||
    !isGithubAccountId(value.installationId) ||
    !isGithubAccountId(value.repositoryId) ||
    !isGithubAccountId(value.accessRevision) ||
    value.repositoryOwnerGithubAccountId !== value.ownerGithubAccountId ||
    typeof value.appRecordId !== "string" ||
    !value.appRecordId ||
    value.appRecordId.length > 256 ||
    typeof value.fullName !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.fullName)
  )
    unavailable();
  return Object.freeze({
    kind: "personal",
    ownerGithubAccountId: value.ownerGithubAccountId,
    appRecordId: value.appRecordId,
    githubAppId: value.githubAppId,
    installationId: value.installationId,
    repositoryId: value.repositoryId,
    repositoryOwnerGithubAccountId: value.repositoryOwnerGithubAccountId,
    accessRevision: value.accessRevision,
    fullName: value.fullName,
  });
}

export function personalRepositoryId(
  value: PersonalRepositoryDescriptor,
): string {
  const descriptor = validatePersonalRepositoryDescriptor(value);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        descriptor.ownerGithubAccountId,
        descriptor.appRecordId,
        descriptor.repositoryId,
      ]),
    )
    .digest("hex");
  return `personal-${digest}`;
}

export function snapshotPersonalRepoBinding(
  value: import("./personal-repo-runtime").PersonalRepoBinding,
) {
  if (
    typeof value.registryId !== "string" ||
    !value.registryId ||
    value.registryId.length > 256
  )
    unavailable();
  return Object.freeze({
    registryId: value.registryId,
    descriptor: validatePersonalRepositoryDescriptor(value.descriptor),
  });
}

export function samePersonalRepoIdentity(
  a: import("./personal-repo-runtime").PersonalRepoBinding,
  b: import("./personal-repo-runtime").PersonalRepoBinding,
): boolean {
  return (
    a.registryId === b.registryId &&
    (
      [
        "ownerGithubAccountId",
        "appRecordId",
        "githubAppId",
        "installationId",
        "repositoryId",
        "repositoryOwnerGithubAccountId",
        "accessRevision",
      ] as const
    ).every((key) => a.descriptor[key] === b.descriptor[key])
  );
}
