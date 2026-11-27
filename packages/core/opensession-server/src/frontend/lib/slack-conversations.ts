// The Channels place's list of Slack conversations, shared by the sidebar
// and the minibar's unread dot. One poll for the whole app while anything
// reads it, faster while the Channels place is on screen.

import { useEffect, useSyncExternalStore } from "react";
import type { Route } from "./app-route";
import {
  fetchConversations,
  type Conversation,
  type ConversationsPayload,
} from "./api/slack-channels";
import { errorMessage } from "./error-message";

export interface ConversationsSnapshot {
  /** Null until the first answer. */
  payload: ConversationsPayload | null;
  error: string | null;
}

const IDLE_POLL_MS = 90_000;
const FOCUSED_POLL_MS = 20_000;
const LAST_CHANNEL_KEY = "opensession-last-channel";

let snapshot: ConversationsSnapshot = { payload: null, error: null };
const listeners = new Set<() => void>();
let subscribers = 0;
let focused = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

function set(next: Partial<ConversationsSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (subscribers === 0) return;
  timer = setTimeout(
    () => void refreshConversations(),
    focused > 0 ? FOCUSED_POLL_MS : IDLE_POLL_MS,
  );
}

/** Ask the server again now. */
export function refreshConversations(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetchConversations()
    .then((payload) => set({ payload, error: null }))
    .catch((error) =>
      set({ error: errorMessage(error, "Couldn't load your Slack channels") }),
    )
    .finally(() => {
      inFlight = null;
      schedule();
    });
  return inFlight;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  subscribers += 1;
  if (subscribers === 1 && !inFlight) void refreshConversations();
  return () => {
    listeners.delete(listener);
    subscribers -= 1;
    if (subscribers === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

const read = () => snapshot;

/**
 * The person's Slack conversations. `focus` polls faster while the caller is
 * on screen: the Channels list passes it, the minibar's dot does not.
 */
export function useSlackConversations(focus = false): ConversationsSnapshot {
  useEffect(() => {
    if (!focus) return;
    focused += 1;
    void refreshConversations();
    return () => {
      focused -= 1;
    };
  }, [focus]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Clear a conversation's dot right away, ahead of the next poll. */
export function markConversationSeen(id: string): void {
  const payload = snapshot.payload;
  if (!payload) return;
  const row = payload.conversations.find((c) => c.id === id);
  if (!row || (!row.unread && !row.unreadCount)) return;
  set({
    payload: {
      ...payload,
      conversations: payload.conversations.map((c) =>
        c.id === id ? { ...c, unread: false, unreadCount: undefined } : c,
      ),
    },
  });
}

/** Anything unread: the minibar's dot. */
export function hasUnreadConversation(
  conversations: readonly Conversation[] | undefined,
): boolean {
  return !!conversations?.some((c) => c.unread);
}

export function rememberChannel(id: string): void {
  try {
    localStorage.setItem(LAST_CHANNEL_KEY, id);
  } catch {}
}

export function lastChannel(): string | undefined {
  try {
    return localStorage.getItem(LAST_CHANNEL_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** The Channels route for `id`, or for the conversation last open there. */
export function channelsRoute(id?: string): Route {
  const target = id ?? lastChannel();
  return target ? { view: "channels", id: target } : { view: "channels" };
}
