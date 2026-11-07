/**
 * Comment threads on a session: conversation between people that rides the
 * session but never enters the agent's run.
 *
 * One model covers two surfaces. A thread with an `anchor` is an inline
 * comment on a passage of the transcript (highlight, card in the margin,
 * replies, resolve). A thread without one is what used to be a team note: it
 * sits in the timeline where it was posted. Both take replies, @-mentions, an
 * assignee and a resolve state, so there is one store, one route surface and
 * one notification path.
 *
 * Storage is one catalog document per session (`comment-threads/<sessionId>`),
 * so every read and write is an async RPC to the kernel and nothing here
 * touches the filesystem on the gateway thread. Legacy note files are
 * converted once by `commentThreadSeedRows`, this namespace's import source.
 *
 * The mutation helpers are pure (`apply*` take and return the thread list) so
 * the rules can be tested without a catalog.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { catalogDocuments, legacyCatalogDirectory } from "./catalog-documents";
import {
  CATALOG_DOCUMENT_MAX_VALUE_BYTES,
  type CatalogDocumentSeedRow,
} from "./session-kernel/catalog-document-protocol";

export const COMMENT_THREADS_NAMESPACE = "comment-threads";

/** Bounds that keep one session's document well under the catalog limit. */
export const MAX_THREADS = 1000;
export const MAX_COMMENTS = 200;
export const MAX_TEXT_LEN = 8000;
const MAX_EXACT_LEN = 2000;
const MAX_CONTEXT_LEN = 64;
/** Leave room under the hard catalog cap for JSON overhead. */
const DOCUMENT_BUDGET = Math.floor(CATALOG_DOCUMENT_MAX_VALUE_BYTES * 0.9);

/**
 * Where an inline comment points. Anchored on the words rather than on DOM
 * positions: the transcript re-renders, lazy-loads and highlights code, and
 * the text survives all of that. `prefix` and `suffix` tell repeats apart.
 */
export interface TextAnchor {
  /** Transcript entry the passage sits in (`data-eid` on the row). */
  entryId: string;
  exact: string;
  prefix: string;
  suffix: string;
  /** The comment is on the whole message (its hover Comment action), not a
   *  passage of it. `exact` then holds the message's opening text, so the
   *  agent and the thread header can quote it. */
  whole?: true;
  /** Who wrote the message a whole-message comment is on, for its quote. */
  by?: string;
}

export interface ThreadComment {
  id: string;
  /** Display name of the author, as resolved from the verified identity. */
  user: string;
  text: string;
  /** Media-route URLs for images attached to the comment. */
  images?: string[];
  /** ms epoch */
  ts: number;
  /** ms epoch of the last edit; absent on comments never edited. */
  editedAt?: number;
  /** Written by the agent rather than a person. */
  agent?: true;
}

export type ThreadStatus = "open" | "resolved";

export interface CommentThread {
  /** Equal to the first comment's id, so a migrated note keeps its id. */
  id: string;
  sessionId: string;
  /** Absent on a session-level thread (a team note). */
  anchor?: TextAnchor;
  status: ThreadStatus;
  /** Who started it: the first comment's author. */
  createdBy: string;
  /** ms epoch of the first comment; what the timeline orders by. */
  ts: number;
  /** ms epoch of the latest change of any kind. */
  updatedAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
  /** Teammate the thread is assigned to; it sits on their Desk until resolved. */
  assignee?: string;
  /** The Desk todo that assignment created (src/server/todos.ts). */
  assigneeTodoId?: string;
  /** ms epoch the agent started answering; cleared when it posts. */
  agentPendingSince?: number;
  /** Read receipts: who opened the thread and when they last saw it. */
  seenBy?: ThreadSeen[];
  comments: ThreadComment[];
}

export interface ThreadSeen {
  user: string;
  /** ms epoch they last had the thread on screen. */
  ts: number;
}

/** Receipts kept per thread; the oldest fall off first. */
export const MAX_SEEN = 50;

export type ThreadFailure =
  | "not_found"
  | "not_author"
  | "empty"
  | "too_many"
  | "too_large";

export type ThreadResult<T = CommentThread> =
  | { ok: true; thread: T; threads: CommentThread[] }
  | { ok: false; reason: ThreadFailure };

/** Session ids are minted by us (`os-<uuidv7>`); keep the key mapping strict. */
export function isValidThreadSession(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(id);
}

