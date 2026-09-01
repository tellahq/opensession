/** Shared helpers for attaching pasted/dropped images to a composer/form. */

import { BASE_PATH } from "./base";

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * A non-image attachment. Big files are streamed to disk over the HTTP upload
 * endpoint and carry the server's staged `path` (what the next turn sends);
 * `dataUrl` is only kept as a fallback for tiny inline cases / older paths.
 */
export interface FileAttachment {
  name: string;
  type: string;
  path?: string;
  dataUrl?: string;
}

// Mirror of the server's MAX_UPLOAD_BYTES (opensession.ts). Enforced client-side too
// so an oversized file fails loudly at pick time instead of silently vanishing.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Stream one file to the server upload endpoint; resolves to its staged path. */
export async function uploadFile(
  file: File,
  signal?: AbortSignal,
): Promise<{ name: string; path: string }> {
  const res = await fetch(`${BASE_PATH}/api/upload`, {
    method: "POST",
    headers: {
      "x-file-name": encodeURIComponent(file.name),
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.ok || !body?.path) {
    throw new Error(body?.error || `Upload failed (${res.status})`);
  }
  return { name: body.name || file.name, path: body.path };
}

// Extensions the server can read a staged image back from (mirrors
// STAGED_IMAGE_MEDIA_TYPES in src/server/uploads.ts). A pasted screenshot often
// arrives unnamed, so the upload has to carry one of these itself.
const STAGEABLE_IMAGE_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
const MAX_NORMALIZED_IMAGE_EDGE = 4096;
// An image small enough to keep inline when staging isn't available. Pasting
// while the server is unreachable still works below this; above it the send
// would only fail again at delivery, so it is reported at attach time instead.
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;

/** Filename for a staged image. A pasted file is usually named `image.png` or
 *  nothing at all, and the staged path's extension is the only record of its
 *  type, so supply one when the file doesn't. */
function imageUploadName(file: File): string {
  if (/\.[a-z0-9]{1,5}$/i.test(file.name)) return file.name;
  return `pasted-${Date.now()}${STAGEABLE_IMAGE_TYPES[file.type] ?? ".png"}`;
}

async function convertImageToJpeg(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(
      1,
      MAX_NORMALIZED_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image canvas is unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Image conversion failed")),
        "image/jpeg",
        0.88,
      );
    });
  } finally {
    bitmap.close();
  }
}

function convertedImageName(name: string): string {
  const stem = name.replace(/\.[a-z0-9]{1,8}$/i, "") || "image";
  return `${stem}.jpg`;
}

/** Make every image reference acceptable to the server before a durable retry.
 * Supported refs remain byte-for-byte stable. Older HEIC/other inline messages
 * are converted when the browser can decode them; otherwise they fail once as
 * an editable item instead of retrying forever and blocking later follow-ups. */
export async function preparePromptImages(
  images?: string[],
): Promise<string[] | undefined> {
  if (!images?.length) return undefined;
  return Promise.all(
    images.map(async (image) => {
      if (image.startsWith("/media?")) return image;
      const match = image.match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (match && STAGEABLE_IMAGE_TYPES[match[1]]) return image;
      if (!match?.[1].startsWith("image/")) throw unsupportedPromptImage();
      try {
        const response = await fetch(image);
        const jpeg = await convertImageToJpeg(await response.blob());
        return await readFileAsDataUrl(jpeg);
      } catch {
        throw unsupportedPromptImage();
      }
    }),
  );
}

function unsupportedPromptImage(): Error & { status: number } {
  return Object.assign(
    new Error(
      "This image format isn't supported. Attach a PNG, JPEG, GIF, or WebP image.",
    ),
    { status: 400 },
  );
}

