/**
 * Per-composer draft persistence, so typed text and staged attachments survive
 * navigating away (session → other session / workspace / home) instead of dying with
 * the unmounted component.
 *
 * The module-level Map is the source of truth while the app is open — every
 * SessionViewer remounts on session switch (key=session.id in App), so component
 * state can't carry a draft across. sessionStorage is a best-effort mirror so a
 * tab reload keeps the draft too; writes are debounced because images ride
 * along as multi-MB `data:` URLs and drafts are saved on every keystroke.
 *
 * Session drafts (`session:<id>` keys) also sync to the server per user
 * (src/server/drafts.ts), so text typed on the phone is here when you sit down
 * at the browser, and the sidebar pencil shows up on both. Only the text
 * travels: staged images stay on the device that staged them.
 *
 * The rule for whose copy wins is a dirty check, not a timestamp race. A key
 * whose text still equals what we last agreed with the server is clean, and
 * the server copy replaces it (including a deletion, which is what makes the
 * pencil clear here after you send the message on your phone). A key you have
 * typed into since is dirty: it stays, and gets pushed.
 */
import { fetchDrafts, saveDraftApi } from "./api";
import { reconcileDrafts } from "./drafts-sync";
import { getCurrentUser } from "../components/UserPicker";
import { whenCurrentUserReady } from "./auth-ready";
import type { FileAttachment } from "./images";
import type { PastedTextAttachment } from "./pasted-text";

export interface ComposerDraft {
  text: string;
  images: string[];
  files: FileAttachment[];
  pastedTexts: PastedTextAttachment[];
}

/** The one draft the new-session palette keeps, wherever it is rendered: the
 *  overlay and the inline card are the same composer, so a prompt typed into
 *  one is already in the other. */
export const NEW_SESSION_DRAFT_KEY = "new-session";

/** The draft key for a workspace's own composer. Attachments parked from the
 *  new-session palette land here, which is where WorkspacePane reads them. */
export function workspaceDraftKey(workspaceId: string): string {
  return `workspace-home:${workspaceId}`;
}

const EMPTY: ComposerDraft = {
  text: "",
  images: [],
  files: [],
  pastedTexts: [],
};
const drafts = new Map<string, ComposerDraft>();
/** Text last confirmed by the server. Persisted beside each local draft so a
 * reload can distinguish offline typing from text already sent elsewhere. */
const syncedText = new Map<string, string>();

// Fired when a draft appears/disappears, or remote text changes. Local
// keystrokes only emit on the presence edge, so the sidebar never re-renders
// per character; remote changes need an event so a mounted composer can adopt.
const CHANGE_EVENT = "backstage-drafts-changed";

function emit(key?: string) {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }));
}

/** Subscribe to drafts appearing/disappearing; returns the unsubscribe.
 *  A key identifies a local change. An undefined key means several drafts may
 *  have changed during hydration and subscribers should re-read their scope. */