export function sameUser(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function cleanText(text: unknown): string {
  return typeof text === "string" ? text.trim().slice(0, MAX_TEXT_LEN) : "";
}

function cleanName(name: string): string {
  return name.trim().slice(0, 64);
}

/** Accept a client anchor only when every part is well formed. */
export function cleanAnchor(value: unknown): TextAnchor | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.entryId !== "string" || !raw.entryId.trim()) return null;
  if (typeof raw.exact !== "string" || !raw.exact.trim()) return null;
  const context = (v: unknown, fromEnd: boolean) =>
    typeof v !== "string"
      ? ""
      : fromEnd
        ? v.slice(-MAX_CONTEXT_LEN)
        : v.slice(0, MAX_CONTEXT_LEN);
  return {
    entryId: raw.entryId.slice(0, 200),
    exact: raw.exact.slice(0, MAX_EXACT_LEN),
    prefix: context(raw.prefix, true),
    suffix: context(raw.suffix, false),
    ...(raw.whole === true ? { whole: true as const } : {}),
    ...(raw.whole === true && typeof raw.by === "string" && raw.by.trim()
      ? { by: raw.by.trim().slice(0, 64) }
      : {}),
  };
}

// ── Reactions on messages ─────────────────────────────────────────────────
//
// Kept in the same per-session document as the threads (`reactions` beside
// `threads`): entry id → emoji → the people who reacted, in order.

export const REACTION_EMOJI = ["👍", "❤️", "🎉", "👀", "🚀", "✅"] as const;
export type MessageReactions = Record<string, Record<string, string[]>>;

const MAX_REACTED_ENTRIES = 2000;

export function cleanReactions(value: unknown): MessageReactions {
  const raw =
    value && typeof value === "object"
      ? (value as { reactions?: unknown }).reactions
      : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: MessageReactions = {};
  for (const [entryId, byEmoji] of Object.entries(raw)) {
    if (!byEmoji || typeof byEmoji !== "object") continue;
    const kept: Record<string, string[]> = {};
    for (const [emoji, people] of Object.entries(byEmoji))
      if (
        (REACTION_EMOJI as readonly string[]).includes(emoji) &&
        Array.isArray(people)
      ) {
        const names = people.filter(
          (p): p is string => typeof p === "string" && !!p.trim(),
        );
        if (names.length) kept[emoji] = names;
      }
    if (Object.keys(kept).length) out[entryId] = kept;
  }
  return out;
}

/** Add `user`'s reaction, or take it back when they already reacted. */
export function applyToggleReaction(
  reactions: MessageReactions,
  entryId: string,
  emoji: string,
  user: string,
): MessageReactions | null {
  if (!(REACTION_EMOJI as readonly string[]).includes(emoji)) return null;
  const id = entryId.trim().slice(0, 200);
  const name = cleanName(user);
  if (!id || !name) return null;
  const entry = { ...reactions[id] };
  const people = entry[emoji] ?? [];
  const next = people.some((p) => sameUser(p, name))
    ? people.filter((p) => !sameUser(p, name))
    : [...people, name];
  if (next.length) entry[emoji] = next;
  else delete entry[emoji];
  const all = { ...reactions };
  if (Object.keys(entry).length) all[id] = entry;
  else delete all[id];
  if (Object.keys(all).length > MAX_REACTED_ENTRIES) return null;
  return all;
}

function isComment(value: unknown): value is ThreadComment {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.user === "string" &&
    typeof c.text === "string" &&
    typeof c.ts === "number" &&
    (c.images === undefined ||
      (Array.isArray(c.images) &&
        c.images.every((image) => typeof image === "string")))
  );
}

function isThread(value: unknown): value is CommentThread {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.sessionId === "string" &&
    (t.status === "open" || t.status === "resolved") &&
    typeof t.createdBy === "string" &&
    typeof t.ts === "number" &&
    Array.isArray(t.comments) &&
    t.comments.length > 0 &&
    t.comments.every(isComment)
  );
}

function isSeen(value: unknown): value is ThreadSeen {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return typeof s.user === "string" && typeof s.ts === "number";
}

/** Parse a stored document, dropping anything malformed. */
export function cleanThreads(value: unknown): CommentThread[] {
  const raw =
    value && typeof value === "object"
      ? (value as { threads?: unknown }).threads
      : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isThread).map((thread) => {
    const clean: CommentThread = {
      ...thread,
      updatedAt:
        typeof thread.updatedAt === "number" ? thread.updatedAt : thread.ts,
    };
    if (thread.seenBy !== undefined) {
      const seen = Array.isArray(thread.seenBy)
        ? thread.seenBy.filter(isSeen)
        : [];
      if (seen.length) clean.seenBy = seen;
      else delete clean.seenBy;
    }
    return clean;
  });
}

