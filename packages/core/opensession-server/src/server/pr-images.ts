/**
 * PR image attachments — stage local screenshots into durable uploads storage
 * and serve them from unguessable public URLs on the webhook server's public
 * origin, so GitHub's camo proxy can fetch them and they render inline in
 * PR/issue markdown everywhere — private repos included.
 *
 * Why this mechanism (empirical, measured against a private repo):
 * - GitHub's own attachment CDN (what the web UI uses — POST
 *   /upload/policies/assets) is a cookie-session form endpoint: it 422s under
 *   an API bearer token and has no documented API. Not usable for a bot.
 * - Committed blob `?raw=true` URLs on a private repo do NOT render inline in
 *   comments: GitHub leaves them un-proxied in body_html, but the browser's
 *   <img> subresource fetch is not the top-level navigation the
 *   cookie→signed-redirect dance needs — human-verified broken image icon on
 *   a private repo's PR (the click-through link works, the inline img 404s).
 * - raw.githubusercontent.com / release-asset URLs fail the same way or
 *   worse (raw.githubusercontent never sees github.com cookies at all).
 * - Tailnet-hosted media URLs get camo-rewritten but camo can't reach the
 *   tailnet — always broken (that's why the walkthrough mirror links media
 *   instead of inlining it).
 * - An image on a PUBLIC host renders everywhere: GitHub rewrites it to
 *   camo.githubusercontent.com, camo fetches it server-side and serves it
 *   from GitHub's CDN to anyone who can read the PR.
 *
 * Privacy model: third-party public hosts are banned for screenshots (PII
 * rule), but the webhook origin is your own infra — the same one that already
 * receives Slack/Plain/GitHub webhooks. URLs carry a 128-bit
 * random token (capability URL, like an unlisted share link); there is no
 * listing endpoint. Anyone with the URL (including GitHub's camo cache) can
 * fetch the image, so don't attach anything that must stay repo-member-only.
 *
 * The GET /pr-images/* route registers on the fail-closed public ingress
 * gateway — see prImagePublicRoutes(), wired in opensession.ts.
 * Webhook routes bind at boot: changes here need a real restart.
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { basename } from "path";
import { randomBytes } from "crypto";
import { UPLOADS_DIR } from "./uploads";
import { configuredIntegration, configuredServer } from "./config";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Camo historically caps proxied images around 5MB — stay under it. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Public origin the webhook server is reachable on (Caddy vhost). */
const PUBLIC_BASE =
  process.env.OPENSESSION_PR_IMAGES_BASE ||
  (typeof configuredIntegration("media").publicBaseUrl === "string"
    ? (configuredIntegration("media").publicBaseUrl as string)
    : configuredServer().publicBaseUrl);

const PR_IMAGES_DIR = `${UPLOADS_DIR}/pr-images`;
const HOME = process.env.HOME || "";

export interface PrImageInput {
  /** Absolute local path to the image (under /tmp or this process's home). */
  path: string;
  /** Alt/caption text for the rendered image. */
  alt?: string;
}

export interface UploadedPrImage {
  alt: string;
  /** Public unguessable URL — renders inline on GitHub via camo. */
  url: string;
  /** Staged absolute path on disk (durable uploads storage). */
  stagedPath: string;
}

function ext(p: string): string {
  return p.slice(p.lastIndexOf(".")).toLowerCase();
}

/** Same reachability rule as walkthrough media: absolute, no traversal, under
 *  the places agents can actually write. */
function readablePath(p: string): boolean {
  return (
    p.startsWith("/") &&
    !p.includes("..") &&
    (p.startsWith("/tmp/") || (!!HOME && p.startsWith(`${HOME}/`)))
  );
}

function safeName(localPath: string): string {
  const name = basename(localPath);
  const dot = name.lastIndexOf(".");
  const stem =
    (dot > 0 ? name.slice(0, dot) : name)
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image";
  return `${stem}${ext(name)}`;
}

/**
 * Stage images into per-token dirs under the uploads storage and return their
 * public URLs. Pure local work — no GitHub API involved, so it works for any
 * repo and never touches any git branch.
 */
