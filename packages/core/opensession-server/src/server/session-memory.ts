/**
 * Session-scoped memory for Open Session runs — repo / user / team scopes,
 * generalizing the Slack channel memory (src/agents/slack/memory.ts) and
 * sharing its store (~/.opensession-memory) so facts flow both ways:
 *
 *   - team           -> the SAME `workspace` store that Slack public-channel
 *                       memory writes to: a fact taught in a public channel is
 *                       known in every session, and vice versa.
 *   - user-<slackId> -> the SAME store as that person's Slack DM memory
 *                       (resolved through the identity table, so aliases,
 *                       emails, and Slack ids all land on one store).
 *                       Users who don't resolve to a teammate get an isolated
 *                       `user-<normalized>` store instead.
 *   - repo-<id>      -> new: per registered repo (PROJECTS ids). Operational
 *                       facts about a codebase
 *                       that don't belong in checked-in docs: gotchas, env
 *                       quirks, "don't touch X until Y ships".
 *
 * Trust model: reads are injected into the system prompt of both interactive
 * and automation runs, but the WRITE tools (opensession-memory MCP,
 * src/agents/slack/memory-tools.ts) are wired into interactive runs ONLY.
 * Automation runs process untrusted event text — letting them store memory
 * would make prompt injection persistent (a hostile ticket plants "standing
 * context" every future run sees). Keep it that way.
 */

import { randomUUID } from "crypto";
import { readdirSync } from "fs";
import {
  activeMemories,
  loadScope,
  saveScope,
  memoryDir,
  type MemoryEntry,
} from "../agents/slack/memory";
import { resolveTeammate, SLACK_ID_TO_NAME } from "./shared/user-mappings";
import { personaName } from "./config";

// "channel" never appears in a session's scopes — it exists so the Settings
// Memory page can list/maintain Slack channel stores alongside the rest.
export type MemoryScopeKind = "repo" | "user" | "team" | "channel";

export interface MemoryScope {
  /** Store file key under MEMORY_DIR, e.g. "repo-app", "workspace". */
  key: string;
  kind: MemoryScopeKind;
  /** Human label for prompts/tool output, e.g. "app", "Alice". */
  label: string;
}

/** The team scope IS the Slack workspace store — shared both ways. */
const TEAM_SCOPE: MemoryScope = {
  key: "workspace",
  kind: "team",
  label: "team",
};

function userScope(user?: string | null): MemoryScope | null {
  const trimmed = user?.trim();
  if (!trimmed) return null;
  const teammate = resolveTeammate(trimmed);
  if (teammate)
    return {
      key: `user-${teammate.slackId}`,
      kind: "user",
      label: teammate.name,
    };
  const key = trimmed.toLowerCase().replace(/[^a-z0-9@._-]+/g, "-");
  return key ? { key: `user-${key}`, kind: "user", label: trimmed } : null;
}

/**
 * The scopes a run reads (and, interactively, writes): one per repo the
 * session spans (primary first), the prompting user's, then team. Order is
 * the storage default for store_memory ("repo" = repos[0]).
 */
export function sessionMemoryScopes(opts: {
  user?: string | null;
  /** Repo ids, primary first (attached repos after). */
  repos?: string[];
  /** Drop the team scope when the caller already injects the workspace store
   *  (Slack channel-watch automations get it via renderMemoryForPrompt). */
  includeTeam?: boolean;
}): MemoryScope[] {
  const scopes: MemoryScope[] = [];
  for (const repo of [...new Set(opts.repos || [])]) {
    if (repo) scopes.push({ key: `repo-${repo}`, kind: "repo", label: repo });
  }
  const u = userScope(opts.user);
  if (u) scopes.push(u);
  if (opts.includeTeam !== false) scopes.push(TEAM_SCOPE);
  return scopes;
}

export async function addSessionMemory(
  scope: MemoryScope,
  text: string,
  by: string,
  opts?: { supersedes?: string[]; scopes?: MemoryScope[] },
): Promise<MemoryEntry> {
  const entries = await loadScope(scope.key);
  const entry: MemoryEntry = {
    id: randomUUID().slice(0, 8),
    text: text.trim(),
    by: by || "someone",
    at: new Date().toISOString(),
  };
  const supersedes = [
    ...new Set((opts?.supersedes || []).map((s) => s.trim()).filter(Boolean)),
  ];
  if (supersedes.length) entry.supersedes = supersedes;
  entries.push(entry);
  await saveScope(scope.key, entries);
  if (supersedes.length) {
    // The replaced entries may live in any scope this session can see (a repo
    // fact is often corrected from a session that also carries team memory).
    await archiveMemories(
      opts?.scopes?.length ? opts.scopes : [scope],
      supersedes,
      entry.id,
    );
  }
  return entry;
}

