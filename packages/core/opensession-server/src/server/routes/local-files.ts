/**
 * The person's side of a local file request (local-file-requests.ts).
 *
 *   GET  /api/local-files?sessionId=          -> { request | null }
 *   POST /api/local-files/:requestId          { sessionId, files: [{ name, path }] }
 *   POST /api/local-files/:requestId/decline  { sessionId }
 */
import type { RouteContext } from "./context";
import { readRequestTextWithinLimit } from "../shared/bounded-body";
import {
  LocalFilesAnswerError,
  answerLocalFilesRequest,
  declineLocalFilesRequest,
  pendingLocalFilesRequest,
} from "../local-file-requests";

const reply = (data: object, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function handleLocalFilesRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (path !== "/api/local-files" && !path.startsWith("/api/local-files/"))
    return undefined;
  if (path === "/api/local-files" && req.method === "GET") {
    return reply({
      request: pendingLocalFilesRequest(
        ctx.url.searchParams.get("sessionId") || "",
      ),
    });
  }
  const identity = ctx.authUser as { automation?: boolean } | null | undefined;
  if (identity?.automation === true)
    return reply({ error: "Only a person can send files" }, 403);
  const origin = req.headers.get("origin");
  if (
    (origin && origin !== ctx.url.origin) ||
    req.headers.get("sec-fetch-site") === "cross-site"
  )
    return reply({ error: "Cross-origin answers are not allowed" }, 403);
  const match = path.match(/^\/api\/local-files\/([a-f0-9-]{36})(\/decline)?$/);
  if (!match || req.method !== "POST")
    return reply({ error: "Not found" }, 404);
  let body: { sessionId?: unknown; files?: unknown };
  try {
    body = JSON.parse(await readRequestTextWithinLimit(req, 64 * 1024));
  } catch {
    return reply({ error: "Invalid request" }, 400);
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (match[2]) {
    const ok = declineLocalFilesRequest(sessionId, match[1]!);
    return reply({ ok }, ok ? 200 : 409);
  }
  try {
    const files = await answerLocalFilesRequest(
      sessionId,
      match[1]!,
      body.files,
    );
    return reply({
      ok: true,
      files: files.map(({ name, size }) => ({ name, size })),
    });
  } catch (error) {
    if (error instanceof LocalFilesAnswerError)
      return reply({ error: error.message }, error.status);
    console.error("[local-files] Answer failed:", error);
    return reply({ error: "Couldn't send the files" }, 500);
  }
}
