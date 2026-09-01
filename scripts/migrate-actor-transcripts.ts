#!/usr/bin/env bun
import { dirname } from "node:path";
import { OPENSESSION_SESSIONS_DIR } from "../packages/core/opensession-server/src/server/paths";
import { sessionKernelDbPath } from "../packages/core/opensession-server/src/server/session-kernel/store";
import {
  migrateActorTranscriptsOffline,
  rollbackActorTranscriptsOffline,
} from "../packages/core/opensession-server/src/server/session-kernel/transcript-offline-migration";

const REQUIRED_INACTIVE_SERVICES = [
  "opensession.service",
  "opensession-executor.service",
  "opensession-session-kernel.service",
] as const;

type ServiceCheck = (service: string) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function assertServicesStopped(
  checkService: ServiceCheck = (service) => {
    const check = Bun.spawnSync(["systemctl", "is-active", service], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: check.exitCode,
      stdout: check.stdout.toString(),
      stderr: check.stderr.toString(),
    };
  },
): void {
  for (const service of REQUIRED_INACTIVE_SERVICES) {
    const result = checkService(service);
    const state = result.stdout.trim();
    if (result.exitCode !== 3 || state !== "inactive" || result.stderr.trim())
      throw new Error(
        `${service} did not report explicit inactive state ` +
          `(exit=${result.exitCode}, state=${JSON.stringify(state)})`,
      );
  }
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  assertServicesStopped();
  const centralPath = value("--central") ?? sessionKernelDbPath();
  const sourceTranscriptPath =
    value("--source") ?? `${OPENSESSION_SESSIONS_DIR}/transcripts.db`;
  const isolatedRoot =
    value("--isolated-root") ??
    `${dirname(centralPath)}/session-kernel-sessions`;
  const rollback = process.argv.includes("--rollback");
  const dryRun =
    process.argv.includes("--dry-run") || process.argv.includes("--audit");
  if (rollback && dryRun)
    throw new Error("Choose either --rollback or --dry-run");
  const startedAt = performance.now();
  if (rollback) {
    console.log(
      JSON.stringify(
        {
          rolledBack: rollbackActorTranscriptsOffline({
            centralPath,
            sourceTranscriptPath,
            isolatedRoot,
          }),
          centralPath,
          sourceTranscriptPath,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = migrateActorTranscriptsOffline({
    centralPath,
    sourceTranscriptPath,
    isolatedRoot,
    dryRun,
    onProgress: ({ completed, total, migrated, adopted }) =>
      console.error(
        `[actor-transcript-migration] ${completed}/${total} ` +
          `(migrated=${migrated}, adopted=${adopted})`,
      ),
  });
  console.log(
    JSON.stringify(
      {
        ...result,
        sourceUntouched: sourceTranscriptPath,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) main();
