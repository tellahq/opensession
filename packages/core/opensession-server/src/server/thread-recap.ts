/**
 * "Since you were last here": a catch-up on the threads a session started,
 * written by a helper model from what they did after a moment the reader
 * names. The threads come from the catalog's workspace index (a thread lands
 * in its parent's workspace); only the few that changed have their latest
 * message read (one known session each).
 */

import { oneShot } from "./one-shot";
import { indexedWorkspaceMembers } from "./session-list-store";
import type { UnifiedSession } from "./types";
import { buildWorkspaceOverview } from "./workspace-overview";

/** Threads read for a recap: a catch-up, not an audit. */
const MAX_THREADS = 8;
/** Recaps are cached per space and minute of `since`. */
const CACHE_MS = 5 * 60_000;
const MAX_CACHE = 200;

export interface SpaceRecapResult {
  /** Two to four sentences, or null when nothing changed or the model failed. */
  text: string | null;
  /** The threads it covers, newest first. */
  threadIds: string[];
}

type Deps = {
  members: (workspaceId: string) => Promise<UnifiedSession[]>;
  lastMessage: (session: UnifiedSession) => Promise<string | null>;
  write: (prompt: string, user?: string) => Promise<string | null>;
  now: () => number;
};

const defaultDeps: Deps = {
  members: indexedWorkspaceMembers,
  lastMessage: async (session) =>
    (await buildWorkspaceOverview([session])).lastMessage?.content ?? null,
  write: (prompt, user) =>
    oneShot(prompt, { user, label: "thread-recap", timeoutMs: 45_000 }),
  now: Date.now,
};

const cache = new Map<string, { at: number; result: SpaceRecapResult }>();

/** How a thread stands, in the words the recap uses. */
export function threadStanding(thread: UnifiedSession): string {
  if (thread.prState === "MERGED") return "shipped (PR merged)";
  if (thread.archived) return "archived";
  if (thread.isRunning) return "working";
  if (thread.prState === "OPEN") return "PR open for review";
  return "idle, waiting for someone";
}

/** Sessions descended from `rootId` (children, their children, ...). */
export function descendants(
  sessions: readonly UnifiedSession[],
  rootId: string,
): UnifiedSession[] {
  const inside = new Set([rootId]);
  const out: UnifiedSession[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of sessions)
      if (
        s.parentSessionId &&
        inside.has(s.parentSessionId) &&
        !inside.has(s.id)
      ) {
        inside.add(s.id);
        out.push(s);
        grew = true;
      }
  }
  return out;
}

export async function threadRecap(
  workspaceId: string,
  rootId: string,
  since: number,
  reader: string,
  deps: Deps = defaultDeps,
): Promise<SpaceRecapResult> {
  const key = `${workspaceId}:${rootId}:${Math.floor(since / 60_000)}`;
  const hit = cache.get(key);
  if (hit && deps.now() - hit.at < CACHE_MS) return hit.result;

  const changed = descendants(await deps.members(workspaceId), rootId)
    .filter((s) => Date.parse(s.lastActivity) > since)
    .sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity))
    .slice(0, MAX_THREADS);
  if (changed.length === 0) return { text: null, threadIds: [] };

  const lines = await Promise.all(
    changed.map(async (thread) => {
      const last = await deps.lastMessage(thread).catch(() => null);
      const started = Date.parse(thread.createdAt) > since ? "new; " : "";
      const who = thread.startedBy || thread.createdBy || "someone";
      return `- "${thread.title}" (${started}${threadStanding(thread)}; started by ${who})${
        last ? `\n  Latest: ${last.replace(/\s+/g, " ").slice(0, 400)}` : ""
      }`;
    }),
  );
  const prompt = [
    `${reader || "A teammate"} is back in a conversation that hands work to threads, after being away. Write them a catch-up of what the threads did since, in two to four short sentences of plain prose: what shipped, what is waiting on a person (name who, when it is clear), and what is still working. Lead with what needs them. No greeting, no headings, no lists, no thread ids, no Markdown.`,
    "",
    "Threads that changed:",
    ...lines,
  ].join("\n");
  const text = (await deps.write(prompt, reader))?.trim() || null;
  const result = { text, threadIds: changed.map((t) => t.id) };
  if (text) {
    cache.set(key, { at: deps.now(), result });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  }
  return result;
}
