import { existsSync } from "fs";
import type { TranscriptEntry } from "./types";

/**
 * The built-in grep tool starts successful result sets with this line. URLs
 * in the following source snippets are code, fixtures, or docs — they are not
 * artifacts the tool produced. Treating `https://example.com/demo.mp4` in a
 * Rust test as media created broken workspace filmstrips (2026-08-11).
 *
 * Keep this deliberately tied to grep's output envelope instead of trying to
 * identify "code-like" URLs: MCP tools legitimately return JSON containing a
 * real media URL, and those should continue to render implicitly.
 */
const GREP_RESULT_HEADER =
  /^Found \d+ match(?:es)?(?: \(more matches available\))?\s*$/;

export function isGrepResultOutput(text: string): boolean {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0]?.trim() || "";
  return GREP_RESULT_HEADER.test(firstLine);
}

/**
 * The read tool's result envelope. Its body is quoted source, so a URL in it
 * belongs to the code, not to the session: a ReScript test's
 * `"https://example.com/image.png"` and a Rust test's
 * `http://example.com/delayed.mp4` filled a workspace filmstrip with broken
 * tiles (2026-08-12), the same failure grep output caused a day earlier.
 *
 * Kept tied to the envelope for the same reason as grep, and for the same
 * reason nothing here tries to recognise "code-like" URLs: an MCP tool that
 * returns a real media URL in its JSON must keep rendering.
 */
const READ_RESULT_HEADER = /^<path>[^\n]*<\/path>\r?\n<type>file<\/type>/;

export function isFileReadOutput(text: string): boolean {
  return READ_RESULT_HEADER.test(text.trimStart());
}

/**
 * Names reserved for documentation and testing (RFC 2606, RFC 6761). Nothing
 * real is ever served from them, so a URL on one is a fixture wherever it was
 * found — an envelope-independent rule, which is what makes it worth having
 * next to the two envelope checks above. `.localhost` and `.test` are included
 * deliberately: the strip renders in the reader's browser, which is not the
 * machine the agent ran on.
 */
const RESERVED_HOST_RE =
  /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

export function isReservedMediaHost(src: string): boolean {
  try {
    return RESERVED_HOST_RE.test(new URL(src).hostname);
  } catch {
    // Unparseable as a URL — not something a browser can load either.
    return true;
  }
}

// Transcript messages can't return video blocks (unlike Read-of-image), so a
// tool or assistant can print `OPENSESSION_VIDEO: <abs-path>` and we turn each
// marker into a /media URL the frontend streams.
// (BACKSTAGE_VIDEO is the pre-rename marker — it lives forever in old
// transcripts and in scripts that haven't updated yet, so keep reading it.)
// Agents dress the line up: bold it, fence it in backticks, hang it off a
// bullet. The wrapper is presentation, not a different intent, so read
// through it. Anchoring to a bare line start made `**OPENSESSION_IMAGE: x**`
// fall through as literal text, and the implicit-mention fallback missed it
// too (a trailing `*` fails that lookahead), so the whole feature vanished
// with no error anywhere.
const MARKER_OPEN = "[\\t ]*(?:[-*>][\\t ]*)?[*_`]{0,3}[\\t ]*";
const MARKER_CLOSE = "[\\t ]*[*_`]{0,3}[\\t ]*";
/** Path capture is lazy so the closing emphasis isn't eaten as path chars. */
function markerRe(keyword: string): RegExp {
  return new RegExp(
    `^${MARKER_OPEN}(?:${keyword}):[\\t ]*(/\\S+?)${MARKER_CLOSE}$`,
    "gm",
  );
}
const VIDEO_MARKER = markerRe("(?:OPENSESSION|BACKSTAGE)_VIDEO");
// Sibling marker for stills (thumbnails, extracted frames, downloaded
// images): `OPENSESSION_IMAGE: <abs-path>` renders inline via the same
// authenticated media route, landing in the entry's existing `images` field.
const IMAGE_MARKER = markerRe("OPENSESSION_IMAGE");

