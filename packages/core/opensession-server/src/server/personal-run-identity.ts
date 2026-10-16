import { createHash } from "node:crypto";
import type { PersonalRepoBinding } from "./personal-repo-runtime";
import {
  personalRepositoryId,
  validatePersonalRepositoryDescriptor,
} from "./personal-repository-identity";
export interface PersonalRunConsumer {
  runKey: string;
  hostId: string;
  sessionId: string;
  binding: PersonalRepoBinding;
  sourceAuthority?: {
    readonly incarnation: string;
    readonly generation: number;
  };
}
export function snapshotPersonalRunConsumer(
  input: PersonalRunConsumer,
): PersonalRunConsumer {
  const d = validatePersonalRepositoryDescriptor(input.binding?.descriptor);
  if (
    input.binding.registryId !== personalRepositoryId(d) ||
    ![input.runKey, input.hostId, input.sessionId].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 256,
    )
  )
    throw new Error("Invalid private run consumer");
  const source = input.sourceAuthority;
  if (
    source &&
    (typeof source.incarnation !== "string" ||
      !source.incarnation ||
      !Number.isSafeInteger(source.generation) ||
      source.generation < 0)
  )
    throw new Error("Invalid private consumer source authority");
  return Object.freeze({
    ...(source
      ? {
          sourceAuthority: Object.freeze({
            incarnation: source.incarnation,
            generation: source.generation,
          }),
        }
      : {}),
    runKey: input.runKey,
    hostId: input.hostId,
    sessionId: input.sessionId,
    binding: Object.freeze({
      registryId: input.binding.registryId,
      descriptor: d,
    }),
  });
}
export function personalRunConsumerKey(input: PersonalRunConsumer): string {
  const v = snapshotPersonalRunConsumer(input),
    d = v.binding.descriptor;
  return createHash("sha256")
    .update(
      JSON.stringify([
        v.runKey,
        v.hostId,
        v.sessionId,
        v.binding.registryId,
        d.ownerGithubAccountId,
        d.appRecordId,
        d.githubAppId,
        d.installationId,
        d.repositoryId,
        d.repositoryOwnerGithubAccountId,
        d.accessRevision,
      ]),
    )
    .digest("hex");
}
/** No-relaunch intent covers every physical host in one logical run lineage. */
export function personalRunLineageKey(input: PersonalRunConsumer): string {
  const snapshot = snapshotPersonalRunConsumer(input);
  return personalRunConsumerKey({ ...snapshot, hostId: "logical-lineage" });
}
