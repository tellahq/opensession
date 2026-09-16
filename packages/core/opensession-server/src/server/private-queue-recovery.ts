import { assertPersonalAttachmentsAbsent } from "./personal-image-admission";
import { samePersonalRepoBinding } from "./personal-repo-runtime";
import type { PrivateQueueAdmission } from "./session-kernel/private-queue-admission";
import { sessionMetadata } from "./session-kernel";
import { withSessionExecutionAccess } from "./application-access";
import {
  withSessionPublication,
  currentPrivateActorFence,
} from "./session-audience";
import { snapshotPersonalRepoBinding } from "./personal-repository-identity";

/** Only actor-owned items obtained from the durable delivery projection belong here. */
export async function withPrivateQueueAdmission<T>(
  sessionId: string,
  items: readonly unknown[],
  work: () => Promise<T>,
): Promise<T> {
  if (!items.length) throw new Error("Private queue admission unavailable");
  const admissions = items.map((item) =>
    item && typeof item === "object" && "privateAdmission" in item
      ? (item.privateAdmission as PrivateQueueAdmission)
      : undefined,
  );
  const admission = admissions[0];
  if (
    !admission ||
    admission.sourceSessionId !== sessionId ||
    !Number.isSafeInteger(admission.owner) ||
    admission.owner <= 0 ||
    typeof admission.incarnation !== "string" ||
    !admission.incarnation ||
    !Number.isSafeInteger(admission.generation) ||
    admission.generation < 0 ||
    !admission.binding ||
    admissions.some(
      (value) => JSON.stringify(value) !== JSON.stringify(admission),
    )
  )
    throw new Error("Private queue original admission unavailable");
  for (const item of items)
    assertPersonalAttachmentsAbsent({
      ...(item as Record<string, unknown>),
      personalRepo: true,
    });
  const binding = snapshotPersonalRepoBinding(admission.binding);
  if (binding.descriptor.ownerGithubAccountId !== admission.owner)
    throw new Error("Private queue owner mismatch");
  const scope = await sessionMetadata({ op: "scope_lookup", sessionId });
  const clock = await sessionMetadata({ op: "scope_fence" });
  if (
    !scope ||
    scope.deleted ||
    scope.canonicalId !== sessionId ||
    scope.owner !== admission.owner ||
    scope.generation !== admission.generation ||
    clock.incarnation !== admission.incarnation
  )
    throw new Error("Private queue admission authority changed");
  const repository = await sessionMetadata({
    op: "repository_get",
    repositoryId: binding.registryId,
    principal: { githubAccountId: admission.owner },
  });
  const repo = repository ? JSON.parse(repository.doc) : undefined;
  if (
    !repo ||
    repo.blocked !== false ||
    !samePersonalRepoBinding(binding, {
      registryId: binding.registryId,
      descriptor: repo.personalGithub,
    })
  )
    throw new Error("Private queue repository authority changed");
  return withSessionExecutionAccess(
    {
      id: sessionId,
      accessScope: { kind: "personal", ownerGithubAccountId: admission.owner },
      personalRepo: binding,
    },
    () =>
      withSessionPublication(
        sessionId,
        admission.owner,
        async () => {
          const current = currentPrivateActorFence();
          if (
            !current ||
            current.incarnation !== admission.incarnation ||
            current.generation !== admission.generation
          )
            throw new Error("Private queue admission authority changed");
          return work();
        },
        { binding },
      ),
  );
}
