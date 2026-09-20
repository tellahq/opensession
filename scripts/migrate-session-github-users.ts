#!/usr/bin/env bun
/** Preview legacy creator→GitHub attribution. Explicit --apply writes at most 50 sessions.
 * Resume with --after <returned cursor>; --limit accepts 1..100. Uses live kernel RPC.
 */
export {};
process.env.OPENSESSION_OPERATOR_MIGRATION = "1";
const { startSessionKernelActor, stopSessionKernelActor } =
  await import("../packages/core/opensession-server/src/server/session-kernel/actor-runtime");
const { migrateSessionGithubUsers } =
  await import("../packages/core/opensession-server/src/server/session-github-user-migration");
const { webAuthRequired } =
  await import("../packages/core/opensession-server/src/server/web-auth");
const args = process.argv.slice(2);
const value = (key: string) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
if (!webAuthRequired())
  throw new Error(
    "GitHub sign-in must be enabled before attribution migration",
  );
await startSessionKernelActor();
try {
  console.log(
    JSON.stringify(
      await migrateSessionGithubUsers({
        apply: args.includes("--apply"),
        after: value("--after"),
        limit: Number(value("--limit") ?? 50),
      }),
      null,
      2,
    ),
  );
} finally {
  stopSessionKernelActor();
}
