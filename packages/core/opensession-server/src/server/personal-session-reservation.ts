import { sessionMetadata } from "./session-kernel";
import type { PersonalRepoBinding } from "./personal-repo-runtime";
import type { NativeSessionFile } from "./types";

/** Dedicated central reservation RPC, never operator seeding or actor-first
 * discovery. The worker atomically owns the id, intent and repository binding. */
export async function reservePersonalSession(input: {
  sessionId: string;
  createIdentity: string;
  ownerGithubAccountId: number;
  binding: PersonalRepoBinding;
  title?: string;
  createdBy?: string;
  createdByLogin?: string;
  model?: string;
}): Promise<{
  sessionId: string;
  created: boolean;
  document: NativeSessionFile;
}> {
  const result = await sessionMetadata({
    op: "reserve_creation",
    sessionId: input.sessionId,
    createIdentity: input.createIdentity,
    accessScope: {
      kind: "personal",
      ownerGithubAccountId: input.ownerGithubAccountId,
    },
    principal: { githubAccountId: input.ownerGithubAccountId },
    binding: input.binding,
    defaults: {
      title: input.title,
      createdBy: input.createdBy,
      createdByLogin: input.createdByLogin,
      model: input.model,
    },
  });
  if (!result.document)
    throw new Error("Private reservation document unavailable");
  return {
    ...result,
    document: JSON.parse(result.document) as NativeSessionFile,
  };
}

/** Shared callers also claim an id before actor/FSM effects, so a concurrent
 * private creation cannot acquire an id after a shared missing-row check. */
export async function reserveSharedSessionCreation(
  sessionId: string,
  createIdentity: string,
): Promise<void> {
  await sessionMetadata({
    op: "reserve_creation",
    sessionId,
    createIdentity,
    accessScope: { kind: "shared" },
  });
}
