/**
 * Client-side rules for comment threads (src/server/comment-threads.ts):
 * merging live frames, splitting inline comments from timeline notes, and
 * the text a thread becomes when it is handed to the main session.
 */

import { parseMentions } from "./mention-text";
import type { Person } from "./people";
import type { CommentThread } from "./types";
import { requestYouShouldKnowChat } from "./you-should-know";

/** Insert or replace by id. An older copy never overwrites a newer one, so a
 *  request's response and its broadcast echo can land in either order. */
export function upsertThread(
  threads: CommentThread[],
  next: CommentThread,
): CommentThread[] {
  const index = threads.findIndex((t) => t.id === next.id);
  if (index < 0) return [...threads, next];
  if ((threads[index]!.updatedAt ?? 0) > (next.updatedAt ?? 0)) return threads;
  const copy = [...threads];
  copy[index] = next;
  return copy;
}

/** A session's threads, and the team notes among them that the timeline
 *  interleaves. */
export interface SessionComments {
  threads: CommentThread[];
  notes: CommentThread[];
}

/** Threads with no passage: the team notes that sit in the timeline. */
export function timelineThreads(threads: CommentThread[]): CommentThread[] {
  return threads.filter((t) => !t.anchor);
}

/** Threads attached to a passage of the transcript. A thread on a whole
 *  message shows under that message instead (MessageThreadSummary). */
export function inlineThreads(threads: CommentThread[]): CommentThread[] {
  return threads.filter((t) => !!t.anchor && !t.anchor.whole);
}

/** Threads on whole messages, in transcript order of their first comment. */
export function messageThreads(threads: CommentThread[]): CommentThread[] {
  return threads.filter((t) => !!t.anchor?.whole).sort((a, b) => a.ts - b.ts);
}

/** A side answer that has been "in progress" this long was cut off by a
 *  restart; stop showing it as working. */
const AGENT_PENDING_STALE_MS = 10 * 60_000;

export function agentIsAnswering(
  thread: CommentThread,
  now = Date.now(),
): boolean {
  return (
    !!thread.agentPendingSince &&
    now - thread.agentPendingSince < AGENT_PENDING_STALE_MS
  );
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** ms epoch of the newest thing to read in a thread: a comment or an edit. */
export function lastActivityAt(thread: CommentThread): number {
  let latest = 0;
  for (const c of thread.comments)
    latest = Math.max(latest, c.editedAt ?? c.ts, c.ts);
  return latest;
}

/** A teammate tagged in the newest comment, and when they saw it. */
export interface TagReceipt {
  name: string;
  /** ms epoch they saw the newest comment; absent until they have. */
  seenAt?: number;
}

/**
 * Read receipts for the people the newest comment @-tags, in the order they
 * were tagged, never its author. Nobody tagged means no receipt: the note
 * was not addressed to anyone in particular.
 */
export function taggedReceipts(
  thread: CommentThread,
  people: Person[],
): TagReceipt[] {
  const latest = thread.comments.at(-1);
  if (!latest || latest.agent) return [];
  const since = lastActivityAt(thread);
  const out: TagReceipt[] = [];
  for (const token of parseMentions(latest.text, people)) {
    if (token.kind !== "mention") continue;
    const name = token.name;
    if (sameName(name, latest.user) || out.some((r) => sameName(r.name, name)))
      continue;
    const person = people.find((p) => sameName(p.name, name));
    const seen = thread.seenBy?.find(
      (s) =>
        s.ts >= since &&
        (sameName(s.user, name) ||
          (!!person && sameName(s.user, person.fullName))),
    );
    out.push(seen ? { name, seenAt: seen.ts } : { name });
  }
  return out;
}

/** Whether `me` still owes the thread a read receipt: the newest comment
 *  tags me and I have not seen it since. */
export function needsSeenMark(
  thread: CommentThread,
  me: string,
  people: Person[],
): boolean {
  if (!me.trim()) return false;
  return taggedReceipts(thread, people).some(
    (r) => sameName(r.name, me) && r.seenAt === undefined,
  );
}

/** "Michiel", "Michiel and Jaap", "Michiel, Jaap and 2 others". */
export function seenByLabel(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** The agent's name in a thread, as the server wrote it. */
export function threadAgentName(thread: CommentThread): string | undefined {
  return thread.comments.find((c) => c.agent)?.user;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * The message a thread becomes in the composer when it is sent to the main
 * session: the passage, the conversation, and how to answer back so the
 * result lands in the thread as well as the transcript.
 */
export function sendToSessionText(thread: CommentThread): string {
  const parts: string[] = [];
  if (thread.anchor) parts.push(quote(thread.anchor.exact), "");
  parts.push("From a comment thread on this session:", "");
  for (const comment of thread.comments)
    parts.push(
      `**${comment.user}${comment.agent ? " (you, answering on the side)" : ""}:** ${comment.text}`,
    );
  parts.push(
    "",
    `Please take care of this. When you're done, reply in the thread (opensession-comments reply_to_comment_thread, threadId \`${thread.id}\`) with what you did.`,
  );
  return parts.join("\n");
}

/** One line of the opening comment, for lists and tooltips. */
export function threadPreview(thread: CommentThread, length = 80): string {
  const text = (thread.comments[0]?.text ?? "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * Hand a thread to the main session: its text lands in the session's composer
 * (appended to any draft, cursor there), so the person reads it, edits it if
 * they like, and sends it as a normal turn.
 */
export function sendThreadToSession(
  sessionId: string,
  thread: CommentThread,
): void {
  requestYouShouldKnowChat(sessionId, sendToSessionText(thread));
}
