#!/usr/bin/env bun
/** Offline recovery, using the same stopped-service boundary as transcript and
 * automation quarantine repairs. Explicit session ids only, maximum 16. Never
 * enumerates placements, deletes queued prompts, or alters transcript rows.
 *
 * Hold ~/.opensession/deploy/.lock for the maintenance window, stop gateway,
 * executor and kernel, run with --dry-run first, then run without it. Restore
 * the same pinned services in kernel/executor/gateway order and check health.
 *
 * bun scripts/repair-orphaned-local-runs.ts --sessions-dir <path> --session <id>
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertServicesStopped } from "./migrate-actor-transcripts";
import { SessionKernelStoreHost } from "../packages/core/opensession-server/src/server/session-kernel/store-host";
import { ORPHANED_RUN_QUARANTINE_REASON } from "../packages/core/opensession-server/src/server/session-kernel/automation-quarantine-repair";
import {
  settleStoppedLocalRun,
  stoppedLocalRunJournalProof,
} from "../packages/core/opensession-server/src/server/session-kernel/orphaned-local-run-repair";

export function journalOwnsSession(
  value: unknown,
  sessionId: string,
  hostId?: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid gateway journal");
  let owns = false;
  for (const record of Object.values(value)) {
    if (
      !record ||
      typeof record !== "object" ||
      !("runKey" in record) ||
      typeof record.runKey !== "string"
    )
      throw new Error("Invalid gateway journal record");
    for (const key of ["runKey", "osSessionId", "claudeSessionId", "hostId"]) {
      const id: unknown = Reflect.get(record, key);
      if (id !== undefined && typeof id !== "string")
        throw new Error("Invalid journal identity");
      if (id === sessionId || (hostId !== undefined && id === hostId))
        owns = true;
    }
  }
  return owns;
}

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `${args[0]} failed with exit ${code}: ${error.slice(0, 200)}`,
    );
  if (output.length > 2 * 1024 * 1024)
    throw new Error("Evidence exceeds the read bound");
  return output;
}

async function emptyCgroup(hostId: string): Promise<boolean> {
  try {
    return !(
      await readFile(
        `/sys/fs/cgroup/system.slice/bks-run-${hostId}.service/cgroup.procs`,
        "utf8",
      )
    ).trim();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return true;
    throw error;
  }
}

async function main(): Promise<void> {
  assertServicesStopped();
  const args = process.argv.slice(2);
  const sessions: string[] = [];
  let directory: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session") sessions.push(args[++i] ?? "");
    else if (args[i] === "--sessions-dir") directory = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (
    !directory ||
    !directory.startsWith("/") ||
    sessions.length < 1 ||
    sessions.length > 16 ||
    sessions.some((id) => !/^(os|bks)-[a-zA-Z0-9-]+$/.test(id)) ||
    new Set(sessions).size !== sessions.length
  )
    throw new Error(
      "Pass an absolute --sessions-dir and 1 to 16 unique --session ids",
    );
  // Explicit path, not OPENSESSION_RUN_JOURNAL: this CLI may itself execute
  // inside a detached host whose environment points at its private journal.
  const journal: unknown = JSON.parse(
    await readFile(join(directory, "active-runs.json"), "utf8"),
  );
  const host = new SessionKernelStoreHost(
    join(directory, "session-kernel.sqlite"),
    join(directory, "session-kernel-sessions"),
  );
  try {
    for (const sessionId of sessions) {
      const store = host.storeForSession(sessionId);
      const quarantine = store.quarantinedSession(sessionId);
      if (
        !quarantine ||
        quarantine.reason !== ORPHANED_RUN_QUARANTINE_REASON ||
        !quarantine.commandKind.startsWith("run_state:")
      ) {
        console.log(
          JSON.stringify({
            sessionId,
            status: "skipped",
            reason: "not an orphaned run-state quarantine",
          }),
        );
        continue;
      }
      const expected = store.runState(sessionId);
      const journalBusy = journalOwnsSession(
        journal,
        sessionId,
        expected.currentRunId,
      );
      if (
        !expected.currentRunId ||
        !/^rh-[a-zA-Z0-9-]+$/.test(expected.currentRunId)
      ) {
        // A previous repair may have settled before a crash at release. The
        // unchanged release reducer is sufficient proof for that retry.
        const released =
          !dryRun &&
          !journalBusy &&
          quarantine.repairable &&
          host.call("releaseQuarantine", [sessionId]) === true;
        console.log(
          JSON.stringify({
            sessionId,
            status: released ? "released" : "skipped",
            reason: released ? undefined : "no local host run identity",
            dryRun,
          }),
        );
        continue;
      }
      const hostId = expected.currentRunId;
      const unit = `bks-run-${hostId}.service`;
      const state = await run([
        "systemctl",
        "show",
        unit,
        "--property=ActiveState",
        "--property=SubState",
      ]);
      const hostInactive =
        state.split("\n").includes("ActiveState=inactive") &&
        state.split("\n").includes("SubState=dead");
      const cgroupEmpty = await emptyCgroup(hostId);
      const evidence = await run([
        "journalctl",
        "--unit",
        unit,
        "--since",
        `@${Math.floor(Date.parse(expected.since) / 1000)}`,
        "--lines=2000",
        "--no-pager",
        "--output=json",
        "--output-fields=MESSAGE,_PID,_SYSTEMD_UNIT,__REALTIME_TIMESTAMP",
      ]);
      const proof = stoppedLocalRunJournalProof(
        hostId,
        Date.parse(expected.since),
        evidence,
      );
      assertServicesStopped();
      const result = settleStoppedLocalRun({
        store,
        sessionId,
        expected,
        proof,
        journalBusy,
        hostInactive,
        cgroupEmpty,
        dryRun,
      });
      let released = false;
      if (result.status === "settled") {
        host.refreshSessionProjections(sessionId);
        released = host.call("releaseQuarantine", [sessionId]) === true;
      }
      console.log(JSON.stringify({ sessionId, ...result, released, dryRun }));
    }
  } finally {
    host.close();
  }
}

if (import.meta.main) await main();
