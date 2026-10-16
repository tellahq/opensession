import { assertPersonalImagesAbsent } from "../personal-image-admission";
import { personalSessionForAction } from "../personal-repository-coordinator";
import { withSessionPublication } from "../session-audience";
import { getSessionControl } from "../session-control";
import {
  withPastedTexts,
  pastedTextsFromWire,
} from "@tellahq/opensession-protocol/pasted-text";
import { withSessionExecutionAccess } from "../application-access";
import { findSessionAsync } from "../session-cache";
import { requestApplicationAccess, type RouteContext } from "./context";
import { withSessionScopeFence } from "../session-scope-coverage";
import { sessionMetadata } from "../session-kernel";

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
  const requestedId = await sessionAccessTarget(ctx);
  if (requestedId === undefined) return undefined;
  const access = requestApplicationAccess(ctx);
  const missing = () =>
    Response.json(
      { error: "Session not found" },
      {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      },
    );
  if (!requestedId) return missing();
  const session = await withSessionScopeFence(() =>
    findSessionAsync(requestedId, access.principal),
  );
  if (!session) return missing();
  ctx.authorizedSession = Object.freeze({
    id: session.id,
    accessScope: Object.freeze(
      session.accessScope ?? { kind: "shared" as const },
    ),
  });
  if (session.accessScope?.kind !== "personal") return undefined;
  if (
    ctx.req.method === "POST" &&
    /^\/api\/sessions\/[^/]+\/prompt$/.test(ctx.path)
  ) {
    const body = (await ctx.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body)
      return Response.json({ error: "Invalid prompt" }, { status: 400 });
    try {
      assertPersonalImagesAbsent(body.images);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Private images unavailable",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    for (const key of [
      "files",
      "contextSessions",
      "contextChats",
      "mcpServers",
    ]) {
      if (
        body[key] !== undefined &&
        (!Array.isArray(body[key]) || (body[key] as unknown[]).length)
      )
        return Response.json(
          { error: "Private attachments or MCP override unavailable" },
          { status: 400 },
        );
    }
    const text =
      typeof body.content === "string"
        ? body.content
        : typeof body.prompt === "string"
          ? body.prompt
          : "";
    const content = withPastedTexts(
      text.trim(),
      pastedTextsFromWire(body.pastedTexts),
    );
    if (!content || content.trimStart().startsWith("/"))
      return Response.json(
        { error: "Private prompt unavailable" },
        { status: 400 },
      );
    const owned = await personalSessionForAction(session);
    const clientId =
      typeof body.clientId === "string"
        ? body.clientId.slice(0, 200)
        : undefined;
    const deliveryId = `github-account:${access.principal!.githubAccountId}:${clientId || crypto.randomUUID()}`;
    const result = await withSessionExecutionAccess(owned, () =>
      withSessionPublication(
        owned.id,
        access.principal!.githubAccountId,
        () =>
          getSessionControl().deliverToSession(
            owned.id,
            content,
            ctx.authUser?.name.split(" ")[0],
            {
              deliveryId,
              busy:
                body.busy === "queue" || body.busyMode === "queue"
                  ? "queue"
                  : undefined,
              hold: body.busy === "queue" || body.busyMode === "queue",
            },
          ),
        { binding: owned.personalRepo },
      ),
    );
    return Response.json(
      { ...result, ...(clientId ? { clientId } : {}) },
      {
        status: result.status === "error" ? 400 : 200,
        headers: {
          "Cache-Control": "private, no-store",
          Vary: "Cookie, Authorization",
        },
      },
    );
  }
  const canonicalId = session.id;
  return withSessionScopeFence(async () => {
    const session = await findSessionAsync(canonicalId, access.principal);
    if (
      !session ||
      session.id !== canonicalId ||
      session.accessScope?.kind !== "personal"
    )
      return missing();
    // Private reads use the SAME canonical handle all the way through. Unknown
    // private routes, media and mutations do not fall into legacy file paths.
    const root = /^\/api\/sessions\/[^/]+$/.test(ctx.path);
    const entry = /^\/api\/sessions\/[^/]+\/entry\/([^/]+)$/.exec(ctx.path);
    if (ctx.req.method !== "GET" || (!root && !entry)) return missing();
    const actor = await sessionMetadata({
      op: "get",
      sessionId: session.id,
      principal: access.principal,
    });
    if (!actor) return missing();
    const headers = {
      "Cache-Control": "private, no-store",
      Vary: "Cookie, Authorization",
    };
    return withSessionExecutionAccess(session, async () => {
      if (root) {
        const { sessionDetail } = await import("./sessions");
        return Response.json(await sessionDetail(session), { headers });
      }
      const { transcript } = await import("../actor-transcript");
      const full = await transcript.getFullEntry(
        session.id,
        decodeURIComponent(entry![1]!),
      );
      if (!full) return missing();
      return Response.json(full, { headers });
    });
  });
}