export function onDraftsChanged(handler: (key?: string) => void): () => void {
  const listener = (event: Event) =>
    handler((event as CustomEvent<string | undefined>).detail);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/** Whether a non-empty draft (text or attachments) is stored under this key. */
export function hasDraft(key: string): boolean {
  return !isEmpty(loadDraft(key));
}

const SS_PREFIX = "backstage-draft:";
// Stay well under the ~5MB sessionStorage quota; an oversized draft (big
// screenshots) just stays memory-only instead of throwing.
const MAX_PERSIST_BYTES = 3_000_000;
const PERSIST_DEBOUNCE_MS = 400;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function isEmpty(d: ComposerDraft): boolean {
  return (
    !d.text.trim() &&
    d.images.length === 0 &&
    d.files.length === 0 &&
    d.pastedTexts.length === 0
  );
}

function persistNow(key: string) {
  timers.delete(key);
  const d = drafts.get(key);
  try {
    if (!d || isEmpty(d)) {
      sessionStorage.removeItem(SS_PREFIX + key);
      return;
    }
    const serialize = (draft: ComposerDraft) =>
      JSON.stringify({
        ...draft,
        ...(syncedText.has(key) ? { syncedText: syncedText.get(key) } : {}),
      });
    const json = serialize(d);
    if (json.length <= MAX_PERSIST_BYTES) {
      sessionStorage.setItem(SS_PREFIX + key, json);
      return;
    }
    // Over the cap, so something has to give — but never the whole draft.
    // An attachment normally rides as a ~90-character `/media?path=` ref;
    // only the inline fallback for an image the server refused (lib/images.ts)
    // is measured in megabytes, so that is what gets left behind. A reload
    // then loses those images and keeps everything written, rather than
    // silently dropping the text along with them.
    const lean = serialize({
      ...d,
      images: d.images.filter((src) => !src.startsWith("data:")),
      files: d.files.filter((file) => !file.dataUrl),
    });
    if (lean.length <= MAX_PERSIST_BYTES)
      sessionStorage.setItem(SS_PREFIX + key, lean);
    else sessionStorage.removeItem(SS_PREFIX + key);
  } catch {
    // Quota or private-mode failure — the in-memory copy still holds the draft.
  }
}

function schedulePersist(key: string) {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => persistNow(key), PERSIST_DEBOUNCE_MS),
  );
}

// Flush pending mirrors when the page is going away, so the debounce window
// can't eat the last keystrokes before a reload. Capability check, not just
// `typeof window`: test runners can leave a bare `window` global without DOM
// methods.
if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function" &&
  typeof window.setInterval === "function" &&
  typeof document !== "undefined" &&
  typeof document.addEventListener === "function"
) {
  window.addEventListener("pagehide", () => {
    for (const key of [...timers.keys()]) {
      clearTimeout(timers.get(key));
      persistNow(key);
    }
  });
}

/** Current draft for a key ("" / empty arrays when none). Treat as immutable. */
export function loadDraft(key: string): ComposerDraft {
  const mem = drafts.get(key);
  if (mem) return mem;
  try {
    const raw = sessionStorage.getItem(SS_PREFIX + key);
    if (raw) {
      const parsed = JSON.parse(raw);
      const d: ComposerDraft = {
        text: typeof parsed?.text === "string" ? parsed.text : "",
        images: Array.isArray(parsed?.images) ? parsed.images : [],
        files: Array.isArray(parsed?.files) ? parsed.files : [],
        pastedTexts: Array.isArray(parsed?.pastedTexts)
          ? parsed.pastedTexts.filter(
              (item: unknown): item is PastedTextAttachment =>
                !!item &&
                typeof item === "object" &&
                typeof (item as PastedTextAttachment).id === "string" &&
                typeof (item as PastedTextAttachment).text === "string",
            )
          : [],
      };
      drafts.set(key, d);
      if (typeof parsed?.syncedText === "string") {
        syncedText.set(key, parsed.syncedText);
      }
      return d;
    }
  } catch {}
  return EMPTY;
}

/** Store `next` locally (an empty draft deletes the entry). */
function writeLocal(
  key: string,
  next: ComposerDraft,
  opts?: { notifyText?: boolean },
): void {
  const previous = loadDraft(key);
  const had = !isEmpty(previous);
  const previousText = previous.text;
  const has = !isEmpty(next);
  // An attachment can land in the store without passing through the composer
  // that staged it: the upload outlives the composer (lib/attachments.ts), so
  // an open one has to hear about it or it goes on showing the draft as it was
  // when the paste happened. Rare by nature, unlike a keystroke, so this costs
  // the sidebar nothing.
  const attachmentsChanged =
    previous.images.length !== next.images.length ||
    previous.files.length !== next.files.length;
  if (has) {
    drafts.set(key, next);
    schedulePersist(key);
  } else {
    // Delete synchronously, never debounced: subscribers react to the change
    // event by calling hasDraft/loadDraft, and with the sessionStorage entry
    // still present a Map miss would re-cache the stale draft — resurrecting
    // what was just cleared (drafts reappearing after send).
    drafts.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
    try {
      sessionStorage.removeItem(SS_PREFIX + key);
    } catch {}
  }
  if (
    had !== has ||
    attachmentsChanged ||
    (opts?.notifyText && previousText !== next.text)
  )
    emit(key);
}

