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
  access,
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "fs/promises";
import { MAX_PROMPT_IMAGES } from "@tellahq/opensession-protocol/session";
import {
  INLINE_IMAGE_EXTENSIONS,
  MAX_FILE_UPLOAD_BYTES,
  MAX_SHIPPED_ATTACHMENT_BYTES,
  MAX_UPLOAD_BYTES,
  sanitizeAttachmentName as sanitizeFilename,
  type StagedAttachment,
} from "./prompt-attachments";
export { MAX_FILE_UPLOAD_BYTES, MAX_UPLOAD_BYTES };
import type { ImageInput, PromptFile } from "./run-events";
import { SESSIONS_DIR } from "./session-cache";

/** The sender's attachment list cannot be staged as sent. Carries the HTTP
 * status so a route answers 400: the browser outbox parks a 4xx as failed with
 * Edit and Discard, while a 5xx retries forever behind a fixed message. */
export class InvalidUploadError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidUploadError";
  }
}

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
export async function parseImageDataUrls(
  urls?: unknown,
): Promise<ImageInput[] | undefined> {
  if (!Array.isArray(urls)) return undefined;
  const out: ImageInput[] = [];
  for (const u of urls) {
    if (typeof u !== "string") continue;
    const m = u.match(/^data:([^;]+);base64,(.+)$/s);
    if (m && m[1].startsWith("image/")) {
      out.push({ mediaType: m[1], data: m[2] });
      continue;
    }
    const staged = await readStagedImage(u);
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
export async function stagedImageRef(
  url: string,
): Promise<{ path: string; mediaType: string; size: number } | undefined> {
  if (!url.startsWith("/media?")) return undefined;
  let path: string | null = null;
  try {
    path = new URL(url, "http://local").searchParams.get("path");
  } catch {
    return undefined;
  }
  if (!path || !(await isWithinUploads(path))) return undefined;
  const dot = path.lastIndexOf(".");
  const mediaType =
    dot > 0
      ? STAGED_IMAGE_MEDIA_TYPES[path.slice(dot).toLowerCase()]
      : undefined;
  if (!mediaType) return undefined;
  try {
    const { size } = await stat(path);
    if (!size || size > MAX_UPLOAD_BYTES) return undefined;
    return { path, mediaType, size };
  } catch {
    return undefined;
  }
}

/** Read a staged image ref back into vision-channel bytes. */
async function readStagedImage(url: string): Promise<ImageInput | undefined> {
  const ref = await stagedImageRef(url);
  if (!ref) return undefined;
  try {
    return {
      mediaType: ref.mediaType,
      data: (await readFile(ref.path)).toString("base64"),
    };
  } catch {
    return undefined;
  }
}

export const UPLOADS_DIR = `${SESSIONS_DIR}/uploads`;
// The HTTP endpoint stages here — a brand-new session has no session id yet, so the
// reference is resolved back (and validated) at send time. Other ingresses that
// hand a run a file by {name, path} reference (Slack) stage here too.
export const STAGED_UPLOADS_DIR = `${UPLOADS_DIR}/staged`;
const MAX_CREATION_ATTACHMENTS = 32;
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

/** Persist inline composer images for a non-agent surface such as team notes.
 * Returns media-route URLs so the owning JSON stays small and the same images
 * remain readable after a server restart. */
export async function stageInlineImages(
  sessionId: string,
  urls?: unknown,
  subdir = "images",
): Promise<string[]> {
  if (urls === undefined) return [];
  if (!Array.isArray(urls))
    throw new InvalidUploadError("images must be an array");
  if (urls.length > MAX_PROMPT_IMAGES)
    throw new InvalidUploadError(
      `Attach up to ${MAX_PROMPT_IMAGES} images per message.`,
    );
  const images = urls.map(
    (url): { data: string; extension: string } | { url: string } => {
      if (typeof url !== "string")
        throw new InvalidUploadError("invalid image");
      // The web composer stages an image at attach time and sends the ref. It
      // already lives under the uploads dir and /media already serves it, so a
      // note keeps the ref instead of rewriting the same bytes to a second file.
      if (url.startsWith("/media?")) return { url };
      const match = url.match(/^data:([^;]+);base64,(.+)$/s);
      const extension = match && INLINE_IMAGE_EXTENSIONS[match[1]];
      if (!match || !extension)
        throw new InvalidUploadError("unsupported image type");
      return { data: match[2], extension };
    },
  );
  if (!images.length) return [];
  const refSizes = new Map<string, number>();
  for (const image of images) {
    if (!("url" in image)) continue;
    const ref = await stagedImageRef(image.url);
    if (!ref) throw new InvalidUploadError("unsupported image type");
    refSizes.set(image.url, ref.size);
  }
  let totalBytes = 0;
  for (const image of images) {
    totalBytes +=
      "url" in image
        ? (refSizes.get(image.url) ?? 0)
        : Buffer.byteLength(image.data, "base64");
    if (totalBytes > MAX_UPLOAD_BYTES)
      throw new InvalidUploadError(
        `images too large (max ${MAX_UPLOAD_BYTES} bytes total)`,
      );
  }
  const dir = `${UPLOADS_DIR}/${sanitizeFilename(subdir)}/${sanitizeFilename(sessionId)}`;
  await mkdir(dir, { recursive: true });
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
      if (!data.length) throw new InvalidUploadError("empty image");
      const path = await uniqueUploadPath(
        dir,
        `${Date.now()}-${index + 1}${image.extension}`,
      );
      await writeFile(path, data);
      staged.push(`/media?path=${encodeURIComponent(path)}`);
    }
    return staged;
  } catch (error) {
    await removeStagedImages(staged);
    throw error;
  }
}

