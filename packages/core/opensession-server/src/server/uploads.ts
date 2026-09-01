/**
 * Composer attachments: image data-URL parsing and non-image file staging.
 * Non-image attachments are staged to disk (the vision path only takes
 * images), then the agent is handed their absolute paths in the opening
 * prompt. Large files (a packed .crx, a zip, a PDF) stream straight to disk
 * over a dedicated HTTP endpoint (POST /api/upload) and only their
 * {name,path} reference rides the WebSocket — base64-over-WS can't carry them
 * (frame cap + memory). The legacy inline {name,dataUrl}-over-WS path is still
 * accepted for small files and older clients.
 */

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import type { ImageInput } from "./run-events";
import { SESSIONS_DIR } from "./session-cache";

/** Keep only the string image references from a composer `images` payload: the
 *  display/queue form (parsed to ImageInput at delivery via parseImageDataUrls).
 *  An entry is either a `data:` URL or a `/media?path=` ref; both render as an
 *  `<img src>` in a transcript, a queue flap and a note. */
export function asDataUrlList(urls?: unknown): string[] | undefined {
  if (!Array.isArray(urls)) return undefined;
  const out = urls.filter((u): u is string => typeof u === "string");
  return out.length ? out : undefined;
}

/**
 * Resolve composer image references into runner ImageInputs.
 *
 * Two forms arrive here. Native clients and small pastes send
 * `data:<mediatype>;base64,<data>` inline. The web composer stages an image to
 * disk at attach time and sends a `/media?path=` ref instead, because its
 * durable outbox keeps every unsent message in localStorage, where the whole
 * origin gets about 5MB and a couple of base64 screenshots fill it.
 *
 * Resolution happens at DELIVERY, not intake, so a queued or retried send reads
 * the same staged file. A ref that no longer resolves drops out of the list;
 * callers that must not silently lose an attachment compare the counts.
 */
export function parseImageDataUrls(urls?: unknown): ImageInput[] | undefined {
  if (!Array.isArray(urls)) return undefined;
  const out: ImageInput[] = [];
  for (const u of urls) {
    if (typeof u !== "string") continue;
    const m = u.match(/^data:([^;]+);base64,(.+)$/s);
    if (m && m[1].startsWith("image/")) {
      out.push({ mediaType: m[1], data: m[2] });
      continue;
    }
    const staged = readStagedImage(u);
    if (staged) out.push(staged);
  }
  return out.length ? out : undefined;
}

/** How many entries of a composer `images` payload name an image at all, so a
 *  caller can tell "no images" from "the images stopped resolving". */
export function countImageRefs(urls?: unknown): number {
  if (!Array.isArray(urls)) return 0;
  return urls.filter(
    (u) =>
      typeof u === "string" &&
      (/^data:image\/[^;]+;base64,./s.test(u) || u.startsWith("/media?")),
  ).length;
}

/** Resolve a `/media?path=` image ref to the file it names. Returns undefined
 *  for anything that isn't an existing image of a supported type inside the
 *  uploads dir, so a stale or forged ref never reaches a run. */
export function stagedImageRef(
  url: string,
): { path: string; mediaType: string; size: number } | undefined {
  if (!url.startsWith("/media?")) return undefined;
  let path: string | null = null;
  try {
    path = new URL(url, "http://local").searchParams.get("path");
  } catch {
    return undefined;
  }
  if (!path || !isWithinUploads(path)) return undefined;
  const dot = path.lastIndexOf(".");
  const mediaType =
    dot > 0
      ? STAGED_IMAGE_MEDIA_TYPES[path.slice(dot).toLowerCase()]
      : undefined;
  if (!mediaType) return undefined;
  try {
    const { size } = statSync(path);
    if (!size || size > MAX_UPLOAD_BYTES) return undefined;
    return { path, mediaType, size };
  } catch {
    return undefined;
  }
}

/** Read a staged image ref back into vision-channel bytes. */
function readStagedImage(url: string): ImageInput | undefined {
  const ref = stagedImageRef(url);
  if (!ref) return undefined;
  try {
    return {
      mediaType: ref.mediaType,
      data: readFileSync(ref.path).toString("base64"),
    };
  } catch {
    return undefined;
  }
}

