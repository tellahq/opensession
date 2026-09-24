/**
 * Chunked, resumable uploads for large attachments (a multi-gigabyte video).
 *
 * The single-request `/api/upload` buffers the whole body in memory and Bun
 * caps a request body at 128 MB, so it cannot carry these. Instead a client:
 *
 *   1. POST /api/uploads { name, size }        -> { id, chunkSize, chunks }
 *   2. PUT  /api/uploads/:id/chunks/:index     (raw bytes, several in parallel)
 *   3. POST /api/uploads/:id/complete          -> { name, path }
 *
 * GET /api/uploads/:id lists the chunks already received, so a client that
 * lost its connection resends only what is missing.
 *
 * The state lives on disk, not in memory: `meta.json`, one sparse `data` file
 * written at each chunk's offset, and one empty marker per received chunk.
 * Markers are independent files, so parallel chunk writes never race on a
 * shared manifest, and a gateway handoff mid-upload loses nothing: the next
 * process reads the same directory. Every operation here is asynchronous.
 *
 * The finished file is renamed into the staged uploads dir, which is what the
 * composer's `{ name, path }` references and the agent's attachment note name.
 */
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import {
  MAX_FILE_UPLOAD_BYTES,
  envBytes,
  sanitizeAttachmentName,
} from "./prompt-attachments";
import { UPLOADS_DIR } from "./uploads";

const GIB = 1024 * 1024 * 1024;
/** Bytes per chunk. Small enough to buffer and hash per request, large enough
 *  that a 4 GB file is a few hundred requests. */
export const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
/** Space that must stay free on the uploads disk after an upload lands. */
const MIN_FREE_BYTES = envBytes("OPENSESSION_UPLOAD_MIN_FREE_BYTES", 5 * GIB);
/** Partial uploads nobody finished are removed after this long. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
/** In-progress uploads at once, across every user. */
const MAX_PARTIAL_UPLOADS = 32;

export const PARTIAL_UPLOADS_DIR = `${UPLOADS_DIR}/partial`;
const STAGED_UPLOADS_DIR = `${UPLOADS_DIR}/staged`;
const ID = /^[a-f0-9-]{36}$/;

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly missing?: number[],
  ) {
    super(message);
    this.name = "UploadError";
  }
}

type Meta = {
  name: string;
  size: number;
  chunkSize: number;
  chunks: number;
  createdAt: number;
};
type Result = { name: string; path: string };

export type UploadStore = {
  /** Where partial uploads live. */
  partialDir: string;
  /** Where finished uploads land. */
  stagedDir: string;
  now?: () => number;
  /** Free bytes on the uploads disk; injectable for tests. */
  freeBytes?: (dir: string) => Promise<number>;
};

const defaultStore: UploadStore = {
  partialDir: PARTIAL_UPLOADS_DIR,
  stagedDir: STAGED_UPLOADS_DIR,
};

async function diskFreeBytes(dir: string): Promise<number> {
  const fs = await statfs(dir);
  return Number(fs.bavail) * Number(fs.bsize);
}

function dirFor(store: UploadStore, id: string): string {
  if (!ID.test(id)) throw new UploadError("Upload not found", 404);
  return `${store.partialDir}/${id}`;
}

async function readMeta(store: UploadStore, id: string): Promise<Meta> {
  try {
    return JSON.parse(await readFile(`${dirFor(store, id)}/meta.json`, "utf8"));
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError("Upload not found", 404);
  }
}

async function receivedChunks(
  store: UploadStore,
  id: string,
): Promise<number[]> {
  const names = await readdir(`${dirFor(store, id)}/done`).catch(() => []);
  return names
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Remove partial uploads older than a day. Runs on each new upload rather
 *  than on a timer, so nothing happens at import time. */
async function pruneAbandoned(store: UploadStore): Promise<number> {
  const now = (store.now ?? Date.now)();
  const entries = await readdir(store.partialDir).catch(() => [] as string[]);
  let live = 0;
  for (const id of entries) {
    if (!ID.test(id)) continue;
    const dir = `${store.partialDir}/${id}`;
    // A directory without readable metadata is judged by its own age, so a
    // create that died halfway is still collected.
    const createdAt = await readMeta(store, id).then(
      (meta) => meta.createdAt,
      async () => (await stat(dir).catch(() => null))?.mtimeMs ?? 0,
    );
    if (now - createdAt > ABANDONED_AFTER_MS) {
      await rm(dir, { recursive: true, force: true });
    } else if (!(await exists(`${dir}/result.json`))) {
      live++;
    }
  }
  return live;
}

export async function createUpload(
  input: unknown,
  store: UploadStore = defaultStore,
): Promise<{ id: string; chunkSize: number; chunks: number }> {
  const body = (input ?? {}) as { name?: unknown; size?: unknown };
  const name = typeof body.name === "string" ? body.name.slice(0, 255) : "";
  const size = body.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1)
    throw new UploadError("Upload needs a file size");
  if (size > MAX_FILE_UPLOAD_BYTES)
    throw new UploadError(
      `File too large (max ${Math.floor(MAX_FILE_UPLOAD_BYTES / GIB)} GB)`,
      413,
    );
  await mkdir(store.partialDir, { recursive: true, mode: 0o700 });
  if ((await pruneAbandoned(store)) >= MAX_PARTIAL_UPLOADS)
    throw new UploadError("Too many uploads in progress. Try again soon.", 429);
  const free = await (store.freeBytes ?? diskFreeBytes)(store.partialDir);
  if (free - size < MIN_FREE_BYTES)
    throw new UploadError(
      "Not enough disk space on the server for this file",
      507,
    );
  const id = crypto.randomUUID();
  const dir = dirFor(store, id);
  const meta: Meta = {
    name: name || "file",
    size,
    chunkSize: UPLOAD_CHUNK_BYTES,
    chunks: Math.ceil(size / UPLOAD_CHUNK_BYTES),
    createdAt: (store.now ?? Date.now)(),
  };
  await mkdir(`${dir}/done`, { recursive: true, mode: 0o700 });
  // Sparse: chunks land at their own offsets, in whatever order they arrive.
  const data = await open(`${dir}/data`, "w", 0o600);
  try {
    await data.truncate(size);
  } finally {
    await data.close();
  }
  await writeFile(`${dir}/meta.json`, JSON.stringify(meta), { mode: 0o600 });
  return { id, chunkSize: meta.chunkSize, chunks: meta.chunks };
}

