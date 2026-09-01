/**
 * @-mention surface: what a person has been tagged in, and clearing it.
 * The store is src/server/mentions.ts; recording happens where the mention is
 * written (a prompt or a team note), not here.
 *
 * `/api/mentions` is its own path family, so ordering against the session
 * routes doesn't matter — the clear is a POST on this family rather than on
 * `/sessions/:id/...`, which the generic session routes would swallow.
 */

import { requestUser, type RouteContext } from "./context";
import { clearAllMentions, clearMention, listMentions } from "../mentions";
import { broadcastToAll } from "../ws-hub";
import { conditionalJsonResponse } from "../http-json";

export async function handleMentionsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  if (path === "/api/mentions" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user"));
    if (!user) return conditionalJsonResponse(req, { mentions: [] });
    return conditionalJsonResponse(req, { mentions: listMentions(user) });
  }

  if (path === "/api/mentions/clear" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    const sessionId =
      typeof body?.sessionId === "string" ? body.sessionId : null;
    if (!sessionId) {
      clearAllMentions(user);
      // Every device the person is signed in on drops the badge together.
      broadcastToAll({ type: "mentions_cleared", user });
      return Response.json({ ok: true });
    }
    const cleared = clearMention(user, sessionId);
    if (cleared) broadcastToAll({ type: "mentions_cleared", user, sessionId });
    return Response.json({ ok: true, cleared });
  }

  return undefined;
}