/** Merge a partial update into the stored draft; an all-empty result deletes it. */
export function saveDraft(key: string, patch: Partial<ComposerDraft>): void {
  const before = loadDraft(key).text;
  writeLocal(key, { ...loadDraft(key), ...patch });
  if (loadDraft(key).text !== before) markEdited(key);
}

export function clearDraft(key: string): void {
  const had = hasDraft(key);
  drafts.delete(key);
  clearTimeout(timers.get(key));
  timers.delete(key);
  try {
    sessionStorage.removeItem(SS_PREFIX + key);
  } catch {}
  syncedText.delete(key);
  if (had) {
    emit(key);
    // Sending or clearing is the one change worth telling the other device
    // about right away: it's what takes the pencil off the row over there.
    markEdited(key, { immediate: true });
  }
}

// ── Server sync (session composers only) ────────────────────────────────

const SESSION_PREFIX = "session:";
/** The text we last agreed on with the server, per key. A key whose current
 *  text differs is dirty: it was typed here and the server copy must not
 *  replace it. */
/** When this device last touched the text, so the server can refuse a device
 *  that wakes up holding an older copy. */
const editedAt = new Map<string, string>();
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const attemptedText = new Map<string, string>();
const PUSH_DEBOUNCE_MS = 800;
let hydratedFor: string | null = null;
let hydrateVersion = 0;
let hydrateRetry: ReturnType<typeof setTimeout> | undefined;
let textMutation = 0;
let unloading = false;

function sessionIdOf(key: string): string | null {
  return key.startsWith(SESSION_PREFIX)
    ? key.slice(SESSION_PREFIX.length)
    : null;
}

function pushNow(key: string): void {
  clearTimeout(pushTimers.get(key));
  pushTimers.delete(key);
  const id = sessionIdOf(key);
  if (!id) return;
  const text = loadDraft(key).text;
  const at = editedAt.get(key) || new Date().toISOString();
  const user = getCurrentUser();
  attemptedText.set(key, text);
  saveDraftApi(user, id, text, at, unloading)
    .then((result) => {
      // Refused as older than the stored copy: leave this key dirty rather
      // than adopting the server's text under someone's cursor. The next
      // keystroke carries a newer stamp and wins.
      if (getCurrentUser() !== user) return;
      if (attemptedText.get(key) === text) attemptedText.delete(key);
      if (result.applied && loadDraft(key).text === text) {
        syncedText.set(key, result.draft?.text ?? "");
        schedulePersist(key);
      } else if (!result.applied && loadDraft(key).text === text) {
        applyRemote(key, result.draft?.text ?? "");
      }
    })
    .catch(() => {
      if (getCurrentUser() === user && attemptedText.get(key) === text) {
        attemptedText.delete(key);
      }
    });
}

/** Text changed locally: stamp it and schedule (or force) the push. */
function markEdited(key: string, opts?: { immediate?: boolean }): void {
  if (!sessionIdOf(key)) return;
  editedAt.set(key, new Date().toISOString());
  textMutation++;
  if (opts?.immediate) {
    pushNow(key);
    return;
  }
  clearTimeout(pushTimers.get(key));
  pushTimers.set(
    key,
    setTimeout(() => pushNow(key), PUSH_DEBOUNCE_MS),
  );
}

/** Adopt the server's text for a clean key, keeping any staged attachments. */
function applyRemote(key: string, text: string): void {
  syncedText.set(key, text);
  writeLocal(key, { ...loadDraft(key), text }, { notifyText: true });
  editedAt.delete(key);
}

