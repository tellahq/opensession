import { findSessionAsync } from "../session-cache";
import type { RouteContext } from "./context";

/** Explicit inventory for the shared HTTP surface. Personal admission remains
 * disabled, so these legacy operations have shared authority only, regardless
 * of a caller's admin role, display name or claimed principal. */
export const SESSION_ACCESS_QUERY_ROUTES = [
  "/api/files",
  "/api/skills",
  "/api/mention-suggestions",
] as const;
export const SESSION_ACCESS_BODY_ROUTES = [
  "/api/automations/retrigger",
] as const;

export async function sessionAccessTarget(
  ctx: RouteContext,
): Promise<string | undefined> {
  // Detail plus every descendant: transcript/entry/images/subagents/overview,
  // assets/notes/context, diff/files/git/branch, PR review, preview, prompt,
  // archive/title/status and DELETE. Collection operations are not ids.
  if (
    (ctx.path === "/api/sessions/search" && ctx.req.method === "GET") ||
    (ctx.path === "/api/sessions/archive-old" && ctx.req.method === "POST")
  )
    return undefined;
  const match = /^\/api\/sessions\/([^/]+)(?:\/|$)/.exec(ctx.path);
  if (match) {
    try {
      return decodeURIComponent(match[1]!);
    } catch {
      return "";
    }
  }
  if (SESSION_ACCESS_QUERY_ROUTES.some((path) => path === ctx.path))
    return ctx.url.searchParams.get("session") ?? undefined;
  if (
    SESSION_ACCESS_BODY_ROUTES.some((path) => path === ctx.path) &&
    ctx.req.method === "POST"
  ) {
    const body = await ctx.req
      .clone()
      .json()
      .catch(() => null);
    return typeof body?.sessionId === "string" ? body.sessionId : "";
  }
  return undefined;
}

export async function handleSessionAccessRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const sessionId = await sessionAccessTarget(ctx);
  if (sessionId === undefined) return undefined;
  if (sessionId && (await findSessionAsync(sessionId))) return undefined;
  return Response.json(
    { error: "Session not found" },
    {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
