import { getSessionControl, type SessionControl } from "./session-control";
import { getWorkspace, listWorkspaces, type Workspace } from "./workspaces";
import { deskShowTargetSchema } from "../shared/desk-navigation";
import type { DeskVoiceNavigation } from "./desk-voice-navigation";

export const SHOW_IN_APP_TOOL = {
  type: "function",
  name: "show_in_app",
  description:
    "Bring a session or a workspace up in the user's own Open Session window, next to the Desk. Use when they ask to see, open, show, or go to something. Give the session's id or its title (a distinctive part is enough), or the workspace's id or name. Only changes the page shown in this voice call's browser.",
  parameters: {
    type: "object",
    properties: {
      session: {
        type: "string",
        description: "Session id, or its title or a distinctive part of it",
      },
      workspace: {
        type: "string",
        description: "Workspace id or name",
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

export type ShowTarget =
  | { kind: "session"; id: string; title: string }
  | { kind: "workspace"; id: string; name: string };

export type ShowResolution =
  | { target: ShowTarget }
  | { error: string; candidates?: Array<{ id: string; title: string }> };

/** How many near-matches the backend gets to disambiguate with. */
const MAX_CANDIDATES = 5;

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Exact names take precedence, but duplicate names always need clarification. */
function pick<T extends { id: string; title: string; recency?: string }>(
  query: string,
  items: T[],
  what: string,
):
  | { item: T }
  | { error: string; candidates?: Array<{ id: string; title: string }> } {
  const q = normalize(query);
  if (!q) return { error: `Name the ${what} to show.` };
  const exact = items.filter((i) => normalize(i.title) === q);
  const partial = exact.length
    ? exact
    : items.filter((i) => normalize(i.title).includes(q));
  if (partial.length === 1) return { item: partial[0]! };
  if (!partial.length) return { error: `No ${what} matches "${query}".` };
  partial.sort((a, b) => (b.recency ?? "").localeCompare(a.recency ?? ""));
  return {
    error: `Several ${what}s match "${query}"; ask which one.`,
    candidates: partial
      .slice(0, MAX_CANDIDATES)
      .map(({ id, title }) => ({ id, title })),
  };
}

export async function resolveShowTarget(
  args: Record<string, unknown>,
  deps: {
    control: Pick<SessionControl, "listSessions" | "getSession">;
    listWorkspaces: () => Promise<Workspace[]>;
    getWorkspace: (id: string) => Promise<Workspace | null>;
  },
): Promise<ShowResolution> {
  const session = typeof args.session === "string" ? args.session.trim() : "";
  const workspace =
    typeof args.workspace === "string" ? args.workspace.trim() : "";

  if (
    Object.keys(args).some((key) => key !== "session" && key !== "workspace") ||
    Boolean(session) === Boolean(workspace) ||
    (args.session !== undefined && typeof args.session !== "string") ||
    (args.workspace !== undefined && typeof args.workspace !== "string") ||
    session.length > 256 ||
    workspace.length > 256
  ) {
    return { error: "Name exactly one session or workspace to show." };
  }

  if (session) {
    // The Desk itself is hidden from every list; a call never lands on it.
    const byId = deps.control.getSession(session);
    if (byId && !byId.desk)
      return {
        target: { kind: "session", id: byId.id, title: byId.title || "" },
      };
    const visible = deps.control
      .listSessions()
      .filter((s) => !s.desk && s.state !== "archived")
      .map((s) => ({
        id: s.id,
        title: s.title || "",
        recency: s.lastActivity ?? s.createdAt,
      }));
    const found = pick(session, visible, "session");
    if ("error" in found) return found;
    return {
      target: { kind: "session", id: found.item.id, title: found.item.title },
    };
  }

  if (workspace) {
    const byId = await deps.getWorkspace(workspace);
    if (byId)
      return { target: { kind: "workspace", id: byId.id, name: byId.name } };
    const all = (await deps.listWorkspaces()).map((w) => ({
      id: w.id,
      title: w.name,
      recency: w.createdAt,
    }));
    const found = pick(workspace, all, "workspace");
    if ("error" in found) return found;
    return {
      target: { kind: "workspace", id: found.item.id, name: found.item.title },
    };
  }

  return { error: "Say which session or workspace to show." };
}

/** Team members can view the shared session/workspace catalog, as in the UI.
 * The call-bound capability is the authorization to navigate one browser. It
 * exists only for verified web callers, never for native or generic MCP calls.
 */
export async function showInApp(
  navigation: DeskVoiceNavigation | undefined,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!navigation)
    return {
      shown: false,
      error: "Navigation requires a signed-in web voice call.",
    };
  const resolved = await resolveShowTarget(args, {
    control: getSessionControl(),
    listWorkspaces,
    getWorkspace,
  });
  if ("error" in resolved) return resolved;
  const { target } = resolved;
  const safe = deskShowTargetSchema.safeParse({
    kind: target.kind,
    id: target.id,
  });
  if (!safe.success)
    return { shown: false, error: "That page cannot be opened by voice." };
  const result = await navigation.show(safe.data);
  return { ...target, ...result };
}
