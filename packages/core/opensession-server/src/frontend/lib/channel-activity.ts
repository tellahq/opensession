// The last mention you saw in Activity, kept per person in this browser,
// so the Activity row can count what came after it.

import { useSyncExternalStore } from "react";
import { getCurrentUser } from "../components/UserPicker";

const CHANGE_EVENT = "opensession-channel-activity-seen";
const storageKey = () =>
  `opensession-channel-activity-seen:${getCurrentUser()}`;

function read(): string | null {
  try {
    return localStorage.getItem(storageKey());
  } catch {
    return null;
  }
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

export function useActivitySeen(): string | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

/** Mark everything up to `ts` seen. Never moves back. */
export function markActivitySeen(ts: string): void {
  const seen = read();
  if (seen && Number(seen) >= Number(ts)) return;
  try {
    localStorage.setItem(storageKey(), ts);
  } catch {}
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
