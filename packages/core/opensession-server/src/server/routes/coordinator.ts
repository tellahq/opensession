/**
 * Coordinator mode routes (coordinator.ts):
 *
 * - PUT  /api/sessions/:id/coordinator   { on }        switch the mode
 */

import { findSessionAsync, touchNativeSessionStrict } from "../session-cache";
import type { RouteContext } from "./context";

const MODE = /^\/api\/sessions\/([^/]+)\/coordinator$/;

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
  return undefined;
}
