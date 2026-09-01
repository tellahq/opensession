/**
 * Archive state for sessions of ALL sources. Slack/Linear session files are
 * owned by their agents (read-only for opensession), so archived-ness lives in
 * a backstage-owned registry keyed by unified session id.
 */
import { readFileSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { unpinEverywhere } from "./pins";
import type { UnifiedSession } from "./types";
import { setIndexedSessionArchived } from "./session-list-store";
import { releasePreviewPathLease } from "./preview-path-leases";

const REGISTRY_PATH = `${OPENSESSION_SESSIONS_DIR}/archive-registry.json`;

/** Why a session ended up archived — drives the "Auto-archived" filter. */
export type ArchiveReason = "manual" | "idle" | "auto";

interface Entry {
  at: string;
  reason: ArchiveReason;
}

// Registry entries were originally a bare ISO timestamp (implicitly manual).
// Old entries are upgraded to the object shape lazily on next write; reads
// treat a bare string as `{ reason: "manual" }` so existing data keeps working.
type RawEntry = string | Entry;

let cache: Record<string, RawEntry> | null = null;

function load(): Record<string, RawEntry> {
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

function save(registry: Record<string, RawEntry>): void {
  cache = registry;
  writeJsonAtomic(REGISTRY_PATH, registry);
}

function releasePreviewLease(sessionId: string): void {
  try {
    releasePreviewPathLease(sessionId);
  } catch (error) {
    console.error(
      `Failed to release preview reservation for ${sessionId}:`,
      error,
    );
  }
}

function toEntry(raw: RawEntry): Entry {
  return typeof raw === "string" ? { at: raw, reason: "manual" } : raw;
}

export function isArchivedId(id: string): boolean {
  return id in load();
}

/**
 * Drop every pin made stale by archiving `justArchived`: the sessions' own ids
 * and alias ids, plus each `workspace:<id>` pin whose workspace now has no live
 * session left. Pass the full current session list so the "last live session" test
 * can see siblings — call this AFTER the archive registry is written so the
 * just-archived sessions read back as archived. Centralizes what the manual,
 * idle-sweep, and Plain-ticket archive paths all need; `setArchived` still handles the
 * lone plain-id case for callers that don't have the full list.
 */
export function unpinArchivedSessions(
  justArchived: UnifiedSession[],
  allSessions: UnifiedSession[],
): void {
  if (!justArchived.length) return;
  const dead = (s: UnifiedSession) => s.archived || isArchivedId(s.id);
  const keys: string[] = [];
  const workspaceIds = new Set<string>();
  for (const s of justArchived) {
    keys.push(s.id, ...(s.aliasIds || []));
    if (s.workspaceId) workspaceIds.add(s.workspaceId);
  }
  // A workspace pin is stale only once none of its sessions are live anymore —
  // else archiving one session would yank a still-active workspace off Pinned.
  for (const pid of workspaceIds) {
    if (!allSessions.some((s) => s.workspaceId === pid && !dead(s)))
      keys.push(`workspace:${pid}`);
  }
  unpinEverywhere(keys);
}

export function getArchiveReason(id: string): ArchiveReason | null {
  const raw = load()[id];
  return raw ? toEntry(raw).reason : null;
}

export function setArchived(
  id: string,
  archived: boolean,
  reason: ArchiveReason = "manual",
): void {
  const registry = { ...load() };
  if (archived) registry[id] = { at: new Date().toISOString(), reason };
  else delete registry[id];
  save(registry);
  setIndexedSessionArchived(id, archived, archived ? reason : undefined);
  // Archived work shouldn't stay pinned (for anyone) — it would resurface in
  // the Pinned band on unarchive. Callers that know more keys (alias ids, the
  // workspace pin) drop those on top of this.
  if (archived) {
    releasePreviewLease(id);
    unpinEverywhere([id]);
  }
}

/** Archive everything idle for more than `days` days. Returns count. */
export function archiveOlderThan(
  sessions: UnifiedSession[],
  days: number,
): number {
  const cutoff = Date.now() - days * 86_400_000;
  const registry = { ...load() };
  let archived = 0;
  const now = new Date().toISOString();

  const justArchived: UnifiedSession[] = [];
  for (const s of sessions) {
    if (s.archived || s.isRunning) continue;
    if (registry[s.id]) continue;
    if (new Date(s.lastActivity).getTime() >= cutoff) continue;
    registry[s.id] = { at: now, reason: "idle" };
    justArchived.push(s);
    archived++;
  }

  if (archived > 0) {
    save(registry);
    for (const session of justArchived) {
      releasePreviewLease(session.id);
      setIndexedSessionArchived(session.id, true, "idle");
    }
    // Registry is written, so isArchivedId now reflects this batch — drop the
    // stale session/alias pins and any workspace pin whose last session just went.
    unpinArchivedSessions(justArchived, sessions);
  }
  return archived;
}
