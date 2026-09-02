export type BootTransition = "invalid" | "initial" | "same" | "changed";
export type RestartPhase = "ok" | "reconnecting" | "restarting" | "crashed";

/** Resolve against React's latest queued phase. A reconnect can schedule
 * `restarting` just before the replacement server's hello arrives, so reading
 * a layout-synced ref here can observe the older `reconnecting` phase and
 * leave the queued `restarting` update stuck forever. */
export function resolvedRestartPhase(phase: RestartPhase): RestartPhase {
  return phase === "reconnecting" || phase === "restarting" ? "ok" : phase;
}

/** Compare process identities without mistaking the first observed boot for a
 * restart. A baseline learned after a restart announcement may still belong to
 * the draining process, so only a change is completion evidence. */
export function bootTransition(
  previous: string | null,
  value: string | null,
): BootTransition {
  if (!value) return "invalid";
  if (!previous) return "initial";
  return value === previous ? "same" : "changed";
}
