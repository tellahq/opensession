type ReplayableIntent = {
  automationId: string;
  sessionId: string;
  trigger: string;
  eventContext?: string;
  acceptedAt: string;
  coalescePlainThread?: boolean;
};

function plainThreadIdOf(intent: ReplayableIntent): string | null {
  if (
    !intent.coalescePlainThread ||
    intent.trigger !== "event" ||
    !intent.eventContext
  )
    return null;
  try {
    const parsed = JSON.parse(intent.eventContext);
    return typeof parsed?.threadId === "string" ? parsed.threadId : null;
  } catch {
    return null;
  }
}

/**
 * Which durable intents boot must NOT replay because the Plain ticket they
 * carry is already covered. Only intents flagged `coalescePlainThread` (the
 * automatic webhook and support-card launches) take part; an explicit
 * retrigger of a Plain session never sets it, so it always replays, even
 * though the session it was retriggered from is still live. Flagged event
 * intents with a `threadId` are per-ticket work, and a ticket whose launch
 * kept failing (or whose support-card link was clicked again and again while
 * it failed) leaves one intent per attempt: 2026-09-09 a broken repository
 * ref left 20 pending intents for 9 tickets, 7 of them for one ticket.
 * Replaying each would open one triage session per attempt. Keep the earliest-accepted intent per (automation,
 * thread). A thread that already has a live session (`liveThreadSessions`:
 * thread id -> session id) needs no replay at all, except the intent of that
 * very session, which an interrupted run still owns. Returns intent session
 * id -> reason.
 */
export function supersededPlainThreadIntents(
  intents: readonly ReplayableIntent[],
  liveThreadSessions: ReadonlyMap<string, string>,
): Map<string, string> {
  const ordered = [...intents]
    .map((intent) => ({ intent, threadId: plainThreadIdOf(intent) }))
    .filter(
      (entry): entry is { intent: ReplayableIntent; threadId: string } =>
        entry.threadId !== null,
    )
    .sort((a, b) =>
      a.intent.acceptedAt < b.intent.acceptedAt
        ? -1
        : a.intent.acceptedAt > b.intent.acceptedAt
          ? 1
          : 0,
    );
  const keyOf = (automationId: string, threadId: string) =>
    `${automationId}\n${threadId}`;
  const kept = new Map<string, string>();
  for (const { intent, threadId } of ordered) {
    const key = keyOf(intent.automationId, threadId);
    const live = liveThreadSessions.get(threadId);
    if (live) {
      if (live === intent.sessionId) kept.set(key, intent.sessionId);
      continue;
    }
    if (!kept.has(key)) kept.set(key, intent.sessionId);
  }
  const superseded = new Map<string, string>();
  for (const { intent, threadId } of ordered) {
    const winner = kept.get(keyOf(intent.automationId, threadId));
    if (winner === intent.sessionId) continue;
    const live = liveThreadSessions.get(threadId);
    superseded.set(
      intent.sessionId,
      live
        ? `superseded: ${threadId} already has live session ${live}`
        : `superseded: ${threadId} replays as intent ${winner}`,
    );
  }
  return superseded;
}

export function automationIntentAlreadySettled(
  sessionId: string,
  runs: readonly { sessionId: string; status: "running" | "ok" | "error" }[],
): boolean {
  return runs.some(
    (run) => run.sessionId === sessionId && run.status !== "running",
  );
}
