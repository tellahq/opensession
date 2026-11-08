/**
 * Coordinator mode routes (coordinator.ts):
 *
 * - PUT  /api/sessions/:id/coordinator   { on }        switch the mode
 * - POST /api/sessions/:id/thread-recap  { since, user } catch-up on its threads
 */

import { findSessionAsync, touchNativeSessionStrict } from "../session-cache";
import { requestUser, type RouteContext } from "./context";

const MODE = /^\/api\/sessions\/([^/]+)\/coordinator$/;
const RECAP = /^\/api\/sessions\/([^/]+)\/thread-recap$/;

export async function handleCoordinatorRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (!path.startsWith("/api/sessions/")) return undefined;

  const mode = path.match(MODE);
  if (mode && req.method === "PUT") {
    const session = await findSessionAsync(decodeURIComponent(mode[1]!));
    if (!session || session.source !== "opensession")
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { on?: unknown };
    if (typeof body.on !== "boolean")
      return Response.json({ error: "on must be a boolean" }, { status: 400 });
    // `false` is stored, not cleared: it is what switches off a legacy
    // space's root session, which coordinates by default.
    await touchNativeSessionStrict(session.id, { coordinator: body.on });
    return Response.json({ ok: true, coordinator: body.on });
  }

  const recap = path.match(RECAP);
  if (recap && req.method === "POST") {
    const session = await findSessionAsync(decodeURIComponent(recap[1]!));
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as {
      since?: unknown;
      user?: unknown;
    };
    const since = Number(body.since);
    if (!Number.isFinite(since) || since <= 0)
      return Response.json({ error: "since is required" }, { status: 400 });
    if (!session.workspaceId)
      return Response.json({ text: null, threadIds: [] });
    const { threadRecap } = await import("../thread-recap");
    return Response.json(
      await threadRecap(
        session.workspaceId,
        session.id,
        since,
        requestUser(ctx, body.user),
      ),
    );
  }
  return undefined;
}
