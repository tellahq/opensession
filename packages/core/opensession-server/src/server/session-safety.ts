import { activeRunRecords } from "./run-journal";
import type { DurableSessionQuarantine } from "./session-kernel/store";
import type { SessionSafetyState } from "./types";

const OPERATION_LABELS: Record<string, string> = {
  acknowledge: "saving the completed action",
  agent_operation: "an agent action",
  core: "updating session state",
  creation_event: "setting up the session",
  delivery: "delivering a message",
  gateway: "processing a session command",
  run_event: "updating the active run",
  run_state: "recovering the active run",
  timer: "running scheduled work",
  turn: "finishing the current turn",
};

/** Human-facing operation name. The durable command kind stays available to
 * operators through the admin reliability endpoint, never through this view. */
export function safetyOperationLabel(commandKind: string): string {
  const normalized = commandKind
    .replace(/^store:/, "")
    .replace(/^command:/, "");
  const [kind, operation] = normalized.split(":", 2);
  if (OPERATION_LABELS[kind]) return OPERATION_LABELS[kind];
  if (operation) return operation.replaceAll("_", " ");
  return normalized.replaceAll("_", " ") || "session work";
}

export function automaticallyRecoverableSessionSafety(
  quarantine: DurableSessionQuarantine,
): boolean {
  const committedOutboxSettlement =
    (quarantine.commandKind === "core:ack_outbox" ||
      quarantine.commandKind === "core:fail_outbox") &&
    /^Outbox \d+ crossed session ownership$/.test(quarantine.reason);
  // Catalog quarantine projections intentionally do not open per-session
  // databases, so their repairable bit cannot include the matching durable
  // outbox-route proof. Admit the narrowly shaped candidate here; the release
  // reducer performs the authoritative route + absence verification.
  if (committedOutboxSettlement) return true;
  if (!quarantine.repairable) return false;
  const actorRestart =
    quarantine.reason === "actor restarted before execution admission" ||
    quarantine.reason === "actor restarted before acknowledgement" ||
    quarantine.reason === "actor restarted after execution began";
  if (!actorRestart) return false;
  return (
    quarantine.commandKind === "gateway:complete" ||
    quarantine.commandKind === "gateway:fail" ||
    quarantine.commandKind === "delivery:complete_submit_command" ||
    quarantine.commandKind === "delivery:fail_submit_command"
  );
}

export async function reconcileAutomaticallyRecoverableSessionSafety(
  quarantines: DurableSessionQuarantine[],
  release: (sessionId: string) => Promise<boolean>,
): Promise<string[]> {
  const released: string[] = [];
  for (const quarantine of quarantines) {
    if (!automaticallyRecoverableSessionSafety(quarantine)) continue;
    if (await release(quarantine.sessionId))
      released.push(quarantine.sessionId);
  }
  return released;
}

export function automaticSafetyReconciliationRunning(
  sessionId: string,
  quarantine?: DurableSessionQuarantine,
  claimedJournalSessions?: ReadonlySet<string>,
): boolean {
  return (
    (!!quarantine && automaticallyRecoverableSessionSafety(quarantine)) ||
    (claimedJournalSessions
      ? claimedJournalSessions.has(sessionId)
      : activeRunRecords().some(
          (run) => run.osSessionId === sessionId && !!run.claimedAt,
        ))
  );
}

export function publicSessionSafety(
  quarantine: DurableSessionQuarantine,
  claimedJournalSessions?: ReadonlySet<string>,
): SessionSafetyState {
  return {
    status: "paused_for_safety",
    explanation:
      "Open Session paused because it couldn't verify the last action. It won't retry automatically.",
    automaticReconciliationRunning: automaticSafetyReconciliationRunning(
      quarantine.sessionId,
      quarantine,
      claimedJournalSessions,
    ),
    pausedAt: new Date(quarantine.quarantinedAt).toISOString(),
    operation: safetyOperationLabel(quarantine.commandKind),
    repairAvailable:
      quarantine.repairable ||
      automaticallyRecoverableSessionSafety(quarantine),
  };
}
