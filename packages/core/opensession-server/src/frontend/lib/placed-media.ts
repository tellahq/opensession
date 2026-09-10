/**
 * Which of an entry's images[]/videos[] its body already shows.
 *
 * The server rewrites an `OPENSESSION_IMAGE:` / `_VIDEO:` / `_COMPARE:` line
 * into markdown where it was written (server/transcript-media.ts) and still
 * lists the media on the entry, since the turn fold's strip, the lightbox
 * gallery and the native clients read the lists. The thumbnail row under a
 * web message is for what the body did NOT place: a Read's image block, a
 * path that turned up in prose, and every entry from before the rewrite,
 * whose body has no `/media` image at all.
 */

const PLACED_IMAGE_RE = /!\[[^\]]*\]\((\/media\?path=[^)\s]+)\)/g;
const PLACED_COMPARE_RE =
  /^[\t ]*(?:before|after):[\t ]*(\/media\?path=\S+)[\t ]*$/gim;

/** The `/media?path=` srcs a body renders in place. */
export function placedMediaSrcs(content: string | undefined): Set<string> {
  const placed = new Set<string>();
  if (!content || !content.includes("/media?path=")) return placed;
  for (const m of content.matchAll(PLACED_IMAGE_RE)) placed.add(m[1]);
  for (const m of content.matchAll(PLACED_COMPARE_RE)) placed.add(m[1]);
  return placed;
}

/** `media` minus what `content` already places; the same array when nothing is. */
export function unplacedMedia(
  media: string[] | undefined,
  content: string | undefined,
): string[] | undefined {
  if (!media?.length) return media;
  const placed = placedMediaSrcs(content);
  if (placed.size === 0) return media;
  const rest = media.filter((src) => !placed.has(src));
  return rest.length === media.length ? media : rest;
}
