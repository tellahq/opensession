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
import { readFile } from "node:fs/promises";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
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
let loading: Promise<Record<string, ManualStatus>> | null = null;
let writes: Promise<void> = Promise.resolve();

/** Read the registry once, asynchronously. Boot awaits this before serving,
 * so the synchronous getters below answer from memory. */
export function loadStatusOverrides(): Promise<Record<string, ManualStatus>> {
  if (cache) return Promise.resolve(cache);
  return (loading ??= readFile(REGISTRY_PATH, "utf-8")
    .then((text) => JSON.parse(text) as Record<string, ManualStatus>)
    .catch(() => ({}))
    .then((registry) => (cache ??= registry)));
}

function load(): Record<string, ManualStatus> {
  if (cache) return cache;
  // Not hydrated yet (a test or a script that skipped boot): answer empty and
  // read the file in the background rather than block on it.
  void loadStatusOverrides();
  return {};
}

/** Replace the registry in memory now and on disk in call order. */
async function save(registry: Record<string, ManualStatus>): Promise<void> {
  cache = registry;
  const write = writes.then(() =>
    writeJsonAtomicAsync(REGISTRY_PATH, registry),
  );
  writes = write.catch(() => {});
  await write;
}

export function getStatusOverride(id: string): ManualStatus | undefined {
  return load()[id];
}

/** Set (a valid lane) or clear (null/invalid) the manual lane for a session id. */
export async function setStatusOverride(
  id: string,
  status: ManualStatus | null,
): Promise<void> {
  await loadStatusOverrides();
  const registry = { ...cache! };
  if (status && isManualStatus(status)) registry[id] = status;
  else delete registry[id];
  await save(registry);
}
