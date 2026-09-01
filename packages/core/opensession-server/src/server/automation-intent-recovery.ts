export function automationIntentAlreadySettled(
  sessionId: string,
  runs: readonly { sessionId: string; status: "running" | "ok" | "error" }[],
): boolean {
  return runs.some(
    (run) => run.sessionId === sessionId && run.status !== "running",
  );
}
