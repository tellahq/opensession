/** Pure run-state reducer shared by the autonomous actor and projections. */

export type RunState =
  | "idle"
  | "preparing"
  | "starting"
  | "running"
  | "ask_blocked"
  | "stopped"
  | "failed"
  | "interrupted"
  | "reattaching";

export type RunEvent =
  | "prompt"
  | "workspace_prepare"
  | "workspace_ready"
  | "workspace_failed"
  | "run_registered"
  | "start_failed"
  | "start_aborted"
  | "stop_lifted"
  | "ask_posed"
  | "ask_resolved"
  | "steer"
  | "turn_end"
  | "run_failed"
  | "cancel"
  | "engine_died"
  | "shutdown_orphaned"
  | "boot_journal_found"
  | "boot_owner_missing"
  | "reattach_start"
  | "reattach_ok"
  | "reattach_fail"
  | "resume_reprompt";

/**
 * The full transition table. Absence of an edge is load-bearing: an event
 * arriving in a state with no edge for it is exactly the illegal combination
 * this module exists to surface (e.g. `turn_end` while `idle` = a double
 * teardown; `ask_resolved` while `running` = an answer for an ask nobody's
 * waiting on).
 *
 * Deliberate leniency edges, so half-wired paths degrade to logging instead of
 * false alarms: `run_registered` straight from idle/stopped/failed/interrupted/
 * reattaching (a run path whose reserve/recovery marker isn't instrumented —
 * e.g. the Slack/Linear loops, or a domain-specific boot recovery); self-edges
 * for queue-while-busy (`prompt`), mid-run `steer`, rotation re-registration
 * (`run_registered` while running), and ask-overwrite (`ask_posed` while
 * ask_blocked); and `stopped` absorbing the cancelled run's own teardown
 * (`turn_end`/`run_failed` land after the Stop that caused them).
 */
export const RUN_STATE_TRANSITIONS: Record<
  RunState,
  Partial<Record<RunEvent, RunState>>
> = {
  idle: {
    prompt: "starting",
    workspace_prepare: "preparing",
    boot_journal_found: "interrupted",
    run_registered: "running",
  },
  preparing: {
    boot_owner_missing: "failed",
    boot_journal_found: "interrupted",
    workspace_ready: "idle",
    workspace_failed: "failed",
    cancel: "idle",
  },
  starting: {
    boot_owner_missing: "failed",
    boot_journal_found: "interrupted",
    run_registered: "running",
    start_failed: "failed",
    start_aborted: "idle",
    run_failed: "failed",
    cancel: "stopped",
    prompt: "starting",
  },
  running: {
    boot_owner_missing: "failed",
    boot_journal_found: "interrupted",
    ask_posed: "ask_blocked",
    turn_end: "idle",
    run_failed: "failed",
    cancel: "stopped",
    engine_died: "interrupted",
    shutdown_orphaned: "interrupted",
    prompt: "running",
    steer: "running",
    run_registered: "running",
  },
  ask_blocked: {
    boot_owner_missing: "failed",
    boot_journal_found: "interrupted",
    ask_resolved: "running",
    turn_end: "idle",
    run_failed: "failed",
    cancel: "stopped",
    engine_died: "interrupted",
    shutdown_orphaned: "interrupted",
    prompt: "ask_blocked",
    steer: "ask_blocked",
    ask_posed: "ask_blocked",
  },
  stopped: {
    boot_journal_found: "interrupted",
    stop_lifted: "idle",
    prompt: "starting",
    run_registered: "running",
    turn_end: "stopped",
    run_failed: "stopped",
    cancel: "stopped",
  },
  failed: {
    boot_journal_found: "interrupted",
    prompt: "starting",
    run_registered: "running",
  },
  interrupted: {
    boot_owner_missing: "failed",
    reattach_start: "reattaching",
    resume_reprompt: "starting",
    cancel: "stopped",
    engine_died: "interrupted",
    boot_journal_found: "interrupted",
    run_registered: "running",
    // An engine death mid-run fires engine_died → interrupted at the
    // watcher, then the run's own terminal outcome (recordRunOutcome)
    // lands moments later. A dead-server turn is lost, not resumable —
    // the follow-up outcome settles it as failed/idle rather than
    // rejecting.
    run_failed: "failed",
    turn_end: "idle",
  },
  reattaching: {
    boot_owner_missing: "failed",
    boot_journal_found: "interrupted",
    reattach_ok: "running",
    reattach_fail: "interrupted",
    run_failed: "failed",
    cancel: "stopped",
    engine_died: "interrupted",
    run_registered: "running",
  },
};

/** Pure lookup: the next state, or undefined when no edge exists. */
export function nextRunState(
  state: RunState,
  event: RunEvent,
): RunState | undefined {
  return RUN_STATE_TRANSITIONS[state]?.[event];
}
