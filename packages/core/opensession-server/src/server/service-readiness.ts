export type ServiceReadinessPhase =
  | "booting"
  | "recovering"
  | "ready"
  | "draining"
  | "failed";
type State = {
  phase: ServiceReadinessPhase;
  error?: string;
  changedAt: string;
};
// Readiness belongs to one gateway child; the supervisor only switches which
// private backend receives new connections.
const globalState = globalThis as typeof globalThis & {
  __opensessionReadiness?: State;
};
const state = (globalState.__opensessionReadiness ??= {
  phase: "booting",
  changedAt: new Date().toISOString(),
});

export function setServiceReadiness(
  phase: ServiceReadinessPhase,
  error?: unknown,
): void {
  if (phase !== state.phase) {
    // The deploy supervisor gates cut-over on this transition; log how long
    // each phase took so a slow boot is attributable from the journal.
    const elapsedMs = Date.now() - Date.parse(state.changedAt);
    console.log(
      `[readiness] ${state.phase} -> ${phase} after ${(elapsedMs / 1000).toFixed(1)}s`,
    );
  }
  state.phase = phase;
  state.error =
    error === undefined
      ? undefined
      : error instanceof Error
        ? error.message
        : String(error);
  state.changedAt = new Date().toISOString();
}

export function serviceReadiness(): Readonly<State> {
  return { ...state };
}
