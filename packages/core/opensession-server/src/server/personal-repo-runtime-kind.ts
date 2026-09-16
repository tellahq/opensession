/** Host/policy-worker ONLY: existing roster/persona helpers read config.
 * Gateway callers must use the asynchronous policy client instead. */
import type { RunHostSpec } from "../runner-host/protocol";
import { githubCredentialUser } from "./auto-continue";
import { isMachineActor } from "./session-actors";
import {
  INTERACTIVE_KINDS,
  baseJournalKind,
  runToolPolicy,
} from "./run-policy";
import { personalCredentialKind } from "./personal-repo-runtime-default";

export function personalHostCredentialKind(
  spec: Pick<
    RunHostSpec,
    "mode" | "user" | "author" | "journalKind" | "deniedTools" | "confirmTools"
  >,
) {
  const journalKind = spec.journalKind || "prompt";
  const policy = runToolPolicy({
    journalKind,
    deniedTools: spec.deniedTools,
    confirmTools: spec.confirmTools,
  });
  const ownerTurn =
    !policy.unattended &&
    INTERACTIVE_KINDS.has(baseJournalKind(journalKind)) &&
    !isMachineActor(githubCredentialUser(spec.user, spec.author?.name));
  return personalCredentialKind(spec.mode === "code", ownerTurn);
}