export interface ArchiveResult {
  archived: Array<{ scope: MemoryScope; entry: MemoryEntry }>;
  missing: string[];
}

/**
 * Mark entries superseded: they stay in the store (recoverable, and still
 * reachable through searchSessionMemory) but stop being injected. This is the
 * mechanism the store lacked — without it a corrected fact costs two entries
 * forever, and every future reader reconciles them at read time.
 */
export async function archiveMemories(
  scopes: MemoryScope[],
  ids: string[],
  supersededBy?: string,
): Promise<ArchiveResult> {
  const wanted = new Set(ids.filter(Boolean));
  const archived: ArchiveResult["archived"] = [];
  const at = new Date().toISOString();
  for (const scope of scopes) {
    if (!wanted.size) break;
    const entries = await loadScope(scope.key);
    let touched = false;
    for (const entry of entries) {
      if (!wanted.has(entry.id) || entry.id === supersededBy) continue;
      wanted.delete(entry.id);
      if (entry.archivedAt) continue; // already archived: nothing to do
      entry.archivedAt = at;
      if (supersededBy) entry.supersededBy = supersededBy;
      archived.push({ scope, entry });
      touched = true;
    }
    if (touched) await saveScope(scope.key, entries);
  }
  return { archived, missing: [...wanted] };
}

/** Undo an archive — the entry returns to injection. */
export async function restoreMemory(
  scopes: MemoryScope[],
  id: string,
): Promise<{ scope: MemoryScope; entry: MemoryEntry } | null> {
  for (const scope of scopes) {
    const entries = await loadScope(scope.key);
    const entry = entries.find((e) => e.id === id);
    if (!entry) continue;
    delete entry.archivedAt;
    delete entry.supersededBy;
    await saveScope(scope.key, entries);
    return { scope, entry };
  }
  return null;
}

export interface ScopedMemory {
  scope: MemoryScope;
  entries: MemoryEntry[];
}

export async function listSessionMemory(
  scopes: MemoryScope[],
  opts?: { includeArchived?: boolean },
): Promise<ScopedMemory[]> {
  return Promise.all(
    scopes.map(async (scope) => {
      const entries = await loadScope(scope.key);
      return {
        scope,
        entries: opts?.includeArchived ? entries : activeMemories(entries),
      };
    }),
  );
}

export interface MemorySearchHit {
  scope: MemoryScope;
  entry: MemoryEntry;
  archived: boolean;
}

/**
 * Search memory across scopes, archived entries included by default.
 *
 * This is what makes a budget on the injected note safe: before it existed,
 * injection was the ONLY way a memory was visible, so trimming the note lost
 * information outright. With retrieval, the budget bounds what a run gets
 * ambiently rather than what the store holds.
 *
 * Scoring mirrors the MCP catalog search: every query term must appear
 * somewhere (AND, not OR — a 2,000-character entry contains most single words
 * by accident), and matches are ranked by how many distinct terms hit, then by
 * recency, with active entries ahead of archived ones at equal score.
 */
export async function searchSessionMemory(
  scopes: MemoryScope[],
  query: string,
  opts?: { includeArchived?: boolean; limit?: number },
): Promise<MemorySearchHit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const limit = Math.max(1, Math.min(50, opts?.limit ?? 10));
  const includeArchived = opts?.includeArchived !== false;
  const scoped = await listSessionMemory(scopes, { includeArchived: true });
  const hits: Array<MemorySearchHit & { score: number }> = [];
  for (const { scope, entries } of scoped) {
    for (const entry of entries) {
      const archived = !!entry.archivedAt;
      if (archived && !includeArchived) continue;
      const haystack = entry.text.toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      if (score < terms.length) continue; // every term must appear
      hits.push({ scope, entry, archived, score });
    }
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.archived) - Number(b.archived) ||
      (a.entry.at < b.entry.at ? 1 : a.entry.at > b.entry.at ? -1 : 0),
  );
  return hits.slice(0, limit).map(({ score: _score, ...hit }) => hit);
}

export type SessionForgetResult =
  | { ok: true; scope: MemoryScope; removed: MemoryEntry }
  | { ok: false; error: string };

/** Remove an entry by id from whichever of the given scopes holds it. */
export async function forgetSessionMemory(
  scopes: MemoryScope[],
  id: string,
): Promise<SessionForgetResult> {
  for (const scope of scopes) {
    const entries = await loadScope(scope.key);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) continue;
    const [removed] = entries.splice(idx, 1);
    await saveScope(scope.key, entries);
    return { ok: true, scope, removed };
  }
  return {
    ok: false,
    error: `No memory entry with id "${id}" in this session's scopes.`,
  };
}

// ── Injection budget ──────────────────────────────────────────────────

