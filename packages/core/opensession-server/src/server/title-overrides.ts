/**
 * Manual display titles for sessions of ALL sources. Slack/Linear session files
 * are owned by their agents (read-only for opensession) and opensession titles are
 * derived at scan time, so a user rename can't live in the session file. It
 * lives in a server-owned registry keyed by unified session id, applied over
 * the derived title in getAllSessions — exactly like the archive registry.
 */
import { readFile } from "fs/promises";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "./paths";

const HOME = homeDir();
const REGISTRY_PATH = `${OPENSESSION_SESSIONS_DIR}/title-overrides.json`;

let cache: Record<string, string> | null = null;
let loading: Promise<Record<string, string>> | null = null;
let writes: Promise<void> = Promise.resolve();

/** Read the registry once, asynchronously. Boot awaits this before serving,
 * so the synchronous getters below answer from memory. */
export function loadTitleOverrides(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache);
  return (loading ??= readFile(REGISTRY_PATH, "utf-8")
    .then((text) => JSON.parse(text) as Record<string, string>)
    .catch(() => ({}))
    .then((registry) => (cache ??= registry)));
}

function load(): Record<string, string> {
  if (cache) return cache;
  // Not hydrated yet (a test or a script that skipped boot): answer empty and
  // read the file in the background rather than block on it.
  void loadTitleOverrides();
  return {};
}

/** Replace the registry in memory now and on disk in call order. */
async function save(registry: Record<string, string>): Promise<void> {
  cache = registry;
  const write = writes.then(() =>
    writeJsonAtomicAsync(REGISTRY_PATH, registry),
  );
  writes = write.catch(() => {});
  await write;
}

export function getTitleOverride(id: string): string | undefined {
  return load()[id];
}

/** Non-blocking read for background title generation, including other writers. */
export async function getTitleOverrideAsync(
  id: string,
): Promise<string | undefined> {
  try {
    return JSON.parse(await readFile(REGISTRY_PATH, "utf-8"))[id];
  } catch {
    return cache?.[id];
  }
}

/** Set (non-empty) or clear (empty/null) the manual title for a session id. */
export async function setTitleOverride(
  id: string,
  title: string | null,
): Promise<void> {
  await loadTitleOverrides();
  const registry = { ...cache! };
  const trimmed = title?.trim();
  if (trimmed) registry[id] = trimmed;
  else delete registry[id];
  await save(registry);
}