export const UPLOADS_DIR = `${SESSIONS_DIR}/uploads`;
// The HTTP endpoint stages here — a brand-new session has no session id yet, so the
// reference is resolved back (and validated) at send time.
const STAGED_UPLOADS_DIR = `${UPLOADS_DIR}/staged`;
// Cap so a single upload can't OOM the process. The HTTP path streams, but the
// inline base64/WS path buffers, so keep it modest.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_CREATION_ATTACHMENTS = 32;
const MAX_INLINE_IMAGES = 6;
const INLINE_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
// The reverse of INLINE_IMAGE_EXTENSIONS, for reading a staged image back off
// disk. Deliberately the same four types: a staged ref carries no media type of
// its own, so only extensions we can name a type for are stageable at all.
const STAGED_IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
// Images still ride the WebSocket frame base64-encoded (~+33%) inside the JSON
// envelope, and Bun's default WS `maxPayloadLength` is only 16 MB — below the
// base64 size of a max upload — so a large image silently blew the frame
// (close 1009). Size the frame cap off the upload cap + base64 overhead + slack.
export const WS_MAX_PAYLOAD_BYTES =
  Math.ceil(MAX_UPLOAD_BYTES * (4 / 3)) + 8 * 1024 * 1024;

// A composer attachment arrives either pre-staged on disk (HTTP upload — carries a
// `path`) or inline as base64 over the WS frame (legacy — carries a data URL).
type ParsedUpload =
  | { kind: "staged"; name: string; path: string }
  | { kind: "inline"; name: string; data: string };

export type CreationAttachmentSource = {
  attachmentId: string;
  name: string;
  sourceRef: string;
  digest: string;
};

/** Normalize composer `files` entries into staged-path refs or inline base64. */
export function parseFileUploads(raw?: unknown): ParsedUpload[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ParsedUpload[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const name = typeof (f as any).name === "string" ? (f as any).name : "";
    const path = typeof (f as any).path === "string" ? (f as any).path : "";
    if (path) {
      out.push({ kind: "staged", name, path });
      continue;
    }
    const url =
      typeof (f as any).dataUrl === "string" ? (f as any).dataUrl : "";
    const m = url.match(/^data:[^;]*;base64,(.+)$/s);
    if (!m) continue;
    out.push({ kind: "inline", name, data: m[1] });
  }
  return out.length ? out : undefined;
}

/** Keep a user-supplied filename to a safe basename (no traversal, no exotic chars). */
function sanitizeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() || "file").replace(/^\.+/, "");
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .trim()
    .slice(0, 120);
  return cleaned || "file";
}

/** Persist inline composer images for a non-agent surface such as team notes.
 * Returns media-route URLs so the owning JSON stays small and the same images
 * remain readable after a server restart. */
export function stageInlineImages(
  sessionId: string,
  urls?: unknown,
  subdir = "images",
): string[] {
  if (urls === undefined) return [];
  if (!Array.isArray(urls)) throw new Error("images must be an array");
  if (urls.length > MAX_INLINE_IMAGES)
    throw new Error(`too many images (max ${MAX_INLINE_IMAGES})`);
  const images = urls.map(
    (url): { data: string; extension: string } | { url: string } => {
      if (typeof url !== "string") throw new Error("invalid image");
      // The web composer stages an image at attach time and sends the ref. It
      // already lives under the uploads dir and /media already serves it, so a
      // note keeps the ref instead of rewriting the same bytes to a second file.
      if (url.startsWith("/media?")) {
        if (!stagedImageRef(url)) throw new Error("unsupported image type");
        return { url };
      }
      const match = url.match(/^data:([^;]+);base64,(.+)$/s);
      const extension = match && INLINE_IMAGE_EXTENSIONS[match[1]];
      if (!match || !extension) throw new Error("unsupported image type");
      return { data: match[2], extension };
    },
  );
  if (!images.length) return [];
  let totalBytes = 0;
  for (const image of images) {
    totalBytes +=
      "url" in image
        ? (stagedImageRef(image.url)?.size ?? 0)
        : Buffer.byteLength(image.data, "base64");
    if (totalBytes > MAX_UPLOAD_BYTES)
      throw new Error(`images too large (max ${MAX_UPLOAD_BYTES} bytes total)`);
  }
  const dir = `${UPLOADS_DIR}/${sanitizeFilename(subdir)}/${sanitizeFilename(sessionId)}`;
  mkdirSync(dir, { recursive: true });
  const staged: string[] = [];
  try {
    for (const [index, image] of images.entries()) {
      // Already on disk under uploads: reference it where it lies. removeStaged
      // Images unlinks it the same way, so the note still owns its cleanup.
      if ("url" in image) {
        staged.push(image.url);
        continue;
      }
      const data = Buffer.from(image.data, "base64");
      if (!data.length) throw new Error("empty image");
      const path = uniqueUploadPath(
        dir,
        `${Date.now()}-${index + 1}${image.extension}`,
      );
      writeFileSync(path, data);
      staged.push(`/media?path=${encodeURIComponent(path)}`);
    }
    return staged;
  } catch (error) {
    removeStagedImages(staged);
    throw error;
  }
}

