/**
 * HTTP surface for chunked, resumable uploads (chunked-uploads.ts).
 *
 *   POST   /api/uploads                     { name, size } -> { id, chunkSize, chunks }
 *   GET    /api/uploads/:id                 -> { received: number[], ... }
 *   PUT    /api/uploads/:id/chunks/:index   raw bytes, optional x-chunk-sha256
 *   POST   /api/uploads/:id/complete        -> { name, path }
 *   DELETE /api/uploads/:id
 */
import type { RouteContext } from "./context";
import {
  RequestBodyTooLargeError,
  readRequestBytesWithinLimit,
  readRequestTextWithinLimit,
} from "../shared/bounded-body";
import {
  UPLOAD_CHUNK_BYTES,
  UploadError,
  cancelUpload,
  completeUpload,
  createUpload,
  uploadStatus,
  writeChunk,
} from "../chunked-uploads";

const reply = (data: object, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function handleUploadRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (path !== "/api/uploads" && !path.startsWith("/api/uploads/"))
    return undefined;
  // Cross-site writes are refused for every /api/ mutation before routing
  // (web-auth.ts crossSiteViolation). Do not compare Origin with ctx.url here:
  // behind the gateway proxy ctx.url is the internal backend address.
  try {
    if (path === "/api/uploads" && req.method === "POST") {
      const input = JSON.parse(await readRequestTextWithinLimit(req, 4096));
      return reply(await createUpload(input));
    }
    const match = path.match(
      /^\/api\/uploads\/([a-f0-9-]{36})(?:\/(complete|chunks\/(\d{1,6})))?$/,
    );
    if (!match) return reply({ error: "Not found" }, 404);
    const [, id, action, index] = match;
    if (!action && req.method === "GET") return reply(await uploadStatus(id!));
    if (!action && req.method === "DELETE") {
      await cancelUpload(id!);
      return reply({ ok: true });
    }
    if (action === "complete" && req.method === "POST")
      return reply({ ok: true, ...(await completeUpload(id!)) });
    if (index !== undefined && req.method === "PUT") {
      const bytes = await readRequestBytesWithinLimit(req, UPLOAD_CHUNK_BYTES);
      await writeChunk(
        id!,
        Number(index),
        bytes,
        req.headers.get("x-chunk-sha256"),
      );
      return reply({ ok: true });
    }
    return reply({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof UploadError)
      return reply(
        {
          error: error.message,
          ...(error.missing ? { missing: error.missing } : {}),
        },
        error.status,
      );
    if (error instanceof RequestBodyTooLargeError)
      return reply({ error: "Chunk too large" }, 413);
    if (error instanceof SyntaxError)
      return reply({ error: "Invalid request" }, 400);
    console.error("[uploads] Request failed:", error);
    return reply({ error: "Upload failed" }, 500);
  }
}
