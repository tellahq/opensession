/**
 * Channel-scoped memory for the Slack agent.
 *
 * Scopes (mirrors Slack's visibility model):
 *   - Public channel  -> the shared `workspace` store (read + write). Anything
 *     remembered in a public channel is visible workspace-wide.
 *   - Private channel -> an isolated `channel-<id>` store (read + write), PLUS
 *     read-only visibility of the workspace store.
 *   - DM              -> an isolated `user-<id>` store (read + write), PLUS
 *     read-only visibility of the workspace store.
 *
 * Memory is both (a) auto-injected into the system prompt each run so the agent
 * "just knows" the channel's facts, and (b) managed conversationally via the
 * remember / list_memory / forget admin tools.
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import {
  writeFileAtomic,
  writeJsonAtomic,
} from "../../server/shared/atomic-write";
import { join } from "path";
import { unlinkSync } from "fs";
import { stateDir } from "../../server/paths";

export const MEMORY_DIR = stateDir("memory");

// Test seam: the snapshot harness (src/server/testing/) redirects the store so
// a recorded fixture can never embed the team's real memories, and so a run's
// injected memory note is fixture data rather than whatever this box happens
// to remember. Resolved per call; MEMORY_DIR itself stays the default.
let memoryDirOverride: string | null = null;

/**
 * Directory backing the scope stores.
 *
 * Resolution order: a test override, isolated state, then the live store.
 */
export function memoryDir(): string {
  if (memoryDirOverride) return memoryDirOverride;
  return process.env.OPENSESSION_STATE_DIR ? stateDir("memory") : MEMORY_DIR;
}

/** JSON roots eligible for a v2 import. */
export function memoryImportDirs(): string[] {
  return [memoryDir()];
}

const MEMORY_V2_DIRTY_MARKER = ".memory-v2-dirty";

export function markMemoryImportDirty(): void {
  writeFileAtomic(
    join(memoryDir(), MEMORY_V2_DIRTY_MARKER),
    new Date().toISOString(),
  );
}

export function memoryImportIsDirty(sourceDirs: string[]): boolean {
  return sourceDirs.some((directory) =>
    existsSync(join(directory, MEMORY_V2_DIRTY_MARKER)),
  );
}

export function clearMemoryImportDirty(sourceDirs: string[]): void {
  for (const directory of sourceDirs) {
    try {
      unlinkSync(join(directory, MEMORY_V2_DIRTY_MARKER));
    } catch {}
  }
}

/** Point the memory store at another directory; returns the previous value. */
export function __setMemoryDirForTest(dir: string | null): string | null {
  const prev = memoryDirOverride;
  memoryDirOverride = dir;
  return prev;
}

export interface MemoryEntry {
  id: string;
  text: string;
  by: string;
  at: string;
  /** Ids this entry replaces. Set when a fact is corrected rather than added:
   *  the model already writes "CORRECTION to memory X" in the prose, so this
   *  is that same relation in a form the store can act on. */
  supersedes?: string[];
  /** Id of the entry that replaced this one. */
  supersededBy?: string;
  /** When this entry stopped being injected. Archived entries stay in the
   *  file — recoverable, and reachable through search — but cost no prompt. */
  archivedAt?: string;
}

/** Superseded entries are history, not standing context. */
export function isArchivedMemory(entry: MemoryEntry): boolean {
  return !!entry.archivedAt;
}

/** The entries that still count as current. */
export function activeMemories(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => !isArchivedMemory(e));
}

export interface MemoryContext {
  channel: string;
  userId: string;
  isDM: boolean;
  /** Private (non-DM) channel. Ignored when isDM is true. */
  isPrivate: boolean;
}

interface ScopeStore {
  entries: MemoryEntry[];
}

/** Where this context reads from / writes to. */
function resolveScopes(ctx: MemoryContext): {
  writable: string;
  sharedReadonly: string | null;
} {
  if (ctx.isDM)
    return { writable: `user-${ctx.userId}`, sharedReadonly: "workspace" };
  if (ctx.isPrivate)
    return { writable: `channel-${ctx.channel}`, sharedReadonly: "workspace" };
  return { writable: "workspace", sharedReadonly: null };
}