function markerPaths(text: string, marker: RegExp): string[] {
  if (!text) return [];
  return [...text.matchAll(marker)].map((m) => m[1]);
}

function extractMarker(text: string, marker: RegExp): string[] {
  return markerPaths(text, marker).map(
    (path) => `/media?path=${encodeURIComponent(path)}`,
  );
}

export interface MarkerMedia {
  /** The absolute path the agent wrote, not a `/media` URL. */
  path: string;
  kind: "image" | "video";
}

/**
 * The marked-up media of a message, in the order it was written, as paths on
 * disk. The transcript wants `/media` URLs because it renders in a browser
 * holding a session cookie; a surface that has to hand Slack the bytes wants
 * the file. Both read the same grammar, so both read it from here.
 */
export function extractMediaMarkers(text: string): MarkerMedia[] {
  if (!text) return [];
  const found: Array<MarkerMedia & { at: number }> = [];
  for (const m of text.matchAll(IMAGE_MARKER))
    found.push({ path: m[1], kind: "image", at: m.index ?? 0 });
  for (const m of text.matchAll(VIDEO_MARKER))
    found.push({ path: m[1], kind: "video", at: m.index ?? 0 });
  return found
    .sort((a, b) => a.at - b.at)
    .map(({ path, kind }) => ({ path, kind }));
}

/** Drops the marker lines, leaving the prose that surrounded them. */
export function stripMediaMarkers(text: string): string {
  return text.replace(IMAGE_MARKER, "").replace(VIDEO_MARKER, "");
}

export function extractVideoMarkers(text: string): string[] {
  return extractMarker(text, VIDEO_MARKER);
}

export function extractImageMarkers(text: string): string[] {
  return extractMarker(text, IMAGE_MARKER);
}

