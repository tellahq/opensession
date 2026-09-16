import { resolveApplicationSession } from "../application-access";
import { withSessionScopeFence } from "../session-scope-coverage";
import { readMcpConfig } from "../connections";
import { mentionPaletteItems } from "../mention-palette";
import {
  findSessionAsync,
  getSessionListSnapshotAsync,
} from "../session-cache";
import { userMatchesAny } from "../shared/user-mappings";
import { listWorkspaces } from "../workspaces";
import {
  requestApplicationAccess,
  requestUser,
  type RouteContext,
} from "./context";

const mentionDependencies = {
  fence: withSessionScopeFence,
  findSessionAsync,
  readMcpConfig,
  sessions: getSessionListSnapshotAsync,
  workspaces: listWorkspaces,
};

export async function handleMentionPaletteRoutes(
  ctx: RouteContext,
  deps = mentionDependencies,
): Promise<Response | undefined> {
  if (ctx.path !== "/api/mention-suggestions" || ctx.req.method !== "GET")
    return undefined;

  return deps.fence(async () => {
    const query = ctx.url.searchParams.get("q") || "";
    const requestedId = ctx.url.searchParams.get("session");
    const access = requestApplicationAccess(ctx);
    const handle =
      requestedId === null
        ? undefined
        : await resolveApplicationSession(
            requestedId,
            access,
            deps.findSessionAsync,
          );
    if (requestedId !== null && !handle)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const sessionId = handle?.id;
    const session = sessionId
      ? await deps.findSessionAsync(sessionId, access.principal)
      : undefined;
    if (sessionId && !session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const personal = handle?.accessScope.kind === "personal";
    const caller = requestUser(ctx, ctx.url.searchParams.get("user"));
    const requestedScope = ctx.url.searchParams.getAll("mcp");
    if (personal && requestedScope.some((value) => value.length > 0))
      return Response.json(
        { error: "MCP scope unavailable for private sessions" },
        { status: 400 },
      );
    const noTools = personal || ctx.url.searchParams.get("tools") === "none";
    // An empty list means the session default: every available tool. A non-empty
    // list on a new-session draft or an existing session narrows the catalog.
    const selectedScope = requestedScope.length
      ? requestedScope
      : session?.mcpServers?.length
        ? session.mcpServers
        : null;
    const scope = selectedScope ? new Set(selectedScope) : null;
    const toolNames = noTools
      ? []
      : Object.entries(deps.readMcpConfig().mcpServers)
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
    const cachedSessions = await deps.sessions();

    return Response.json({
      items: mentionPaletteItems({
        query,
        toolNames,
        workspaces: await deps.workspaces(),
        sessions: cachedSessions,
        currentSessionId: sessionId,
      }),
    });
  });
}
