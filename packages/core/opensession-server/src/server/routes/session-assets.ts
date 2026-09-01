/**
 * Session assets HTTP surface (see src/server/session-assets.ts for the
 * store): the Assets tab's tree listing, raw file serving for previews, and
 * delete. Raw serving is PATH-based (…/assets/raw/<relpath>) rather than a
 * ?path= query so a previewed index.html can reference ./style.css and have
 * the browser resolve it to a sibling asset URL naturally.
 *
 * Registered BEFORE handleSessionsRoutes in routes/index.ts: the /assets
 * suffixes live inside the /api/sessions/:id path family, and the generic
 * session routes must never swallow them (the same trap that forced
 * detach-repo onto POST). Mutation here is POST for that reason too.
 */

import type { RouteContext } from "./context";
import {
  assetStorageLocation,
  deleteAssetAcross,
  listAssetsAcross,
  openAssetAcross,
} from "../session-assets";
import { sessionIdsForAsync } from "../session-cache";

export async function handleSessionAssetsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  // GET /api/sessions/:id/assets → { dir, files: [{path,size,mtime}] }
  const listMatch = path.match(/^\/api\/sessions\/([^/]+)\/assets$/);
  if (listMatch && req.method === "GET") {
    try {
      const sessionId = decodeURIComponent(listMatch[1]!);
      const sessionIds = await sessionIdsForAsync(sessionId);
      return Response.json({
        dir: assetStorageLocation(sessionIds[0] || sessionId),
        files: await listAssetsAcross(sessionIds),
      });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
  }

  // GET /api/sessions/:id/assets/raw/<relpath> → the file itself.
  // ?download=1 forces an attachment disposition.
  const rawMatch = path.match(/^\/api\/sessions\/([^/]+)\/assets\/raw\/(.+)$/);
  if (rawMatch && req.method === "GET") {
    let found;
    try {
      const sessionId = decodeURIComponent(rawMatch[1]!);
      const relRaw = decodeURIComponent(rawMatch[2]!);
      found = await openAssetAcross(
        await sessionIdsForAsync(sessionId),
        relRaw,
      );
    } catch (e: any) {
      return new Response(e?.message || "bad path", { status: 400 });
    }
    if (!found) return new Response("not found", { status: 404 });
    const headers: Record<string, string> = {
      "Content-Type": found.type,
      "Content-Length": String(found.size),
      "Cache-Control": "no-store",
    };
    if (url.searchParams.get("download")) {
      const name =
        found.path
          .split("/")
          .pop()
          ?.replace(/[^\w. -]/g, "_") || "asset";
      headers["Content-Disposition"] = `attachment; filename="${name}"`;
    }
    return new Response(found.body, { headers });
  }

  // POST /api/sessions/:id/assets/delete { path } — POST (not DELETE) so the
  // generic session-delete route can never swallow it.
  const delMatch = path.match(/^\/api\/sessions\/([^/]+)\/assets\/delete$/);
  if (delMatch && req.method === "POST") {
    try {
      const sessionId = decodeURIComponent(delMatch[1]!);
      const body = (await req.json().catch(() => ({}))) as {
        path?: string;
      };
      if (!body.path)
        return Response.json({ error: "path required" }, { status: 400 });
      await deleteAssetAcross(await sessionIdsForAsync(sessionId), body.path);
      return Response.json({ ok: true });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
  }

  return undefined;
}
