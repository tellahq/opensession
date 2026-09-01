/**
 * Session grouping for history search. A workspace is the unit of one piece of
 * work (CONCEPTS.md: "this branch, and every conversation I had while building
 * it"): the session that made the change, the follow-up that fixed review
 * comments, the read-only review spawned to look at the diff. The distiller
 * writes one record per SESSION, so without grouping one piece of work comes
 * back as several unrelated-looking results.
 *
 * Group key, in order:
 *   1. the session's workspace (or its family root's, for a child that never
 *      got one), time-bucketed. See FOLD_WINDOW_MS.
 *   2. the parent/spawn chain, for sessions with no workspace at all
 *      (pre-workspace history, and standalone spawns).
 *
 * The chain stays as the fallback rather than the primary key because
 * `workspaceId` is optional and a spawned session can mint its own: keying on
 * it alone would silently stop folding the exact review case this exists for.
 *
 * Pure and dependency-free on purpose: session-index.ts owns the index and the
 * session cache, this stays importable from tests without either.
 */

/** How far up a parent chain to walk before giving up (cycles are guarded
 *  separately; this bounds a pathological depth). */
const DEPTH_CAP = 8;

/**
 * Two sessions in one workspace only fold together when they are this close in
 * time. A feed workspace (a Plain ticket) is reused forever, so without a
 * window a question asked today would fold into one asked six months ago and
 * the older record would answer for both. Bucket boundaries split a family
 * occasionally, which costs one extra row and no information.
 */
const FOLD_WINDOW_MS = 45 * 86_400_000;

export interface FamilyMember {
  id: string;
  parentSessionId?: string;
  /** Attribution link for internal helper sessions. */
  spawnedBy?: string;
  /** The workspace grouping this session's piece of work. */
  workspaceId?: string | null;
}

/** The lookups foldFamilies needs, built once per search from the session list. */
export interface FoldContext {
  parents: Map<string, string>;
  workspaces: Map<string, string>;
  /** workspaceId → how many sessions live in it. */
  sizes: Map<string, number>;
}

export function foldContext(sessions: FamilyMember[]): FoldContext {
  const workspaces = workspaceLinks(sessions);
  const sizes = new Map<string, number>();
  for (const ws of workspaces.values()) sizes.set(ws, (sizes.get(ws) ?? 0) + 1);
  return { parents: parentLinks(sessions), workspaces, sizes };
}

/** sessionId → parent sessionId, skipping self-links. */
export function parentLinks(sessions: FamilyMember[]): Map<string, string> {
  const parents = new Map<string, string>();
  for (const s of sessions) {
    const p = s.parentSessionId || s.spawnedBy;
    if (p && p !== s.id) parents.set(s.id, p);
  }
  return parents;
}

/** sessionId → workspaceId, for sessions that belong to one. */
export function workspaceLinks(sessions: FamilyMember[]): Map<string, string> {
  const ws = new Map<string, string>();
  for (const s of sessions) if (s.workspaceId) ws.set(s.id, s.workspaceId);
  return ws;
}

/** The oldest ancestor of `id`: the session that started this piece of work. */
export function familyRoot(id: string, parents: Map<string, string>): string {
  let cur = id;
  const seen = new Set([cur]);
  for (let i = 0; i < DEPTH_CAP; i++) {
    const next = parents.get(cur);
    // An unindexed or deleted parent still roots the family: the id is the
    // link, whether or not that session is in the list we were handed.
    if (!next || seen.has(next)) break;
    cur = next;
    seen.add(next);
  }
  return cur;
}

export interface Foldable {
  /** Record id, `session:<id>` or a bare session id. */
  id: string;
  /** Record timestamp (ms), which buckets a long-lived workspace. */
  ts?: number;
}

export type Folded<T extends Foldable> = T & {
  /** Workspace this hit's piece of work belongs to, when it has one. */
  workspaceId?: string;
  /** The session this one was spawned from, when it was. */
  parentId?: string;
  /** Sibling records of the same piece of work, folded in behind this one. */
  folded?: T[];
};

/**
 * The workspace whose piece of work `id` belongs to. Usually its own, with one
 * exception: a spawned session sitting ALONE in a workspace is an artifact of
 * the spawn rather than a piece of work (a fifth of children still land that
 * way), so it inherits its family root's. A spawned session whose workspace
 * has other sessions in it has become work of its own and keeps it.
 */
function workspaceOf(id: string, ctx: FoldContext): string | undefined {
  const own = ctx.workspaces.get(id);
  const spawned = ctx.parents.has(id);
  if (own && (!spawned || (ctx.sizes.get(own) ?? 1) > 1)) return own;
  return ctx.workspaces.get(familyRoot(id, ctx.parents)) ?? own;
}

function groupKey(
  id: string,
  ts: number | undefined,
  ctx: FoldContext,
): string {
  const ws = workspaceOf(id, ctx);
  if (ws) return `ws:${ws}:${Math.floor((ts ?? 0) / FOLD_WINDOW_MS)}`;
  return `fam:${familyRoot(id, ctx.parents)}`;
}

/**
 * Collapse a best-first ranked list so each piece of work appears once. The
 * first (best-scoring) member leads and keeps its own text and score; the rest
 * ride along in `folded` so a caller can still name them. An LLM reading only
 * the leader's record would otherwise never learn that the sibling it needed
 * exists.
 */
export function foldFamilies<T extends Foldable>(
  hits: T[],
  ctx: FoldContext,
  limit: number,
): Folded<T>[] {
  const byGroup = new Map<string, Folded<T>>();
  const order: string[] = [];
  for (const hit of hits) {
    const id = bareSessionId(hit.id);
    const key = groupKey(id, hit.ts, ctx);
    const leader = byGroup.get(key);
    if (leader) {
      (leader.folded ??= []).push(hit);
      continue;
    }
    const parent = ctx.parents.get(id);
    byGroup.set(key, {
      ...hit,
      ...(workspaceOf(id, ctx) ? { workspaceId: workspaceOf(id, ctx) } : {}),
      ...(parent ? { parentId: parent } : {}),
    });
    order.push(key);
  }
  return order.slice(0, limit).map((key) => byGroup.get(key)!);
}

export function bareSessionId(id: string): string {
  return id.replace(/^session:/, "");
}
