import { fuzzyMatch } from "../shared/fuzzy-match";

export interface MentionPaletteSession {
  id: string;
  title?: string | null;
  branch?: string | null;
  repo?: string | null;
  source?: string | null;
  lastActivity?: string | null;
  archived?: boolean;
}

export interface MentionPaletteWorkspace {
  id: string;
  name: string;
  repo?: string | null;
  branch?: string | null;
  createdAt?: string | null;
}

export interface MentionPaletteItem {
  display: string;
  insert: string;
  kind: "tool" | "workspace" | "session";
  sub?: string;
}

interface Options {
  query: string;
  toolNames: string[];
  workspaces: MentionPaletteWorkspace[];
  sessions: MentionPaletteSession[];
  currentSessionId?: string | null;
}

/** Score an item's fields, keeping the item only when something matched. */
function scored<T>(
  query: string,
  items: T[],
  fields: (item: T) => Array<string | null | undefined>,
): Array<{ item: T; score: number }> {
  const out: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = fuzzyMatch(query, fields(item));
    if (score > 0) out.push({ item, score });
  }
  return out;
}

/** Non-file rows for the @ palette. Tools are intentionally uncapped: the
 * connected catalog is small and the request is to make every available tool
 * discoverable. Workspaces and sessions are recent context rather than second
 * search screens, so those sections stay bounded. */
export function mentionPaletteItems({
  query,
  toolNames,
  workspaces,
  sessions,
  currentSessionId,
}: Options): MentionPaletteItem[] {
  const q = query.trim();
  const tools = scored(q, [...new Set(toolNames)], (name) => [name])
    .sort((a, b) => b.score - a.score || a.item.localeCompare(b.item))
    .map(({ item: name }) => ({
      display: name,
      insert: name,
      kind: "tool" as const,
    }));
  // Typos are forgiven, so a close name outranks a loose one. Sort is stable,
  // so equal scores keep the catalog's own order.
  const workspaceRows = scored(q, workspaces, (workspace) => [
    workspace.name,
    workspace.repo,
    workspace.branch,
    workspace.id,
  ])
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ item: workspace }) => ({
      display: workspace.name,
      insert: `workspace:${workspace.id}`,
      kind: "workspace" as const,
      sub: workspace.branch || workspace.repo || undefined,
    }));
  const matchingSessions = scored(
    q,
    sessions.filter(
      (session) => !session.archived && session.id !== currentSessionId,
    ),
    (session) => [
      session.title,
      session.branch,
      session.repo,
      session.source,
      session.id,
    ],
  );
  // Keep only the six best matches, newest first among equals, while walking
  // the catalog. Sorting the entire session history on every character made a
  // small picker scale with years of archived work.
  const recent: Array<{ item: MentionPaletteSession; score: number }> = [];
  for (const entry of matchingSessions) {
    const at = entry.item.lastActivity || "";
    const index = recent.findIndex(
      (candidate) =>
        entry.score > candidate.score ||
        (entry.score === candidate.score &&
          at > (candidate.item.lastActivity || "")),
    );
    if (index < 0) recent.push(entry);
    else recent.splice(index, 0, entry);
    if (recent.length > 6) recent.pop();
  }
  const sessionRows = recent.map(({ item: session }) => ({
    display: session.title || session.branch || session.id,
    insert: `session:${session.id}`,
    kind: "session" as const,
    sub: session.branch || session.repo || session.source || undefined,
  }));
  return [...tools, ...workspaceRows, ...sessionRows];
}
