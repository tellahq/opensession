import { readMcpConfig } from "../connections";
import { mentionPaletteItems } from "../mention-palette";
import {
  findSessionAsync,
  getSessionListSnapshotAsync,
  peekCachedSessions,
} from "../session-cache";
import { userMatchesAny } from "../shared/user-mappings";
import { listWorkspaces } from "../workspaces";
import { requestUser, type RouteContext } from "./context";

export async function handleMentionPaletteRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (ctx.path !== "/api/mention-suggestions" || ctx.req.method !== "GET")
    return undefined;

  const query = ctx.url.searchParams.get("q") || "";
  const sessionId = ctx.url.searchParams.get("session");
  const session = sessionId ? await findSessionAsync(sessionId) : undefined;
  const caller = requestUser(ctx, ctx.url.searchParams.get("user"));
  const requestedScope = ctx.url.searchParams.getAll("mcp");
  // An empty list means the session default: every available tool. A non-empty
  // list on a new-session draft or an existing session narrows the catalog.
  const selectedScope = requestedScope.length
    ? requestedScope
    : session?.mcpServers?.length
      ? session.mcpServers
      : null;
  const scope = selectedScope ? new Set(selectedScope) : null;
  const toolNames = Object.entries(readMcpConfig().mcpServers)
    .filter(([name]) => !scope || scope.has(name))
    .filter(([, config]) => {
      const allowed = (config as { allowedUsers?: unknown }).allowedUsers;
      return (
        !Array.isArray(allowed) ||
        allowed.length === 0 ||
        (!!caller && userMatchesAny(caller, allowed.map(String)))
      );
    })
    .map(([name]) => name);
  const cachedSessions = peekCachedSessions();

  return Response.json({
    items: mentionPaletteItems({
      query,
      toolNames,
      workspaces: listWorkspaces(),
      sessions: cachedSessions.length
        ? cachedSessions
        : await getSessionListSnapshotAsync(),
      currentSessionId: sessionId,
    }),
  });
}