/** Remove media files previously returned by stageInlineImages. */
export async function removeStagedImages(urls?: string[]): Promise<void> {
  for (const url of urls || []) {
    try {
      const path = new URL(url, "http://local").searchParams.get("path");
      if (path && (await isWithinUploads(path))) await unlink(path);
    } catch {}
  }
}

/** Resolve `p` and confirm it lives inside UPLOADS_DIR — guards against a
 *  client-supplied {name,path} ref pointing the agent at an arbitrary file. */
export async function isWithinUploads(p: string): Promise<boolean> {
  try {
    const [real, base] = await Promise.all([
      realpath(p),
      realpath(UPLOADS_DIR),
    ]);
    return real === base || real.startsWith(base + "/");
  } catch {
    return false;
  }
}

/** Pick a collision-free absolute path under `dir` for the sanitized `wanted`. */
async function uniqueUploadPath(
  dir: string,
  wanted: string,
  used?: Set<string>,
): Promise<string> {
  let fname = wanted;
  let i = 1;
  while (used?.has(fname) || (await pathExists(`${dir}/${fname}`))) {
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

function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
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
  const wanted = sanitizeFilename(name);
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) throw new Error("empty upload");
  if (buf.length > MAX_UPLOAD_BYTES)
    throw new Error(
      `file too large (${buf.length} bytes, max ${MAX_UPLOAD_BYTES})`,
    );
  await mkdir(STAGED_UPLOADS_DIR, { recursive: true });
  // Parallel uploads often share a name (iOS calls every picked photo
  // "image.jpeg"). Choosing a free name and writing later let two of them
  // pick the same one, so the second overwrote the first. The exclusive
  // create claims the name and writes it in one step.
  const used = new Set<string>();
  for (;;) {
    const p = await uniqueUploadPath(STAGED_UPLOADS_DIR, wanted, used);
    try {
      await writeFile(p, buf, { flag: "wx" });
      return { name: name || wanted, path: p };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function uploadDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * A digest of a staged file's identity rather than its bytes, for files too
 * large to read whole (a multi-gigabyte video). Staged uploads are written
 * once and never modified, and the destination is a hard link to the same
 * inode, so device, inode, size and mtime pin the exact bytes without reading
 * them. Same `sha256:` shape as a content digest, which the kernel requires.
 */
async function identityDigest(path: string): Promise<string> {
  const s = await stat(path);
  return `sha256:${createHash("sha256")
    .update(`file\0${s.dev}\0${s.ino}\0${s.size}\0${s.mtimeMs}`)
    .digest("hex")}`;
}

async function sourceRefForPath(path: string): Promise<string> {
  if (!(await isWithinUploads(path)))
    throw new Error("Attachment source is outside uploads");
  const base = await realpath(UPLOADS_DIR);
  const real = await realpath(path);
  return `uploads:${encodeURIComponent(real.slice(base.length + 1))}`;
}

async function pathForSourceRef(sourceRef: string): Promise<string> {
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
  if (!(await isWithinUploads(path)))
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
export async function prepareCreationAttachmentSources(
  sessionId: string,
  raw?: unknown,
): Promise<CreationAttachmentSource[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("files must be an array");
  const uploads = parseFileUploads(raw) ?? [];
  if (uploads.length !== raw.length)
    throw new Error("Creation contains an invalid file attachment");
  if (uploads.length > MAX_CREATION_ATTACHMENTS)
    throw new Error(
      `too many creation attachments (max ${MAX_CREATION_ATTACHMENTS})`,
    );
  await mkdir(STAGED_UPLOADS_DIR, { recursive: true });
  let totalBytes = 0;
  const sources: CreationAttachmentSource[] = [];
  for (const [index, upload] of uploads.entries()) {
    let bytes: Buffer;
    let sourcePath: string;
    if (upload.kind === "staged") {
      const size = (await isWithinUploads(upload.path))
        ? await stat(upload.path).then(
            (st) => st.size,
            () => null,
          )
        : null;
      if (size === null)
        throw new Error(
          `Creation attachment source is unavailable: ${upload.name}`,
        );
      if (size > MAX_UPLOAD_BYTES) {
        // Too large to read here: fence it by identity and hard-link it.
        if (size > MAX_FILE_UPLOAD_BYTES)
          throw new Error(
            `Creation attachment has invalid size: ${upload.name}`,
          );
        const digest = await identityDigest(upload.path);
        sources.push({
          attachmentId: createHash("sha256")
            .update(`${sessionId}\0${index}\0${upload.name}\0${digest}`)
            .digest("hex")
            .slice(0, 32),
          name: upload.name || "file",
          sourceRef: await sourceRefForPath(upload.path),
          digest,
        });
        continue;
      }
      bytes = await readFile(upload.path);
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
      const existing = await readFile(sourcePath).catch((error) => {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        if (uploadDigest(existing) !== digest)
          throw new Error(`Creation attachment source ${attachmentId} changed`);
      } else {
        await writeFile(sourcePath, bytes, { mode: 0o600 });
      }
    }
    sources.push({
      attachmentId,
      name: upload.name || "file",
      sourceRef: await sourceRefForPath(sourcePath),
      digest,
    });
  }
  return sources;
}

/** Copy or adopt one exact actor-owned destination after validating its source. */
export async function stageCreationAttachment(
  sessionId: string,
  source: CreationAttachmentSource,
): Promise<{ name: string; path: string }> {
  const path = creationAttachmentPath(
    sessionId,
    source.attachmentId,
    source.name,
  );
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const destinationSize = await stat(path).then(
    (st) => st.size,
    () => null,
  );
  const large =
    destinationSize !== null
      ? destinationSize > MAX_UPLOAD_BYTES
      : await pathForSourceRef(source.sourceRef)
          .then((sourcePath) => stat(sourcePath))
          .then(
            (st) => st.size > MAX_UPLOAD_BYTES,
            () => false,
          );
  if (large) return stageLargeCreationAttachment(path, source);
  if (destinationSize !== null) {
    if (uploadDigest(await readFile(path)) !== source.digest)
      throw new Error(
        `Creation attachment ${source.attachmentId} destination changed`,
      );
    return { name: source.name, path };
  }
  const sourcePath = await pathForSourceRef(source.sourceRef);
  const bytes = await readFile(sourcePath);
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
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
  return { name: source.name, path };
}

/** A file past MAX_UPLOAD_BYTES is hard-linked, never read or copied: a
 *  multi-gigabyte video would otherwise be buffered whole. */
async function stageLargeCreationAttachment(
  path: string,
  source: CreationAttachmentSource,
): Promise<{ name: string; path: string }> {
  if (await pathExists(path)) {
    if ((await identityDigest(path)) !== source.digest)
      throw new Error(
        `Creation attachment ${source.attachmentId} destination changed`,
      );
    return { name: source.name, path };
  }
  const sourcePath = await pathForSourceRef(source.sourceRef);
  if ((await stat(sourcePath)).size > MAX_FILE_UPLOAD_BYTES)
    throw new Error(
      `Creation attachment ${source.attachmentId} has invalid size`,
    );
  if ((await identityDigest(sourcePath)) !== source.digest)
    throw new Error(
      `Creation attachment ${source.attachmentId} digest changed`,
    );
  try {
    await link(sourcePath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  return { name: source.name, path };
}

/**
 * Turn normalized uploads into on-disk {name, path} pairs the agent can read.
 * Pre-staged refs (HTTP) are validated (confined to UPLOADS_DIR, exists, within
 * cap) and passed through; inline base64 is written to a per-session dir (outside
 * any repo, so it never pollutes git). Collisions de-duped, oversized skipped.
 */
async function stageUploads(
  sessionId: string,
  uploads: ParsedUpload[],
): Promise<{ name: string; path: string }[]> {
  const dir = `${UPLOADS_DIR}/${sessionId}`;
  await mkdir(dir, { recursive: true });
  const staged: { name: string; path: string }[] = [];
  const used = new Set<string>();
  for (const up of uploads) {
    if (up.kind === "staged") {
      if (!(await isWithinUploads(up.path))) {
        console.warn(
          `[uploads] Dropping staged ref outside uploads dir: ${up.path}`,
        );
        continue;
      }
      let sz = 0;
      try {
        sz = (await stat(up.path)).size;
      } catch {
        continue;
      }
      if (sz === 0 || sz > MAX_FILE_UPLOAD_BYTES) {
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
    const p = await uniqueUploadPath(dir, wanted, used);
    await writeFile(p, buf);
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

/**
 * Read staged attachments back for a host on another machine (a Runner, a
 * remote Sandbox), which cannot open the uploads dir the note names. Bounded
 * as one payload: the spec is a single JSON document on the wire. Every
 * attachment gets an entry; one past the cap (or unreadable) ships without
 * bytes so the in-host note can still tell the model its host path is out
 * of reach, instead of leaving the plain note's path as the only word.
 */
export async function readPromptFiles(
  staged?: StagedAttachment[],
): Promise<PromptFile[] | undefined> {
  if (!staged?.length) return undefined;
  const files: PromptFile[] = [];
  let total = 0;
  for (const { name, path } of staged) {
    let bytes: Buffer;
    try {
      // Size first: a multi-gigabyte upload must never be read whole just to
      // find out it does not fit the payload.
      const { size } = await stat(path);
      if (total + size > MAX_SHIPPED_ATTACHMENT_BYTES) {
        console.warn(
          `[uploads] ${name} (${size} bytes) stays host-only: remote payload cap reached`,
        );
        files.push({ name });
        continue;
      }
      bytes = await readFile(path);
    } catch (error) {
      console.warn(
        `[uploads] Could not read ${name} for a remote host:`,
        error,
      );
      files.push({ name });
      continue;
    }
    if (total + bytes.length > MAX_SHIPPED_ATTACHMENT_BYTES) {
      console.warn(
        `[uploads] ${name} (${bytes.length} bytes) stays host-only: remote payload cap reached`,
      );
      files.push({ name });
      continue;
    }
    total += bytes.length;
    files.push({ name, data: bytes.toString("base64") });
  }
  return files;
}

/** Parse + stage composer file attachments in one step; returns the prompt note-augmenter. */
export async function stageFileAttachments(
  sessionId: string,
  raw?: unknown,
): Promise<{ name: string; path: string }[]> {
  const uploads = parseFileUploads(raw);
  if (!uploads) return [];
  return stageUploads(sessionId, uploads);
}