function scopeFile(scope: string): string {
  return `${memoryDir()}/${scope}.json`;
}

/** Exported for session-memory.ts (repo/user/team scopes share this store). */
export async function loadScope(scope: string): Promise<MemoryEntry[]> {
  try {
    const file = Bun.file(scopeFile(scope));
    if (await file.exists()) {
      const data = JSON.parse(await file.text()) as ScopeStore;
      return Array.isArray(data.entries) ? data.entries : [];
    }
  } catch (e) {
    console.warn(`[memory] failed to read scope ${scope}:`, e);
  }
  return [];
}

export async function saveScope(
  scope: string,
  entries: MemoryEntry[],
): Promise<void> {
  const runtime = await import("../../server/memory-v2/runtime");
  const mode = runtime.memoryRolloutMode();
  if (mode === "legacy" || mode === "shadow") markMemoryImportDirty();
  writeJsonAtomic(scopeFile(scope), { entries });
  if (mode === "shadow") await runtime.refreshMemoryV2Shadow();
}

/** Save a new fact to the writable store for this context. */
export async function addMemory(
  ctx: MemoryContext,
  text: string,
  by: string,
): Promise<MemoryEntry> {
  const { writable } = resolveScopes(ctx);
  const { memoryRolloutMode } = await import("../../server/memory-v2/runtime");
  if (memoryRolloutMode() === "v2") {
    const { ensureMemoryV2Ready, legacySummary } =
      await import("../../server/memory-v2");
    const { store } = await ensureMemoryV2Ready();
    const summary = legacySummary(text);
    const record = store.create({
      scopeKey: writable,
      summary,
      ...(summary === text.trim() ? {} : { details: text }),
      kind: "reference",
      tier: "retrievable",
      source: { type: "slack", actor: by || undefined, channelId: ctx.channel },
      tags: ["slack"],
    });
    return {
      id: record.id,
      text: record.summary,
      by: by || "someone",
      at: record.createdAt,
    };
  }
  const entries = await loadScope(writable);
  const entry: MemoryEntry = {
    id: randomUUID().slice(0, 8),
    text: text.trim(),
    by: by || "someone",
    at: new Date().toISOString(),
  };
  entries.push(entry);
  await saveScope(writable, entries);
  return entry;
}

export interface MemoryView {
  /** Entries the agent can edit here. */
  local: MemoryEntry[];
  /** Workspace entries visible but read-only in this scope (private/DM only). */
  shared: MemoryEntry[];
  /** True when the local store IS the workspace store (public channels). */
  localIsWorkspace: boolean;
}

export async function listMemory(ctx: MemoryContext): Promise<MemoryView> {
  const { writable, sharedReadonly } = resolveScopes(ctx);
  const { memoryRolloutMode } = await import("../../server/memory-v2/runtime");
  if (memoryRolloutMode() === "v2") {
    const { ensureMemoryV2Ready } = await import("../../server/memory-v2");
    const { store } = await ensureMemoryV2Ready();
    const read = (scopeKey: string): MemoryEntry[] => {
      const out: MemoryEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = store.list(
          { scopeKeys: [scopeKey], states: ["active"] },
          { cursor, limit: 100 },
        );
        out.push(
          ...page.items.map((record) => ({
            id: record.id,
            text: record.summary,
            by: record.source.type,
            at: record.createdAt,
          })),
        );
        cursor = page.nextCursor;
      } while (cursor && out.length < 50);
      return out.slice(0, 50);
    };
    return {
      local: read(writable),
      shared: sharedReadonly ? read(sharedReadonly) : [],
      localIsWorkspace: writable === "workspace",
    };
  }
  // Archived entries are excluded everywhere a human or a prompt reads memory;
  // only the maintenance surfaces ask for them explicitly.
  const local = activeMemories(await loadScope(writable));
  const shared = sharedReadonly
    ? activeMemories(await loadScope(sharedReadonly))
    : [];
  return { local, shared, localIsWorkspace: writable === "workspace" };
}

