/**
 * GitHub user-attachments — the server-side counterpart of the "Embedding
 * images and videos in PRs" run instruction (run-instructions.ts).
 *
 * Two capabilities, both riding the bot credential (GitHub App user tokens
 * are rejected by both endpoints with 404):
 *
 * - uploadUserAttachment: POST a local media file to the undocumented
 *   uploads.github.com/user-attachments endpoint, returning the stable
 *   github.com/user-attachments/assets/<uuid> URL that GitHub renders inline
 *   (an <img> for images, a native player for a bare video URL). Used by the
 *   walkthrough PR mirror (walkthrough.ts). Verified 2026-08-15 against
 *   an internal pull request.
 *
 * - resolveUserAttachment: turn such a URL back into a short-lived signed
 *   private-user-images URL (plus whether it is an image or a video). The
 *   canonical URL only answers to GitHub cookie auth — token fetches 404 —
 *   but the POST /markdown API resolves it when given the owning repo as
 *   `context`, and the signed URL it emits (a ~300s JWT) fetches without any
 *   auth. Used by the /gh-asset redirect in routes/media.ts so the review
 *   surfaces can show PR media inline.
 */

import { statSync } from "fs";
import { basename } from "path";
import { botGhToken } from "./github-limit";

const MEDIA_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

const FETCH_TIMEOUT_MS = 15_000;
/** Signed URLs carry a 300s JWT; serve from cache only while comfortably
 *  inside that window. */
const RESOLVE_TTL_MS = 240_000;

export function attachmentUrl(id: string): string {
  return `https://github.com/user-attachments/assets/${id.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Upload

const repoDbIds = new Map<string, number>();

async function repoDbId(ghRepo: string, token: string): Promise<number | null> {
  const hit = repoDbIds.get(ghRepo);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(`https://api.github.com/repos/${ghRepo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const id = (await res.json())?.id;
    if (typeof id !== "number") return null;
    repoDbIds.set(ghRepo, id);
    return id;
  } catch {
    return null;
  }
}

/** Re-publishing a walkthrough re-mirrors the same staged files; don't mint a
 *  duplicate asset for bytes we already uploaded this process lifetime. */
const uploadCache = new Map<string, string>();

/**
 * Upload one local media file as a user attachment of `ghRepo`; returns the
 * stable github.com/user-attachments URL, or null on any failure (unknown
 * media type, missing bot credential, endpoint rejection) — callers fall back
 * to linking the file rather than failing the publish.
 */
export async function uploadUserAttachment(
  ghRepo: string,
  filePath: string,
): Promise<string | null> {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime) return null;
  let stat: { size: number; mtimeMs: number };
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  const cacheKey = [ghRepo, filePath, stat.size, stat.mtimeMs].join("\u0000");
  const cached = uploadCache.get(cacheKey);
  if (cached) return cached;
  const token = await botGhToken({ write: true });
  if (!token) return null;
  const repoId = await repoDbId(ghRepo, token);
  if (repoId === null) return null;
  const name = basename(filePath).replace(/[^\w. -]/g, "_");
  try {
    const res = await fetch(
      `https://uploads.github.com/user-attachments/assets?name=${encodeURIComponent(name)}&content_type=${encodeURIComponent(mime)}&repository_id=${repoId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          // The endpoint 400s ("Invalid Content-Type") when the request has
          // no Content-Type header at all, which is what fetch sends for a
          // raw ArrayBuffer body. The value itself is loose (the query param
          // is what names the asset's type), but send the real one.
          "Content-Type": mime,
        },
        body: await Bun.file(filePath).arrayBuffer(),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      console.warn(
        `[gh-attachments] upload of ${name} to ${ghRepo} failed: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`,
      );
      return null;
    }
    const url = (await res.json())?.url;
    if (
      typeof url !== "string" ||
      !url.startsWith("https://github.com/user-attachments/")
    ) {
      return null;
    }
    uploadCache.set(cacheKey, url);
    return url;
  } catch (e: any) {
    console.warn(
      `[gh-attachments] upload of ${name} to ${ghRepo} failed: ${e?.message || e}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolve

export interface ResolvedAttachment {
  /** Signed private-user-images URL, fetchable without auth for ~5 minutes. */
  url: string;
  kind: "image" | "video";
}

/**
 * Pull the signed media URL out of a /markdown render of both reference
 * forms (image syntax and a bare autolink). The video tag is checked first:
 * for a video asset the bare form renders a <video>, while the image form of
 * the SAME asset can still emit an <img>, and the video answer is the one
 * that plays. Exported for tests.
 */
export function parseAttachmentRender(html: string): ResolvedAttachment | null {
  const video =
    /<video[^>]*\bsrc="(https:\/\/private-user-images\.githubusercontent\.com\/[^"]+)"/i.exec(
      html,
    );
  if (video) return { url: video[1].replace(/&amp;/g, "&"), kind: "video" };
  const img =
    /<img[^>]*\bsrc="(https:\/\/private-user-images\.githubusercontent\.com\/[^"]+)"/i.exec(
      html,
    );
  if (img) return { url: img[1].replace(/&amp;/g, "&"), kind: "image" };
  return null;
}

const resolveCache = new Map<
  string,
  { resolved: ResolvedAttachment; expires: number }
>();

/**
 * Resolve one attachment id to a fresh signed URL, authorized via `ghRepo`
 * as the /markdown context (the wrong repo, or one the bot cannot read,
 * resolves to nothing — the render comes back as a plain link).
 */
export async function resolveUserAttachment(
  id: string,
  ghRepo: string,
): Promise<ResolvedAttachment | null> {
  const key = `${id.toLowerCase()}\u0000${ghRepo}`;
  const hit = resolveCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.resolved;
  const token = await botGhToken();
  if (!token) return null;
  const url = attachmentUrl(id);
  try {
    const res = await fetch("https://api.github.com/markdown", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        text: `![a](${url})\n\n${url}`,
        mode: "gfm",
        context: ghRepo,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const resolved = parseAttachmentRender(await res.text());
    if (!resolved) return null;
    resolveCache.set(key, { resolved, expires: Date.now() + RESOLVE_TTL_MS });
    if (resolveCache.size > 500) {
      const oldest = resolveCache.keys().next().value;
      if (oldest !== undefined) resolveCache.delete(oldest);
    }
    return resolved;
  } catch {
    return null;
  }
}
