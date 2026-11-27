// Unsent messages in the Channels place, one per conversation and thread.
// Slack keeps its own drafts behind an API only its client may call, so
// these are this browser's: whatever you leave in a message box stays there
// when you move on, and Drafts & sent lists it until you send or delete it.
// Kept per signed-in person in localStorage.

import { useSyncExternalStore } from "react";
import { getCurrentUser } from "../components/UserPicker";
import {
  decodeDrafts,
  draftKey,
  type ChannelDraft,
} from "./channel-draft-model";

export { draftKey, type ChannelDraft } from "./channel-draft-model";

const CHANGE_EVENT = "opensession-channel-drafts-changed";
const storageKey = () => `opensession-channel-drafts:${getCurrentUser()}`;

let cachedRaw: string | null = null;
let cached: ChannelDraft[] = [];

function readAll(): ChannelDraft[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey());
  } catch {}
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = decodeDrafts(raw);
  }
  return cached;
}

function writeAll(drafts: ChannelDraft[]) {
  try {
    if (drafts.length)
      localStorage.setItem(storageKey(), JSON.stringify(drafts));
    else localStorage.removeItem(storageKey());
  } catch {}
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey()) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Every unsent message, newest first. */
export function useChannelDrafts(): ChannelDraft[] {
  return useSyncExternalStore(subscribe, readAll, () => cached);
}

export function readDraft(
  channelId: string,
  thread?: string,
): ChannelDraft | undefined {
  const key = draftKey(channelId, thread);
  return readAll().find(
    (draft) => draftKey(draft.channelId, draft.thread) === key,
  );
}

/** Keep what is in a message box, or forget it once it is empty. */
export function saveDraft(
  channelId: string,
  thread: string | undefined,
  text: string,
  mentions: ReadonlyMap<string, string>,
): void {
  const key = draftKey(channelId, thread);
  const rest = readAll().filter(
    (draft) => draftKey(draft.channelId, draft.thread) !== key,
  );
  if (!text.trim()) {
    if (rest.length !== readAll().length) writeAll(rest);
    return;
  }
  const draft: ChannelDraft = {
    channelId,
    text,
    at: Date.now(),
    mentions: [...mentions],
  };
  if (thread) draft.thread = thread;
  writeAll([draft, ...rest]);
}

export function deleteDraft(channelId: string, thread?: string): void {
  saveDraft(channelId, thread, "", new Map());
}
