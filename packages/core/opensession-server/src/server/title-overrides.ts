/**
 * Manual display titles for sessions of ALL sources. Slack/Linear session files
 * are owned by their agents (read-only for opensession) and opensession titles are
 * derived at scan time, so a user rename can't live in the session file. It
 * lives in a server-owned registry keyed by unified session id, applied over
 * the derived title in getAllSessions — exactly like the archive registry.
 */
import { readFileSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "./paths";

const HOME = homeDir();
const REGISTRY_PATH = `${OPENSESSION_SESSIONS_DIR}/title-overrides.json`;

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (cache) return cache;
  try {
    cache = existsSync(REGISTRY_PATH)
      ? JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"))
      : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function save(registry: Record<string, string>): void {
  cache = registry;
  writeJsonAtomic(REGISTRY_PATH, registry);
}

export function getTitleOverride(id: string): string | undefined {
  return load()[id];
}

/** Set (non-empty) or clear (empty/null) the manual title for a session id. */
export function setTitleOverride(id: string, title: string | null): void {
  const registry = { ...load() };
  const trimmed = title?.trim();
  if (trimmed) registry[id] = trimmed;
  else delete registry[id];
  save(registry);
}
