/**
 * Open Session for Mac auto-update feed + release artifact proxy.
 *
 * The Electron shell (packages/clients/mac/) auto-updates via Electron's built-in
 * Squirrel.Mac updater pointed at `GET /api/packages/clients/mac/update?version=<installed>`
 * using its static JSON feed mode. Releases are the signed + notarized arm64
 * zips that .github/workflows/os1-mac-release.yml publishes to the private
 * GitHub repo — which Squirrel's plain NSURLSession can't reach — so `GET
 * /api/packages/clients/mac/download/<tag>.zip` proxies the asset through the gh CLI,
 * disk-cached under ~/.opensession-os1-mac-updates/<tag>/.
 *
 * Both endpoints are exempt from the web-auth gate (opensession.ts fetch
 * preamble): Squirrel carries no cookies, and the origin is tailnet-only, so
 * like /api/health they're open by nature.
 *
 * The Chrome extension (packages/clients/chrome/) rides the same machinery: Chrome's
 * extension updater polls `GET /api/packages/clients/chrome/updates.xml` (Omaha/gupdate
 * format, the ExtensionInstallForcelist update URL) and installs the signed
 * .crx from `GET /api/packages/clients/chrome/download/<tag>.crx`, proxied from the
 * `os1-chrome-v*` GitHub releases that .github/workflows/os1-chrome-release.yml
 * publishes on every master push touching packages/clients/chrome/. Those releases are
 * marked prerelease ON PURPOSE: `releases/latest` (the os1-mac feed above)
 * ignores prereleases, so the two release streams can share the repo.
 */

import { stateDir } from "../paths";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { $ } from "bun";
import type { RouteContext } from "./context";
import { configuredIntegration, configuredServer } from "../config";

const updates = () => configuredIntegration("updates");
const releaseRepo = () =>
  typeof updates().releaseRepo === "string"
    ? (updates().releaseRepo as string)
    : "";
const CACHE_DIR = stateDir("os1-mac-updates");
const INSTALLER_CACHE_DIR = stateDir("os1-mac-installers");
const LATEST_TTL_MS = 5 * 60 * 1000;

// os1-chrome: stable extension ID derived from the signing key
// (~/.os1-chrome-key.pem on the VPS, OS1_CHROME_CRX_KEY secret in Actions;
// the matching public key is pinned in packages/clients/chrome/manifest.json "key").
const chromeExtensionId = () =>
  typeof updates().chromeExtensionId === "string"
    ? (updates().chromeExtensionId as string)
    : "";
const CHROME_TAG_PREFIX = "os1-chrome-v";
const CHROME_CACHE_DIR = stateDir("os1-chrome-updates");

interface LatestRelease {
  tag: string; // e.g. "v0.2.0"
  version: [number, number, number];
  notes: string;
  publishedAt: string;
  /** Release asset name, e.g. "OpenSession-0.2.0-arm64.zip". */
  asset: string;
  /** REST asset URL (api.github.com/…/releases/assets/<id>). */
  assetApiUrl: string;
  /** Signed + notarized disk image for a fresh install. */
  installer?: { asset: string; assetApiUrl: string };
}

const g = globalThis as {
  __os1UpdateLatest?: { at: number; value: LatestRelease | null };
  __os1ChromeLatest?: { at: number; value: LatestRelease | null };
  __os1UpdateDownloads?: Map<string, Promise<string | null>>;
};

/**
 * Is this release asset the signed arm64 app zip Squirrel installs from?
 *
 * `OpenSession-` is what os1-mac's electron-builder `artifactName` produces
 * since the app was renamed to Open Session. `OS1-` is what every release
 * before it produced, and it is still accepted: the feed reads whatever the
 * LATEST release happens to carry, so dropping the old spelling would stop
 * updates dead between this deploy and the next release. Nothing warns when
 * no asset matches, which is why this has a test.
 */
