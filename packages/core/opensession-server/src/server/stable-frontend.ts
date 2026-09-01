import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "./shared/atomic-write";

export type StableFrontendSnapshot = {
  releaseRoot: string;
  fallbackRoots: string[];
  version: string;
  indexHtml: string;
  publishedAt: string;
};

export type StableFrontendResponder = (request: Buffer) => Buffer | null;

export function stableFrontendSnapshotPath(deployState: string): string {
  return join(deployState, "stable-frontend.json");
}

const MAX_FALLBACK_ROOTS = 3;

function validReleaseRoot(
  deployState: string,
  candidate: string,
): string | null {
  const releases = resolve(deployState, "releases");
  const root = resolve(candidate);
  if (
    !root.startsWith(`${releases}${sep}`) ||
    !existsSync(join(root, ".opensession-release"))
  )
    return null;
  return root;
}

export function publishStableFrontendSnapshot(
  deployState: string,
  snapshot: Omit<StableFrontendSnapshot, "publishedAt" | "fallbackRoots"> & {
    fallbackRoots?: string[];
  },
): StableFrontendSnapshot {
  const previous = parseSnapshot(deployState);
  const fallbackRoots = [
    ...(snapshot.fallbackRoots ?? []),
    ...(previous ? [previous.releaseRoot, ...previous.fallbackRoots] : []),
  ]
    .map((candidate) => validReleaseRoot(deployState, candidate))
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter(
      (root, index, roots) =>
        root !== resolve(snapshot.releaseRoot) && roots.indexOf(root) === index,
    )
    .slice(0, MAX_FALLBACK_ROOTS);
  const published: StableFrontendSnapshot = {
    ...snapshot,
    fallbackRoots,
    publishedAt: new Date().toISOString(),
  };
  writeFileAtomic(
    stableFrontendSnapshotPath(deployState),
    `${JSON.stringify(published)}\n`,
    0o600,
  );
  return published;
}

function parseSnapshot(deployState: string): StableFrontendSnapshot | null {
  try {
    const value = JSON.parse(
      readFileSync(stableFrontendSnapshotPath(deployState), "utf8"),
    ) as Partial<StableFrontendSnapshot>;
    if (
      typeof value.releaseRoot !== "string" ||
      typeof value.version !== "string" ||
      typeof value.indexHtml !== "string" ||
      typeof value.publishedAt !== "string"
    )
      return null;
    const root = validReleaseRoot(deployState, value.releaseRoot);
    if (!root) return null;
    const fallbackRoots = Array.isArray(value.fallbackRoots)
      ? value.fallbackRoots
          .filter(
            (candidate): candidate is string => typeof candidate === "string",
          )
          .map((candidate) => validReleaseRoot(deployState, candidate))
          .filter((candidate): candidate is string => Boolean(candidate))
          .filter(
            (candidate, index, roots) =>
              candidate !== root && roots.indexOf(candidate) === index,
          )
          .slice(0, MAX_FALLBACK_ROOTS)
      : [];
    return {
      ...value,
      releaseRoot: root,
      fallbackRoots,
    } as StableFrontendSnapshot;
  } catch {
    return null;
  }
}

const MIME_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  wasm: "application/wasm",
  woff2: "font/woff2",
};

function response(
  status: string,
  body: Buffer,
  headers: Record<string, string>,
  head: boolean,
  contentLength = body.byteLength,
): Buffer {
  const lines = [
    `HTTP/1.1 ${status}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${contentLength}`,
    "Connection: close",
    "",
    "",
  ];
  const headBytes = Buffer.from(lines.join("\r\n"));
  return head ? headBytes : Buffer.concat([headBytes, body]);
}

function parsedRequest(request: Buffer): {
  method: "GET" | "HEAD";
  pathname: string;
  acceptsHtml: boolean;
  socialCrawler: boolean;
} | null {
  if (request.byteLength > 64 * 1024) return null;
  const text = request.toString("latin1");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const lines = text.slice(0, headerEnd).split("\r\n");
  const match = /^(GET|HEAD) ([^ ]+) HTTP\/1\.[01]$/.exec(lines[0] || "");
  if (!match) return null;
  let pathname: string;
  try {
    pathname = new URL(match[2], "http://localhost").pathname;
  } catch {
    return null;
  }
  const accept =
    lines
      .find((line) => /^accept:/i.test(line))
      ?.slice(7)
      .trim() || "";
  const userAgent =
    lines
      .find((line) => /^user-agent:/i.test(line))
      ?.slice(11)
      .trim() || "";
  return {
    method: match[1] as "GET" | "HEAD",
    pathname,
    acceptsHtml: accept.includes("text/html") || accept.includes("*/*"),
    socialCrawler:
      /bot|crawler|spider|slackbot|facebookexternalhit|twitterbot|linkedinbot/i.test(
        userAgent,
      ),
  };
}

const BACKEND_PATH_PREFIXES = [
  "/api/",
  "/ws",
  "/media",
  "/rpc",
  "/run-ws",
  "/rpc-ws",
  "/d/",
];

