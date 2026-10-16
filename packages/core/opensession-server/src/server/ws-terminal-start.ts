import {
  discardTerminalStart,
  isTerminalStartCurrent,
  startSessionTerminal,
  type TerminalOpts,
  type TerminalSessionInfo,
} from "./terminals";

/** Both lookups are shared-only. Keep the arrival reservation across both. */
export async function admitTerminalStart(
  ws: unknown,
  termId: string,
  token: object,
  opts: TerminalOpts,
  authorize: () => Promise<{ allowed: boolean }>,
  lookup: () => Promise<TerminalSessionInfo | null | undefined>,
): Promise<void> {
  const current = () => isTerminalStartCurrent(ws, termId, token);
  try {
    const admission = await authorize();
    if (!current()) return;
    if (!admission.allowed) throw new Error("Session not found");
    const session = await lookup();
    if (!current()) return;
    if (!session) throw new Error("Session not found");
    await startSessionTerminal(ws, termId, session, opts, token);
  } catch {
    if (current()) {
      opts.send({ type: "term_notice", message: "Terminal unavailable" });
      opts.send({ type: "term_exit", code: 1 });
    }
  } finally {
    discardTerminalStart(ws, termId, token);
  }
}