export function isMacReleaseAsset(name: string | undefined): boolean {
  return /^(OpenSession|OS1)-.*-arm64\.zip$/.test(name || "");
}

/** Signed disk image people install directly; the zip above is for Squirrel. */
export function isMacInstallerAsset(name: string | undefined): boolean {
  return /^(OpenSession|OS1)-.*-arm64\.dmg$/.test(name || "");
}

export function chromeDownloadTag(path: string): string | null {
  return (
    path.match(
      /^\/api\/(?:packages\/clients\/chrome|os1-chrome)\/download\/(os1-chrome-v[\w.-]+)\.crx$/,
    )?.[1] ?? null
  );
}

export function macDownloadTag(path: string): string | null {
  return (
    path.match(
      /^\/api\/(?:packages\/clients\/mac|os1-mac)\/download\/(v\d+\.\d+\.\d+[\w.-]*)\.zip$/,
    )?.[1] ?? null
  );
}

function parseVersion(v: string): [number, number, number] | null {
  const m = String(v)
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Latest published release (memory-cached) — null when none or gh failed. */
async function latestRelease(): Promise<LatestRelease | null> {
  const cached = g.__os1UpdateLatest;
  if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.value;
  let value: LatestRelease | null = null;
  try {
    // REST on purpose (not `gh release view`/`download`, which go through
    // GraphQL): the two API pools are metered separately, and pr-info's gh
    // traffic periodically exhausts GraphQL while core stays healthy.
    const repo = releaseRepo();
    if (!repo) return null;
    const raw = await $`gh api repos/${repo}/releases/latest`.quiet().text();
    const rel = JSON.parse(raw) as {
      tag_name?: string;
      body?: string;
      published_at?: string;
      assets?: { name?: string; url?: string }[];
    };
    const version = parseVersion(rel.tag_name || "");
    const assets = rel.assets || [];
    const asset = assets.find((candidate) =>
      isMacReleaseAsset(candidate?.name),
    );
    const installer = assets.find((candidate) =>
      isMacInstallerAsset(candidate?.name),
    );
    if (version && rel.tag_name && asset?.name && asset?.url) {
      value = {
        tag: rel.tag_name,
        version,
        notes: (rel.body || "").slice(0, 4000),
        publishedAt: rel.published_at || new Date().toISOString(),
        asset: asset.name,
        assetApiUrl: asset.url,
        ...(installer?.name && installer.url
          ? {
              installer: {
                asset: installer.name,
                assetApiUrl: installer.url,
              },
            }
          : {}),
      };
    }
  } catch (err) {
    const stderr =
      (err as { stderr?: { toString(): string } })?.stderr?.toString() ?? "";
    console.warn(
      `[os1-update] gh release view failed: ${err} ${stderr}`.trim(),
    );
    // Keep serving the stale value (if any) rather than flapping to 204.
    value = cached?.value ?? null;
  }
  g.__os1UpdateLatest = { at: Date.now(), value };
  return value;
}

/**
 * Latest published os1-chrome-v* prerelease (memory-cached). Listed (not
 * `releases/latest`, which excludes prereleases by design) and filtered by tag
 * prefix so the two release streams sharing this repo never cross.
 */
async function chromeLatestRelease(): Promise<LatestRelease | null> {
  const cached = g.__os1ChromeLatest;
  if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.value;
  let value: LatestRelease | null = null;
  try {
    const repo = releaseRepo();
    if (!repo) return null;
    const raw = await $`gh api repos/${repo}/releases?per_page=30`
      .quiet()
      .text();
    const rels = JSON.parse(raw) as {
      tag_name?: string;
      draft?: boolean;
      body?: string;
      published_at?: string;
      assets?: { name?: string; url?: string }[];
    }[];
    // The list is newest-first; take the first os1-chrome release with a
    // parseable version and a .crx asset.
    for (const rel of rels) {
      const tag = rel.tag_name || "";
      if (!tag.startsWith(CHROME_TAG_PREFIX) || rel.draft) continue;
      const version = parseVersion(tag.slice(CHROME_TAG_PREFIX.length - 1));
      const asset = (rel.assets || []).find((a) =>
        /\.crx$/.test(a?.name || ""),
      );
      if (!version || !asset?.name || !asset?.url) continue;
      value = {
        tag,
        version,
        notes: (rel.body || "").slice(0, 4000),
        publishedAt: rel.published_at || new Date().toISOString(),
        asset: asset.name,
        assetApiUrl: asset.url,
      };
      break;
    }
  } catch (err) {
    const stderr =
      (err as { stderr?: { toString(): string } })?.stderr?.toString() ?? "";
    console.warn(
      `[os1-update] chrome release list failed: ${err} ${stderr}`.trim(),
    );
    value = cached?.value ?? null;
  }
  g.__os1ChromeLatest = { at: Date.now(), value };
  return value;
}

/**
 * Fetch the release asset into the disk cache (once — concurrent requests share
 * one download) and return its path, or null on failure.
 */
async function cachedAssetPath(
  rel: LatestRelease,
  cacheDir: string = CACHE_DIR,
): Promise<string | null> {
  const dir = `${cacheDir}/${rel.tag}`;
  const file = `${dir}/${rel.asset}`;
  if (existsSync(file)) return file;
  const downloads = (g.__os1UpdateDownloads ??= new Map());
  const inflightKey = `${cacheDir}:${rel.tag}`;
  let inflight = downloads.get(inflightKey);
  if (!inflight) {
    inflight = (async () => {
      // Download to a temp dir then move into place so a crashed/partial
      // download never gets served.
      const tmp = `${cacheDir}/.tmp-${rel.tag}-${Date.now()}`;
      try {
        mkdirSync(tmp, { recursive: true });
        await $`gh api ${rel.assetApiUrl} -H "Accept: application/octet-stream" > ${tmp}/${rel.asset}`.quiet();
        mkdirSync(cacheDir, { recursive: true });
        rmSync(dir, { recursive: true, force: true });
        await $`mv ${tmp} ${dir}`.quiet();
        // Drop caches of older tags — only the latest is ever served.
        for (const entry of readdirSync(cacheDir)) {
          if (entry !== rel.tag)
            rmSync(`${cacheDir}/${entry}`, { recursive: true, force: true });
        }
        return existsSync(file) ? file : null;
      } catch (err) {
        // Transient failures (e.g. GitHub rate-limit exhaustion) are fine:
        // the updater retries on its next check. Just don't leave debris.
        const stderr =
          (err as { stderr?: { toString(): string } })?.stderr?.toString() ??
          "";
        console.warn(
          `[os1-update] release download failed: ${err} ${stderr}`.trim(),
        );
        rmSync(tmp, { recursive: true, force: true });
        return null;
      } finally {
        downloads.delete(inflightKey);
      }
    })();
    downloads.set(inflightKey, inflight);
  }
  return inflight;
}

export async function handleOs1UpdateRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;
  if (
    !path.startsWith("/api/packages/clients/mac/") &&
    !path.startsWith("/api/packages/clients/chrome/") &&
    !path.startsWith("/api/os1-mac/") &&
    !path.startsWith("/api/os1-chrome/")
  )
    return undefined;
  if (req.method !== "GET") return undefined;

  // Omaha/gupdate feed Chrome's extension updater polls (also the update URL
  // in ExtensionInstallForcelist). "noupdate" when no release exists yet.
  if (
    path === "/api/packages/clients/chrome/updates.xml" ||
    path === "/api/os1-chrome/updates.xml"
  ) {
    const rel = await chromeLatestRelease();
    const base = configuredServer().publicBaseUrl.replace(/\/$/, "");
    const app = rel
      ? `<app appid='${chromeExtensionId()}'><updatecheck codebase='${base}/api/packages/clients/chrome/download/${rel.tag}.crx' version='${rel.version.join(".")}'/></app>`
      : `<app appid='${chromeExtensionId()}'><updatecheck status='noupdate'/></app>`;
    return new Response(
      `<?xml version='1.0' encoding='UTF-8'?>\n<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>${app}</gupdate>\n`,
      {
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      },
    );
  }

  // The signed .crx Chrome installs from.
  const crxTag = chromeDownloadTag(path);
  if (crxTag) {
    const rel = await chromeLatestRelease();
    if (!rel || rel.tag !== crxTag) {
      return Response.json({ error: "Unknown release" }, { status: 404 });
    }
    const file = await cachedAssetPath(rel, CHROME_CACHE_DIR);
    if (!file) {
      return Response.json(
        { error: "Release asset unavailable" },
        { status: 502 },
      );
    }
    return new Response(Bun.file(file), {
      headers: {
        "Content-Type": "application/x-chrome-extension",
        "Content-Disposition": `attachment; filename="${rel.asset}"`,
        "Cache-Control": "no-cache",
      },
    });
  }

  // Squirrel.Mac static JSON feed. Squirrel compares currentRelease with the
  // app version itself; unlike the dynamic server mode, this mode cannot use a
  // 204 response to signal that the app is current.
  if (
    path === "/api/packages/clients/mac/update" ||
    path === "/api/os1-mac/update"
  ) {
    const current = parseVersion(url.searchParams.get("version") || "");
    const rel = await latestRelease();
    if (!rel) {
      const currentRelease = current?.join(".") || "0.0.0";
      return Response.json({ currentRelease, releases: [] });
    }
    // Canonical public form is prefix-less (the instance root); it
    // normalizes back onto /api/* in the fetch preamble.
    const base = configuredServer().publicBaseUrl.replace(/\/$/, "");
    return Response.json({
      currentRelease: rel.version.join("."),
      releases: [
        {
          version: rel.version.join("."),
          updateTo: {
            version: rel.version.join("."),
            url: `${base}/api/packages/clients/mac/download/${rel.tag}.zip`,
            name: rel.tag,
            notes: rel.notes,
            pub_date: rel.publishedAt,
          },
        },
      ],
    });
  }

  // The signed disk image used by the Download apps dialog. Keep it on a
  // stable URL so the frontend never needs to know the current release tag.
  if (
    path === "/api/packages/clients/mac/download/latest.dmg" ||
    path === "/api/os1-mac/download/latest.dmg"
  ) {
    const rel = await latestRelease();
    if (!rel?.installer) {
      return Response.json(
        { error: "Release installer unavailable" },
        { status: 404 },
      );
    }
    const installerRelease: LatestRelease = {
      ...rel,
      asset: rel.installer.asset,
      assetApiUrl: rel.installer.assetApiUrl,
    };
    const file = await cachedAssetPath(installerRelease, INSTALLER_CACHE_DIR);
    if (!file) {
      return Response.json(
        { error: "Release installer unavailable" },
        { status: 502 },
      );
    }
    return new Response(Bun.file(file), {
      headers: {
        "Content-Type": "application/x-apple-diskimage",
        "Content-Disposition": `attachment; filename="${rel.installer.asset}"`,
        "Cache-Control": "no-cache",
      },
    });
  }

  // The signed app zip Squirrel installs from.
  const macTag = macDownloadTag(path);
  if (macTag) {
    const rel = await latestRelease();
    if (!rel || rel.tag !== macTag) {
      return Response.json({ error: "Unknown release" }, { status: 404 });
    }
    const file = await cachedAssetPath(rel);
    if (!file) {
      return Response.json(
        { error: "Release asset unavailable" },
        { status: 502 },
      );
    }
    return new Response(Bun.file(file), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${rel.asset}"`,
        "Cache-Control": "no-cache",
      },
    });
  }

  return undefined;
}
