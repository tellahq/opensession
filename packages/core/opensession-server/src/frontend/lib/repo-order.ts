// Per-user order for repository bands. The server-side ui-pref follows the
// user across devices; user-scoped localStorage keeps startup synchronous.

import { z } from "zod";
import { getCurrentUser } from "../components/UserPicker";
import { fetchUiPrefs, saveUiPrefsApi } from "./api";
import { whenCurrentUserReady } from "./auth-ready";

const LOCAL_KEY_PREFIX = "opensession-repo-order:";
const DIRTY_KEY_PREFIX = "opensession-repo-order-dirty:";
const PREF_KEY = "repo-order";
const CHANGE_EVENT = "opensession-repo-order-changed";
const USER_CHANGE_EVENT = "opensession-user-changed";

function localKey(user: string): string {
  return `${LOCAL_KEY_PREFIX}${user.trim().toLowerCase() || "anonymous"}`;
}

function dirtyKey(user: string): string {
  return `${DIRTY_KEY_PREFIX}${user.trim().toLowerCase() || "anonymous"}`;
}

const repoNameSchema = z.string();
const eventListenerSchema = z.function();

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function normalizeRepoOrder(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const item of value) {
    const parsed = repoNameSchema.safeParse(item);
    if (!parsed.success) continue;
    const repo = parsed.data.trim();
    if (!repo || seen.has(repo)) continue;
    seen.add(repo);
    order.push(repo);
  }
  return order;
}

export function mergeRepoOrder(
  preferred: readonly string[],
  discovered: readonly string[],
): string[] {
  const available = new Set(discovered);
  const ordered = normalizeRepoOrder(preferred).filter((repo) =>
    available.has(repo),
  );
  const seen = new Set(ordered);
  for (const repo of discovered) {
    if (!seen.has(repo)) {
      seen.add(repo);
      ordered.push(repo);
    }
  }
  return ordered;
}

/** Reorder only visible slots, preserving filtered-out repositories in place. */
export function replaceVisibleRepoOrder(
  fullOrder: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const visible = new Set(visibleOrder);
  const queue = [...visibleOrder];
  const next = fullOrder.map((repo) =>
    visible.has(repo) ? (queue.shift() ?? repo) : repo,
  );
  const seen = new Set(next);
  for (const repo of visibleOrder) {
    if (!seen.has(repo)) {
      seen.add(repo);
      next.push(repo);
    }
  }
  return next;
}

function readLocal(user: string): string[] {
  try {
    return normalizeRepoOrder(
      JSON.parse(localStorage.getItem(localKey(user)) || "[]"),
    );
  } catch {
    return [];
  }
}

function writeLocal(user: string, order: readonly string[]) {
  localStorage.setItem(
    localKey(user),
    JSON.stringify(normalizeRepoOrder(order)),
  );
}

export function getRepoOrder(): string[] {
  return readLocal(getCurrentUser());
}

let writeStamp = 0;
let saveChain: Promise<unknown> = Promise.resolve();
const pendingWrites = new Map<string, string>();

function persist(user: string, value: string, attempt = 0) {
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      if (pendingWrites.get(user) !== value) return;
      const stored = await saveUiPrefsApi(user, { [PREF_KEY]: value });
      if (stored[PREF_KEY] !== value)
        throw new Error("repo order was not stored");
      if (pendingWrites.get(user) === value) {
        pendingWrites.delete(user);
        localStorage.removeItem(dirtyKey(user));
      }
    })
    .catch(() => {
      if (
        attempt < 2 &&
        pendingWrites.get(user) === value &&
        JSON.stringify(readLocal(user)) === value
      ) {
        setTimeout(
          () => persist(user, value, attempt + 1),
          1_000 * (attempt + 1),
        );
      }
    });
}

export function setRepoOrder(order: readonly string[]) {
  const user = getCurrentUser();
  const next = normalizeRepoOrder(order);
  writeStamp++;
  writeLocal(user, next);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  const value = JSON.stringify(next);
  localStorage.setItem(dirtyKey(user), value);
  pendingWrites.set(user, value);
  persist(user, value);
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
  if (pendingWrites.has(user)) return;
  const dirtyValue = localStorage.getItem(dirtyKey(user));
  if (dirtyValue) {
    pendingWrites.set(user, dirtyValue);
    persist(user, dirtyValue);
    return;
  }
  const parsedServerValue = repoNameSchema.safeParse(prefs[PREF_KEY]);
  if (!parsedServerValue.success) {
    const localOrder = readLocal(user);
    if (localOrder.length) {
      const value = JSON.stringify(localOrder);
      localStorage.setItem(dirtyKey(user), value);
      pendingWrites.set(user, value);
      persist(user, value);
    }
    return;
  }
  try {
    const serverOrder = normalizeRepoOrder(JSON.parse(parsedServerValue.data));
    if (JSON.stringify(serverOrder) !== JSON.stringify(readLocal(user))) {
      writeLocal(user, serverOrder);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    }
  } catch {}
}

export function onRepoOrderChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Capability check, not just `typeof window`: test runners can leave a bare
// `window` global without DOM methods, which must not break module import.
if (
  "window" in globalThis &&
  eventListenerSchema.safeParse(window.addEventListener).success
) {
  whenCurrentUserReady((user) => void hydrate(user));
  window.addEventListener(USER_CHANGE_EVENT, () => {
    writeStamp++;
    window.dispatchEvent(new Event(CHANGE_EVENT));
    void hydrate(getCurrentUser());
  });
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
