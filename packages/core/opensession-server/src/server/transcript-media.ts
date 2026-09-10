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
// A pair of stills shown as one before/after slider:
// `OPENSESSION_COMPARE: <abs-before> <abs-after>`. Both halves obey the
// image rules; the web renders the pair as a ```compare fence (see
// placeMediaMarkers), every other client reads two paths.
const COMPARE_MARKER = new RegExp(
  `^${MARKER_OPEN}OPENSESSION_COMPARE:[\\t ]*(/\\S+)[\\t ]+(/\\S+?)${MARKER_CLOSE}$`,
  "gm",
);

/**
 * The `/media` URL a path on disk streams from (routes/media.ts). Parentheses
 * are encoded too, which encodeURIComponent leaves alone: the same URL is
 * written into markdown image syntax, where an unbalanced `)` would end the
 * link early.
 */
export function mediaUrlFor(path: string): string {
  return `/media?path=${encodeURIComponent(path)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")}`;
}

function markerPaths(text: string, marker: RegExp): string[] {
  if (!text) return [];
  return [...text.matchAll(marker)].map((m) => m[1]);
}

function extractMarker(text: string, marker: RegExp): string[] {
  return markerPaths(text, marker).map(mediaUrlFor);
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
 * the file. Both read the same grammar, so both read it from here. A compare
 * marker is its two stills, before first.
 */
export function extractMediaMarkers(text: string): MarkerMedia[] {
  if (!text) return [];
  const found: Array<MarkerMedia & { at: number }> = [];
  for (const m of text.matchAll(IMAGE_MARKER))
    found.push({ path: m[1], kind: "image", at: m.index ?? 0 });
  for (const m of text.matchAll(VIDEO_MARKER))
    found.push({ path: m[1], kind: "video", at: m.index ?? 0 });
  for (const m of text.matchAll(COMPARE_MARKER)) {
    const at = m.index ?? 0;
    found.push({ path: m[1], kind: "image", at });
    found.push({ path: m[2], kind: "image", at: at + 0.5 });
  }
  return found
    .sort((a, b) => a.at - b.at)
    .map(({ path, kind }) => ({ path, kind }));
}

/** Drops the marker lines, leaving the prose that surrounded them. */
export function stripMediaMarkers(text: string): string {
  return text
    .replace(IMAGE_MARKER, "")
    .replace(VIDEO_MARKER, "")
    .replace(COMPARE_MARKER, "");
}

// ── Media in place ──────────────────────────────────────────────────────────
// An assistant message keeps its markers where they were written, rewritten
// into markdown every client can render: a marker becomes standard image
// syntax (`![caption](/media?path=...)`, which the web renders as a figure and
// plays as a video when the file is one), a compare marker becomes a
// ```compare fence the web upgrades into a slider and everyone else reads as
// two links. Until 2026-09 the markers were cut out of the text and only the
// entry's images[]/videos[] carried them, so a message that said "## Proof"
// over three markers showed nothing under Proof and three thumbnails at the
// very end.

type MarkerLine =
  | { kind: "image" | "video"; path: string }
  | { kind: "compare"; before: string; after: string };

/** A single line's marker, if it is one. Each regex is global, so a fresh
 *  anchored copy is used rather than sharing lastIndex across calls. */
function markerOf(line: string): MarkerLine | null {
  const one = (re: RegExp) => new RegExp(re.source, "").exec(line);
  const compare = one(COMPARE_MARKER);
  if (compare)
    return { kind: "compare", before: compare[1], after: compare[2] };
  const image = one(IMAGE_MARKER);
  if (image) return { kind: "image", path: image[1] };
  const video = one(VIDEO_MARKER);
  if (video) return { kind: "video", path: video[1] };
  return null;
}

const CAPTION_MAX_LENGTH = 160;
/** Lines that open a markdown block of their own are never a caption. */
const BLOCK_START_RE =
  /^(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~|\||<|!\[|\s{4}|\t|(?:[-*_]\s*){3,}$)/;

/**
 * The caption rule, kept tight so ordinary prose after a marker is not eaten:
 * one line of plain text directly under the marker (no blank line between),
 * short, not a marker or another block, and the line after it blank, another
 * marker, or the end of the message. A two-line paragraph after a marker is
 * prose; a one-line remark right under it is what it says about the picture.
 */
export function isCaptionLine(line: string, following: string | undefined) {
  const text = line.trim();
  if (!text || text.length > CAPTION_MAX_LENGTH) return false;
  if (markerOf(line) || BLOCK_START_RE.test(line)) return false;
  if (following === undefined || following.trim() === "") return true;
  return markerOf(following) !== null;
}

/** A caption as image alt text: emphasis wrappers and bracket characters
 *  are dropped, since the alt is plain text and a `]` would end it. */
function altText(caption: string | undefined): string {
  if (!caption) return "";
  return caption
    .replace(/^[*_]+|[*_]+$/g, "")
    .replace(/[[\]\\]/g, "")
    .trim();
}

function placedMarkdown(marker: MarkerLine, caption: string | undefined) {
  if (marker.kind === "compare") {
    return [
      "```compare",
      `before: ${mediaUrlFor(marker.before)}`,
      `after: ${mediaUrlFor(marker.after)}`,
      ...(caption ? [`caption: ${caption}`] : []),
      "```",
    ].join("\n");
  }
  return `![${altText(caption)}](${mediaUrlFor(marker.path)})`;
}

export interface PlacedMedia {
  /** The text with every marker rewritten in place. Byte-identical to the
   *  input when there was no marker. */
  content: string;
  /** `/media` URLs, in the order written. A compare marker is two images. */
  images: string[];
  videos: string[];
  /** Everything a marker named: what the agent asked to be SHOWN. */
  featuredMedia: string[];
}

/**
 * Rewrites every marker line where it stands. A blank line is kept on each
 * side of the rewritten form so it is a paragraph of its own: an image glued
 * to the prose above it would be an inline image inside that paragraph, and
 * a fence needs the blank line to open at all.
 */
export function placeMediaMarkers(text: string): PlacedMedia {
  const images: string[] = [];
  const videos: string[] = [];
  const featuredMedia: string[] = [];
  if (!text) return { content: text, images, videos, featuredMedia };
  const lines = text.split("\n");
  const out: string[] = [];
  let placed = false;
  for (let i = 0; i < lines.length; i++) {
    const marker = markerOf(lines[i]);
    if (!marker) {
      out.push(lines[i]);
      continue;
    }
    placed = true;
    let caption: string | undefined;
    const next = lines[i + 1];
    if (next !== undefined && isCaptionLine(next, lines[i + 2])) {
      caption = next.trim();
      i++;
    }
    if (marker.kind === "compare") {
      const before = mediaUrlFor(marker.before);
      const after = mediaUrlFor(marker.after);
      images.push(before, after);
      featuredMedia.push(before, after);
    } else {
      const url = mediaUrlFor(marker.path);
      (marker.kind === "video" ? videos : images).push(url);
      featuredMedia.push(url);
    }
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(placedMarkdown(marker, caption));
    const after = lines[i + 1];
    if (after !== undefined && after.trim() !== "" && !markerOf(after))
      out.push("");
  }
  return {
    content: placed ? out.join("\n") : text,
    images: [...new Set(images)],
    videos: [...new Set(videos)],
    featuredMedia: [...new Set(featuredMedia)],
  };
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

/**
 * An assistant message's media. Markers stay in the text, rewritten in place
 * (placeMediaMarkers); the entry's images[]/videos[] still carry every one of
 * them, plus implicit mentions, for the turn fold's strip, the lightbox
 * gallery and the clients that read the lists rather than the markdown. The
 * trailing thumbnail row under a web message hides what the body already
 * placed (frontend lib/placed-media.ts). `featuredMedia` names the marker
 * media only, the same line toolResultMedia draws.
 *
 * Named for the video marker it first read; every marker kind goes through
 * it now.
 */
export function extractAssistantVideos(text: string): {
  content: string;
  videos: string[];
  images: string[];
  featuredMedia: string[];
} {
  const placed = placeMediaMarkers(text);
  // Implicit mentions render too (markers stay the explicit override; the
  // Set-union keeps a marker + bare mention of the same file to one embed).
  // Scanned on the rewritten text: a placed `/media?path=` URL is not a bare
  // path, so nothing is counted twice.
  const implicit = extractImplicitMedia(placed.content);
  const vset = new Set(placed.videos);
  const iset = new Set(placed.images);
  for (const v of implicit.videos) vset.add(v);
  for (const i of implicit.images) iset.add(i);
  return {
    content: placed.featuredMedia.length
      ? placed.content.trimEnd()
      : placed.content,
    videos: [...vset],
    images: [...iset],
    featuredMedia: placed.featuredMedia,
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
