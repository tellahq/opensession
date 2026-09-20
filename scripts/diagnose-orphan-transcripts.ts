#!/usr/bin/env bun
/** Read-only diagnosis of 1..100 explicit ids. No enumeration and no --apply. */
export {};
const ids = process.argv.slice(2);
if (
  !ids.length ||
  ids.length > 100 ||
  ids.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id))
)
  throw new Error(
    "Usage: bun scripts/diagnose-orphan-transcripts.ts <session-id> [<session-id> ...] (1..100)",
  );
const { startSessionKernelActor, stopSessionKernelActor } =
  await import("../packages/core/opensession-server/src/server/session-kernel/actor-runtime");
const { sweepOrphanTranscripts } =
  await import("../packages/core/opensession-server/src/server/transcript-orphan-sweep");
await startSessionKernelActor();
try {
  const report = await sweepOrphanTranscripts({
    dryRun: true,
    candidateSessionIds: ids,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.refused) process.exitCode = 1;
} finally {
  stopSessionKernelActor();
}
