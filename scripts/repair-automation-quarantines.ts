#!/usr/bin/env bun
/**
 * Offline operator job: recover automation sessions stranded by the missing
 * run-state settlement that `settleAutomationRunState` now prevents.
 *
 * These sessions cannot be recovered online. The wedge detector fenced them
 * with `run_state:<state>`, and `quarantineRepairEvidence` refuses to release
 * while the run state is unsettled, so the fence reports `repairable: false`
 * and an explicit release is a no-op. The actor also fences every session
 * mutation except quarantine/release, so nothing online can settle the state
 * either. This job repairs the cause offline; the release reducer then passes
 * on its own unmodified merits.
 *
 * Run with the instance stopped:
 *   sudo systemctl stop opensession opensession-executor opensession-session-kernel
 *   bun scripts/repair-automation-quarantines.ts --dry-run
 *   bun scripts/repair-automation-quarantines.ts
 *   sudo systemctl start opensession
 */
import { dirname } from "node:path";
import { assertServicesStopped } from "./migrate-actor-transcripts";
import {
  listAutomations,
  type AutomationRun,
} from "../packages/core/opensession-server/src/server/automations";
import { activeRunRecords } from "../packages/core/opensession-server/src/server/run-journal";
import { sessionKernelDbPath } from "../packages/core/opensession-server/src/server/session-kernel/store";
import {
  repairSettledAutomationQuarantines,
  type AutomationLedgerStatus,
} from "../packages/core/opensession-server/src/server/session-kernel/automation-quarantine-repair";

/**
 * The automation ledger's terminal verdict per session. This is the durable
 * receipt that `runAutomation` drained its stream and reached its completion
 * tail — the exact state the missing settlement stranded.
 */
export function automationLedgerVerdicts(
  automations: Array<{ runs?: AutomationRun[] }> = listAutomations(),
): Map<string, AutomationLedgerStatus> {
  const verdicts = new Map<string, AutomationLedgerStatus>();
  for (const automation of automations) {
    for (const run of automation.runs || []) {
      if (!run.sessionId) continue;
      // A session can only have one ledger entry; if a duplicate ever appears,
      // the least settled verdict wins so the repair stays fail-closed.
      const prior = verdicts.get(run.sessionId);
      if (prior === "running") continue;
      verdicts.set(run.sessionId, run.status);
    }
  }
  return verdicts;
}

/** Every session id any journal record still names, by any of its aliases. */
export function journaledSessionIds(records = activeRunRecords()): Set<string> {
  const owned = new Set<string>();
  for (const record of records)
    for (const id of [
      record.osSessionId,
      record.claudeSessionId,
      record.runKey,
    ])
      if (id) owned.add(id);
  return owned;
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  assertServicesStopped();
  const centralPath = value("--central") ?? sessionKernelDbPath();
  const isolatedRoot =
    value("--isolated-root") ??
    `${dirname(centralPath)}/session-kernel-sessions`;
  const dryRun =
    process.argv.includes("--dry-run") || process.argv.includes("--audit");
  const startedAt = performance.now();

  const verdicts = automationLedgerVerdicts();
  const journaled = journaledSessionIds();
  const result = repairSettledAutomationQuarantines({
    centralPath,
    isolatedRoot,
    dryRun,
    ledgerStatus: (sessionId) => verdicts.get(sessionId),
    journalBusy: (sessionId) => journaled.has(sessionId),
  });

  console.log(
    JSON.stringify(
      {
        ...result,
        centralPath,
        automationSessionsWithLedgerVerdict: verdicts.size,
        journaledSessions: journaled.size,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) main();
