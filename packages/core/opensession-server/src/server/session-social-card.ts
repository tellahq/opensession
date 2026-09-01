/**
 * Dynamic social card for session links.
 *
 * The UI normally lives on a private host, so Slack cannot crawl its Open Graph
 * metadata. The same renderer is therefore available on the public webhook
 * origin and is also linked from the session page for clients that can crawl it.
 *
 * The card can carry a screenshot the session itself produced (a walkthrough
 * shot, or an image someone pasted into the chat). That image is baked into a
 * PNG served from a capability URL, so it travels wherever the link is pasted.
 * Only session-owned media is used, and only at thumbnail size.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "fs";
import { configuredIntegration, configuredServer, productName } from "./config";
import { teamDirectory, type DirectoryPerson } from "./people";
import { stateDir } from "./paths";
import { findSessionAsync } from "./session-cache";
import { transcript } from "./actor-transcript";
import { isWithinUploads, stagedImageRef } from "./uploads";
import type { TranscriptEntry, UnifiedSession } from "./types";

/**
 * sharp is loaded lazily and treated as optional. Its platform `@img/sharp-*`
 * native cannot be embedded into a `bun build --compile` executable (it is
 * resolved from the on-disk sidecar at runtime, not bundled), so a top-level
 * import would crash boot where the sidecar is absent. Load it on first use
 * instead: when it (or its native) is missing, the PNG social-card endpoint
 * degrades to a 501 and the Open Graph meta tags still emit, so the server
 * boots and serves the UI either way.
 */
type SharpFactory = (typeof import("sharp"))["default"];
let sharpFactory: SharpFactory | null | undefined; // undefined = not tried yet

async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpFactory !== undefined) return sharpFactory;
  try {
    const mod = await import("sharp");
    sharpFactory = ((mod as { default?: SharpFactory }).default ??
      mod) as unknown as SharpFactory;
  } catch (e) {
    console.warn(
      "[social-card] sharp unavailable — PNG social cards disabled (Open Graph tags still emit):",
      e instanceof Error ? e.message : e,
    );
    sharpFactory = null;
  }
  return sharpFactory;
}

const SESSION_CARD_VERSION = 26;

const SHOT_BACKING = "#FFFFFF";
/** Preserve each screenshot's aspect ratio within a bounded Slack preview. */
const SHOT_MAX_WIDTH = 640;
const SHOT_MAX_HEIGHT = 640;
const SHOT_RADIUS = 28;
/** Room around the stack for its side and top shadows. */
const SHOT_PAD_X = 40;
const SHOT_PAD_TOP = 30;
/** Hide the lower edge so the screenshots rise out of the card. */
const SHOT_BOTTOM_CROP = 38;
/** How far the card behind sits to the left, and how much lower. */
const SHOT_STACK_OFFSET = 96;
const SHOT_STACK_LIFT = 14;
const SHOT_LIMIT = 2;
/** Keep fallback candidates so an unusable first image does not hide a good one. */
const SHOT_CANDIDATE_LIMIT = 12;
/** Card renders are usually ultra-wide. Rejecting them prevents recursive previews. */
const SHOT_MAX_ASPECT = 16 / 9 + 0.02;
/** Link previews commonly render the card on a 2x display. */
const CARD_RENDER_SCALE = 2;

export interface SessionSocialCardData {
  title: string;
  owner: string;
  repo?: string;
  /** Strongest session screenshot candidates first. The renderer keeps two. */
  shots?: string[];
}

