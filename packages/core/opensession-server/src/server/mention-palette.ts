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

function includesQuery(
  query: string,
  ...values: Array<string | null | undefined>
): boolean {
  if (!query) return true;
  return values.some((value) => value?.toLowerCase().includes(query));
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
  const q = query.trim().toLowerCase();
  const tools = [...new Set(toolNames)]
    .filter((name) => includesQuery(q, name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      display: name,
      insert: name,
      kind: "tool" as const,
    }));
  const workspaceRows = workspaces
    .filter((workspace) =>
      includesQuery(
        q,
        workspace.name,
        workspace.repo,
        workspace.branch,
        workspace.id,
      ),
    )
    .slice(0, 6)
    .map((workspace) => ({
      display: workspace.name,
      insert: `workspace:${workspace.id}`,
      kind: "workspace" as const,
      sub: workspace.branch || workspace.repo || undefined,
    }));
  const matchingSessions = sessions
    .filter((session) => !session.archived && session.id !== currentSessionId)
    .filter((session) =>
      includesQuery(
        q,
        session.title,
        session.branch,
        session.repo,
        session.source,
        session.id,
      ),
    );
  // Keep only the six newest matches while walking the catalog. Sorting the
  // entire session history on every character made a small picker scale with
  // years of archived work.
  const recent: MentionPaletteSession[] = [];
  for (const session of matchingSessions) {
    const at = session.lastActivity || "";
    const index = recent.findIndex(
      (candidate) => at > (candidate.lastActivity || ""),
    );
    if (index < 0) recent.push(session);
    else recent.splice(index, 0, session);
    if (recent.length > 6) recent.pop();
  }
  const sessionRows = recent.map((session) => ({
    display: session.title || session.branch || session.id,
    insert: `session:${session.id}`,
    kind: "session" as const,
    sub: session.branch || session.repo || session.source || undefined,
  }));
  return [...tools, ...workspaceRows, ...sessionRows];
}
