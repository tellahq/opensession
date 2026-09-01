/**
 * Manual status overrides for sessions of ALL sources. The sidebar's "My
 * sessions" lanes (Needs input / In progress / In review / Done / Backlog) are
 * normally *derived* from a session's PR + run state. This registry lets a human
 * pin a session into a chosen lane — e.g. shove an idle session into Backlog, or
 * drop something out of "In review" until later — overriding the derivation.
 *
 * Same shape as the archive / title-override registries: a backstage-owned JSON
 * store keyed by unified session id, applied over the derived value in
 * getAllSessions. Slack/Linear session files are read-only for opensession and the
 * lane is computed at scan time, so the override can't live in the session file.
 */
import { readFileSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { OPENSESSION_SESSIONS_DIR } from "./paths";

/** The manual lanes a session can be pinned into — mirrors the frontend's MineStatus. */
export type ManualStatus =
  | "needsinput"
  | "inprogress"
  | "review"
  | "merged"
  | "pending";

const VALID: ReadonlySet<string> = new Set<ManualStatus>([
  "needsinput",
  "inprogress",
  "review",
  "merged",
  "pending",
]);

export function isManualStatus(v: unknown): v is ManualStatus {
  return typeof v === "string" && VALID.has(v);
}

const REGISTRY_PATH = `${OPENSESSION_SESSIONS_DIR}/status-overrides.json`;

let cache: Record<string, ManualStatus> | null = null;

function load(): Record<string, ManualStatus> {
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

function save(registry: Record<string, ManualStatus>): void {
  cache = registry;
  writeJsonAtomic(REGISTRY_PATH, registry);
}

export function getStatusOverride(id: string): ManualStatus | undefined {
  return load()[id];
}

/** Set (a valid lane) or clear (null/invalid) the manual lane for a session id. */
export function setStatusOverride(
  id: string,
  status: ManualStatus | null,
): void {
  const registry = { ...load() };
  if (status && isManualStatus(status)) registry[id] = status;
  else delete registry[id];
  save(registry);
}
