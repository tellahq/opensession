/**
 * @-mentions of a teammate, kept per person so their sidebar can show which
 * sessions are waiting on them. A mention already pushed to their devices
 * (src/server/push.ts); this is the part that survives a closed notification:
 * a durable "you were tagged here" flag that clears when they open the session.
 *
 * One record per (person, session) — the badge is per row, so a second mention
 * in the same session updates the record rather than stacking. Storage is the
 * flat-file pattern of session-notes.ts/pins.ts, keyed on the picker first
 * name, which is also what push subscriptions and the identity table use.
 *
 * The store is append/clear only. It is never replaced wholesale, so a client
 * that writes before it has read cannot wipe anything (the hazard the
 * whole-map PUT in reads.ts carries).
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";
import { mentionedUsers } from "./people";

const MENTIONS_DIR = stateDir("mentions");

/** Plenty for a badge list, and a hard bound on an unattended file. */
const MAX_STORED = 200;
const PREVIEW_LEN = 140;

export interface Mention {
  sessionId: string;
  /** Display name of whoever wrote the mention. */
  by: string;
  /** Where it was written: a prompt in the transcript, or a team note. */
  source: "prompt" | "note";
  /** First line or so of the text, for a hover card or a mentions list. */
  preview: string;
  /** ms epoch */
  ts: number;
}

/** Person keys become filenames, so keep the mapping defensive. */
function isValidPerson(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

function fileFor(person: string): string {
  return `${MENTIONS_DIR}/${person.toLowerCase()}.json`;
}

function readAll(person: string): Mention[] {
  if (!isValidPerson(person)) return [];
  try {
    const f = fileFor(person);
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, "utf8"));
    if (!Array.isArray(raw?.mentions)) return [];
    return raw.mentions.filter(
      (m: unknown): m is Mention =>
        !!m &&
        typeof (m as any).sessionId === "string" &&
        typeof (m as any).by === "string" &&
        typeof (m as any).ts === "number",
    );
  } catch {
    return [];
  }
}

function write(person: string, mentions: Mention[]): void {
  if (!existsSync(MENTIONS_DIR)) mkdirSync(MENTIONS_DIR, { recursive: true });
  writeJsonAtomic(fileFor(person), { mentions: mentions.slice(-MAX_STORED) });
}

/** This person's outstanding mentions, oldest first. */
export function listMentions(person: string): Mention[] {
  return readAll(person);
}

/**
 * Record that `by` mentioned `person` in `sessionId`. Returns the stored
 * record so the caller can broadcast exactly what it wrote.
 */
export function addMention(
  person: string,
  mention: Omit<Mention, "ts"> & { ts?: number },
): Mention | null {
  if (!isValidPerson(person)) return null;
  const record: Mention = {
    sessionId: mention.sessionId,
    by: mention.by.trim().slice(0, 64),
    source: mention.source,
    preview: mention.preview.trim().slice(0, PREVIEW_LEN),
    ts: mention.ts ?? Date.now(),
  };
  // The newest mention in a session replaces the older one: one row, one badge.
  const rest = readAll(person).filter((m) => m.sessionId !== record.sessionId);
  write(person, [...rest, record]);
  return record;
}

/** Clear this person's mention for one session — what opening it does. */
export function clearMention(person: string, sessionId: string): boolean {
  const all = readAll(person);
  const rest = all.filter((m) => m.sessionId !== sessionId);
  if (rest.length === all.length) return false;
  write(person, rest);
  return true;
}

/** Clear every mention for a person. */
export function clearAllMentions(person: string): void {
  if (!isValidPerson(person)) return;
  write(person, []);
}

/**
 * Scan `text` for teammates and record a mention for each. The one place that
 * knows what a mention means, called from all three surfaces that can carry
 * one (a prompt over HTTP, a prompt over the WebSocket, a team note), so the
 * badge and the push can never disagree about who was tagged.
 *
 * Returns the people recorded, for the caller's push loop.
 */
export function recordMentions(
  text: string,
  sender: string,
  sessionId: string,
  source: Mention["source"],
  onRecorded?: (person: string, mention: Mention) => void,
): string[] {
  if (!text.includes("@")) return [];
  const people = mentionedUsers(text, sender);
  for (const person of people) {
    const mention = addMention(person, {
      sessionId,
      by: sender || "Someone",
      source,
      preview: text,
    });
    if (mention) onRecorded?.(person, mention);
  }
  return people;
}

/**
 * Record a mention and announce it: the durable badge, the live socket frame
 * that marks the row on every device the person has open, and the web push
 * that reaches them with the app closed. Every surface that can carry a
 * mention calls this rather than assembling the three itself, so a new
 * surface cannot ship two of them and forget the third.
 *
 * `where` is the tail of the push title ("… mentioned you in <where>") — the
 * session's title for a message, "a session note" for a note.
 */
export async function notifyMentions(
  text: string,
  sender: string,
  sessionId: string,
  source: Mention["source"],
  where: string,
): Promise<string[]> {
  const { broadcastToAll } = await import("./ws-hub");
  const mentioned = recordMentions(
    text,
    sender,
    sessionId,
    source,
    (person, mention) =>
      broadcastToAll({ type: "mention", user: person, mention }),
  );
  if (!mentioned.length) return mentioned;
  const { sendPushToUser } = await import("./push");
  const body = mentionPreview(text);
  for (const name of mentioned)
    void sendPushToUser(name, {
      title: `${sender || "Someone"} mentioned you in ${where}`,
      body,
      url: `/session/${encodeURIComponent(sessionId)}`,
      // One tag per session per kind: a second mention replaces the
      // notification instead of stacking, and a note never collapses a
      // message (or the other way round).
      tag: `opensession-${source === "note" ? "note" : "mention"}-${sessionId}`,
    });
  return mentioned;
}

/** The push body shares the mention's preview rule. */
export function mentionPreview(text: string): string {
  return text.length > PREVIEW_LEN
    ? `${text.slice(0, PREVIEW_LEN - 1)}…`
    : text;
}
