/**
 * Papercuts routes: the friction log (src/server/papercuts.ts) and its
 * per-repo toggles (Settings → Papercuts).
 */

import type { RouteContext } from "./context";
import {
  listPapercuts,
  papercutsRepoConfigs,
  setPapercutsEnabled,
} from "../papercuts";

export async function handlePapercutsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  // Recent papercuts + the per-repo config, one call for the Settings panel.
  if (path === "/api/papercuts" && req.method === "GET") {
    const repo = url.searchParams.get("repo") || undefined;
    const days = parseInt(url.searchParams.get("days") || "", 10) || undefined;
    const limit =
      parseInt(url.searchParams.get("limit") || "", 10) || undefined;
    return Response.json({
      entries: listPapercuts({ repo, days, limit }),
      repos: papercutsRepoConfigs(),
    });
  }

  if (path === "/api/papercuts/config" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.repo !== "string" ||
      typeof body.enabled !== "boolean"
    ) {
      return Response.json(
        { error: "expected { repo: string, enabled: boolean }" },
        { status: 400 },
      );
    }
    try {
      setPapercutsEnabled(body.repo, body.enabled);
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
    return Response.json({ repos: papercutsRepoConfigs() });
  }

  return undefined;
}
