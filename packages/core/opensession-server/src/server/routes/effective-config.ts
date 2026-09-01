/**
 * GET /api/sessions/:id/effective-config — the fully-resolved configuration a
 * session's next turn would run with, every row naming the file or code path
 * that decided it (see src/server/effective-config.ts, docs/effective-config.md).
 *
 * Registered BEFORE handleSessionsRoutes in routes/index.ts, like the assets,
 * notes and git surfaces: the suffix lives inside the /api/sessions/:id path
 * family, and the generic session routes must never swallow it.
 *
 * Read-only: it peeks the account pool rather than picking from it, and takes
 * the same auth as every other session route (the gate in opensession.ts).
 */

import { requestUser, type RouteContext } from "./context";
import { buildSessionEffectiveConfig } from "../effective-config";
import { findSessionAsync } from "../session-cache";

export async function handleEffectiveConfigRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;
  const match = path.match(/^\/api\/sessions\/([^/]+)\/effective-config$/);
  if (!match || req.method !== "GET") return undefined;

  const sessionId = decodeURIComponent(match[1]!);
  const session = await findSessionAsync(sessionId);
  if (!session)
    return Response.json({ error: "session not found" }, { status: 404 });

  // Who the next turn would be attributed to: the signed-in caller, or an
  // explicit ?user= for asking "what would this look like for them" (the
  // allowedUsers gate and the shared-server key both key off it).
  const user = requestUser(ctx, url.searchParams.get("user")) || undefined;
  const verbose = url.searchParams.get("verbose") === "1";
  try {
    return Response.json(
      await buildSessionEffectiveConfig(session, { user, verbose }),
    );
  } catch (error) {
    console.error("[effective-config] failed:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