/**
 * Build the stable shell's hot-path responder. Snapshot parsing is rate-limited
 * and immutable assets are held in a bounded LRU, so a reload burst during a
 * gateway handoff cannot turn synchronous filesystem work into an ingress
 * outage. Snapshot publication remains visible within `snapshotTtlMs`.
 */
export function createStableFrontendResponder(
  deployState: string,
  options: {
    snapshotTtlMs?: number;
    maxAssetCacheBytes?: number;
    maxCachedAssetBytes?: number;
    liveStatus?: () => Record<string, unknown>;
  } = {},
): StableFrontendResponder {
  const snapshotTtlMs = options.snapshotTtlMs ?? 250;
  const maxAssetCacheBytes = options.maxAssetCacheBytes ?? 64 * 1024 * 1024;
  const maxCachedAssetBytes = options.maxCachedAssetBytes ?? 8 * 1024 * 1024;
  let checkedAt = 0;
  let snapshot: StableFrontendSnapshot | null = null;
  let indexBody = Buffer.alloc(0);
  let assetBytes = 0;
  const assets = new Map<string, Buffer>();

  const currentSnapshot = (): StableFrontendSnapshot | null => {
    const now = Date.now();
    if (now - checkedAt < snapshotTtlMs) return snapshot;
    checkedAt = now;
    const next = parseSnapshot(deployState);
    if (
      next?.releaseRoot !== snapshot?.releaseRoot ||
      next?.version !== snapshot?.version ||
      next?.indexHtml !== snapshot?.indexHtml ||
      next?.fallbackRoots.join("\n") !== snapshot?.fallbackRoots.join("\n")
    ) {
      snapshot = next;
      indexBody = next ? Buffer.from(next.indexHtml) : Buffer.alloc(0);
      assets.clear();
      assetBytes = 0;
    } else {
      snapshot = next;
    }
    return snapshot;
  };

  const cachedAsset = (path: string, length: number): Buffer => {
    const cached = assets.get(path);
    if (cached) {
      assets.delete(path);
      assets.set(path, cached);
      return cached;
    }
    const body = readFileSync(path);
    if (length <= maxCachedAssetBytes && length <= maxAssetCacheBytes) {
      while (assetBytes + length > maxAssetCacheBytes && assets.size > 0) {
        const oldest = assets.entries().next().value as
          | [string, Buffer]
          | undefined;
        if (!oldest) break;
        assets.delete(oldest[0]);
        assetBytes -= oldest[1].byteLength;
      }
      assets.set(path, body);
      assetBytes += body.byteLength;
    }
    return body;
  };

  return (request: Buffer): Buffer | null => {
    const parsed = parsedRequest(request);
    if (!parsed) return null;
    const head = parsed.method === "HEAD";
    if (parsed.pathname === "/live") {
      let status: Record<string, unknown> = {};
      try {
        status = options.liveStatus?.() ?? {};
      } catch (error) {
        console.error(
          "[stable-frontend] could not collect ingress status",
          error,
        );
      }
      return response(
        "200 OK",
        Buffer.from(
          `${JSON.stringify({
            ok: true,
            phase: "handoff",
            backendReady: false,
            ...status,
          })}\n`,
        ),
        {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
        head,
      );
    }
    if (
      parsed.pathname === "/ready" ||
      parsed.pathname === "/api" ||
      BACKEND_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))
    )
      return null;

    const selected = currentSnapshot();
    if (!selected) return null;
    const name = parsed.pathname.slice(1);
    if (name && basename(name) === name) {
      for (const root of [selected.releaseRoot, ...selected.fallbackRoots]) {
        const asset = join(root, ".frontend-dist", name);
        try {
          const stat = statSync(asset);
          if (stat.isFile()) {
            const extension = name.includes(".")
              ? name.slice(name.lastIndexOf(".") + 1)
              : "";
            return response(
              "200 OK",
              head ? Buffer.alloc(0) : cachedAsset(asset, stat.size),
              {
                "Content-Type":
                  MIME_TYPES[extension] || "application/octet-stream",
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
              },
              head,
              stat.size,
            );
          }
        } catch {}
      }
    }
    if (
      !parsed.acceptsHtml ||
      parsed.socialCrawler ||
      /\.[a-z0-9]{1,8}$/i.test(parsed.pathname)
    )
      return null;
    return response(
      "200 OK",
      indexBody,
      {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      },
      head,
    );
  };
}

const responders = new Map<string, StableFrontendResponder>();

/**
 * Serve only immutable frontend assets, the SPA document, and liveness while a
 * gateway child is unavailable. API and mutation traffic remains parked for
 * the generation-checked backend; the stable ingress never impersonates it.
 */
export function stableFrontendHttpResponse(
  deployState: string,
  request: Buffer,
): Buffer | null {
  let responder = responders.get(deployState);
  if (!responder) {
    responder = createStableFrontendResponder(deployState);
    responders.set(deployState, responder);
  }
  return responder(request);
}
