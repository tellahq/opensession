// Per-user visibility for external source bands in the sidebar. The local copy
// keeps startup synchronous; ui-prefs makes the choice follow the user across
// devices. Feed ids are dynamic, so unknown ids are preserved.

import { z } from "zod";
import { getCurrentUser } from "../components/UserPicker";
import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { whenCurrentUserReady } from "./auth-ready";

const LOCAL_KEY_PREFIX = "opensession-sidebar-hidden-feeds:";
const PREF_KEY = "sidebar-hidden-feeds";
const CHANGE_EVENT = "opensession-sidebar-feeds-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

function localKey(user: string): string {
  return `${LOCAL_KEY_PREFIX}${user.trim().toLowerCase() || "anonymous"}`;
}

const hiddenSidebarFeedIdSchema = z.string().min(1);
const hiddenSidebarFeedsSchema = z.array(z.unknown()).transform((values) => {
  const ids: string[] = [];
  for (const value of values) {
    const result = hiddenSidebarFeedIdSchema.safeParse(value);
    if (result.success) ids.push(result.data);
  }
  return [...new Set(ids)];
});

export function normalizeHiddenSidebarFeeds(value: string[]): string[] {
  return [...new Set(value)];
}

function parseHiddenSidebarFeeds(value: string): string[] | null {
  try {
    const result = hiddenSidebarFeedsSchema.safeParse(JSON.parse(value));
    if (!result.success) return [];
    return result.data;
  } catch {
    return null;
  }
}

function readLocal(user: string): Set<string> {
  const hidden = parseHiddenSidebarFeeds(
    localStorage.getItem(localKey(user)) || "[]",
  );
  return new Set(hidden ?? []);
}

function writeLocal(user: string, hidden: Set<string>) {
  localStorage.setItem(
    localKey(user),
    JSON.stringify(normalizeHiddenSidebarFeeds([...hidden])),
  );
}

export function readHiddenSidebarFeeds(): Set<string> {
  return readLocal(getCurrentUser());
}

let writeStamp = 0;
let saveChain: Promise<unknown> = Promise.resolve();

export function setSidebarFeedVisible(id: string, visible: boolean) {
  const user = getCurrentUser();
  const hidden = readLocal(user);
  if (visible) hidden.delete(id);
  else hidden.add(id);
  writeStamp++;
  writeLocal(user, hidden);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  saveChain = saveChain
    .catch(() => {})
    .then(() =>
      saveUiPrefsApi(user, { [PREF_KEY]: JSON.stringify([...hidden]) }),
    )
    .catch(() => {});
}

async function hydrate(user: string) {
  const stampAtStart = writeStamp;
  let prefs: Record<string, string>;
  try {
    prefs = await fetchUiPrefs(user);
  } catch {
    return;
  }
  if (writeStamp !== stampAtStart) return;
  const serverValue = prefs[PREF_KEY];
  if (serverValue !== undefined) {
    const parsed = parseHiddenSidebarFeeds(serverValue);
    if (parsed === null) return;
    const serverHidden = new Set(parsed);
    if (
      JSON.stringify([...serverHidden]) !== JSON.stringify([...readLocal(user)])
    ) {
      writeLocal(user, serverHidden);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    }
  } else {
    const localHidden = readLocal(user);
    if (localHidden.size > 0) {
      void saveUiPrefsApi(user, {
        [PREF_KEY]: JSON.stringify([...localHidden]),
      }).catch(() => {});
    }
  }
}

// Guarded the way sidebar-tools.ts guards the same pair: without it, importing
// this module outside a browser (a test that only wants a pure helper from a
// module that re-exports from here) throws on `localStorage` at import time,
// before any test has had a chance to install a shim.
if (typeof window !== "undefined") {
  whenCurrentUserReady((user) => void hydrate(user));
  window.addEventListener(USER_CHANGE_EVENT, () => {
    writeStamp++;
    window.dispatchEvent(new Event(CHANGE_EVENT));
    void hydrate(getCurrentUser());
  });
}

export function onSidebarFeedsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key?.startsWith(LOCAL_KEY_PREFIX)) {
      writeStamp++;
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } else if (
      event.key === "opensession-user" ||
      event.key === "backstage-user"
    ) {
      writeStamp++;
      window.dispatchEvent(new Event(CHANGE_EVENT));
      void hydrate(getCurrentUser());
    }
  });
}
