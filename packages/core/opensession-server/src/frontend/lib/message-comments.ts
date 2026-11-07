/**
 * Comments and reactions on whole messages, for the transcript rows that
 * show them. The session viewer owns the thread list (its `comment_thread`
 * handler); this mirrors it per session so a row deep in the transcript can
 * read its own thread without the list being threaded through every block,
 * and holds the session's reactions and which message's comments are open.
 */

import { createContext, use, useSyncExternalStore } from "react";
import { messageThreads } from "./comment-threads";
import type { MessageReactions } from "./api/threads";
import type { CommentThread } from "./types";

/** The emoji a person can react with, in picker order (server: REACTION_EMOJI). */
export const REACTION_EMOJI = ["👍", "❤️", "🎉", "👀", "🚀", "✅"] as const;

interface SessionMessageComments {
  threads: CommentThread[];
  reactions: MessageReactions;
}

/** The message whose comments are open: its session and entry. */
export interface OpenMessageComments {
  sessionId: string;
  entryId: string;
  /** The message's opening text, quoted at the top of a new thread. */
  excerpt: string;
  /** Who wrote the message, for the quote. */
  author: string;
}

const EMPTY: SessionMessageComments = { threads: [], reactions: {} };
const bySession = new Map<string, SessionMessageComments>();
let open: OpenMessageComments | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishMessageThreads(
  sessionId: string,
  threads: CommentThread[],
): void {
  const current = bySession.get(sessionId) ?? EMPTY;
  const next = messageThreads(threads);
  if (
    next.length === current.threads.length &&
    next.every((thread, i) => thread === current.threads[i])
  )
    return;
  bySession.set(sessionId, { ...current, threads: next });
  emit();
}

export function publishMessageReactions(
  sessionId: string,
  reactions: MessageReactions,
): void {
  const current = bySession.get(sessionId) ?? EMPTY;
  bySession.set(sessionId, { ...current, reactions });
  emit();
}

/** The thread on one message, if anyone has commented on it. */
export function useMessageThread(
  sessionId: string | undefined,
  entryId: string,
): CommentThread | null {
  const read = () =>
    sessionId
      ? ((bySession.get(sessionId) ?? EMPTY).threads.find(
          (thread) => thread.anchor?.entryId === entryId,
        ) ?? null)
      : null;
  return useSyncExternalStore(subscribe, read, read);
}

const NO_REACTIONS: Record<string, string[]> = {};

export function useMessageReactions(
  sessionId: string | undefined,
  entryId: string,
): Record<string, string[]> {
  const read = () =>
    sessionId
      ? ((bySession.get(sessionId) ?? EMPTY).reactions[entryId] ?? NO_REACTIONS)
      : NO_REACTIONS;
  return useSyncExternalStore(subscribe, read, read);
}

/** Every commented message in a session, oldest first: what the pane's
 *  arrows step through. */
export function useMessageThreads(sessionId: string): CommentThread[] {
  const read = () => (bySession.get(sessionId) ?? EMPTY).threads;
  return useSyncExternalStore(subscribe, read, read);
}

export function openMessageComments(target: OpenMessageComments): void {
  open = target;
  emit();
}

export function closeMessageComments(): void {
  if (!open) return;
  open = null;
  emit();
}

export function useOpenMessageComments(): OpenMessageComments | null {
  const read = () => open;
  return useSyncExternalStore(subscribe, read, read);
}

/** People in a thread, starter first, each once. */
export function threadPeople(thread: CommentThread): string[] {
  const seen = new Set<string>();
  const people: string[] = [];
  for (const comment of thread.comments) {
    const key = comment.user.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(comment.user);
  }
  return people;
}

const SessionIdContext = createContext<string | null>(null);

/** The session the transcript under it belongs to: what a message's
 *  Comment and reaction actions write to. */
export const MessageCommentsSession = SessionIdContext.Provider;

export function useMessageCommentsSession(): string | null {
  return use(SessionIdContext);
}
