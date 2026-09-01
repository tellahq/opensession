/**
 * Library routes: the browsable catalog of tools, automations and
 * integrations (src/server/library.ts). Read-only — installing still happens
 * through the surface that owns each type, which is the point of the module.
 */

import type { RouteContext } from "./context";
import { listLibrary } from "../library";

export async function handleLibraryRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/library" && req.method === "GET") {
    return Response.json({ entries: listLibrary() });
  }

  return undefined;
}
