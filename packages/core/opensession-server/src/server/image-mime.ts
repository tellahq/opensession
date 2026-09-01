/**
 * Image extensions the diff/review views render inline (binary files have no
 * textual hunks, so the client shows the picture instead). Shared by the
 * worktree-image and pr-image endpoints.
 */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/** Content-type for an image path, or null when it isn't a renderable image. */
export function imageContentType(p: string): string | null {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_TYPES[p.slice(dot).toLowerCase()] || null;
}

/** Response headers for serving repo images: correct type, no sniffing, and no
 *  script execution if an SVG is opened as a document instead of an <img>. */
export function imageHeaders(contentType: string, cacheControl: string) {
  return {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "script-src 'none'",
  };
}
