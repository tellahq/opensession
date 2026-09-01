/**
 * The rule for reconciling this device's composer drafts with the server's
 * copy (src/server/drafts.ts). Kept apart from drafts.ts, which owns the
 * store, timers and DOM events, so the rule itself can be read and tested on
 * its own.
 *
 * It is a dirty check, not a timestamp race. A key whose current text still
 * equals what we last agreed with the server was not typed into here, so the
 * server copy wins, including a deletion. That deletion is the important half:
 * it is what clears the pencil in the browser after you send the message from
 * your phone. A key that was typed into since is ours, and gets pushed.
 */

export interface DraftSyncState {
  /** key → the text in the composer store right now. */
  local: Record<string, string>;
  /** key → the text last agreed with the server. Absent = never synced. */
  synced: Record<string, string>;
}

export type DraftSyncAction =
  /** Replace the local text with the server's (`text` may be ""). */
  | { kind: "adopt"; key: string; text: string }
  /** Already equal; just record it as agreed. */
  | { kind: "agree"; key: string; text: string }
  /** Typed here since the last agreement: send it. */
  | { kind: "push"; key: string };

export function reconcileDrafts(
  server: Record<string, { text: string }>,
  state: DraftSyncState,
  keyFor: (sessionId: string) => string,
): DraftSyncAction[] {
  const actions: DraftSyncAction[] = [];
  const isDirty = (key: string) =>
    (state.local[key] ?? "") !== (state.synced[key] ?? "");
  const seen = new Set<string>();

  for (const [sessionId, entry] of Object.entries(server)) {
    const key = keyFor(sessionId);
    seen.add(key);
    if (isDirty(key)) continue;
    if ((state.local[key] ?? "") === entry.text) {
      actions.push({ kind: "agree", key, text: entry.text });
    } else {
      actions.push({ kind: "adopt", key, text: entry.text });
    }
  }

  // Keys we had agreed on that the server no longer holds: sent or cleared
  // on the other device.
  for (const key of Object.keys(state.synced)) {
    if (seen.has(key) || isDirty(key)) continue;
    if (state.local[key]) actions.push({ kind: "adopt", key, text: "" });
  }

  // Everything typed here that the server hasn't agreed to yet, including
  // text entered before the first load landed.
  for (const key of Object.keys(state.local)) {
    if (isDirty(key)) actions.push({ kind: "push", key });
  }

  return actions;
}
