/**
 * Dev-instance mode — OPENSESSION_DEV=1.
 *
 * Historically the flag only swapped the frontend build pipeline
 * (frontend-build.ts IS_DEV, which stays self-contained) and enabled Bun HMR.
 * Since 2026-08-04 it also makes a second instance safe to boot NEXT TO the
 * production one on the same box: no agents, no webhook intake, no
 * schedulers/sweeps/tickers, no detached-server adoption, no restart-resume,
 * and no shared GitHub token refresher. Every `isDevInstance()` call site is
 * a skip-gate — with the flag unset, behavior is byte-identical to before.
 *
 * State isolation is a separate, mandatory knob: OPENSESSION_STATE_DIR
 * (rename-compat statePath — every `~/.opensession-*` store resolves under
 * it, fresh namespace) or at minimum OPENSESSION_SESSIONS_DIR. A dev instance
 * with neither REFUSES to boot: sharing the live sessions dir means unlinking
 * and stealing the production run-rpc unix socket, which wedges every
 * interactive run fleet-wide (2026-07-16/17 outages).
 */

/** True iff this process is a dev instance (OPENSESSION_DEV=1). */
export function isDevInstance(): boolean {
  return process.env.OPENSESSION_DEV === "1";
}

/**
 * The refuse-to-boot condition, pure so tests can drive it: a dev instance
 * with no isolated state namespace would share the live instance's sessions dir
 * (and its run-rpc socket). Returns the error to print, or null when booting
 * is fine. Checked in opensession.ts (exit) AND in run-rpc.ts's socket bind
 * (module side effects run before the entry file's statements).
 */
export function devInstanceBootError(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.OPENSESSION_DEV !== "1") return null;
  if (env.OPENSESSION_STATE_DIR) return null;
  if (env.OPENSESSION_SESSIONS_DIR) return null;
  return (
    "OPENSESSION_DEV=1 refuses to boot on the live state: set OPENSESSION_STATE_DIR " +
    "(isolated state root; every ~/.opensession-* store resolves under it) or at " +
    "least OPENSESSION_SESSIONS_DIR. A dev instance sharing the live sessions dir would " +
    "steal the production run-rpc socket and wedge every interactive run."
  );
}