export type ForgetResult =
  | { ok: true; removed: MemoryEntry }
  | { ok: false; error: string };

/** Remove an entry by id from the writable store for this context. */
export async function forgetMemory(
  ctx: MemoryContext,
  id: string,
): Promise<ForgetResult> {
  const { writable, sharedReadonly } = resolveScopes(ctx);
  const { memoryRolloutMode } = await import("../../server/memory-v2/runtime");
  if (memoryRolloutMode() === "v2") {
    const { ensureMemoryV2Ready } = await import("../../server/memory-v2");
    const { store } = await ensureMemoryV2Ready();
    const record = store.get(id);
    if (!record || record.scopeKey !== writable) {
      if (record && sharedReadonly && record.scopeKey === sharedReadonly) {
        return {
          ok: false,
          error:
            "That entry is workspace memory and is read-only here. Change it from a public channel or Memory settings.",
        };
      }
      return {
        ok: false,
        error: `No memory entry with id "${id}" in this scope.`,
      };
    }
    store.delete(id);
    return {
      ok: true,
      removed: {
        id: record.id,
        text: record.summary,
        by: record.source.type,
        at: record.createdAt,
      },
    };
  }
  const entries = await loadScope(writable);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    // Help the model understand *why* a visible id can't be forgotten here.
    if (sharedReadonly) {
      const shared = await loadScope(sharedReadonly);
      if (shared.some((e) => e.id === id)) {
        return {
          ok: false,
          error:
            "That entry is workspace memory (shared from public channels) and is read-only here. " +
            "It can only be edited or forgotten from a public channel.",
        };
      }
    }
    return {
      ok: false,
      error: `No memory entry with id "${id}" in this scope.`,
    };
  }
  const [removed] = entries.splice(idx, 1);
  await saveScope(writable, entries);
  return { ok: true, removed };
}

/** Render prompt-matched memory as fenced turn context. */
export async function renderMemoryForPrompt(
  ctx: MemoryContext,
  query = "",
): Promise<string> {
  const { memoryRolloutMode } = await import("../../server/memory-v2/runtime");
  const mode = memoryRolloutMode();
  if (mode === "v2") {
    const { writable, sharedReadonly } = resolveScopes(ctx);
    const { retrieveMemoryForPrompt } = await import("../../server/memory-v2");
    return (
      await retrieveMemoryForPrompt(query, {
        scopeKeys: [writable, ...(sharedReadonly ? [sharedReadonly] : [])],
      })
    ).text;
  }
  if (mode === "shadow") {
    const { writable, sharedReadonly } = resolveScopes(ctx);
    const { retrieveMemoryForPrompt } = await import("../../server/memory-v2");
    void retrieveMemoryForPrompt(query, {
      scopeKeys: [writable, ...(sharedReadonly ? [sharedReadonly] : [])],
    }).catch(() => {});
  }
  const { local, shared, localIsWorkspace } = await listMemory(ctx);
  if (local.length === 0 && shared.length === 0) return "";

  const lines: string[] = [
    "\n\n## Channel memory",
    "Facts remembered for this " +
      (ctx.isDM
        ? "DM"
        : localIsWorkspace
          ? "workspace (public channels)"
          : "channel") +
      ". Treat these as standing context. The user can change them via the remember/forget tools.",
  ];
  const fmt = (e: MemoryEntry) => `- [${e.id}] ${e.text}`;
  if (local.length) {
    lines.push(localIsWorkspace ? "\nWorkspace memory:" : "\nThis channel:");
    lines.push(...local.map(fmt));
  }
  if (shared.length) {
    lines.push("\nWorkspace memory (shared, read-only here):");
    lines.push(...shared.map(fmt));
  }
  return lines.join("\n");
}