/**
 * Stage one image and return the `/media?path=` ref the composer carries, or a
 * `data:` URL when staging isn't possible.
 *
 * Images used to ride entirely as base64. That still works and is what the
 * native clients send, but the web composer persists every unsent message in
 * localStorage (the durable outbox), and the whole origin gets 5,240,320 UTF-16
 * code units there (measured, Chrome 146). Base64 inflates a file by 4/3, so a
 * screenshot spends a megabyte or two of that budget, and a couple of unsent
 * ones fill it. The failure is worse than losing the send: the key is shared by
 * every session in the tab and failed items are never evicted, so one fat
 * message parked in the outbox blocks plain-text sends everywhere until it is
 * discarded.
 */
async function stageImage(
  file: File,
  rejected: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  if (file.size > MAX_UPLOAD_BYTES) {
    rejected.push(
      `${file.name || "image"} (too large, max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)`,
    );
    return null;
  }
  let stageable = file;
  if (!STAGEABLE_IMAGE_TYPES[file.type]) {
    try {
      const jpeg = await convertImageToJpeg(file);
      stageable = new File([jpeg], convertedImageName(file.name), {
        type: "image/jpeg",
      });
    } catch {
      rejected.push(`${file.name || "image"} (use PNG, JPEG, GIF, or WebP)`);
      return null;
    }
  }
  const inline = () => readFileAsDataUrl(stageable);
  try {
    const { path } = await uploadFile(
      new File([stageable], imageUploadName(stageable), {
        type: stageable.type,
      }),
      signal,
    );
    return `/media?path=${encodeURIComponent(path)}`;
  } catch (e) {
    if (signal?.aborted) return null;
    if (file.size <= MAX_INLINE_IMAGE_BYTES) return inline();
    rejected.push(
      `${file.name || "image"} (${(e as Error)?.message || "upload failed"})`,
    );
    return null;
  }
}

/**
 * Split a picked/dropped file list into images (for the vision path) and other
 * files. Both are streamed to disk via the HTTP upload endpoint; an image comes
 * back as a `/media?path=` ref, another file as a name+path ref. Images stay on
 * the vision path because the model can actually see them; everything else is
 * handed to the agent by file path.
 * `rejected` lists files that were too big or failed to upload, so the caller can
 * surface them instead of dropping them silently.
 */
export async function splitAttachments(
  files: FileList | File[],
  signal?: AbortSignal,
): Promise<{ images: string[]; files: FileAttachment[]; rejected: string[] }> {
  const all = Array.from(files);
  const imageFiles = all.filter((f) => f.type.startsWith("image/"));
  const otherFiles = all.filter((f) => !f.type.startsWith("image/"));

  const rejected: string[] = [];
  const images = (
    await Promise.all(imageFiles.map((f) => stageImage(f, rejected, signal)))
  ).filter((u): u is string => u !== null);

  const uploaded = await Promise.all(
    otherFiles.map(async (f): Promise<FileAttachment | null> => {
      if (f.size > MAX_UPLOAD_BYTES) {
        rejected.push(
          `${f.name} (too large, max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)`,
        );
        return null;
      }
      try {
        const { name, path } = await uploadFile(f, signal);
        return { name, type: f.type, path };
      } catch (e) {
        if (signal?.aborted) return null;
        rejected.push(
          `${f.name} (${(e as Error)?.message || "upload failed"})`,
        );
        return null;
      }
    }),
  );

  return {
    images,
    files: uploaded.filter((f): f is FileAttachment => f !== null),
    rejected,
  };
}

/** Image files pulled from a paste event (clipboard), if any. */
export function imageFilesFromPaste(e: React.ClipboardEvent): File[] {
  return Array.from(e.clipboardData?.items || [])
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
}

/** Short extension badge for a filename (e.g. "PDF", "TS"), or "File".
 *
 * The extension keeps its caps: a type token is read like an acronym, the way
 * every file browser sets one. The fallback is a word rather than a type, so
 * it takes sentence case like the rest of the product's copy. */
export function extBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "File";
  return name.slice(dot + 1, dot + 5).toUpperCase();
}