function fits(threads: CommentThread[]): boolean {
  return Buffer.byteLength(JSON.stringify({ threads })) <= DOCUMENT_BUDGET;
}

function replace(threads: CommentThread[], next: CommentThread): ThreadResult {
  const all = threads.map((t) => (t.id === next.id ? next : t));
  if (!fits(all)) return { ok: false, reason: "too_large" };
  return { ok: true, thread: next, threads: all };
}

export interface NewThreadInput {
  sessionId: string;
  user: string;
  text: string;
  images?: string[];
  anchor?: TextAnchor | null;
  assignee?: string | null;
  id?: string;
  now?: number;
}

export function applyCreateThread(
  threads: CommentThread[],
  input: NewThreadInput,
): ThreadResult {
  const text = cleanText(input.text);
  const images = input.images ?? [];
  if (!text && images.length === 0) return { ok: false, reason: "empty" };
  if (threads.length >= MAX_THREADS) return { ok: false, reason: "too_many" };
  const now = input.now ?? Date.now();
  const id = input.id ?? crypto.randomUUID();
  const user = cleanName(input.user);
  const thread: CommentThread = {
    id,
    sessionId: input.sessionId,
    ...(input.anchor ? { anchor: input.anchor } : {}),
    status: "open",
    createdBy: user,
    ts: now,
    updatedAt: now,
    ...(input.assignee ? { assignee: cleanName(input.assignee) } : {}),
    comments: [
      { id, user, text, ...(images.length ? { images } : {}), ts: now },
    ],
  };
  const all = [...threads, thread];
  if (!fits(all)) return { ok: false, reason: "too_large" };
  return { ok: true, thread, threads: all };
}

export function applyAddComment(
  threads: CommentThread[],
  threadId: string,
  input: {
    user: string;
    text: string;
    images?: string[];
    agent?: boolean;
    now?: number;
  },
): ThreadResult<CommentThread & { added: ThreadComment }> {
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return { ok: false, reason: "not_found" };
  const text = cleanText(input.text);
  const images = input.images ?? [];
  if (!text && images.length === 0) return { ok: false, reason: "empty" };
  if (thread.comments.length >= MAX_COMMENTS)
    return { ok: false, reason: "too_many" };
  const now = input.now ?? Date.now();
  const comment: ThreadComment = {
    id: crypto.randomUUID(),
    user: cleanName(input.user),
    text,
    ...(images.length ? { images } : {}),
    ts: now,
    ...(input.agent ? { agent: true as const } : {}),
  };
  const next: CommentThread = {
    ...thread,
    comments: [...thread.comments, comment],
    updatedAt: now,
  };
  if (input.agent) delete next.agentPendingSince;
  const result = replace(threads, next);
  if (!result.ok) return result;
  return { ...result, thread: { ...next, added: comment } };
}

export function applyEditComment(
  threads: CommentThread[],
  threadId: string,
  commentId: string,
  text: string,
  user: string,
  now = Date.now(),
): ThreadResult {
  const thread = threads.find((t) => t.id === threadId);
  const comment = thread?.comments.find((c) => c.id === commentId);
  if (!thread || !comment) return { ok: false, reason: "not_found" };
  if (comment.agent || !sameUser(comment.user, user))
    return { ok: false, reason: "not_author" };
  const trimmed = cleanText(text);
  if (!trimmed) return { ok: false, reason: "empty" };
  return replace(threads, {
    ...thread,
    updatedAt: now,
    comments: thread.comments.map((c) =>
      c.id === commentId ? { ...c, text: trimmed, editedAt: now } : c,
    ),
  });
}

export type DeleteCommentResult =
  | {
      ok: true;
      threads: CommentThread[];
      /** The thread after the delete, or null when the whole thread went. */
      thread: CommentThread | null;
      removed: ThreadComment[];
    }
  | { ok: false; reason: ThreadFailure };

/**
 * Delete one comment. Only its author may, except the agent's answers, which
 * anyone may clear away. Deleting the first comment deletes the thread: the
 * replies answer it and mean nothing on their own.
 */
