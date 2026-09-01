/**
 * Read tracking for session team notes (the transcript NoteBubbles). Parallel
 * to lib/reads.ts but keyed on the session's last note timestamp: the viewer
 * stamps `opensession-note-read:<id>` while a session is open, and a session
 * counts as having unread notes when its newest note is from someone else and
 * newer than that stamp.
 *
 * A one-time baseline stamp keeps every session that already has notes from
 * lighting up the first time this runs.
 */

const BASELINE_KEY = "opensession-note-baseline";
const READ_PREFIX = "opensession-note-read:";
const CHANGE_EVENT = "opensession-note-read-changed";

function baseline(): number {
  let v = Number(localStorage.getItem(BASELINE_KEY) || 0);
  if (!v) {
    v = Date.now();
    localStorage.setItem(BASELINE_KEY, String(v));
  }
  return v;
}

/** Stamp the session's notes as read up to `lastTs`. */
export function markNotesRead(sessionId: string, lastTs: number): void {
  localStorage.setItem(READ_PREFIX + sessionId, String(lastTs));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function isNoteUnread(
  sessionId: string,
  lastTs: number,
  lastUser: string,
  me: string,
): boolean {
  if (!lastTs || lastUser === me) return false;
  const stamp = Number(localStorage.getItem(READ_PREFIX + sessionId) || 0);
  return lastTs > Math.max(stamp, baseline());
}

export function onNoteReadsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
