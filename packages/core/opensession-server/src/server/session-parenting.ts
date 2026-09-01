import type { UnifiedSession } from "./types";

export type ReparentableSession = Pick<
  UnifiedSession,
  "id" | "source" | "parentSessionId" | "spawnedBy"
>;

export type ReparentValidation =
  | {
      ok: true;
      session: ReparentableSession;
      parent?: ReparentableSession;
    }
  | { ok: false; error: string };

/**
 * Validate a parent-link change without mutating session state. Parent links
 * are allowed across session sources, but only native Open Session sessions
 * can be changed because their relationship is stored in the native session
 * file. Both visible parent links and internal spawn attribution are followed
 * when checking for cycles.
 */
export function validateSessionReparent(
  id: string,
  parentSessionId: string | undefined,
  findSession: (id: string) => ReparentableSession | undefined,
): ReparentValidation {
  const session = findSession(id);
  if (!session) return { ok: false, error: `No session with id \`${id}\`.` };
  if (session.source !== "opensession") {
    return {
      ok: false,
      error: `Session \`${id}\` is ${session.source || "external"}; only native Open Session sessions can be reparented.`,
    };
  }
  if (!parentSessionId) return { ok: true, session };
  if (parentSessionId === id) {
    return { ok: false, error: "A session cannot be its own parent." };
  }

  const parent = findSession(parentSessionId);
  if (!parent) {
    return {
      ok: false,
      error: `No parent session with id \`${parentSessionId}\`.`,
    };
  }

  const seen = new Set<string>();
  let cursor: ReparentableSession | undefined = parent;
  while (cursor) {
    if (cursor.id === id) {
      return {
        ok: false,
        error: `Reparenting \`${id}\` to \`${parentSessionId}\` would create a cycle.`,
      };
    }
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    const nextId: string | undefined =
      cursor.parentSessionId || cursor.spawnedBy;
    cursor = nextId ? findSession(nextId) : undefined;
  }

  return { ok: true, session, parent };
}
