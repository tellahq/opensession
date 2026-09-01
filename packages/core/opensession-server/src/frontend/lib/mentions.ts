/**
 * Sessions where a teammate tagged you, so the sidebar can mark the row.
 * Server-owned (src/server/mentions.ts) rather than per-browser: a mention is
 * a message to a person, and it has to look the same on every device they
 * open. Same in-memory-cache shape as pins.ts — synchronous reads, hydrated on
 * load and on user switch, updated live from the socket.
 *
 * A mention clears when you open the session. That is the whole read model:
 * looking is what "I've seen it" means, so there is no separate dismiss.
 */

import { clearMentionApi, fetchMentions, type MentionRecord } from "./api";
import { getCurrentUser } from "../components/UserPicker";
import { whenCurrentUserReady } from "./auth-ready";

const CHANGE_EVENT = "opensession-mentions-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

let cache = new Map<string, MentionRecord>();
let loadedFor: string | null = null;

function emit() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function toMap(list: MentionRecord[]): Map<string, MentionRecord> {
  return new Map(list.map((m) => [m.sessionId, m]));
}

async function load(user: string) {
  loadedFor = user;
  let list: MentionRecord[] = [];
  try {
    list = await fetchMentions(user);
  } catch {
    list = [];
  }
  // A newer load() (user switched mid-flight) wins.
  if (loadedFor !== user) return;
  cache = toMap(list);
  emit();
}

whenCurrentUserReady((user) => void load(user));
window.addEventListener(USER_CHANGE_EVENT, () => void load(getCurrentUser()));

/** The mention on this session, if you have one. */
export function mentionFor(sessionId: string): MentionRecord | undefined {
  return cache.get(sessionId);
}

export function mentionCount(): number {
  return cache.size;
}

export function allMentions(): MentionRecord[] {
  return [...cache.values()].sort((a, b) => b.ts - a.ts);
}

/**
 * Drop the mention for a session — called when you open it. Optimistic: the
 * badge goes now, the server catches up, and its broadcast is a no-op for this
 * client because the cache already agrees.
 */
export function clearMention(sessionId: string): void {
  if (!cache.has(sessionId)) return;
  const next = new Map(cache);
  next.delete(sessionId);
  cache = next;
  emit();
  void clearMentionApi(getCurrentUser(), sessionId).catch(() => {});
}

export function clearAllMentions(): void {
  if (!cache.size) return;
  cache = new Map();
  emit();
  void clearMentionApi(getCurrentUser()).catch(() => {});
}

/** Apply a server push. Ignores mentions addressed to somebody else. */
export function receiveMention(user: string, mention: MentionRecord): void {
  if (!sameUser(user)) return;
  const next = new Map(cache);
  next.set(mention.sessionId, mention);
  cache = next;
  emit();
}

/** Another device of yours opened the session (or cleared everything). */
export function receiveMentionsCleared(user: string, sessionId?: string): void {
  if (!sameUser(user)) return;
  if (!sessionId) {
    if (!cache.size) return;
    cache = new Map();
    emit();
    return;
  }
  if (!cache.has(sessionId)) return;
  const next = new Map(cache);
  next.delete(sessionId);
  cache = next;
  emit();
}

/** Mentions are keyed on the picker first name; the socket carries the same. */
function sameUser(user: string): boolean {
  return user.trim().toLowerCase() === getCurrentUser().trim().toLowerCase();
}

export function onMentionsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}
