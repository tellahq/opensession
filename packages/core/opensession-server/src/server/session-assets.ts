/**
 * Session assets. Local disk is the default backend; an optional S3-compatible
 * backend stores each asset as an object under <prefix>/<session-id>/<path>.
 * The public API stays backend-neutral and async. When remote storage is on,
 * legacy local files remain readable so enabling it never hides old assets,
 * while every new write goes directly to the object store.
 */

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, resolve } from "node:path";
import { configuredAssetStorage, type ResolvedAssetStorage } from "./config";
import { stateDir } from "./paths";
import { broadcastToSession } from "./ws-hub";

export const ASSETS_ROOT = stateDir("assets");

const ASSET_METADATA_FILE = ".opensession-assets.json";
const ASSET_METADATA_TEMP = `${ASSET_METADATA_FILE}.tmp`;
const DESCRIPTION_METADATA_KEY = "opensession-description";
const MAX_FILES = 2000;
const MAX_DEPTH = 12;
const LIST_CACHE_MS = 5_000;

/** MCP payload ceiling. The storage backend itself can hold larger objects. */
export const MAX_WRITE_BYTES = 4 * 1024 * 1024;

export interface SessionAssetFile {
  path: string;
  size: number;
  mtime: string;
  description?: string;
}

export interface SessionAssetContent extends SessionAssetFile {
  sessionId: string;
  data: Buffer;
  type: string;
}

export interface SessionAssetStream extends SessionAssetFile {
  sessionId: string;
  body: Blob | ReadableStream<Uint8Array>;
  type: string;
}

type AssetMetadata = Record<string, { description?: string }>;

type AssetStore = {
  kind: "local" | "s3";
  location(sessionId: string): string;
  write(
    sessionId: string,
    relPath: string,
    data: Buffer,
    description?: string,
  ): Promise<SessionAssetFile>;
  list(sessionId: string): Promise<SessionAssetFile[]>;
  open(sessionId: string, relPath: string): Promise<SessionAssetStream | null>;
  read(sessionId: string, relPath: string): Promise<SessionAssetContent | null>;
  delete(sessionId: string, relPath: string): Promise<boolean>;
};

function emptyAssetMetadata(): AssetMetadata {
  return Object.create(null) as AssetMetadata;
}

function safeSessionId(sessionId: string): string {
  const id = (sessionId || "").trim();
  if (!/^[\w.-]+$/.test(id) || id.includes(".."))
    throw new Error(`invalid session id: ${sessionId}`);
  return id;
}

/** Validate and normalize a path without assuming a storage backend. */
export function safeAssetPath(relPath: string): string {
  const raw = (relPath || "").trim().replace(/^\.\//, "");
  if (!raw) throw new Error("path is required");
  if (
    raw.startsWith("/") ||
    raw.includes("\\") ||
    raw.split("/").includes("..")
  )
    throw new Error(
      `path must be relative inside the assets folder (no leading /, no ..): ${relPath}`,
    );
  const rel = normalize(raw).replace(/\\/g, "/");
  if (rel === "." || rel.startsWith("../"))
    throw new Error(`path escapes the assets folder: ${relPath}`);
  if (rel === ASSET_METADATA_FILE || rel === ASSET_METADATA_TEMP)
    throw new Error(`path is reserved for asset metadata: ${relPath}`);
  return rel;
}

/** The legacy local directory. Kept for local mode and remote-mode fallback. */
export function assetsDirFor(sessionId: string): string {
  return join(ASSETS_ROOT, safeSessionId(sessionId));
}

export function resolveAssetPath(
  sessionId: string,
  relPath: string,
): { abs: string; rel: string } {
  const dir = assetsDirFor(sessionId);
  const rel = safeAssetPath(relPath);
  const abs = resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + "/"))
    throw new Error(`path escapes the assets folder: ${relPath}`);
  return { abs, rel };
}

/** Legacy local-path lookup retained while callers migrate to backend-neutral reads. */
export function findAssetPath(
  sessionIds: string[],
  relPath: string,
): { abs: string; rel: string; sessionId: string } | null {
  for (const sessionId of new Set(sessionIds)) {
    const candidate = resolveAssetPath(sessionId, relPath);
    if (existsSync(candidate.abs) && statSync(candidate.abs).isFile()) {
      return { ...candidate, sessionId };
    }
  }
  return null;
}