async function hydrate(user: string): Promise<void> {
  const version = ++hydrateVersion;
  const mutation = textMutation;
  let server: Record<string, { text: string; updatedAt: string }>;
  try {
    server = await fetchDrafts(user);
  } catch {
    clearTimeout(hydrateRetry);
    hydrateRetry = setTimeout(() => {
      if (getCurrentUser() === user && hydratedFor !== user) void hydrate(user);
    }, 5_000);
    return;
  }
  // A newer hydrate (or a user switch) started while this one was in flight.
  if (
    version !== hydrateVersion ||
    mutation !== textMutation ||
    getCurrentUser() !== user
  )
    return;
  clearTimeout(hydrateRetry);
  hydrateRetry = undefined;
  hydratedFor = user;

  const storedKeys = new Set<string>();
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const storageKey = sessionStorage.key(index);
      if (storageKey?.startsWith(SS_PREFIX + SESSION_PREFIX)) {
        storedKeys.add(storageKey.slice(SS_PREFIX.length));
      }
    }
  } catch {}
  const local: Record<string, string> = {};
  for (const key of [...drafts.keys(), ...syncedText.keys(), ...storedKeys]) {
    if (sessionIdOf(key)) local[key] = loadDraft(key).text;
  }
  for (const action of reconcileDrafts(
    server,
    {
      local,
      synced: Object.fromEntries([...syncedText, ...attemptedText]),
    },
    (id) => SESSION_PREFIX + id,
  )) {
    if (action.kind === "adopt") applyRemote(action.key, action.text);
    else if (action.kind === "agree") {
      syncedText.set(action.key, action.text);
      schedulePersist(action.key);
    } else pushNow(action.key);
  }
  // Keys the server dropped and we no longer hold are settled: stop tracking
  // them so the map doesn't grow for the life of the tab.
  for (const key of [...syncedText.keys()]) {
    if (!loadDraft(key).text && !server[key.slice(SESSION_PREFIX.length)]) {
      syncedText.delete(key);
    }
  }
}

/** Forget every session draft held for the previous user (they are that
 *  person's unsent writing, not the new user's). */
function dropSessionDrafts(): void {
  let changed = false;
  for (const key of [...drafts.keys()]) {
    if (!sessionIdOf(key)) continue;
    if (!isEmpty(loadDraft(key))) changed = true;
    clearTimeout(pushTimers.get(key));
    pushTimers.delete(key);
    drafts.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
    try {
      sessionStorage.removeItem(SS_PREFIX + key);
    } catch {}
  }
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(SS_PREFIX + SESSION_PREFIX))
        sessionStorage.removeItem(key);
    }
  } catch {}
  syncedText.clear();
  attemptedText.clear();
  editedAt.clear();
  if (changed) emit();
}

function rehydrateForCurrentUser(): void {
  clearTimeout(hydrateRetry);
  hydrateRetry = undefined;
  hydratedFor = null;
  dropSessionDrafts();
  void hydrate(getCurrentUser());
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  whenCurrentUserReady((user) => void hydrate(user));
  window.addEventListener("opensession-user-changed", rehydrateForCurrentUser);
  window.addEventListener("storage", (event) => {
    if (event.key === "opensession-user" || event.key === "backstage-user") {
      rehydrateForCurrentUser();
    }
  });
  if (typeof document !== "undefined") {
    // Coming back to a tab that sat in the background: pick up what was typed
    // (or sent) on the other device while it was away.
    document.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState === "visible")
        void hydrate(getCurrentUser());
    });
    window.setInterval(() => {
      if (document.visibilityState === "visible")
        void hydrate(getCurrentUser());
    }, 30_000);
  }
  // Don't let the debounce eat the last keystrokes when the tab goes away.
  window.addEventListener("pagehide", () => {
    unloading = true;
    for (const key of [...pushTimers.keys()]) pushNow(key);
  });
}
