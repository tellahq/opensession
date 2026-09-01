/**
 * Inline media streaming for OPENSESSION_VIDEO markers + composer-upload downloads.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { resolveUserAttachment } from "../gh-attachments";
import { isWithinUploads } from "../uploads";
import { resolveLegacySessionsPath } from "../paths";
import { getRepo } from "../worktree";
const HOME = process.env.HOME || "";

export async function handleMediaRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // Stream a local media file referenced by a `OPENSESSION_VIDEO:` marker in a
  // tool's output, so the session viewer can play it inline (tools can't return
  // video blocks the way Read returns images). Path-scoped: absolute path under
  // /tmp or the service user's home, no traversal, known media extension. Range-enabled
  // so the <video> scrubber can seek.
  if (path === "/media" && req.method === "GET") {
    // Records written before the session store was renamed carry absolute
    // paths under its old name, and the URLs built from them outlive the
    // rename in PR descriptions and old transcripts — so resolve those onto
    // the active store before anything else looks at the path.
    const mediaPath = resolveLegacySessionsPath(
      url.searchParams.get("path") || "",
    );
    const mediaTypes: Record<string, string> = {
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };
    const ext = mediaPath.slice(mediaPath.lastIndexOf(".")).toLowerCase();
    const scoped =
      mediaPath.startsWith("/tmp/") ||
      (!!HOME && mediaPath.startsWith(`${HOME}/`));
    // Non-media extensions are servable ONLY from the composer-uploads dir
    // (as a download) — anything wider would make this a read-any-file-on-
    // the-box endpoint (tokens live in dotfiles and json configs).
    const isUploadDownload = !mediaTypes[ext] && isWithinUploads(mediaPath);
    if (
      !mediaPath.startsWith("/") ||
      mediaPath.includes("..") ||
      !scoped ||
      (!mediaTypes[ext] && !isUploadDownload)
    ) {
      return new Response("forbidden", { status: 403 });
    }
    const file = Bun.file(mediaPath);
    if (!(await file.exists()))
      return new Response("not found", { status: 404 });

    const type = mediaTypes[ext] || "application/octet-stream";
    const size = file.size;
    const range = req.headers.get("range");
    // ?download=1 saves the file instead of playing it inline, the same way
    // the session-assets route spells it. The lightbox's Download links
    // straight here, so the browser saves the file under its own name — a
    // plain <a download> is honoured by Safari, the iOS PWA and the desktop
    // shell alike, none of which reliably save a blob: URL built in JS.
    const asAttachment = isUploadDownload || !!url.searchParams.get("download");
    const baseHeaders: Record<string, string> = {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
      ...(asAttachment
        ? {
            "Content-Disposition": `attachment; filename="${mediaPath
              .split("/")
              .pop()
              ?.replace(/[^\w. -]/g, "_")}"`,
          }
        : {}),
    };
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end) {
        return new Response("range not satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
    return new Response(file, {
      headers: { ...baseHeaders, "Content-Length": String(size) },
    });
  }

  // Redirect a GitHub user-attachment (github.com/user-attachments/assets/<id>)
  // to a freshly signed URL the browser can fetch without GitHub cookies. PR
  // prose on the review surfaces embeds these (see the frontend markdown
  // renderer's gh-attachment rewrites); the canonical URL itself answers only
  // to cookie auth. `repo` names the registered repo whose PR the prose came
  // from — resolution is authorized through it. Same auth model as /media
  // above: unguessable ids, tailnet-only server. Media elements re-request on
  // seek/reload, so the redirect is uncacheable and each request gets a URL
  // that is valid now (the server caches resolutions inside the JWT window).
  const ghAsset = path.match(
    /^\/gh-asset\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (ghAsset && req.method === "GET") {
    let ghRepo: string | undefined;
    try {
      const repo = getRepo(url.searchParams.get("repo") || "");
      if (repo.host !== "codestorage") ghRepo = repo.ghRepo;
    } catch {
      // Unknown repo id — fall through to 404.
    }
    if (!ghRepo) return new Response("unknown repo", { status: 404 });
    const resolved = await resolveUserAttachment(ghAsset[1], ghRepo);
    if (!resolved) return new Response("not found", { status: 404 });
    return new Response(null, {
      status: 302,
      headers: { Location: resolved.url, "Cache-Control": "no-store" },
    });
  }

  return undefined;
}