export async function uploadStatus(
  id: string,
  store: UploadStore = defaultStore,
): Promise<{
  id: string;
  name: string;
  size: number;
  chunkSize: number;
  chunks: number;
  received: number[];
}> {
  const meta = await readMeta(store, id);
  return {
    id,
    name: meta.name,
    size: meta.size,
    chunkSize: meta.chunkSize,
    chunks: meta.chunks,
    received: await receivedChunks(store, id),
  };
}

/** Write one chunk at its offset. `sha256` (hex), when sent, must match. */
export async function writeChunk(
  id: string,
  index: number,
  bytes: Uint8Array,
  sha256?: string | null,
  store: UploadStore = defaultStore,
): Promise<void> {
  const meta = await readMeta(store, id);
  if (!Number.isInteger(index) || index < 0 || index >= meta.chunks)
    throw new UploadError("Chunk index out of range");
  const offset = index * meta.chunkSize;
  const expected = Math.min(meta.chunkSize, meta.size - offset);
  if (bytes.byteLength !== expected)
    throw new UploadError(
      `Chunk ${index} has ${bytes.byteLength} bytes, expected ${expected}`,
    );
  if (sha256) {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256.toLowerCase())
      throw new UploadError(`Chunk ${index} checksum mismatch`, 422);
  }
  const dir = dirFor(store, id);
  const data = await open(`${dir}/data`, "r+").catch(() => {
    throw new UploadError("Upload not found", 404);
  });
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      const { bytesWritten } = await data.write(
        bytes,
        written,
        bytes.byteLength - written,
        offset + written,
      );
      written += bytesWritten;
    }
  } finally {
    await data.close();
  }
  await writeFile(`${dir}/done/${index}`, "", { mode: 0o600 });
}

/** Pick a name under `dir` that nothing holds yet, keeping the extension. */
async function freePath(dir: string, wanted: string): Promise<string> {
  const dot = wanted.lastIndexOf(".");
  for (let i = 0; ; i++) {
    const name =
      i === 0
        ? wanted
        : dot > 0
          ? `${wanted.slice(0, dot)}-${i}${wanted.slice(dot)}`
          : `${wanted}-${i}`;
    if (!(await exists(`${dir}/${name}`))) return `${dir}/${name}`;
  }
}

/** Finish an upload whose every chunk has arrived. Idempotent: completing
 *  twice returns the same path. */
export async function completeUpload(
  id: string,
  store: UploadStore = defaultStore,
): Promise<Result> {
  const dir = dirFor(store, id);
  const previous = await readFile(`${dir}/result.json`, "utf8").catch(
    () => null,
  );
  if (previous) return JSON.parse(previous) as Result;
  const meta = await readMeta(store, id);
  const received = new Set(await receivedChunks(store, id));
  const missing: number[] = [];
  for (let i = 0; i < meta.chunks && missing.length < 512; i++)
    if (!received.has(i)) missing.push(i);
  if (missing.length)
    throw new UploadError(
      `${missing.length} chunk(s) have not arrived`,
      409,
      missing,
    );
  await mkdir(store.stagedDir, { recursive: true });
  const path = await freePath(
    store.stagedDir,
    sanitizeAttachmentName(meta.name),
  );
  await rename(`${dir}/data`, path);
  const result: Result = { name: meta.name, path };
  // Kept (tiny) until the prune, so a retried complete gets the same answer.
  await writeFile(`${dir}/result.json`, JSON.stringify(result), {
    mode: 0o600,
  });
  await rm(`${dir}/done`, { recursive: true, force: true });
  return result;
}

export async function cancelUpload(
  id: string,
  store: UploadStore = defaultStore,
): Promise<void> {
  const dir = dirFor(store, id);
  if (await exists(`${dir}/result.json`)) return;
  await rm(dir, { recursive: true, force: true });
}