export function uploadPrImages(images: PrImageInput[]): UploadedPrImage[] {
  if (!images.length) throw new Error("no images given");
  for (const img of images) {
    const p = (img.path || "").trim();
    if (!readablePath(p))
      throw new Error(
        `image path must be absolute under /tmp or ${HOME || "the service home"}: ${p}`,
      );
    if (!IMAGE_EXTS.has(ext(p)))
      throw new Error(
        `image must be one of ${[...IMAGE_EXTS].join(" ")}: ${p}`,
      );
    if (!existsSync(p)) throw new Error(`image file not found: ${p}`);
    if (statSync(p).size > MAX_IMAGE_BYTES)
      throw new Error(
        `image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB — GitHub's camo proxy won't serve bigger): ${p}`,
      );
  }
  return images.map((img) => {
    const token = randomBytes(16).toString("hex");
    const name = safeName(img.path.trim());
    const dir = `${PR_IMAGES_DIR}/${token}`;
    mkdirSync(dir, { recursive: true });
    copyFileSync(img.path.trim(), `${dir}/${name}`);
    return {
      alt: img.alt?.trim() || basename(img.path).replace(/\.[^.]+$/, ""),
      url: `${PUBLIC_BASE}/pr-images/${token}/${name}`,
      stagedPath: `${dir}/${name}`,
    };
  });
}

/** Markdown for one uploaded image. */
export function prImageMarkdown(img: UploadedPrImage): string {
  return `![${img.alt}](${img.url})`;
}

// Capability URLs are unlisted, not access-controlled: once one is posted on
// a PUBLIC repo, GitHub's camo proxy caches the image and anyone reading the
// thread sees it — equivalent to publishing the screenshot (PR #78 review
// P1). The registry can contain PUBLIC repos, and the instance credential
// can post to them, so callers MUST gate image
// comments on visibility. Fail-closed: unknown visibility refuses.
const repoVisibilityCache = new Map<string, boolean>();

/** True = private, false = public, null = could not determine (treat as
 *  public / refuse). Cached per ghRepo for the process lifetime. */
export async function repoIsPrivate(ghRepo: string): Promise<boolean | null> {
  const cached = repoVisibilityCache.get(ghRepo);
  if (cached !== undefined) return cached;
  const { botGhToken } = await import("./github-limit");
  const token = await botGhToken({ repo: ghRepo });
  if (!token) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${ghRepo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "opensession",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    if (typeof data?.private !== "boolean") return null;
    repoVisibilityCache.set(ghRepo, data.private);
    return data.private;
  } catch {
    return null;
  }
}

/**
 * Substitute `{{image:N}}` placeholders (1-based) in a markdown body with the
 * uploaded images; any images never referenced are appended at the end so
 * nothing silently vanishes.
 */
export function spliceImagesIntoMarkdown(
  markdown: string,
  uploaded: UploadedPrImage[],
): string {
  const used = new Set<number>();
  let body = markdown.replace(/\{\{\s*image:(\d+)\s*\}\}/gi, (m, n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx < 0 || idx >= uploaded.length) return m;
    used.add(idx);
    return prImageMarkdown(uploaded[idx]);
  });
  const rest = uploaded.filter((_, i) => !used.has(i));
  if (rest.length) {
    body = `${body.trimEnd()}\n\n${rest.map(prImageMarkdown).join("\n\n")}`;
  }
  return body;
}

const PUBLIC_PATH_RE =
  /^\/pr-images\/([a-f0-9]{32})\/([a-z0-9-_]+\.(?:png|jpe?g|gif|webp))$/;

/**
 * Public routes for the webhook server: serve a staged image by its
 * capability URL. Token + strictly-slugged filename only — no listing, no
 * traversal surface (the regex is the whole grammar). Immutable cache headers
 * so camo/CDNs hold on to it.
 */
export function prImagePublicRoutes(): Map<
  string,
  (req: Request, url: URL) => Promise<Response>
> {
  const routes = new Map<
    string,
    (req: Request, url: URL) => Promise<Response>
  >();
  routes.set("GET /pr-images/*", async (_req, url) => {
    const m = url.pathname.match(PUBLIC_PATH_RE);
    if (!m) return Response.json({ error: "Not found" }, { status: 404 });
    const path = `${PR_IMAGES_DIR}/${m[1]}/${m[2]}`;
    if (!existsSync(path))
      return Response.json({ error: "Not found" }, { status: 404 });
    return new Response(Bun.file(path), {
      headers: {
        "Content-Type": CONTENT_TYPES[ext(m[2])] || "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  return routes;
}