export function applyDeleteComment(
  threads: CommentThread[],
  threadId: string,
  commentId: string,
  user: string,
  now = Date.now(),
): DeleteCommentResult {
  const thread = threads.find((t) => t.id === threadId);
  const comment = thread?.comments.find((c) => c.id === commentId);
  if (!thread || !comment) return { ok: false, reason: "not_found" };
  if (!comment.agent && !sameUser(comment.user, user))
    return { ok: false, reason: "not_author" };
  if (thread.comments[0]?.id === commentId)
    return {
      ok: true,
      threads: threads.filter((t) => t.id !== threadId),
      thread: null,
      removed: thread.comments,
    };
  const next: CommentThread = {
    ...thread,
    updatedAt: now,
    comments: thread.comments.filter((c) => c.id !== commentId),
  };
  return {
    ok: true,
    threads: threads.map((t) => (t.id === threadId ? next : t)),
    thread: next,
    removed: [comment],
  };
}

export interface ThreadPatch {
  status?: ThreadStatus;
  /** `null` unassigns. */
  assignee?: string | null;
  assigneeTodoId?: string | null;
  agentPending?: boolean;
}

export function applyUpdateThread(
  threads: CommentThread[],
  threadId: string,
  patch: ThreadPatch,
  user: string,
  now = Date.now(),
): ThreadResult {
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return { ok: false, reason: "not_found" };
  const next: CommentThread = { ...thread, updatedAt: now };
  if (patch.status && patch.status !== thread.status) {
    next.status = patch.status;
    if (patch.status === "resolved") {
      next.resolvedBy = cleanName(user);
      next.resolvedAt = now;
    } else {
      delete next.resolvedBy;
      delete next.resolvedAt;
    }
  }
  if (patch.assignee !== undefined) {
    if (patch.assignee) next.assignee = cleanName(patch.assignee);
    else delete next.assignee;
  }
  if (patch.assigneeTodoId !== undefined) {
    if (patch.assigneeTodoId) next.assigneeTodoId = patch.assigneeTodoId;
    else delete next.assigneeTodoId;
  }
  if (patch.agentPending !== undefined) {
    if (patch.agentPending) next.agentPendingSince = now;
    else delete next.agentPendingSince;
  }
  return replace(threads, next);
}

/** ms epoch of the newest thing to read in a thread: a comment or an edit. */
export function lastActivityAt(thread: CommentThread): number {
  let latest = 0;
  for (const c of thread.comments)
    latest = Math.max(latest, c.editedAt ?? c.ts, c.ts);
  return latest;
}

/**
 * Record that `user` had the thread on screen. A no-op (`changed: false`)
 * when their receipt already covers the newest comment, so a client that
 * reports twice writes nothing. A receipt is not activity: `updatedAt` stays,
 * so it never reorders a thread or reads as news.
 */
export function applyMarkSeen(
  threads: CommentThread[],
  threadId: string,
  user: string,
  now = Date.now(),
): ThreadResult & { changed?: boolean } {
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return { ok: false, reason: "not_found" };
  const name = cleanName(user);
  if (!name) return { ok: false, reason: "empty" };
  const seen = thread.seenBy ?? [];
  const mine = seen.find((s) => sameUser(s.user, name));
  if (mine && mine.ts >= lastActivityAt(thread))
    return { ok: true, thread, threads, changed: false };
  const next: CommentThread = {
    ...thread,
    seenBy: [
      ...seen.filter((s) => !sameUser(s.user, name)),
      { user: name, ts: now },
    ].slice(-MAX_SEEN),
  };
  const result = replace(threads, next);
  return result.ok ? { ...result, changed: true } : result;
}

/**
 * Who hears about activity on a thread: whoever started it, everyone who
 * commented, and the assignee. Never the agent, and never anyone in `exclude`.
 */
export function threadParticipants(
  thread: CommentThread,
  exclude: string[] = [],
): string[] {
  const out: string[] = [];
  const add = (name: string | undefined) => {
    if (!name) return;
    if (exclude.some((x) => sameUser(x, name))) return;
    if (out.some((x) => sameUser(x, name))) return;
    out.push(name);
  };
  add(thread.createdBy);
  for (const comment of thread.comments) if (!comment.agent) add(comment.user);
  add(thread.assignee);
  return out;
}

/** The thread as the agent reads it, oldest comment first. */
export function formatThread(thread: CommentThread): string {
  return thread.comments
    .map(
      (c) =>
        `**${c.agent ? `${c.user} (you)` : c.user}** at ${new Date(c.ts).toISOString()}:\n${c.text}`,
    )
    .join("\n\n");
}

// ── Catalog access ──────────────────────────────────────────────────────────

function documents() {
  return catalogDocuments(COMMENT_THREADS_NAMESPACE);
}

export async function listThreads(sessionId: string): Promise<CommentThread[]> {
  if (!isValidThreadSession(sessionId)) return [];
  return cleanThreads(await documents().get(sessionId));
}