function readAssetMetadata(sessionId: string): AssetMetadata {
  try {
    const metadata = JSON.parse(
      readFileSync(join(assetsDirFor(sessionId), ASSET_METADATA_FILE), "utf8"),
    ) as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw new Error("metadata is not an object");
    return Object.assign(emptyAssetMetadata(), metadata) as AssetMetadata;
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyAssetMetadata();
    throw new Error(
      `Could not read asset descriptions: ${error?.message || error}`,
    );
  }
}

function writeAssetMetadata(sessionId: string, metadata: AssetMetadata): void {
  const path = join(assetsDirFor(sessionId), ASSET_METADATA_FILE);
  if (!Object.keys(metadata).length) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(assetsDirFor(sessionId), { recursive: true });
  const tempPath = join(assetsDirFor(sessionId), ASSET_METADATA_TEMP);
  writeFileSync(tempPath, JSON.stringify(metadata, null, 2));
  renameSync(tempPath, path);
}

class LocalAssetStore implements AssetStore {
  kind = "local" as const;

  location(sessionId: string): string {
    return assetsDirFor(sessionId);
  }

  async write(
    sessionId: string,
    relPath: string,
    data: Buffer,
    description?: string,
  ): Promise<SessionAssetFile> {
    const { abs, rel } = resolveAssetPath(sessionId, relPath);
    const metadata = readAssetMetadata(sessionId);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, data);
    if (description !== undefined) {
      const clean = description.trim().slice(0, 500);
      if (clean) metadata[rel] = { description: clean };
      else delete metadata[rel];
      writeAssetMetadata(sessionId, metadata);
    }
    const st = statSync(abs);
    return {
      path: rel,
      size: st.size,
      mtime: st.mtime.toISOString(),
      description: metadata[rel]?.description,
    };
  }

  async list(sessionId: string): Promise<SessionAssetFile[]> {
    const dir = assetsDirFor(sessionId);
    if (!existsSync(dir)) return [];
    const metadata = readAssetMetadata(sessionId);
    const out: SessionAssetFile[] = [];
    const walk = (d: string, prefix: string, depth: number) => {
      if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_FILES) return;
        if (
          !prefix &&
          (entry.name === ASSET_METADATA_FILE ||
            entry.name === ASSET_METADATA_TEMP)
        )
          continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(d, entry.name), rel, depth + 1);
        else if (entry.isFile()) {
          try {
            const st = statSync(join(d, entry.name));
            out.push({
              path: rel,
              size: st.size,
              mtime: st.mtime.toISOString(),
              description: metadata[rel]?.description,
            });
          } catch {}
        }
      }
    };
    walk(dir, "", 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async open(
    sessionId: string,
    relPath: string,
  ): Promise<SessionAssetStream | null> {
    const { abs, rel } = resolveAssetPath(sessionId, relPath);
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return {
      sessionId,
      path: rel,
      size: st.size,
      mtime: st.mtime.toISOString(),
      description: readAssetMetadata(sessionId)[rel]?.description,
      body: Bun.file(abs),
      type: assetMime(rel),
    };
  }

  async read(
    sessionId: string,
    relPath: string,
  ): Promise<SessionAssetContent | null> {
    const { abs, rel } = resolveAssetPath(sessionId, relPath);
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return {
      sessionId,
      path: rel,
      size: st.size,
      mtime: st.mtime.toISOString(),
      description: readAssetMetadata(sessionId)[rel]?.description,
      data: readFileSync(abs),
      type: assetMime(rel),
    };
  }

  async delete(sessionId: string, relPath: string): Promise<boolean> {
    const { abs, rel } = resolveAssetPath(sessionId, relPath);
    if (!existsSync(abs)) return false;
    rmSync(abs, { recursive: true, force: true });
    const metadata = readAssetMetadata(sessionId);
    for (const path of Object.keys(metadata)) {
      if (path === rel || path.startsWith(`${rel}/`)) delete metadata[path];
    }
    writeAssetMetadata(sessionId, metadata);
    return true;
  }
}

function encodeDescription(
  description: string | undefined,
): string | undefined {
  const clean = description?.trim().slice(0, 500);
  return clean ? encodeURIComponent(clean) : undefined;
}

function decodeDescription(
  metadata: Record<string, string> | undefined,
): string | undefined {
  const encoded = metadata?.[DESCRIPTION_METADATA_KEY];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function notFound(error: any): boolean {
  return (
    error?.name === "NoSuchKey" ||
    error?.name === "NotFound" ||
    error?.$metadata?.httpStatusCode === 404
  );
}

async function bodyBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  return Buffer.from(await new Response(body).arrayBuffer());
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await fn(items[index]!);
      }
    }),
  );
  return out;
}