function clean(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function samePerson(person: DirectoryPerson, ref: string): boolean {
  const key = ref.trim().replace(/^@/, "").toLowerCase();
  return [person.name, person.fullName, person.github]
    .filter(Boolean)
    .some((value) => value!.toLowerCase() === key);
}

export function sessionCardTitle(session: UnifiedSession): { title: string } {
  const sessionTitle = clean(session.title) || session.id;
  return { title: sessionTitle };
}

function sessionSocialCardBaseData(
  session: UnifiedSession,
): SessionSocialCardData {
  const heading = sessionCardTitle(session);
  const ownerRef =
    clean(session.createdBy || session.startedBy) || productName();
  const person = teamDirectory().find((candidate) =>
    samePerson(candidate, ownerRef),
  );
  return {
    title: heading.title,
    owner: person?.fullName || ownerRef,
    ...(session.repo ? { repo: session.repo } : {}),
  };
}

export async function sessionSocialCardData(
  session: UnifiedSession,
  options: { includeShot?: boolean } = {},
): Promise<SessionSocialCardData> {
  const base = sessionSocialCardBaseData(session);
  const shots = options.includeShot ? await sessionShotPaths(session) : [];
  return { ...base, ...(shots.length ? { shots } : {}) };
}

const SHOT_MAX_BYTES = 24 * 1024 * 1024;
const SHOT_SCAN_ENTRIES = 60;

/**
 * Only staged session media is eligible: a walkthrough shot or an image
 * someone attached in the chat, both of which live under the uploads dir. The
 * card travels on a capability URL, so a path an agent merely printed is not
 * enough to put a file on it.
 */
const DATA_SHOT_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;

function dataShotBytes(source: string): Buffer | undefined {
  if (!DATA_SHOT_RE.test(source)) return undefined;
  const encoded = source.slice(source.indexOf(",") + 1);
  if (!encoded || Math.ceil((encoded.length * 3) / 4) > SHOT_MAX_BYTES)
    return undefined;
  try {
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length > 0 && bytes.length <= SHOT_MAX_BYTES
      ? bytes
      : undefined;
  } catch {
    return undefined;
  }
}

function usableShot(source: string): boolean {
  if (!source) return false;
  if (source.startsWith("data:")) {
    if (!DATA_SHOT_RE.test(source)) return false;
    const encodedBytes = Math.ceil(
      (source.length - source.indexOf(",") - 1) * 0.75,
    );
    return encodedBytes > 0 && encodedBytes <= SHOT_MAX_BYTES;
  }
  if (!isWithinUploads(source)) return false;
  if (!/\.(png|jpe?g|webp|gif)$/i.test(source)) return false;
  try {
    const stat = statSync(source);
    return stat.isFile() && stat.size > 0 && stat.size <= SHOT_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Resolve one transcript image without widening the card route into a general
 * file reader. Composer uploads and transcript-owned data images are eligible. */
function transcriptShot(src: string): string | undefined {
  const staged = stagedImageRef(src);
  if (staged && usableShot(staged.path)) return staged.path;
  return usableShot(src) ? src : undefined;
}

/** Add eligible images from the requested entry order without duplicates. */
async function appendEntryShots(
  sessionId: string,
  entries: TranscriptEntry[],
  field: "images" | "featuredMedia",
  append: (source: string | undefined) => boolean,
): Promise<void> {
  for (const entry of entries) {
    // Bounded transcript rows replace large data images with os-blob markers.
    // Hydrate that one row so chat screenshots remain available to the card.
    const needsFull =
      entry.images?.some((src) => src.startsWith("os-blob:")) ||
      entry.featuredMedia?.some((src) => src.startsWith("os-blob:"));
    const source = needsFull
      ? ((await transcript.getFullEntry(sessionId, entry.id)) ?? entry)
      : entry;
    for (const src of [...(source[field] ?? [])].reverse()) {
      if (!append(transcriptShot(src))) return;
    }
  }
}

/**
 * Pick the pictures that best say what this session is about. Walkthrough
 * after-shots are the strongest deliberate summaries. Next comes other
 * walkthrough media, media the agent explicitly featured, then pictures a
 * person attached in the conversation. Ordinary tool attachments are excluded
 * because a file the agent merely read is not a useful social preview.
 */
async function sessionShotPaths(session: UnifiedSession): Promise<string[]> {
  const paths: string[] = [];
  const seen = new Set<string>();
  const append = (source: string | undefined): boolean => {
    if (paths.length >= SHOT_CANDIDATE_LIMIT) return false;
    if (!source || seen.has(source) || !usableShot(source)) return true;
    seen.add(source);
    paths.push(source);
    return paths.length < SHOT_CANDIDATE_LIMIT;
  };
  const walkthroughShots = session.walkthrough?.shots ?? [];
  for (const shot of walkthroughShots) append(shot.after);
  for (const shot of walkthroughShots) append(shot.before);
  if (paths.length >= SHOT_CANDIDATE_LIMIT) return paths;

  try {
    const tail = await transcript.readTail(session.id, SHOT_SCAN_ENTRIES);
    const newestFirst = [...tail.entries].reverse();
    await appendEntryShots(session.id, newestFirst, "featuredMedia", append);
    await appendEntryShots(
      session.id,
      newestFirst.filter((entry) => entry.type === "user"),
      "images",
      append,
    );

    if (paths.length < SHOT_CANDIDATE_LIMIT && tail.firstSeq > 1) {
      const opening = await transcript.readRange(
        session.id,
        1,
        Number.MAX_SAFE_INTEGER,
        0,
        SHOT_SCAN_ENTRIES,
      );
      await appendEntryShots(
        session.id,
        opening.entries.filter((entry) => entry.type === "user"),
        "images",
        append,
      );
    }
  } catch {
    // No transcript for this session yet, or the store is unavailable.
  }
  return paths;
}

interface PreparedShot {
  dataUrl: string;
  width: number;
  height: number;
}

interface UsableShotSource {
  input: Buffer | string;
  sharp: SharpFactory;
}

/** Apply the renderer's actual screenshot gate without rasterizing the card. */
async function usableShotSource(
  source: string | undefined,
): Promise<UsableShotSource | undefined> {
  if (!source) return undefined;
  try {
    const sharp = await loadSharp();
    if (!sharp) return undefined;
    const input = dataShotBytes(source) ?? source;
    const metadata = await sharp(input, {
      limitInputPixels: 40_000_000,
    }).metadata();
    if (!metadata.width || !metadata.height) return undefined;
    const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    const orientedWidth = swapsAxes ? metadata.height : metadata.width;
    const orientedHeight = swapsAxes ? metadata.width : metadata.height;
    const aspect = orientedWidth / orientedHeight;
    // Card renders and message-column captures are usually ultra-wide. Putting
    // one back inside the card creates the recursive, unreadable preview.
    if (aspect > SHOT_MAX_ASPECT) return undefined;
    return { input, sharp };
  } catch {
    return undefined;
  }
}

/** Whether Slack can show a meaningful screenshot card for this session. */
export async function hasUsableSessionShot(
  data: SessionSocialCardData,
): Promise<boolean> {
  for (const source of (data.shots ?? []).slice(0, SHOT_CANDIDATE_LIMIT)) {
    if (await usableShotSource(source)) return true;
  }
  return false;
}

/** Keep the complete screenshot and its native aspect ratio. Resizing only
 * bounds the payload and supplies enough pixels for the card's 2x output. */
async function prepareShot(
  source: string | undefined,
): Promise<PreparedShot | undefined> {
  const usable = await usableShotSource(source);
  if (!usable) return undefined;
  try {
    const { data, info } = await usable
      .sharp(usable.input, {
        limitInputPixels: 40_000_000,
      })
      .rotate()
      .resize({
        width: SHOT_MAX_WIDTH * CARD_RENDER_SCALE,
        height: SHOT_MAX_HEIGHT * CARD_RENDER_SCALE,
        fit: "inside",
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      dataUrl: `data:image/png;base64,${data.toString("base64")}`,
      width: info.width / CARD_RENDER_SCALE,
      height: info.height / CARD_RENDER_SCALE,
    };
  } catch {
    return undefined;
  }
}

async function preparedShots(
  paths: string[] | undefined,
): Promise<PreparedShot[]> {
  const shots: PreparedShot[] = [];
  for (const source of (paths ?? []).slice(0, SHOT_CANDIDATE_LIMIT)) {
    const shot = await prepareShot(source);
    if (shot) shots.push(shot);
    if (shots.length >= SHOT_LIMIT) break;
  }
  // Keep source priority intact. A deliberate walkthrough image should not lose
  // to a less relevant chat image merely because the latter is landscape.
  return shots;
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * A squircle: the superellipse corner the UI wears through
 * `corner-shape: squircle`, baked into a path because this rasterizes through
 * librsvg, which has no such property. An `rx` rounded rect beside the app's
 * real tiles reads as the wrong shape even at preview size. Sampled along the
 * curve rather than approximated with beziers, so the corner is the actual
 * superellipse at any size.
 */
function squircleRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  exponent = 4,
  steps = 20,
): string {
  const r = Math.min(radius, width / 2, height / 2);
  const power = 2 / exponent;
  const corner = (
    cx: number,
    cy: number,
    sx: number,
    sy: number,
    reverse: boolean,
  ): string => {
    let path = "";
    for (let i = 0; i <= steps; i++) {
      const t = ((reverse ? steps - i : i) / steps) * (Math.PI / 2);
      const px = cx + sx * r * Math.cos(t) ** power;
      const py = cy + sy * r * Math.sin(t) ** power;
      path += `L${px.toFixed(2)} ${py.toFixed(2)}`;
    }
    return path;
  };
  return [
    `M${(x + r).toFixed(2)} ${y.toFixed(2)}`,
    `L${(x + width - r).toFixed(2)} ${y.toFixed(2)}`,
    corner(x + width - r, y + r, 1, -1, true),
    corner(x + width - r, y + height - r, 1, 1, false),
    corner(x + r, y + height - r, -1, 1, true),
    corner(x + r, y + r, -1, -1, false),
    "Z",
  ].join("");
}

interface ShotFrame extends PreparedShot {
  index: number;
  x: number;
  y: number;
  rotation: number;
  pivotX: number;
  pivotY: number;
}

/** The lead shot sits right, with the second card behind it. Their lower edges
 * share a baseline so differently shaped screenshots still rise as one stack. */
function shotFrames(shots: PreparedShot[]): ShotFrame[] {
  const selected = shots.slice(0, SHOT_LIMIT);
  const stacked = selected.length > 1;
  const tallest = Math.max(...selected.map((shot) => shot.height), 0);
  return selected.map((shot, index) => {
    const x = (selected.length - 1 - index) * SHOT_STACK_OFFSET;
    const y = tallest - shot.height + (index === 0 ? 0 : SHOT_STACK_LIFT);
    return {
      ...shot,
      index,
      x,
      y,
      rotation: stacked ? (index === 0 ? 2 : -5) : 0,
      pivotX: x + shot.width / 2,
      pivotY: y + shot.height,
    };
  });
}

function rotatePoint(
  x: number,
  y: number,
  pivotX: number,
  pivotY: number,
  degrees: number,
): { x: number; y: number } {
  if (!degrees) return { x, y };
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - pivotX;
  const dy = y - pivotY;
  return {
    x: pivotX + dx * cos - dy * sin,
    y: pivotY + dx * sin + dy * cos,
  };
}

/** The fan's true extent, corners rotated, so the crop hugs what is drawn. */
function stackBounds(frames: ShotFrame[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const frame of frames) {
    const corners: Array<[number, number]> = [
      [frame.x, frame.y],
      [frame.x + frame.width, frame.y],
      [frame.x + frame.width, frame.y + frame.height],
      [frame.x, frame.y + frame.height],
    ];
    for (const [cornerX, cornerY] of corners) {
      const point = rotatePoint(
        cornerX,
        cornerY,
        frame.pivotX,
        frame.pivotY,
        frame.rotation,
      );
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The card is the session's screenshots and nothing else. The title travels
 * with the link itself (Slack's own line, or og:title), so drawing it here
 * would say the same thing twice. No screenshot means no card: the caller
 * shows a plain link instead of an empty rectangle.
 *
 * SVG source is exported so the visual can be inspected without PNG decoding.
 */
export function sessionSocialCardSvg(shots: PreparedShot[]): string {
  const frames = shotFrames(shots);
  if (!frames.length) return "";
  const bounds = stackBounds(frames);
  // Whole pixels: a fractional offset would print through every coordinate in
  // the file for no visible gain.
  const offsetX = Math.round(SHOT_PAD_X - bounds.minX);
  const offsetY = Math.round(SHOT_PAD_TOP - bounds.minY);
  const width = Math.round(bounds.maxX - bounds.minX) + SHOT_PAD_X * 2;
  const height =
    Math.round(bounds.maxY - bounds.minY) + SHOT_PAD_TOP - SHOT_BOTTOM_CROP;
  const placed = frames.map((frame) => ({
    ...frame,
    x: frame.x + offsetX,
    y: frame.y + offsetY,
    pivotX: frame.pivotX + offsetX,
    pivotY: frame.pivotY + offsetY,
    shape: squircleRectPath(
      frame.x + offsetX,
      frame.y + offsetY,
      frame.width,
      frame.height,
      SHOT_RADIUS,
    ),
  }));
  const shotDefs = placed
    .map(
      (frame) =>
        `  <clipPath id="shotClip${frame.index}" clipPathUnits="userSpaceOnUse"><path d="${frame.shape}"/></clipPath>`,
    )
    .join("\n");
  const shotMarkup = [...placed]
    .reverse()
    .map((frame) => {
      const transform = frame.rotation
        ? ` transform="rotate(${frame.rotation} ${frame.pivotX} ${frame.pivotY})"`
        : "";
      return `<g${transform}><path d="${frame.shape}" fill="${SHOT_BACKING}" filter="url(#shotShadow)"/>
<g clip-path="url(#shotClip${frame.index})"><image href="${frame.dataUrl}" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" preserveAspectRatio="xMidYMid meet"/></g>
<path d="${frame.shape}" fill="none" stroke="#000000" stroke-opacity="0.1" stroke-width="1"/></g>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden">
<defs>
${shotDefs}
  <filter id="shotShadow" x="-26%" y="-34%" width="152%" height="178%" color-interpolation-filters="sRGB">
    <feDropShadow in="SourceAlpha" dx="0" dy="18" stdDeviation="22" flood-color="#000000" flood-opacity="0.16" result="ambient"/>
    <feDropShadow in="SourceAlpha" dx="0" dy="6" stdDeviation="7" flood-color="#000000" flood-opacity="0.12" result="lift"/>
    <feDropShadow in="SourceAlpha" dx="0" dy="1" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.1" result="contact"/>
    <feMerge><feMergeNode in="ambient"/><feMergeNode in="lift"/><feMergeNode in="contact"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
${shotMarkup}
</svg>`;
}

/** Null when there is nothing to draw, or when sharp is unavailable. */
export async function renderSessionSocialCard(
  data: SessionSocialCardData,
): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const shots = await preparedShots(data.shots);
  const svg = sessionSocialCardSvg(shots);
  if (!svg) return null;
  // The whole card lands at 2x, embedded screenshots included. Rendering only
  // the outer SVG at 2x would still upscale a 1x data image.
  return sharp(Buffer.from(svg), { density: 72 * CARD_RENDER_SCALE })
    .png()
    .toBuffer();
}

function publicBase(): string {
  const media = configuredIntegration("media").publicBaseUrl;
  return (
    process.env.OPENSESSION_SESSION_CARD_BASE ||
    (typeof media === "string" ? media : configuredServer().publicBaseUrl)
  ).replace(/\/+$/, "");
}

export function sessionSocialCardUrl(sessionId: string): string {
  return `${publicBase()}/session-card/${encodeURIComponent(sessionId)}/${cardToken(sessionId)}.png?v=${SESSION_CARD_VERSION}`;
}

let cachedCardSecret = "";

function cardSecret(): string {
  const configured = process.env.OPENSESSION_SESSION_CARD_SECRET?.trim();
  if (configured) return configured;
  if (cachedCardSecret) return cachedCardSecret;
  const path = stateDir("social-card-secret");
  try {
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length >= 32) return (cachedCardSecret = stored);
  } catch {}
  const created = randomBytes(32).toString("hex");
  writeFileSync(path, `${created}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}
  return (cachedCardSecret = created);
}

function cardToken(sessionId: string): string {
  return createHmac("sha256", cardSecret())
    .update(`session-social-card:${sessionId}`)
    .digest("base64url")
    .slice(0, 32);
}

function validCardToken(sessionId: string, token: string): boolean {
  const expected = Buffer.from(cardToken(sessionId));
  const presented = Buffer.from(token);
  return (
    expected.length === presented.length && timingSafeEqual(expected, presented)
  );
}

function socialDescription(data: SessionSocialCardData): string {
  return [data.owner, data.repo].filter(Boolean).join(" · ");
}

function replaceMeta(htmlSource: string, key: string, value: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(<meta\\s+(?:property|name)="${escaped}"\\s+content=")[^"]*("\\s*/?>)`,
  );
  return htmlSource.replace(pattern, `$1${html(value)}$2`);
}

export function sessionHtmlWithSocialMeta(
  htmlSource: string,
  session: UnifiedSession,
  pathname: string,
): string {
  const data = sessionSocialCardBaseData(session);
  const image = sessionSocialCardUrl(session.id);
  const page = `${configuredServer().publicBaseUrl.replace(/\/+$/, "")}${pathname}`;
  const documentTitle = `${data.title} · ${productName()}`;
  let output = htmlSource.replace(
    /<title>[^<]*<\/title>/,
    `<title>${html(documentTitle)}</title>`,
  );
  output = replaceMeta(output, "og:title", data.title);
  output = replaceMeta(output, "og:image", image);
  output = replaceMeta(output, "twitter:card", "summary_large_image");
  output = replaceMeta(output, "twitter:title", data.title);
  output = replaceMeta(output, "twitter:image", image);
  const description = socialDescription(data);
  const extra = `
  <meta property="og:description" content="${html(description)}" />
  <meta property="og:url" content="${html(page)}" />
  <meta property="og:image:alt" content="${html(`${data.title}, Open Session preview`)}" />
  <meta name="twitter:description" content="${html(description)}" />
  <meta name="twitter:image:alt" content="${html(`${data.title}, Open Session preview`)}" />`;
  return output.replace(/(<meta property="og:type"[^>]*>)/, `$1${extra}`);
}

export function socialSessionIdFromPath(pathname: string): string | null {
  const match =
    pathname.match(/^\/session\/([^/?#]+)/) ||
    pathname.match(/^\/workspace\/[^/?#]+\/session\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

const cardCache = new Map<
  string,
  { fingerprint: string; bytes: Buffer; at: number }
>();
const CARD_CACHE_MS = 60_000;
const CARD_CACHE_LIMIT = 100;

function rememberCard(
  cacheKey: string,
  entry: { fingerprint: string; bytes: Buffer; at: number },
): void {
  cardCache.delete(cacheKey);
  cardCache.set(cacheKey, entry);
  if (cardCache.size <= CARD_CACHE_LIMIT) return;
  const oldest = cardCache.keys().next().value;
  if (oldest) cardCache.delete(oldest);
}

function shotFingerprint(source: string): string {
  if (source.startsWith("data:"))
    return createHash("sha256").update(source).digest("base64url");
  try {
    const stat = statSync(source);
    return `${source}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${source}:missing`;
  }
}

function cardFingerprint(data: SessionSocialCardData): string {
  return JSON.stringify({
    ...data,
    shots: data.shots?.map(shotFingerprint),
  });
}

export function sessionSocialCardPublicRoutes(): Map<
  string,
  (req: Request, url: URL) => Promise<Response>
> {
  const routes = new Map<
    string,
    (req: Request, url: URL) => Promise<Response>
  >();
  routes.set("GET /session-card/*", async (_req, url) => {
    const match = url.pathname.match(
      /^\/session-card\/([^/]{1,600})\/([A-Za-z0-9_-]{32})\.png$/,
    );
    if (!match) return Response.json({ error: "Not found" }, { status: 404 });
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(match[1]);
    } catch {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!validCardToken(sessionId, match[2]))
      return Response.json({ error: "Not found" }, { status: 404 });
    const session = await findSessionAsync(sessionId);
    if (!session) return Response.json({ error: "Not found" }, { status: 404 });
    const data = await sessionSocialCardData(session, { includeShot: true });
    if (!(await loadSharp()))
      return Response.json(
        { error: "Social card rendering unavailable (sharp not installed)" },
        { status: 501 },
      );
    const cacheKey = `${SESSION_CARD_VERSION}:${session.id}`;
    const fingerprint = cardFingerprint(data);
    const cached = cardCache.get(cacheKey);
    const now = Date.now();
    let bytes: Buffer;
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      now - cached.at < CARD_CACHE_MS
    ) {
      bytes = cached.bytes;
    } else {
      const rendered = await renderSessionSocialCard(data);
      // A session with no usable screenshot has no card. Callers show a plain
      // link rather than an empty rectangle.
      if (!rendered)
        return Response.json({ error: "Not found" }, { status: 404 });
      bytes = rendered;
      rememberCard(cacheKey, { fingerprint, bytes, at: now });
    }
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex",
      },
    });
  });
  return routes;
}