export async function getThread(
  sessionId: string,
  threadId: string,
): Promise<CommentThread | null> {
  return (await listThreads(sessionId)).find((t) => t.id === threadId) ?? null;
}

/**
 * Run one pure mutation under the catalog's compare-and-swap. The mutator can
 * rerun on a conflict; the last run is the one that committed, so its result
 * is what the caller gets. A refused mutation writes nothing.
 */
export async function mutateThreads<
  R extends { ok: true; threads: CommentThread[] } | { ok: false },
>(sessionId: string, mutate: (threads: CommentThread[]) => R): Promise<R> {
  let outcome: R | undefined;
  let unchanged: CommentThread[] = [];
  await documents().update(sessionId, (value) => {
    const current = cleanThreads(value);
    const reactions = cleanReactions(value);
    const kept = Object.keys(reactions).length ? { reactions } : {};
    outcome = mutate(current);
    if (outcome.ok) return { threads: outcome.threads, ...kept };
    unchanged = current;
    // Writing back what was read is a no-op put (the catalog compares the
    // encoded value); a missing document stays missing.
    return value === null ? null : { threads: unchanged, ...kept };
  });
  return outcome!;
}

export async function listReactions(
  sessionId: string,
): Promise<MessageReactions> {
  if (!isValidThreadSession(sessionId)) return {};
  return cleanReactions(await documents().get(sessionId));
}

/** Toggle one reaction; null when the input is invalid. */
export async function toggleReaction(
  sessionId: string,
  entryId: string,
  emoji: string,
  user: string,
): Promise<MessageReactions | null> {
  if (!isValidThreadSession(sessionId)) return null;
  let result: MessageReactions | null = null;
  await documents().update(sessionId, (value) => {
    const threads = cleanThreads(value);
    result = applyToggleReaction(cleanReactions(value), entryId, emoji, user);
    if (!result) return value;
    return Object.keys(result).length
      ? { threads, reactions: result }
      : { threads };
  });
  return result;
}

/** Remove a deleted session's threads. */
export async function deleteSessionThreads(sessionId: string): Promise<void> {
  if (!isValidThreadSession(sessionId)) return;
  await documents().update(sessionId, () => null);
}

// ── One-time import ─────────────────────────────────────────────────────────

/** Each legacy note becomes a one-comment, open, unanchored thread. */
export function threadsFromNotes(
  sessionId: string,
  notes: unknown[],
): CommentThread[] {
  return notes.filter(isComment).map((note) => ({
    id: note.id,
    sessionId,
    status: "open" as const,
    createdBy: note.user,
    ts: note.ts,
    updatedAt: note.editedAt ?? note.ts,
    comments: [
      {
        id: note.id,
        user: note.user,
        text: note.text,
        ...(note.images?.length ? { images: note.images } : {}),
        ts: note.ts,
        ...(note.editedAt ? { editedAt: note.editedAt } : {}),
      },
    ],
  }));
}

async function jsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

/**
 * Seed rows for the first boot with this namespace: the thread documents the
 * catalog mirrors to disk (so a rebuilt catalog keeps them), then every legacy
 * note file for a session that has no thread document yet. Runs once, during
 * the boot import, with async filesystem calls only.
 */
export async function commentThreadSeedRows(): Promise<
  CatalogDocumentSeedRow[]
> {
  const rows = new Map<string, string>();
  const threadsDir = await legacyCatalogDirectory(COMMENT_THREADS_NAMESPACE);
  for (const file of await jsonFiles(threadsDir)) {
    const key = file.slice(0, -5);
    if (!isValidThreadSession(key)) continue;
    try {
      const value = await readFile(join(threadsDir, file), "utf8");
      JSON.parse(value);
      rows.set(key, value);
    } catch {
      console.warn(`[comment-threads] skipped unreadable ${file}`);
    }
  }
  const notesDir = await legacyCatalogDirectory("session-notes");
  for (const file of await jsonFiles(notesDir)) {
    const key = file.slice(0, -5);
    if (!isValidThreadSession(key) || rows.has(key)) continue;
    try {
      const raw = JSON.parse(await readFile(join(notesDir, file), "utf8"));
      const notes: unknown[] = Array.isArray(raw?.notes) ? raw.notes : [];
      const threads = threadsFromNotes(key, notes).slice(-MAX_THREADS);
      if (threads.length) rows.set(key, JSON.stringify({ threads }));
    } catch {
      console.warn(`[comment-threads] skipped unreadable note file ${file}`);
    }
  }
  return [...rows].map(([key, value]) => ({ key, value }));
}
