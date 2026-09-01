/**
 * Team notes on a session — human-to-human messages that ride the session's
 * transcript but never reach the agent. Plain's "internal note", for our own
 * sessions: you leave one for a teammate reading the run, not for the model.
 *
 * This is a narrow re-implementation of a feature that shipped in July on the
 * native team-chat backend (`session:<id>` channels in the since-deleted
 * src/server/chat.ts) and was removed with it in 5c90eddc. What came back is
 * only the part that was in use: per-session notes with optional images. No
 * watercooler, threads or reactions.
 *
 * Notes persist per session in `~/.opensession-session-notes/<id>.json` (the
 * flat-file pattern of pins.ts/push.ts). Realtime delivery rides the app
 * WebSocket from the route; an `@Name` mention web-pushes that teammate's
 * devices via src/server/push.ts and records a sidebar badge via
 * src/server/mentions.ts, which owns the mention scan for notes and prompts
 * alike.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";
import { removeStagedImages } from "./uploads";

const NOTES_DIR = stateDir("session-notes");

// Keep each session's store bounded — the UI only ever loads the recent tail.
const MAX_STORED = 2000;
const MAX_TEXT_LEN = 8000;

export interface SessionNote {
  id: string;
  /** Sender's display name, as resolved from the verified identity. */
  user: string;
  text: string;
  /** Media-route URLs for images attached to the note. */
  images?: string[];
  /** ms epoch */
  ts: number;
  /** ms epoch of the last edit; absent on notes never edited. */
  editedAt?: number;
}

/** Session ids are minted by us (`os-<uuidv7>`), but keep the filename mapping
 *  defensive: anything outside this charset can't become a path. */
export function isValidNoteSession(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(id);
}

function fileFor(sessionId: string): string {
  return `${NOTES_DIR}/${sessionId}.json`;
}

function readAll(sessionId: string): SessionNote[] {
  try {
    const f = fileFor(sessionId);
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, "utf8"));
    if (!Array.isArray(raw?.notes)) return [];
    return raw.notes.filter(
      (n: unknown): n is SessionNote =>
        !!n &&
        typeof (n as any).id === "string" &&
        typeof (n as any).user === "string" &&
        typeof (n as any).text === "string" &&
        (!(n as any).images ||
          (Array.isArray((n as any).images) &&
            (n as any).images.every(
              (image: unknown) => typeof image === "string",
            ))) &&
        typeof (n as any).ts === "number",
    );
  } catch {
    return [];
  }
}

/** The session's most recent `limit` notes, oldest first. */
export function listSessionNotes(
  sessionId: string,
  limit = 200,
): SessionNote[] {
  const capped = Math.max(1, Math.min(limit, MAX_STORED));
  return readAll(sessionId).slice(-capped);
}

/** Append a note and return the stored record, or null when it is empty. */
export function addSessionNote(
  sessionId: string,
  user: string,
  text: string,
  images: string[] = [],
): SessionNote | null {
  const trimmed = text.trim().slice(0, MAX_TEXT_LEN);
  if (!trimmed && images.length === 0) return null;
  const note: SessionNote = {
    id: crypto.randomUUID(),
    user: user.trim().slice(0, 64),
    text: trimmed,
    ...(images.length ? { images } : {}),
    ts: Date.now(),
  };
  const all = readAll(sessionId);
  all.push(note);
  const removed = all.slice(0, -MAX_STORED);
  if (!existsSync(NOTES_DIR)) mkdirSync(NOTES_DIR, { recursive: true });
  writeJsonAtomic(fileFor(sessionId), { notes: all.slice(-MAX_STORED) });
  for (const old of removed) removeStagedImages(old.images);
  return note;
}

/** Author check, used by both mutations. Display names are what a note
 *  carries, so the comparison is case-insensitive on the trimmed name — the
 *  same shape the rest of the app compares identities with. */
function isAuthor(note: SessionNote, user: string): boolean {
  return note.user.trim().toLowerCase() === user.trim().toLowerCase();
}

/** Outcome of a mutation, so the route can pick its status code: a missing
 *  note is a 404 and someone else's note is a 403, and the caller shouldn't
 *  have to re-read the store to tell them apart. */
export type NoteMutation =
  | { ok: true; note: SessionNote }
  | { ok: false; reason: "not_found" | "not_author" };

/**
 * Edit a note's text. Only its author may: a note is one person speaking, and
 * a teammate silently rewriting it would make the transcript a record of
 * something nobody said. `editedAt` is set so the UI can mark it.
 */
export function editSessionNote(
  sessionId: string,
  noteId: string,
  text: string,
  user: string,
): NoteMutation {
  const trimmed = text.trim().slice(0, MAX_TEXT_LEN);
  if (!trimmed) return { ok: false, reason: "not_found" };
  const all = readAll(sessionId);
  const note = all.find((n) => n.id === noteId);
  if (!note) return { ok: false, reason: "not_found" };
  if (!isAuthor(note, user)) return { ok: false, reason: "not_author" };
  note.text = trimmed;
  note.editedAt = Date.now();
  writeJsonAtomic(fileFor(sessionId), { notes: all });
  return { ok: true, note };
}

/** Delete a note. Author-only, for the same reason as editing. */
export function deleteSessionNote(
  sessionId: string,
  noteId: string,
  user: string,
): NoteMutation {
  const all = readAll(sessionId);
  const note = all.find((n) => n.id === noteId);
  if (!note) return { ok: false, reason: "not_found" };
  if (!isAuthor(note, user)) return { ok: false, reason: "not_author" };
  writeJsonAtomic(fileFor(sessionId), {
    notes: all.filter((n) => n.id !== noteId),
  });
  removeStagedImages(note.images);
  return { ok: true, note };
}

/**
 * Latest note per session — what an unread indicator would key off. One scan
 * over the notes dir; the files are small and team-scale, so no cache.
 */
export function sessionNoteActivity(): Array<{
  sessionId: string;
  lastTs: number;
  lastUser: string;
}> {
  const out: Array<{ sessionId: string; lastTs: number; lastUser: string }> =
    [];
  try {
    for (const f of readdirSync(NOTES_DIR)) {
      if (!f.endsWith(".json")) continue;
      const sessionId = f.slice(0, -".json".length);
      const notes = readAll(sessionId);
      const last = notes[notes.length - 1];
      if (!last) continue;
      out.push({ sessionId, lastTs: last.ts, lastUser: last.user });
    }
  } catch {}
  return out;
}