// Implicit media: tool results and assistant text that
// mention media by path/URL render it inline WITHOUT needing the explicit
// markers. Guardrails against code-session noise: local candidates must be
// absolute paths that actually exist on disk (a diff's `b/logo.png` or a
// source file's "/assets/x.png" never render), remote candidates must be
// clean URLs ending in a media extension, and both are capped per entry.
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
// `*` and `_` sit in both boundaries so a path a person emphasised
// (`**/tmp/shot.png**`) reads the same as a bare one.
const LOCAL_MEDIA_RE =
  /(?:^|[\s"'`(=*_])(\/[^\s"'`)\]},;]+\.(?:png|jpe?g|gif|webp|mp4|webm|mov|m4v))(?=$|[\s"'`)\]},;:*_])/gim;
const REMOTE_MEDIA_RE =
  /(https?:\/\/[^\s"'`)\]}>,;]+\.(?:png|jpe?g|gif|webp|mp4|webm|mov|m4v)(?:\?[^\s"'`)\]}>,;]*)?)/gi;
const IMPLICIT_MEDIA_CAP = 6;

export function extractImplicitMedia(text: string): {
  images: string[];
  videos: string[];
} {
  const images: string[] = [];
  const videos: string[] = [];
  if (!text || text.length > 512_000) return { images, videos };
  // Quoted code is not an artifact: search snippets and file listings carry
  // fixture URLs (see the envelope predicates above for why this stays
  // envelope-shaped).
  if (isGrepResultOutput(text) || isFileReadOutput(text))
    return { images, videos };
  const seen = new Set<string>();
  const add = (src: string, pathLike: string) => {
    if (seen.has(src)) return;
    const bucket = IMAGE_EXT.test(pathLike.replace(/\?.*$/, ""))
      ? images
      : videos;
    if (bucket.length >= IMPLICIT_MEDIA_CAP) return;
    seen.add(src);
    bucket.push(src);
  };
  for (const m of text.matchAll(LOCAL_MEDIA_RE)) {
    const p = m[1];
    try {
      if (!existsSync(p)) continue;
    } catch {
      continue;
    }
    add(`/media?path=${encodeURIComponent(p)}`, p);
  }
  // Reserved documentation/testing names serve nothing, wherever they turn up.
  for (const m of text.matchAll(REMOTE_MEDIA_RE))
    if (!isReservedMediaHost(m[1])) add(m[1], m[1]);
  return { images, videos };
}

export function extractAssistantVideos(text: string): {
  content: string;
  videos: string[];
  images: string[];
} {
  const videos = extractVideoMarkers(text);
  const images = extractImageMarkers(text);
  let content = text;
  if (videos.length > 0) content = content.replace(VIDEO_MARKER, "");
  if (images.length > 0) content = content.replace(IMAGE_MARKER, "");
  // Implicit mentions render too (markers stay the explicit override; the
  // Set-union keeps a marker + bare mention of the same file to one embed).
  const implicit = extractImplicitMedia(content);
  const vset = new Set(videos);
  const iset = new Set(images);
  for (const v of implicit.videos) vset.add(v);
  for (const i of implicit.images) iset.add(i);
  return {
    content: videos.length || images.length ? content.trimEnd() : text,
    videos: [...vset],
    images: [...iset],
  };
}

/**
 * A tool result's media, derived once for every engine. The claude, pi
 * and codex parsers and the live pi stream all render the same result
 * text, so they all call this: while each kept its own copy the codex branches
 * read video markers only, and an `OPENSESSION_IMAGE:` line — the thing agents
 * are told to print when they want a human to LOOK at something — rendered on
 * two engines and silently vanished on the third (2026-08-16).
 *
 * `attached` is the media the engine hands over out of band: a Read's image
 * block on claude, piToolResultImages on pi, nothing on codex.
 * Markers are the agent asking for that one to be SHOWN, so only they are
 * featured; attachments and paths that merely turn up in the output attach
 * without opening their row (see TranscriptEntry.featuredMedia).
 *
 * Returns only the keys it found, so callers spread it straight into the
 * entry they are building.
 */
export function toolResultMedia(
  text: string,
  attached: string[] = [],
): Pick<TranscriptEntry, "images" | "videos" | "featuredMedia"> {
  const markerImages = extractImageMarkers(text);
  const markerVideos = extractVideoMarkers(text);
  const implicit = extractImplicitMedia(text);
  const images = [
    ...new Set([...attached, ...markerImages, ...implicit.images]),
  ];
  const videos = [...new Set([...markerVideos, ...implicit.videos])];
  const featuredMedia = [...new Set([...markerImages, ...markerVideos])];
  return {
    ...(images.length ? { images } : {}),
    ...(videos.length ? { videos } : {}),
    ...(featuredMedia.length ? { featuredMedia } : {}),
  };
}

/**
 * Read-time repair for transcript-v2 rows persisted before these guards
 * existed. Explicit marker media (`featuredMedia`) is always preserved; only
 * media *inferred* from quoted code — a search snippet, a file listing, or any
 * reserved-name URL — is removed. This is the only path that heals the rows
 * already in the store, so it carries every predicate the extractor applies.
 */
export function sanitizeTranscriptMediaEntry<T extends TranscriptEntry>(
  entry: T,
): T {
  if (!entry.images?.length && !entry.videos?.length) return entry;

  const content = entry.content || "";
  const quotedCode =
    entry.type === "tool_result" &&
    (isGrepResultOutput(content) || isFileReadOutput(content));
  const featured = new Set(entry.featuredMedia || []);
  const keep = (src: string) =>
    featured.has(src) ||
    (!quotedCode && !(/^https?:\/\//i.test(src) && isReservedMediaHost(src)));
  if ((entry.images || []).every(keep) && (entry.videos || []).every(keep))
    return entry;

  const images = entry.images?.filter(keep);
  const videos = entry.videos?.filter(keep);
  const repaired = { ...entry };
  if (images?.length) repaired.images = images;
  else delete repaired.images;
  if (videos?.length) repaired.videos = videos;
  else delete repaired.videos;
  return repaired;
}
