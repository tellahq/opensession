/**
 * Per-user "last read" marks — the server mirror of the frontend's localStorage
 * read state (src/frontend/lib/reads.ts). Each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file under `~/.opensession-reads/` of shape
 * `{ reads: Record<sessionId, isoTimestamp> }`, where the timestamp is the
 * session's `lastActivity` at the moment it was last open in the viewer.
 * Filename, directory resolution and legacy-name fallback come from
 * shared/user-store.ts, shared with pins and the other per-user stores.
 *
 * A session is unread when its current `lastActivity` is newer than its mark
 * (see isUnread). A session with no mark is never unread — the flag means "new
 * since you last read it", not "never seen" — matching the client semantics.
 *
 * The frontend pushes its full read map here whenever a mark changes (markRead
 * on open/activity, markUnread from the sidebar) so server-side consumers that
 * can't see localStorage — notably the hardware macropad feed (GET /api/keypad)
 * — can flag sessions with unread activity.
 */

import { userStore } from "./shared/user-store";

// Bound the map so it can't grow forever; when over cap we drop the
// oldest-inserted marks (object key order is insertion order). Matches the
// frontend CAP so the mirror and localStorage stay the same size.
const CAP = 500;

/** Keep string id → string timestamp entries, capped. */
function clean(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (input && typeof input === "object") {
    for (const [id, ts] of Object.entries(input as Record<string, unknown>)) {
      if (typeof id === "string" && typeof ts === "string") out[id] = ts;
    }
  }
  const keys = Object.keys(out);
  if (keys.length > CAP) {
    for (const k of keys.slice(0, keys.length - CAP)) delete out[k];
  }
  return out;
}

const store = userStore<Record<string, string>>({
  name: "reads",
  field: "reads",
  clean,
});

/** A user's read marks: session id → ISO `lastActivity` last seen. */
export function getReads(user: string): Record<string, string> {
  return store.get(user);
}

/**
 * Replace a user's read marks (strings only, capped). Wholesale, like setPins —
 * the frontend sends its full map on every change. Returns the stored map.
 */
export function setReads(user: string, reads: unknown): Record<string, string> {
  return store.set(user, reads);
}

/**
 * True when the session has activity newer than the user's last-read mark.
 * A session with no mark is never unread (mirrors the client isUnread).
 */
export function isUnread(
  lastActivity: string | undefined,
  mark: string | undefined,
): boolean {
  if (!mark || !lastActivity) return false;
  const a = new Date(lastActivity).getTime();
  const m = new Date(mark).getTime();
  if (Number.isNaN(a) || Number.isNaN(m)) return false;
  return a > m;
}

await store.load();
