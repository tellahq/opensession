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

/** Sender of a turn relayed from a Plain discussion (Ask Sidekick). A
 *  teammate wrote it, but the name is the channel, not a person: it must
 *  not unlock what a present person unlocks, nor bill a subscription. */
export const PLAIN_ACTOR = "Plain";

/** Suffix an automation's own ticks carry as `createdBy`/sender:
 *  `"<automation name> (automation)"` (automations.ts). */
export const AUTOMATION_ACTOR_SUFFIX = " (automation)";

/** Suffix a `/loop` tick carries as sender: `"<person who set it> (loop)"`
 *  (run-session's loop ticker). `LOOP_ACTOR` is the senderless form. */
export const LOOP_ACTOR_SUFFIX = " (loop)";
export const LOOP_ACTOR = "loop";

/** Suffix a scheduled check-back (opensession-schedule's schedule_prompt)
 *  carries as sender: `"<person whose session it is> (scheduled)"`. */
export const SCHEDULED_ACTOR_SUFFIX = " (scheduled)";
export const SCHEDULED_ACTOR = "scheduled";

/** Sender for a delivered scheduled prompt. Same contract as `loopActor`:
 *  the person keeps ownership, commit identity and provider account, but
 *  the agent wrote the prompt, so nobody pressed send. */
export function scheduledActor(setBy?: string | null): string {
  const name = scheduledOwner(setBy);
  return name ? `${name}${SCHEDULED_ACTOR_SUFFIX}` : SCHEDULED_ACTOR;
}

/** The person behind a sender, with every scheduler suffix removed. A
 *  check-back that schedules the next one runs as `"<person> (scheduled)"`;
 *  without this each round appended another suffix until the sender grew
 *  past what transcript attribution parses and the check-back rendered as
 *  the person's own message. */
export function scheduledOwner(sender?: string | null): string {
  let name = (sender || "").trim();
  for (;;) {
    const lower = name.toLowerCase();
    if (lower === SCHEDULED_ACTOR || lower === LOOP_ACTOR) return "";
    const suffix = [SCHEDULED_ACTOR_SUFFIX, LOOP_ACTOR_SUFFIX].find((s) =>
      lower.endsWith(s),
    );
    if (!suffix) return name;
    name = name.slice(0, -suffix.length).trim();
  }
}

/** Sender for a scheduled `/loop` tick. The person who set the loop stays
 *  in the name: the session is still theirs (ownership, commit identity,
 *  provider account), but no person pressed send on this turn. */
export function loopActor(setBy?: string | null): string {
  const name = (setBy || "").trim();
  return name ? `${name}${LOOP_ACTOR_SUFFIX}` : LOOP_ACTOR;
}

/**
 * True for a sender our scheduler minted on a person's behalf (`loopActor`,
 * `scheduledActor`). Not a machine actor: the person is credited, so
 * `humanPrompter` keeps the name. But nothing that requires a person to be
 * present right now (the spawn suite an automation-owned session earns on a
 * human's turn) may treat a scheduled tick as that person; use
 * `interactivePrompter` there.
 */
export function isScheduledActor(sender?: string | null): boolean {
  const lower = (sender || "").trim().toLowerCase();
  return (
    lower === LOOP_ACTOR ||
    lower.endsWith(LOOP_ACTOR_SUFFIX) ||
    lower === SCHEDULED_ACTOR ||
    lower.endsWith(SCHEDULED_ACTOR_SUFFIX)
  );
}

/**
 * The person who sent this turn themselves, or null: excludes every machine
 * actor (`humanPrompter`) and every scheduled tick sent in a person's name
 * (`isScheduledActor`). Decides capabilities a present person unlocks, never
 * credit or billing.
 */
export function interactivePrompter(user?: string | null): string | null {
  const name = humanPrompter(user);
  return name && !isScheduledActor(name) ? name : null;
}

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
    lower === PLAIN_ACTOR.toLowerCase() ||
    lower.endsWith(AUTOMATION_ACTOR_SUFFIX) ||
    // The agent's own name: a session it started with no person to credit.
    sameBrand(name, personaName()) ||
    sameBrand(name, productMark()) ||
    sameBrand(name, productName()) ||
    delegatedActorParent(name) !== null
  );
}

/**
 * The person behind a prompt, or null when nobody is: a machine sender, an
 * empty sender, or the anonymous placeholder. This is what a session records
 * as `lastPromptedBy`, so only people ever become a session's principal.
 */
export function humanPrompter(user?: string | null): string | null {
  const name = (user || "").trim();
  if (!name || name.toLowerCase() === "anonymous" || isMachineActor(name))
    return null;
  return name;
}

/**
 * The person a session currently acts for: the last person who prompted it,
 * else whoever started it.
 *
 * A turn with no human sender (a review handoff, an auto-continue nudge, a
 * queue drain, a restart resume) commits and opens PRs on this person's
 * behalf. Before `lastPromptedBy` existed the fallback was always the
 * creator, so a session one teammate started and another took over kept
 * crediting the one who left: Michiel rewrote a PR in Grant's session, the
 * review handoff that followed committed the fix, and the trailer named
 * Grant again (tella-fusion#6348). A stored sender that is somehow a sentinel
 * is ignored rather than trusted.
 */
export function sessionPrincipal(session: {
  startedBy?: string | null;
  lastPromptedBy?: string | null;
}): string | null {
  return humanPrompter(session.lastPromptedBy) ?? session.startedBy ?? null;
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