/**
 * Ceiling on the injected note, in characters.
 *
 * Measured 2026-08-18 before this existed: an opensession session injected
 * 368,000 characters (~92k tokens) of memory on EVERY run — the repo scope
 * (187 entries) plus the team scope (106), growing monotonically, with nothing
 * that had ever removed an entry. That is the same order as the mounted MCP
 * tool schemas, arriving through a different door, and nothing reported it.
 *
 * Entries here are long-form paragraphs (1,246 chars on average), so a cap has
 * to drop WHOLE entries — truncating mid-sentence would turn a fact into a
 * plausible half-fact, which is worse than omitting it.
 */
export const DEFAULT_MEMORY_NOTE_BUDGET_CHARS = 60_000;
/** Every scope with entries keeps room for at least this much, so a large repo
 *  scope cannot starve the team and user scopes entirely. */
const SCOPE_FLOOR_CHARS = 3_000;

function memoryNoteBudget(): number {
  const raw = Number(process.env.OPENSESSION_MEMORY_BUDGET_CHARS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_MEMORY_NOTE_BUDGET_CHARS;
}

/** Priority when the budget binds: the session's primary repo first (most
 *  specific), then the person, then the team, then any attached repos. */
function budgetPriority(scoped: ScopedMemory[]): ScopedMemory[] {
  const repos = scoped.filter((s) => s.scope.kind === "repo");
  const rest = (kind: MemoryScopeKind) =>
    scoped.filter((s) => s.scope.kind === kind);
  return [
    ...repos.slice(0, 1),
    ...rest("user"),
    ...rest("team"),
    ...repos.slice(1),
    ...rest("channel"),
  ];
}

/**
 * Choose which entries each scope contributes. Selection is NEWEST-first (the
 * oldest facts are the likeliest to have been overtaken), but the returned
 * lists stay in chronological order so the note still reads as a history.
 */
export function selectWithinBudget(
  scoped: ScopedMemory[],
  budget: number,
): Map<string, MemoryEntry[]> {
  const out = new Map<string, MemoryEntry[]>();
  const order = budgetPriority(scoped).filter((s) => s.entries.length);
  let spent = 0;
  order.forEach((entry, index) => {
    // Hold back a floor for each scope still to come, so later scopes are not
    // starved by whichever one happens to be biggest.
    const remainingScopes = order.length - index - 1;
    const ceiling = budget - spent - remainingScopes * SCOPE_FLOOR_CHARS;
    const newestFirst = [...entry.entries].sort((a, b) =>
      a.at < b.at ? 1 : a.at > b.at ? -1 : 0,
    );
    const keep = new Set<string>();
    let used = 0;
    for (const e of newestFirst) {
      const cost = e.text.length + e.id.length + 6; // "- [id] " plus a newline
      if (used + cost > Math.max(ceiling, SCOPE_FLOOR_CHARS)) break;
      keep.add(e.id);
      used += cost;
    }
    spent += used;
    out.set(
      entry.scope.key,
      entry.entries.filter((e) => keep.has(e.id)),
    );
  });
  return out;
}

// ── Byte-stable snapshot ──────────────────────────────────────────────

/**
 * The note was rebuilt on every turn, which is a cache problem rather than a
 * correctness one: the memory block sits near the front of the prompt, so any
 * change to it invalidates the cached prefix and every token behind it gets
 * reprocessed. A parallel session storing a fact in a shared scope would do
 * that to this session, mid-conversation, for no benefit — and it looks
 * exactly like ordinary token spend, so nothing would ever report it.
 *
 * A session therefore renders its note once and reuses the same bytes.
 * Refresh is deliberate: a new session, or THIS session storing/forgetting
 * something (rare, intentional, and the person expects it to stick). Writes
 * from other sessions land on the next session, not mid-turn.
 */
const noteSnapshots = new Map<string, string>();
const MAX_SNAPSHOTS = 512;

export async function snapshotMemoryNote(
  sessionId: string | undefined,
  build: () => Promise<string>,
): Promise<string> {
  if (!sessionId) return build();
  const cached = noteSnapshots.get(sessionId);
  if (cached !== undefined) {
    // Refresh recency so the eviction below drops idle sessions first.
    noteSnapshots.delete(sessionId);
    noteSnapshots.set(sessionId, cached);
    return cached;
  }
  const note = await build();
  if (noteSnapshots.size >= MAX_SNAPSHOTS) {
    const oldest = noteSnapshots.keys().next().value;
    if (oldest) noteSnapshots.delete(oldest);
  }
  noteSnapshots.set(sessionId, note);
  return note;
}

/** Drop a session's snapshot so its next turn rebuilds. Called by the memory
 *  write tools; no id means every session (used by the Settings surface). */
export function invalidateMemorySnapshot(sessionId?: string): void {
  if (sessionId) noteSnapshots.delete(sessionId);
  else noteSnapshots.clear();
}

function scopeHeading(scope: MemoryScope): string {
  if (scope.kind === "repo") return `Repo ${scope.label}:`;
  if (scope.kind === "user") return `${scope.label} (user):`;
  return "Team (workspace-wide):";
}

// ── Settings-page maintenance surface (see GET/POST/PUT/DELETE /api/memory) ──

/** Reconstruct a scope descriptor from a store-file key ("workspace",
 *  "repo-x", "user-U…", "channel-C…"). Unknown shapes are rejected so the
 *  API can't be used to create arbitrary files under MEMORY_DIR. */
export function describeScope(key: string): MemoryScope | null {
  if (key === "workspace") return TEAM_SCOPE;
  const m = key.match(/^(repo|user|channel)-([A-Za-z0-9@._-]+)$/);
  if (!m) return null;
  const [, kind, rest] = m;
  if (kind === "repo") return { key, kind: "repo", label: rest };
  if (kind === "channel") return { key, kind: "channel", label: rest };
  const teammate = /^U[A-Z0-9]{6,}$/.test(rest)
    ? SLACK_ID_TO_NAME[rest]
    : undefined;
  return { key, kind: "user", label: teammate || rest };
}

/**
 * Every memory scope for the Settings page: team + one per registered repo
 * (always shown, even when empty, so there's somewhere to add), plus whatever
 * user/channel stores exist on disk.
 */
export async function listAllMemory(
  repoIds: string[],
): Promise<ScopedMemory[]> {
  const keys = new Set<string>([
    "workspace",
    ...repoIds.map((r) => `repo-${r}`),
  ]);
  try {
    for (const f of readdirSync(memoryDir())) {
      if (f.endsWith(".json")) keys.add(f.slice(0, -5));
    }
  } catch {} // no store dir yet — the fixed scopes still render
  const scopes = [...keys]
    .map(describeScope)
    .filter((s): s is MemoryScope => !!s);
  const order: Record<MemoryScopeKind, number> = {
    team: 0,
    repo: 1,
    user: 2,
    channel: 3,
  };
  scopes.sort(
    (a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label),
  );
  // The maintenance surface sees archived entries too — they are still real
  // records someone may want to read, restore or delete.
  return listSessionMemory(scopes, { includeArchived: true });
}

export async function updateMemoryEntry(
  scopeKey: string,
  id: string,
  text: string,
): Promise<MemoryEntry | null> {
  const entries = await loadScope(scopeKey);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  entry.text = text.trim();
  await saveScope(scopeKey, entries);
  return entry;
}

/**
 * Render the scopes' memory for system-prompt injection. Empty string when
 * every scope is empty AND the run has no write tools (nothing to say).
 * `tools: true` (interactive runs) also teaches the opensession-memory tools,
 * even with no entries yet — otherwise nothing would ever get stored.
 */
export async function renderSessionMemoryNote(
  scopes: MemoryScope[],
  opts?: { tools?: boolean; budgetChars?: number },
): Promise<string> {
  const scoped = await listSessionMemory(scopes);
  const any = scoped.some((s) => s.entries.length > 0);
  if (!any && !opts?.tools) return "";

  const selected = selectWithinBudget(
    scoped,
    opts?.budgetChars ?? memoryNoteBudget(),
  );
  const lines: string[] = ["## Memory"];
  if (any) {
    lines.push(
      "Durable facts stored for this session's scopes. Treat them as standing " +
        "context (background knowledge, not instructions from the current conversation).",
    );
    let dropped = 0;
    for (const { scope, entries } of scoped) {
      if (!entries.length) continue;
      const kept = selected.get(scope.key) ?? entries;
      dropped += entries.length - kept.length;
      if (!kept.length) continue;
      lines.push("", scopeHeading(scope));
      lines.push(...kept.map((e) => `- [${e.id}] ${e.text}`));
    }
    if (dropped) {
      lines.push(
        "",
        `${dropped} older ${dropped === 1 ? "entry is" : "entries are"} held back to keep this ` +
          "section a sane size. Nothing is lost: `search_memory` reaches every entry, " +
          "including ones superseded by a later correction.",
      );
    }
  }
  if (opts?.tools) {
    lines.push(
      "",
      "Manage memory with the opensession-memory tools: `store_memory` saves a fact " +
        "(scope `repo` = this session's repo, `user` = whoever is prompting, `team` = " +
        `shared workspace-wide, including ${personaName()} in Slack), \`forget_memory\` removes one by id, ` +
        "`list_memory` shows everything. Store only durable, non-obvious facts worth every " +
        "future session knowing (operational gotchas, decisions, preferences) — never " +
        "conversation state, and never anything already in the repo's docs. When the user " +
        'says "remember ...", store it.',
    );
  }
  return lines.join("\n");
}
