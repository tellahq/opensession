/**
 * Machine actors — the non-human `createdBy`/sender values our own code mints.
 *
 * A session records whoever started it in `createdBy`, and most of the time
 * that is a person. But several of our own paths start a session (or send the
 * message that starts one) under a sentinel instead: a delegated worker
 * reporting back, the auto-continue nudge, the wake after a restart, the
 * machine web identity local tooling signs in as. Those strings look exactly
 * like display names, so anything counting people has to be able to tell them
 * apart. Analytics counted all of them as humans until this module existed.
 *
 * The point of collecting them here is that the writers and the readers share
 * one definition: mint a sentinel with the helper below and `isMachineActor`
 * already knows about it. Adding a new sentinel elsewhere, spelled by hand, is
 * how the count drifts back.
 *
 * Pure and side-effect free — safe to import from anywhere.
 */

import { AUTO_CONTINUE_USER } from "./auto-continue";
import { personaName, productMark, productName } from "./config";
import { isNativeSessionId } from "./paths";
import { gitIdentityFor } from "./shared/user-mappings";

/** Sender for the turn a restart wakes (run-session.ts). */
export const SYSTEM_RESTART_USER = "system (restart)";

/** The machine web identity local tooling (captures, probes) signs in as. */
export const AUTOMATION_MACHINE_USER = "Automation";

/** Sender for sessions the GitHub review agent starts. */
export const GITHUB_ACTOR = "GitHub";

/** Sender for a worker session reporting back to the session that spawned it. */
export function workerActor(sessionId: string): string {
  return `worker ${sessionId}`;
}

/** Sender for a message one session sends another it does not parent. */
export function agentActor(sessionId: string): string {
  return `agent ${sessionId}`;
}

/**
 * The session id a `worker <id>` / `agent <id>` sender names, or null. Both
 * forms carry their own provenance, which is what lets a delegated session be
 * credited to whoever delegated it even when its parent link is missing.
 */
export function delegatedActorParent(actor?: string | null): string | null {
  const match = (actor || "").trim().match(/^(?:worker|agent)\s+(\S+)$/i);
  return match && isNativeSessionId(match[1]) ? match[1] : null;
}

/**
 * True only for the `worker <id>` form. The two senders are not
 * interchangeable: a worker reporting to its own parent carries the report
 * verbatim, while any other cross-session message is wrapped as a notice.
 */
export function isWorkerActor(actor?: string | null): boolean {
  const match = (actor || "").trim().match(/^worker\s+(\S+)$/i);
  return !!match && isNativeSessionId(match[1]);
}

/**
 * Compare two brand labels ignoring case and ornament. `createdBy` stores the
 * agent's name as it read the day the session started, so a mark that later
 * loses a "¹" or gains a "™" would otherwise strand every session before the
 * change. A real rename ("OS" to something else) still strands them: the
 * stored label is a copy, and nothing on disk records what it used to be.
 */
function sameBrand(a: string, b: string): boolean {
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, "");
  return !!key(a) && key(a) === key(b);
}

/** True when `createdBy` is one of our sentinels rather than a person. */
export function isMachineActor(createdBy?: string | null): boolean {
  const name = (createdBy || "").trim();
  if (!name) return false;
  // A configured teammate is never a sentinel, whatever they are called.
  // Cheap insurance against a login like "GitHub" reading as machine.
  if (gitIdentityFor(name)) return false;
  const lower = name.toLowerCase();
  return (
    lower === AUTO_CONTINUE_USER ||
    lower === SYSTEM_RESTART_USER ||
    lower === AUTOMATION_MACHINE_USER.toLowerCase() ||
    lower === GITHUB_ACTOR.toLowerCase() ||
    // The agent's own name: a session it started with no person to credit.
    sameBrand(name, personaName()) ||
    sameBrand(name, productMark()) ||
    sameBrand(name, productName()) ||
    delegatedActorParent(name) !== null
  );
}

/**
 * Identity whose personal provider subscription may serve this turn.
 *
 * Human-authored messages use the prompter's account. Machine-authored
 * continuations (worker reports, auto-continue, restart recovery) inherit the
 * interactive session owner's account instead of becoming an unknown user and
 * incorrectly declaring the shared pool dry. A machine-owned session stays
 * pool-only: never turn one synthetic actor into another person's authority.
 */
export function providerAccountUser(
  promptUser?: string | null,
  sessionOwner?: string | null,
): string | undefined {
  if (promptUser && !isMachineActor(promptUser)) return promptUser;
  if (sessionOwner && !isMachineActor(sessionOwner)) return sessionOwner;
  return undefined;
}

/**
 * Display label for a machine actor. A delegated sender collapses to its kind
 * — one "Worker sessions" row rather than a row per spawned session id, which
 * is what made the owner tables unreadable.
 */
export function machineActorLabel(createdBy?: string | null): string {
  const name = (createdBy || "").trim();
  const match = name.match(/^(worker|agent)\s+(\S+)$/i);
  if (match && isNativeSessionId(match[2]))
    return match[1].toLowerCase() === "worker"
      ? "Worker sessions"
      : "Agent sessions";
  return name === name.toLowerCase()
    ? name.charAt(0).toUpperCase() + name.slice(1)
    : name;
}
