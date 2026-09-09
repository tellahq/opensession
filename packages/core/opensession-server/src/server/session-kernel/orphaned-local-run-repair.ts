/** Offline operator repair for a run-state quarantine whose exact local host
 * has a terminal journal receipt and whose systemd cgroup is empty. This is
 * deliberately not an actor RPC: a stopped gateway/executor/kernel is part of
 * the proof. Other quarantine reasons and ambiguous effects stay fenced. */
import type { DurableRunState, SessionKernelStore } from "./store";
import { ORPHANED_RUN_QUARANTINE_REASON } from "./automation-quarantine-repair";

export type StoppedLocalRunProof = {
  hostId: string;
  terminalAt: number;
  exitedAt: number;
  outcome: "done" | "error";
};

/** The host's terminal event and systemd's later successful deactivation must
 * belong to this exact unit. A later start or an incomplete journal fails
 * closed. Only systemd PID 1 can supply the deactivation receipt. */
export function stoppedLocalRunJournalProof(
  hostId: string,
  since: number,
  journal: string,
): StoppedLocalRunProof | undefined {
  if (!/^rh-[a-zA-Z0-9-]+$/.test(hostId) || !Number.isFinite(since))
    return undefined;
  const unit = `bks-run-${hostId}.service`;
  const prefix = `[host ${hostId.slice(0, 11)}]`;
  let terminal: { at: number; outcome: "done" | "error" } | undefined;
  let exitedAt: number | undefined;
  for (const line of journal.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!row || typeof row !== "object") return undefined;
    const field = (key: string) =>
      key in row ? Reflect.get(row, key) : undefined;
    const message = field("MESSAGE");
    const at = Number(field("__REALTIME_TIMESTAMP")) / 1_000;
    if (typeof message !== "string" || !Number.isFinite(at)) return undefined;
    if (at < since) continue;
    if (field("_PID") === "1" && message.startsWith(`Started ${unit}`)) {
      terminal = undefined;
      exitedAt = undefined;
    }
    if (field("_SYSTEMD_UNIT") === unit) {
      const outcome =
        message === `${prefix} run ended: done`
          ? "done"
          : message === `${prefix} run ended: error`
            ? "error"
            : undefined;
      if (outcome) {
        terminal = { at, outcome };
        exitedAt = undefined;
      }
    }
    if (
      terminal &&
      at >= terminal.at &&
      field("_PID") === "1" &&
      message === `${unit}: Deactivated successfully.`
    )
      exitedAt = at;
  }
  return terminal && exitedAt !== undefined
    ? { hostId, terminalAt: terminal.at, exitedAt, outcome: terminal.outcome }
    : undefined;
}

export type LocalRunRepairResult =
  | { status: "skipped"; reason: string }
  | { status: "eligible"; hostId: string; from: string }
  | { status: "settled"; hostId: string; from: string };

/** Validate everything before the only state mutation. The caller subsequently
 * invokes the ordinary quarantine release through the store host, which still
 * checks pending commands, timers, effects, and catalog projections. */
export function settleStoppedLocalRun(options: {
  store: SessionKernelStore;
  sessionId: string;
  expected: DurableRunState;
  proof: StoppedLocalRunProof | undefined;
  journalBusy: boolean;
  hostInactive: boolean;
  cgroupEmpty: boolean;
  dryRun: boolean;
}): LocalRunRepairResult {
  const { store, sessionId, expected, proof } = options;
  const quarantine = store.quarantinedSession(sessionId);
  if (
    !quarantine ||
    quarantine.reason !== ORPHANED_RUN_QUARANTINE_REASON ||
    !quarantine.commandKind.startsWith("run_state:")
  )
    return {
      status: "skipped",
      reason: "not an orphaned run-state quarantine",
    };
  const current = store.runState(sessionId);
  if (
    current.currentRunId !== expected.currentRunId ||
    current.generation !== expected.generation ||
    current.changeSeq !== expected.changeSeq ||
    current.state !== expected.state
  )
    return { status: "skipped", reason: "run identity or revision changed" };
  if (
    !proof ||
    proof.hostId !== current.currentRunId ||
    proof.terminalAt < Date.parse(current.since) ||
    proof.exitedAt < proof.terminalAt ||
    !Number.isFinite(proof.terminalAt) ||
    !Number.isFinite(proof.exitedAt)
  )
    return {
      status: "skipped",
      reason: "no matching terminal host and exit receipts",
    };
  if (options.journalBusy)
    return {
      status: "skipped",
      reason: "a gateway journal still owns the session",
    };
  if (!options.hostInactive || !options.cgroupEmpty)
    return {
      status: "skipped",
      reason: "host inactivity and empty cgroup not proven",
    };
  // A completed host is not proof that its gateway projections committed. Mark
  // the interrupted orchestration failed, never successful, and retain queues.
  if (
    ![
      "preparing",
      "starting",
      "running",
      "ask_blocked",
      "interrupted",
      "reattaching",
    ].includes(current.state)
  )
    return { status: "skipped", reason: "run state is already terminal" };
  if (options.dryRun)
    return { status: "eligible", hostId: proof.hostId, from: current.state };
  const settled = store.applyRunEvent({
    sessionId,
    event: "run_failed",
    runKey: proof.hostId,
    detail: {
      source: "offline_stopped_local_run_repair",
      generation: current.generation,
      terminalAt: proof.terminalAt,
      exitedAt: proof.exitedAt,
      outcome: proof.outcome,
    },
  });
  if (!settled.accepted)
    return {
      status: "skipped",
      reason: `run settlement rejected: ${settled.reason}`,
    };
  return { status: "settled", hostId: proof.hostId, from: current.state };
}
