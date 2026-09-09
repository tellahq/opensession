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

import { catalogDocuments } from "./catalog-documents";
import { documentField } from "./shared/catalog-user-store";
import { mentionedUsers } from "./people";

const documents = catalogDocuments("mentions");

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

function cleanMentions(value: unknown): Mention[] {
  const raw = documentField(value, "mentions");
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value: unknown): value is Mention =>
      value !== null &&
      typeof value === "object" &&
      "sessionId" in value &&
      typeof value.sessionId === "string" &&
      "by" in value &&
      typeof value.by === "string" &&
      "ts" in value &&
      typeof value.ts === "number" &&
      "preview" in value &&
      typeof value.preview === "string" &&
      "source" in value &&
      (value.source === "prompt" || value.source === "note"),
  );
}

/** This person's outstanding mentions, oldest first. */
export async function listMentions(person: string): Promise<Mention[]> {
  if (!isValidPerson(person)) return [];
  return cleanMentions(await documents.get(person.toLowerCase()));
}

/** One catalog CAS owns the append, so concurrent mentions cannot overwrite. */
export async function addMention(
  person: string,
  mention: Omit<Mention, "ts"> & { ts?: number },
): Promise<Mention | null> {
  if (!isValidPerson(person)) return null;
  const record: Mention = {
    sessionId: mention.sessionId,
    by: mention.by.trim().slice(0, 64),
    source: mention.source,
    preview: mention.preview.trim().slice(0, PREVIEW_LEN),
    ts: mention.ts ?? Date.now(),
  };
  await documents.update(person.toLowerCase(), (value) => ({
    mentions: [
      ...cleanMentions(value).filter((m) => m.sessionId !== record.sessionId),
      record,
    ].slice(-MAX_STORED),
  }));
  return record;
}

/** Clear this person's mention for one session. */
export async function clearMention(
  person: string,
  sessionId: string,
): Promise<boolean> {
  if (!isValidPerson(person)) return false;
  let cleared = false;
  await documents.update(person.toLowerCase(), (value) => {
    const all = cleanMentions(value);
    const mentions = all.filter((m) => m.sessionId !== sessionId);
    cleared = mentions.length !== all.length;
    return { mentions };
  });
  return cleared;
}

export async function clearAllMentions(person: string): Promise<void> {
  if (!isValidPerson(person)) return;
  await documents.set(person.toLowerCase(), { mentions: [] });
}

export async function recordMentions(
  text: string,
  sender: string,
  sessionId: string,
  source: Mention["source"],
  onRecorded?: (person: string, mention: Mention) => void,
): Promise<string[]> {
  if (!text.includes("@")) return [];
  const people = mentionedUsers(text, sender);
  for (const person of people) {
    const mention = await addMention(person, {
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
  const mentioned = await recordMentions(
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
