#!/usr/bin/env bun
/**
 * Standalone demo-dataset generator:
 *
 *   OPENSESSION_STATE_DIR=/tmp/os-demo bun scripts/demo-data.ts
 *   OPENSESSION_SESSIONS_DIR=/tmp/os-demo-sessions bun scripts/demo-data.ts
 *
 * Seeds the synthetic demo dataset (src/server/demo/generate.ts) into the
 * env-resolved state dirs. Refuses to run against the live state: at least
 * one of OPENSESSION_STATE_DIR / OPENSESSION_SESSIONS_DIR must be set so the
 * writes land in an explicitly named scratch root, never in this user's real
 * ~/.opensession-* stores.
 *
 * Run this BEFORE the demo instance's first boot when possible — the PR
 * snapshot caches are read once at server module load, so pre-seeding makes
 * the PR panel populated from the very first request.
 */

export {}; // top-level await needs module context

const stateRoot = process.env.OPENSESSION_STATE_DIR;
if (!stateRoot && !process.env.OPENSESSION_SESSIONS_DIR) {
  console.error(
    "demo-data: refusing to seed live state.\n" +
      "Set OPENSESSION_STATE_DIR=<scratch root> (redirects every state store) " +
      "or OPENSESSION_SESSIONS_DIR=<scratch sessions dir>, then re-run.",
  );
  process.exit(1);
}

// statePath()/stateDir() (and the PR caches) resolve under HOME — point HOME
// at the scratch root BEFORE any src/server module loads so automations/
// audit/notes/goals and the PR caches land inside it too. With only
// OPENSESSION_SESSIONS_DIR set, HOME stays real: the HOME-rooted stores are then
// SKIPPED (homeStores:false) and the engine-transcript dir (default
// ~/.claude/projects/…) is folded into the scratch sessions dir, so nothing
// touches live state either way.
if (stateRoot) {
  process.env.HOME = stateRoot;
  process.env.OPENSESSION_SESSIONS_DIR ||= `${stateRoot}/.opensession-sessions`;
} else {
}

const { generateDemoData } =
  await import("../packages/core/opensession-server/src/server/demo/generate");

const result = generateDemoData({ homeStores: !!stateRoot });
if (!stateRoot && result.created) {
  console.log(
    "demo-data: OPENSESSION_SESSIONS_DIR-only run — skipped the HOME-rooted stores " +
      "(automations/audit/notes/goals + PR caches), and transcripts went to " +
      `${result.transcriptsDir} (start the server with the same ` +
      "Set OPENSESSION_STATE_DIR to seed everything.",
  );
}
if (!result.created) {
  console.log(
    `demo-data: marker already present at ${result.markerPath} — nothing written. Delete it to regenerate.`,
  );
} else {
  console.log(
    [
      "demo-data: generated synthetic dataset",
      `  sessions:    ${result.sessionsDir} (${result.sessionIds.length} sessions)`,
      `  transcripts: ${result.transcriptsDir}`,
      `  worktree:    ${result.worktreeDir}`,
      `  marker:      ${result.markerPath}`,
    ].join("\n"),
  );
}
