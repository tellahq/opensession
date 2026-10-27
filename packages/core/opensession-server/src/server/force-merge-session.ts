/**
 * force_merge_pull_request for one session: who may confirm, and which PR.
 * The card and the merge itself live in force-merge.ts.
 */
import {
  ForceMergeError,
  requestForceMerge,
  type ForceMergeOutcome,
} from "./force-merge";
import type { MergeMethod } from "./pr-contract";
import { findSession } from "./session-cache";
import { resolvePrReadinessTarget } from "./session-repos";
import { trustedGithubTeammate } from "./shared/user-mappings";
import { webAuthRequired } from "./web-auth";

/** Why this session cannot open a force-merge card, or null. */
export function forceMergeRefusal(
  session:
    | {
        automation?: unknown;
        automationId?: unknown;
        automationDescendantPolicy?: unknown;
      }
    | undefined,
  user: string | undefined,
  signInRequired: boolean,
): string | null {
  if (
    session?.automation ||
    session?.automationId ||
    session?.automationDescendantPolicy
  )
    return "Force merge is not available to automation runs.";
  if (!signInRequired)
    return "Force merge needs GitHub sign-in on this instance, so a person can confirm it. Merge the PR on GitHub instead.";
  if (!trustedGithubTeammate(user))
    return "Only a signed-in teammate driving this session can confirm a force merge.";
  return null;
}

export async function forceMergeForSession(
  sessionId: string,
  user: string | undefined,
  input: {
    url?: string;
    repo?: string;
    number?: number;
    reason: string;
    method?: MergeMethod;
  },
  signal?: AbortSignal,
): Promise<ForceMergeOutcome> {
  const refusal = forceMergeRefusal(
    findSession(sessionId),
    user,
    webAuthRequired(),
  );
  if (refusal) throw new ForceMergeError(refusal, 403);
  const target = await resolvePrReadinessTarget(sessionId, input);
  return requestForceMerge(
    sessionId,
    {
      target,
      reason: input.reason,
      ...(input.method ? { method: input.method } : {}),
      driver: trustedGithubTeammate(user)!,
    },
    signal,
  );
}