/** Remove media files previously returned by stageInlineImages. */
export function removeStagedImages(urls?: string[]): void {
  for (const url of urls || []) {
    try {
      const path = new URL(url, "http://local").searchParams.get("path");
      if (path && isWithinUploads(path)) unlinkSync(path);
    } catch {}
  }
}

/** Resolve `p` and confirm it lives inside UPLOADS_DIR — guards against a
 *  client-supplied {name,path} ref pointing the agent at an arbitrary file. */
export function isWithinUploads(p: string): boolean {
  try {
    const real = realpathSync(p);
    const base = realpathSync(UPLOADS_DIR);
    return real === base || real.startsWith(base + "/");
  } catch {
    return false;
  }
}

/** Pick a collision-free absolute path under `dir` for the sanitized `wanted`. */
function uniqueUploadPath(
  dir: string,
  wanted: string,
  used?: Set<string>,
): string {
  let fname = wanted;
  let i = 1;
  while (used?.has(fname) || existsSync(`${dir}/${fname}`)) {
    const dot = wanted.lastIndexOf(".");
    fname =
      dot > 0
        ? `${wanted.slice(0, dot)}-${i}${wanted.slice(dot)}`
        : `${wanted}-${i}`;
    i++;
  }
  used?.add(fname);
  return `${dir}/${fname}`;
}

/**
 * Stream one HTTP upload body to the staging dir and return the {name, path} the
 * client echoes back in its next turn. Size cap enforced (the route rejects on
 * Content-Length first; this re-checks the actual bytes).
 */
export async function stageHttpUpload(
  name: string,
  req: Request,
): Promise<{ name: string; path: string }> {
  mkdirSync(STAGED_UPLOADS_DIR, { recursive: true });
  const wanted = sanitizeFilename(name);
  const p = uniqueUploadPath(STAGED_UPLOADS_DIR, wanted);
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) throw new Error("empty upload");
  if (buf.length > MAX_UPLOAD_BYTES)
    throw new Error(
      `file too large (${buf.length} bytes, max ${MAX_UPLOAD_BYTES})`,
    );
  writeFileSync(p, buf);
  return { name: name || wanted, path: p };
}

function uploadDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sourceRefForPath(path: string): string {
  if (!isWithinUploads(path))
    throw new Error("Attachment source is outside uploads");
  const base = realpathSync(UPLOADS_DIR);
  const real = realpathSync(path);
  return `uploads:${encodeURIComponent(real.slice(base.length + 1))}`;
}

function pathForSourceRef(sourceRef: string): string {
  if (!sourceRef.startsWith("uploads:"))
    throw new Error("Unsupported creation attachment source");
  const relative = decodeURIComponent(sourceRef.slice("uploads:".length));
  if (
    !relative ||
    relative.includes("\0") ||
    relative.split("/").includes("..")
  )
    throw new Error("Invalid creation attachment source");
  const path = `${UPLOADS_DIR}/${relative}`;
  if (!isWithinUploads(path))
    throw new Error("Attachment source crossed uploads");
  return path;
}

export function creationAttachmentPath(
  sessionId: string,
  attachmentId: string,
  name: string,
): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(attachmentId))
    throw new Error("Invalid creation attachment id");
  return `${UPLOADS_DIR}/${sanitizeFilename(sessionId)}/${attachmentId}-${sanitizeFilename(name)}`;
}