type S3Sender = { send(command: any): Promise<any> };

export class S3AssetStore implements AssetStore {
  kind = "s3" as const;
  private listCache = new Map<
    string,
    { at: number; files: SessionAssetFile[] }
  >();

  constructor(
    private config: Extract<ResolvedAssetStorage, { provider: "s3" }>,
    private client: S3Sender = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
  ) {}

  private sessionPrefix(sessionId: string): string {
    return `${this.config.prefix}/${safeSessionId(sessionId)}/`;
  }

  private key(
    sessionId: string,
    relPath: string,
  ): { key: string; rel: string } {
    const rel = safeAssetPath(relPath);
    return { key: `${this.sessionPrefix(sessionId)}${rel}`, rel };
  }

  private invalidate(sessionId: string): void {
    this.listCache.delete(safeSessionId(sessionId));
  }

  location(sessionId: string): string {
    return `s3://${this.config.bucket}/${this.sessionPrefix(sessionId)}`;
  }

  async write(
    sessionId: string,
    relPath: string,
    data: Buffer,
    description?: string,
  ): Promise<SessionAssetFile> {
    const { key, rel } = this.key(sessionId, relPath);
    let keptDescription: string | undefined;
    if (description === undefined) {
      try {
        const head = await this.client.send(
          new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
        );
        keptDescription = decodeDescription(head.Metadata);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }
    const encoded = encodeDescription(description ?? keptDescription);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: data,
        ContentType: assetMime(rel),
        ...(encoded
          ? { Metadata: { [DESCRIPTION_METADATA_KEY]: encoded } }
          : {}),
      }),
    );
    this.invalidate(sessionId);
    return {
      path: rel,
      size: data.byteLength,
      mtime: new Date().toISOString(),
      description:
        description === undefined
          ? keptDescription
          : description.trim().slice(0, 500) || undefined,
    };
  }

  async list(sessionId: string): Promise<SessionAssetFile[]> {
    const id = safeSessionId(sessionId);
    const cached = this.listCache.get(id);
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.files;
    const prefix = this.sessionPrefix(id);
    const objects: Array<{ key: string; size: number; mtime: string }> = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(1000, MAX_FILES - objects.length),
          ...(continuationToken
            ? { ContinuationToken: continuationToken }
            : {}),
        }),
      );
      for (const object of page.Contents || []) {
        if (!object.Key || object.Key === prefix) continue;
        objects.push({
          key: object.Key,
          size: object.Size || 0,
          mtime: object.LastModified
            ? new Date(object.LastModified).toISOString()
            : new Date(0).toISOString(),
        });
        if (objects.length >= MAX_FILES) break;
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken && objects.length < MAX_FILES);

    const files = await mapLimited(objects, 12, async (object) => {
      let description: string | undefined;
      try {
        const head = await this.client.send(
          new HeadObjectCommand({
            Bucket: this.config.bucket,
            Key: object.key,
          }),
        );
        description = decodeDescription(head.Metadata);
      } catch {}
      return {
        path: object.key.slice(prefix.length),
        size: object.size,
        mtime: object.mtime,
        ...(description ? { description } : {}),
      };
    });
    files.sort((a, b) => a.path.localeCompare(b.path));
    this.listCache.set(id, { at: Date.now(), files });
    return files;
  }

  async open(
    sessionId: string,
    relPath: string,
  ): Promise<SessionAssetStream | null> {
    const { key, rel } = this.key(sessionId, relPath);
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      const body = object.Body?.transformToWebStream?.();
      if (!body) throw new Error(`S3 returned no body for ${rel}`);
      return {
        sessionId,
        path: rel,
        size: object.ContentLength ?? 0,
        mtime: object.LastModified
          ? new Date(object.LastModified).toISOString()
          : new Date(0).toISOString(),
        description: decodeDescription(object.Metadata),
        body,
        type: object.ContentType || assetMime(rel),
      };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async read(
    sessionId: string,
    relPath: string,
  ): Promise<SessionAssetContent | null> {
    const { key, rel } = this.key(sessionId, relPath);
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      const data = await bodyBuffer(object.Body);
      return {
        sessionId,
        path: rel,
        size: object.ContentLength ?? data.byteLength,
        mtime: object.LastModified
          ? new Date(object.LastModified).toISOString()
          : new Date(0).toISOString(),
        description: decodeDescription(object.Metadata),
        data,
        type: object.ContentType || assetMime(rel),
      };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async delete(sessionId: string, relPath: string): Promise<boolean> {
    const { key } = this.key(sessionId, relPath);
    const prefix = `${key}/`;
    const keys = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: key,
          ...(continuationToken
            ? { ContinuationToken: continuationToken }
            : {}),
        }),
      );
      for (const object of page.Contents || []) {
        if (object.Key === key || object.Key?.startsWith(prefix))
          keys.add(object.Key);
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
    if (!keys.size) return false;
    const all = [...keys];
    for (let index = 0; index < all.length; index += 1000) {
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: {
            Objects: all.slice(index, index + 1000).map((Key) => ({ Key })),
          },
        }),
      );
      if (result.Errors?.length) {
        throw new Error(
          `Could not delete ${result.Errors.length} asset object${result.Errors.length === 1 ? "" : "s"}`,
        );
      }
    }
    this.invalidate(sessionId);
    return true;
  }
}

