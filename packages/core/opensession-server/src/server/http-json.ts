import { createHash } from "crypto";

interface JsonSnapshot {
  version: string | number;
  text: string;
  hash: string;
  gzip?: Promise<Blob>;
}

const snapshots = new Map<string, JsonSnapshot>();

export interface ConditionalJsonOptions {
  /** Reuse serialization and compression until this version changes. */
  cache?: { key: string; version: string | number };
}

function serialize(value: unknown): JsonSnapshot {
  const text = JSON.stringify(value);
  return {
    version: 0,
    text,
    hash: createHash("sha256").update(text).digest("base64url").slice(0, 20),
  };
}

function snapshot(
  value: unknown,
  cache?: ConditionalJsonOptions["cache"],
): JsonSnapshot {
  if (!cache) return serialize(value);
  const existing = snapshots.get(cache.key);
  if (existing?.version === cache.version) return existing;
  const next = { ...serialize(value), version: cache.version };
  snapshots.set(cache.key, next);
  return next;
}

/**
 * JSON for list-like GET routes. The browser revalidates with ETag, large
 * answers travel compressed, and stable snapshots avoid serializing the same
 * data for every poll.
 */
export async function conditionalJsonResponse(
  req: Request,
  value: unknown,
  options: ConditionalJsonOptions = {},
): Promise<Response> {
  const body = snapshot(value, options.cache);
  const gzip = /(?:^|,)\s*gzip(?:\s*;|\s*,|\s*$)/i.test(
    req.headers.get("Accept-Encoding") || "",
  );
  const etag = `"${body.hash}${gzip ? "-gzip" : ""}"`;
  const headers = new Headers({
    "Cache-Control": "private, no-cache",
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag,
    Vary: "Accept-Encoding",
  });
  if (gzip) headers.set("Content-Encoding", "gzip");
  if (req.headers.get("If-None-Match") === etag)
    return new Response(null, { status: 304, headers });
  if (!gzip) return new Response(body.text, { headers });
  body.gzip ??= new Response(
    new Blob([body.text]).stream().pipeThrough(new CompressionStream("gzip")),
  ).blob();
  return new Response(await body.gzip, { headers });
}