/** Durably spool inline bodies and reduce all create inputs to bounded source refs. */
export function prepareCreationAttachmentSources(
  sessionId: string,
  raw?: unknown,
): CreationAttachmentSource[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("files must be an array");
  const uploads = parseFileUploads(raw) ?? [];
  if (uploads.length !== raw.length)
    throw new Error("Creation contains an invalid file attachment");
  if (uploads.length > MAX_CREATION_ATTACHMENTS)
    throw new Error(
      `too many creation attachments (max ${MAX_CREATION_ATTACHMENTS})`,
    );
  mkdirSync(STAGED_UPLOADS_DIR, { recursive: true });
  let totalBytes = 0;
  return uploads.map((upload, index) => {
    let bytes: Buffer;
    let sourcePath: string;
    if (upload.kind === "staged") {
      if (!isWithinUploads(upload.path) || !existsSync(upload.path))
        throw new Error(
          `Creation attachment source is unavailable: ${upload.name}`,
        );
      bytes = readFileSync(upload.path);
      sourcePath = upload.path;
    } else {
      bytes = Buffer.from(upload.data, "base64");
      sourcePath = "";
    }
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES)
      throw new Error(`Creation attachment has invalid size: ${upload.name}`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_UPLOAD_BYTES)
      throw new Error(
        `creation attachments too large (max ${MAX_UPLOAD_BYTES} bytes total)`,
      );
    const digest = uploadDigest(bytes);
    const attachmentId = createHash("sha256")
      .update(`${sessionId}\0${index}\0${upload.name}\0${digest}`)
      .digest("hex")
      .slice(0, 32);
    if (!sourcePath) {
      sourcePath = `${STAGED_UPLOADS_DIR}/creation-${attachmentId}`;
      if (existsSync(sourcePath)) {
        if (uploadDigest(readFileSync(sourcePath)) !== digest)
          throw new Error(`Creation attachment source ${attachmentId} changed`);
      } else {
        writeFileSync(sourcePath, bytes, { mode: 0o600 });
      }
    }
    return {
      attachmentId,
      name: upload.name || "file",
      sourceRef: sourceRefForPath(sourcePath),
      digest,
    };
  });
}

/** Copy or adopt one exact actor-owned destination after validating its source. */
export function stageCreationAttachment(
  sessionId: string,
  source: CreationAttachmentSource,
): { name: string; path: string } {
  const path = creationAttachmentPath(
    sessionId,
    source.attachmentId,
    source.name,
  );
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  if (existsSync(path)) {
    if (uploadDigest(readFileSync(path)) !== source.digest)
      throw new Error(
        `Creation attachment ${source.attachmentId} destination changed`,
      );
    return { name: source.name, path };
  }
  const sourcePath = pathForSourceRef(source.sourceRef);
  const bytes = readFileSync(sourcePath);
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES)
    throw new Error(
      `Creation attachment ${source.attachmentId} has invalid size`,
    );
  if (uploadDigest(bytes) !== source.digest)
    throw new Error(
      `Creation attachment ${source.attachmentId} digest changed`,
    );
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
  return { name: source.name, path };
}

/**
 * Turn normalized uploads into on-disk {name, path} pairs the agent can read.
 * Pre-staged refs (HTTP) are validated (confined to UPLOADS_DIR, exists, within
 * cap) and passed through; inline base64 is written to a per-session dir (outside
 * any repo, so it never pollutes git). Collisions de-duped, oversized skipped.
 */
function stageUploads(
  sessionId: string,
  uploads: ParsedUpload[],
): { name: string; path: string }[] {
  const dir = `${UPLOADS_DIR}/${sessionId}`;
  mkdirSync(dir, { recursive: true });
  const staged: { name: string; path: string }[] = [];
  const used = new Set<string>();
  for (const up of uploads) {
    if (up.kind === "staged") {
      if (!isWithinUploads(up.path) || !existsSync(up.path)) {
        console.warn(
          `[uploads] Dropping staged ref outside uploads dir: ${up.path}`,
        );
        continue;
      }
      let sz = 0;
      try {
        sz = statSync(up.path).size;
      } catch {
        continue;
      }
      if (sz === 0 || sz > MAX_UPLOAD_BYTES) {
        console.warn(`[uploads] Skipping ${up.name || up.path} — ${sz} bytes`);
        continue;
      }
      staged.push({
        name: up.name || up.path.split("/").pop() || "file",
        path: up.path,
      });
      continue;
    }
    const buf = Buffer.from(up.data, "base64");
    if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
      console.warn(
        `[uploads] Skipping ${up.name || "(unnamed)"} for ${sessionId} — ${buf.length} bytes`,
      );
      continue;
    }
    const wanted = sanitizeFilename(up.name);
    const p = uniqueUploadPath(dir, wanted, used);
    writeFileSync(p, buf);
    staged.push({ name: up.name || wanted, path: p });
  }
  return staged;
}

/** Append a note listing staged upload paths so the agent knows to read them. */
export function withUploadsNote(
  prompt: string,
  staged: { name: string; path: string }[],
): string {
  if (!staged.length) return prompt;
  const lines = staged.map((s) => `- ${s.name}: ${s.path}`).join("\n");
  return `${prompt}\n\n[The user attached ${staged.length} file(s), saved to disk — read them with your file tools if relevant:\n${lines}\n]`;
}

/** Parse + stage composer file attachments in one step; returns the prompt note-augmenter. */
export function stageFileAttachments(
  sessionId: string,
  raw?: unknown,
): { name: string; path: string }[] {
  const uploads = parseFileUploads(raw);
  if (!uploads) return [];
  return stageUploads(sessionId, uploads);
}
