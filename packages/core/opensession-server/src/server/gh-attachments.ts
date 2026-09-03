/**
 * GitHub user attachments: repository-scoped image and video uploads that
 * render inside GitHub markdown.
 *
 * GitHub CLI 2.99 made this upload contract public through its repeatable
 * `--attach` flag. The CLI uses the same `uploads.github.com/user-attachments`
 * endpoint and stable `github.com/user-attachments/assets/<uuid>` URLs used
 * here. Open Session keeps the small service-side client because its automated
 * flows authenticate with short-lived GitHub App installation tokens, while
 * the CLI intentionally accepts only OAuth and personal access tokens.
 *
 * - uploadUserAttachment uploads a local file and returns its stable URL. The
 *   walkthrough PR mirror and media-comment tool use it, so private-repository
 *   media stays on GitHub instead of being copied to a public capability URL.
 *
 * - resolveUserAttachment turns such a URL back into a short-lived signed
 *   private-user-images URL (plus whether it is an image or a video). The
 *   canonical URL only answers to GitHub cookie auth, but POST /markdown
 *   resolves it when given the owning repo as `context`. The /gh-asset redirect
 *   uses that result so Open Session can show PR media inline.
 */

import { statSync } from "fs";
import { basename } from "path";
import { botGhToken } from "./github-limit";

export type UserAttachmentKind = "image" | "video";

interface MediaFormat {
  mime: string;
  kind: UserAttachmentKind;
  maxBytes: number;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Paid GitHub plans accept 100 MB. Free plans reject videos above 10 MB at
 * the endpoint, because the service cannot know the repository's plan first. */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** Matches the formats and generous client-side limits in gh 2.99. */
const MEDIA_FORMATS: Record<string, MediaFormat> = {
  ".png": { mime: "image/png", kind: "image", maxBytes: MAX_IMAGE_BYTES },
  ".jpg": { mime: "image/jpeg", kind: "image", maxBytes: MAX_IMAGE_BYTES },
  ".jpeg": { mime: "image/jpeg", kind: "image", maxBytes: MAX_IMAGE_BYTES },
  ".gif": { mime: "image/gif", kind: "image", maxBytes: MAX_IMAGE_BYTES },
  ".webp": { mime: "image/webp", kind: "image", maxBytes: MAX_IMAGE_BYTES },
  ".svg": { mime: "image/svg+xml", kind: "image", maxBytes: MAX_IMAGE_BYTES },
  ".mp4": { mime: "video/mp4", kind: "video", maxBytes: MAX_VIDEO_BYTES },
  ".mov": {
    mime: "video/quicktime",
    kind: "video",
    maxBytes: MAX_VIDEO_BYTES,
  },
  ".webm": { mime: "video/webm", kind: "video", maxBytes: MAX_VIDEO_BYTES },
};

const FETCH_TIMEOUT_MS = 15_000;
/** Signed URLs carry a 300s JWT; serve from cache only while comfortably
 * inside that window. */
const RESOLVE_TTL_MS = 240_000;

function mediaFormat(filePath: string): MediaFormat | null {
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return MEDIA_FORMATS[extension] ?? null;
}

/** Whether a local path has a GitHub-supported image or video extension. */
export function userAttachmentKind(
  filePath: string,
): UserAttachmentKind | null {
  return mediaFormat(filePath)?.kind ?? null;
}

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
 * duplicate asset for bytes we already uploaded this process lifetime. */
const uploadCache = new Map<string, string>();

/**
 * Upload one local media file as a user attachment of `ghRepo`; returns the
 * stable github.com/user-attachments URL, or null on any failure. Callers can
 * then fall back to linking the file or decline to publish an incomplete post.
 */
export async function uploadUserAttachment(
  ghRepo: string,
  filePath: string,
): Promise<string | null> {
  const format = mediaFormat(filePath);
  if (!format) return null;
  let stat: { size: number; mtimeMs: number; isFile: () => boolean };
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > format.maxBytes)
    return null;
  const cacheKey = [ghRepo, filePath, stat.size, stat.mtimeMs].join("\u0000");
  const cached = uploadCache.get(cacheKey);
  if (cached) return cached;
  const token = await botGhToken({ write: true, repo: ghRepo });
  if (!token) return null;
  const repoId = await repoDbId(ghRepo, token);
  if (repoId === null) return null;
  const name = basename(filePath).replace(/[^\w. -]/g, "_");
  try {
    const res = await fetch(
      `https://uploads.github.com/user-attachments/assets?name=${encodeURIComponent(name)}&content_type=${encodeURIComponent(format.mime)}&repository_id=${repoId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          // This matches gh 2.99. The media type belongs in the content_type
          // query parameter; the request itself is an opaque byte stream.
          "Content-Type": "application/octet-stream",
        },
        // A Blob is replayable across the upload host's redirects and avoids
        // loading a permitted 100 MB video into the gateway heap at once.
        body: Bun.file(filePath),
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

export interface UploadedUserAttachment {
  path: string;
  url: string;
  kind: UserAttachmentKind;
  /** Used by images. GitHub's native video player has no alt-text field. */
  alt?: string;
}

const escapeAlt = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/[\r\n]+/g, " ");

/** GitHub renders a video player only when its attachment URL owns a paragraph. */
export function userAttachmentMarkdown(
  attachment: UploadedUserAttachment,
): string {
  if (attachment.kind === "video") return attachment.url;
  const fallback = basename(attachment.path)
    .replace(/\.[^.]+$/, "")
    .replace(/\./g, " ");
  return `![${escapeAlt(attachment.alt?.trim() || fallback)}](${attachment.url})`;
}

/**
 * Substitute `{{media:N}}` placeholders (1-based) and append any unreferenced
 * files. The old image-only tool used `{{image:N}}`, so that spelling remains
 * valid. Appended files are separate paragraphs so videos become native players.
 */
export function spliceUserAttachments(
  markdown: string,
  attachments: UploadedUserAttachment[],
): string {
  const used = new Set<number>();
  let body = markdown.replace(
    /\{\{\s*(?:media|image):(\d+)\s*\}\}/gi,
    (marker, n) => {
      const index = Number.parseInt(n, 10) - 1;
      if (index < 0 || index >= attachments.length) return marker;
      used.add(index);
      return userAttachmentMarkdown(attachments[index]);
    },
  );
  const rest = attachments.filter((_, index) => !used.has(index));
  if (rest.length) {
    body = `${body.trimEnd()}\n\n${rest.map(userAttachmentMarkdown).join("\n\n")}`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Resolve

export interface ResolvedAttachment {
  /** Signed private-user-images URL, fetchable without auth for ~5 minutes. */
  url: string;
  kind: UserAttachmentKind;
}

/**
 * Pull the signed media URL out of a /markdown render of both reference forms
 * (image syntax and a bare autolink). Video is checked first: the image form of
 * the same video asset can still emit an <img>, while the bare form plays.
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
 * as the /markdown context. A wrong or unreadable repo resolves to nothing.
 */
export async function resolveUserAttachment(
  id: string,
  ghRepo: string,
): Promise<ResolvedAttachment | null> {
  const key = `${id.toLowerCase()}\u0000${ghRepo}`;
  const hit = resolveCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.resolved;
  const token = await botGhToken({ repo: ghRepo });
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