const localStore = new LocalAssetStore();
let remoteStoreCache: { signature: string; store: S3AssetStore } | undefined;

function primaryStore(): AssetStore {
  const config = configuredAssetStorage();
  if (config.provider === "local") return localStore;
  const signature = JSON.stringify(config);
  if (remoteStoreCache?.signature !== signature) {
    remoteStoreCache = { signature, store: new S3AssetStore(config) };
  }
  return remoteStoreCache.store;
}

function storesForRead(): AssetStore[] {
  const primary = primaryStore();
  return primary.kind === "s3" ? [primary, localStore] : [primary];
}

export function assetStorageLocation(sessionId: string): string {
  return primaryStore().location(sessionId);
}

export async function writeAsset(
  sessionId: string,
  relPath: string,
  data: Buffer,
  description?: string,
): Promise<SessionAssetFile> {
  if (data.byteLength > MAX_WRITE_BYTES)
    throw new Error(
      `asset too large (${data.byteLength} bytes > ${MAX_WRITE_BYTES})`,
    );
  const file = await primaryStore().write(
    sessionId,
    relPath,
    data,
    description,
  );
  broadcastToSession(sessionId, { type: "assets_changed", sessionId });
  return file;
}

export async function listAssetsAcross(
  sessionIds: string[],
): Promise<SessionAssetFile[]> {
  const files = new Map<string, SessionAssetFile>();
  for (const sessionId of new Set(sessionIds)) {
    for (const store of storesForRead()) {
      for (const file of await store.list(sessionId)) {
        if (!files.has(file.path)) files.set(file.path, file);
        if (files.size >= MAX_FILES) break;
      }
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function openAssetAcross(
  sessionIds: string[],
  relPath: string,
): Promise<SessionAssetStream | null> {
  for (const sessionId of new Set(sessionIds)) {
    for (const store of storesForRead()) {
      const found = await store.open(sessionId, relPath);
      if (found) return found;
    }
  }
  return null;
}

export async function readAssetAcross(
  sessionIds: string[],
  relPath: string,
): Promise<SessionAssetContent | null> {
  for (const sessionId of new Set(sessionIds)) {
    for (const store of storesForRead()) {
      const found = await store.read(sessionId, relPath);
      if (found) return found;
    }
  }
  return null;
}

export async function deleteAssetAcross(
  sessionIds: string[],
  relPath: string,
): Promise<void> {
  const ids = [...new Set(sessionIds)];
  let deleted = false;
  for (const sessionId of ids) {
    for (const store of storesForRead()) {
      if (await store.delete(sessionId, relPath)) deleted = true;
    }
  }
  if (!deleted) throw new Error(`no such asset: ${relPath}`);
  for (const sessionId of ids) {
    broadcastToSession(sessionId, { type: "assets_changed", sessionId });
  }
}

/** Validate full read/write/delete access before a settings change is saved. */
export async function testS3AssetStorage(
  config: Extract<ResolvedAssetStorage, { provider: "s3" }>,
): Promise<void> {
  const store = new S3AssetStore(config);
  const sessionId = `.connection-test-${crypto.randomUUID()}`;
  const rel = "probe.txt";
  const description = "Open Session storage connection test";
  try {
    await store.write(sessionId, rel, Buffer.from("ok"), description);
    const found = await store.read(sessionId, rel);
    if (!found || found.data.toString("utf8") !== "ok")
      throw new Error("The test object could not be read back");
    if (found.description !== description)
      throw new Error("The test object metadata could not be read back");
  } finally {
    await store.delete(sessionId, rel).catch(() => false);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
};

export function assetMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}
