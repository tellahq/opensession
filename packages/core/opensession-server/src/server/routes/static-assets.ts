/**
 * Static app shell assets: icons, service worker, splash images, hashed SPA assets, PWA manifest.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { existsSync, statSync } from "fs";
import type { RouteContext } from "./context";
import {
  configuredIntegration,
  configuredRepos,
  productMark,
  productName,
} from "../config";
import {
  REPO_ROOT,
  frontend,
  frontendDistFile,
  frontendSourcePath,
  frontendStaticFile,
} from "../frontend-build";
import { trimIconMargin } from "../png-trim";
import { resolveRepoIcon } from "../repo-appearance";
import { organizationIconBytes } from "../organization-settings";

// Icons normalized for the tile, keyed by path and invalidated by mtime.
// Trimming decodes and re-encodes a PNG, which is silly to repeat for a file
// that hasn't changed since the last request.
const trimmedIcons = new Map<string, { mtimeMs: number; bytes: Uint8Array }>();

export function builtAssetContentType(name: string): string | null {
  if (name.endsWith(".css")) return "text/css";
  if (name.endsWith(".map")) return "application/json";
  if (name.endsWith(".js")) return "text/javascript";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".woff2")) return "font/woff2";
  return null;
}

// Per-prefix PWA identity keeps legacy /backstage installs distinct, while the
// shortcut still opens the new-agent flow in that same deployed shell.
export function pwaManifest(publicPrefix: string) {
  return {
    name: productName(),
    // The label under the icon once the web app is installed, where there is
    // room for about 12 characters before iOS and Android truncate it. That is
    // what the short mark is for; `name` keeps the full product name for the
    // install prompt and the app list.
    short_name: productMark(),
    start_url: `${publicPrefix}/`,
    display: "standalone",
    display_override: ["window-controls-overlay"],
    // A link into the app from outside it (a Plain card, a Slack message)
    // navigates the installed window to that link. Without this the default
    // is to focus the existing window and ignore the URL, so the deep link
    // silently lands on whatever was already open — and there is no history
    // entry behind it, so Back does nothing either.
    launch_handler: { client_mode: "navigate-existing" },
    // Match the current dark page and chrome surfaces. WebKit exposes the
    // manifest background if its standalone window is briefly letterboxed.
    background_color: "#1c1c1c",
    theme_color: "#222222",
    icons: [
      {
        src: `${publicPrefix}/icon-192.png?v=5`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${publicPrefix}/icon.png?v=5`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
    shortcuts: [
      {
        name: "Start an agent",
        url: `${publicPrefix}/new`,
        icons: [
          {
            src: `${publicPrefix}/icon-192.png?v=5`,
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
    ],
  };
}

/**
 * A tile icon that lives on disk, or undefined when the file isn't there.
 *
 * Served with its empty margin cropped off and no margin added back (see
 * png-trim.ts): icons come drawn to whatever proportions their author chose — a
 * GitHub avatar puts its mark on ~60% of its canvas, an app icon on 80% — while
 * a letter tile fills its square, so untouched art reads visibly smaller than
 * the tiles beside it.
 */
async function localIcon(
  iconPath: string,
  staticName?: string,
): Promise<Response | undefined> {
  const file = staticName
    ? frontendStaticFile(staticName, iconPath)
    : Bun.file(iconPath);
  if (!file || !(await file.exists())) return undefined;
  const mtimeMs = existsSync(iconPath) ? statSync(iconPath).mtimeMs : 0;
  const cacheKey = staticName ? `static:${staticName}` : iconPath;
  let entry = trimmedIcons.get(cacheKey);
  if (!entry || entry.mtimeMs !== mtimeMs) {
    const raw = new Uint8Array(await file.arrayBuffer());
    entry = { mtimeMs, bytes: trimIconMargin(raw) ?? raw };
    trimmedIcons.set(cacheKey, entry);
  }
  // A fresh view each time: a Response takes ownership of the buffer it is
  // handed, and this one is cached for the next request.
  return new Response(entry.bytes.slice().buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "image/png",
      // These are editable assets: a day-long hard cache pins a redrawn
      // icon on every client that already fetched it.
      "Cache-Control": "public, max-age=3600, must-revalidate",
    },
  });
}

export async function handleStaticAssetsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // App icons (approved native artwork, gen by scripts/gen-icons.py) — real PNGs so iOS home-screen and PWA installs
  // pick them up; data-URI apple-touch-icons don't work on iOS. Short cache
  // + must-revalidate so a refreshed design isn't pinned by a stale copy.
  const iconFiles: Record<string, { name: string; sourcePath?: string }> = {
    "/apple-touch-icon.png": { name: "apple-touch-icon.png" }, // 180×180
    "/icon-192.png": { name: "icon-192.png" },
    "/icon.png": { name: "icon.png" }, // 512×512
    "/mac-app-icon.png": {
      name: "mac-app-icon.png",
      sourcePath: `${REPO_ROOT}/packages/clients/mac/build/icon-512.png`,
    },
  };
  const iconAsset = iconFiles[path];
  if (iconAsset) {
    const file = frontendStaticFile(iconAsset.name, iconAsset.sourcePath);
    if (!file || !(await file.exists()))
      return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600, must-revalidate",
      },
    });
  }

  if (path === "/organization-icon.png" && req.method === "GET") {
    const bytes = organizationIconBytes();
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600, must-revalidate",
      },
    });
  }

  // The exact fixed light/dark artwork used behind opensession.com. Keep the
  // sign-in gate and onboarding independent of the marketing deployment and
  // public network. The old sign-in poster URLs remain aliases so a page still
  // running the previous bundle switches artwork immediately; its retired mp4
  // request simply falls back to this poster.
  const mediaFiles: Record<string, string> = {
    "/signin-bg.webp": "onboarding-bg.webp",
    "/signin-bg-dark.webp": "onboarding-bg-dark.webp",
    "/onboarding-bg.webp": "onboarding-bg.webp",
    "/onboarding-bg-dark.webp": "onboarding-bg-dark.webp",
    // DownloadAppsDialog's app-card previews. Referenced by URL (not bundler
    // imports) so both the Bun SPA build and the Next.js website build see a
    // plain string instead of diverging asset module types. The backgrounds are
    // the exact light and dark artwork used behind opensession.com's landing page.
    "/download-background.webp": "download-background.webp",
    "/download-background-dark.webp": "download-background-dark.webp",
    "/download-mac.webp": "download-mac.webp",
    "/download-phone.webp": "download-phone.webp",
  };
  if (mediaFiles[path] && req.method === "GET") {
    const file = frontendStaticFile(mediaFiles[path]);
    if (!file || !(await file.exists()))
      return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "Content-Type": path.endsWith(".mp4") ? "video/mp4" : "image/webp",
        "Cache-Control": "public, max-age=86400, must-revalidate",
      },
    });
  }

  // Per-repo icons for the RepoTile UI: a repo's configured `icon` PNG, and
  // nothing else. Anything without one 404s and the client paints its
  // colored letter tile instead.
  //
  // There used to be two fallbacks under that — the owner's local mark, then
  // the repo's GitHub org avatar. Both are marks for the OWNER, not the
  // repo, so every repo in one org wore the same tile: on this instance
  // seven of eight served identical bytes, which made the tile useless as a
  // way to tell repos apart and cost the phone's Inbox rows a whole second
  // line to spell the repo out. An icon is now opt-in per repo (`icon` in
  // the repo's config entry, absolute or relative to its checkout) and the
  // default is a color and a letter — the color assigned across the
  // registered set (see repo-tile-colors.ts) so no two of them match.
  //
  // Every icon served from src/frontend is drawn to the same proportions
  // (artwork on ~80% of a square canvas, corners rounded to match the tile's
  // own clip), because nothing downstream can normalize them: the tiles sit
  // side by side in the sidebar, in the phone app and in the PWA, and a mark
  // with more built-in padding than its neighbour just reads as a smaller
  // icon. Keep new icons on those proportions.
  const repoIcon = path.match(/^\/repo-icon\/([\w.-]+)\.png$/);
  if (repoIcon && req.method === "GET") {
    const id = repoIcon[1];
    // Feed bands (the feeds design) and the Plain project band ride the
    // same tile pipeline: any `<id>-icon.png` dropped in src/frontend
    // serves generically.
    if (/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(id)) {
      const generic = await localIcon(
        frontendSourcePath(`${id}-icon.png`),
        `${id}-icon.png`,
      );
      if (generic) return generic;
    }
    // A repo's optional `icon` — art someone chose for it, either a path in
    // its config or an avatar fetched into the state dir from Settings →
    // Setup. No icon, no tile art: the letter tile is the default.
    const repo = configuredRepos()[id];
    const configured = resolveRepoIcon(repo?.icon, repo?.repo);
    if (configured) {
      const served = await localIcon(configured);
      if (served) return served;
    }
    return new Response("Not found", { status: 404 });
  }

  // Service worker (Web Push + app-shell cache). Must precede the hashed-asset
  // matcher — sw.js is served from source, never cached hard (the browser
  // refetches it on its own schedule and applies updates).
  if (path === "/sw.js") {
    const file = frontendStaticFile("sw.js");
    if (!file || !(await file.exists()))
      return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        // Scope follows the prefix this registration lives under.
        "Service-Worker-Allowed": `${publicPrefix}/`,
      },
    });
  }

  // iOS PWA launch images (apple-touch-startup-image). One PNG per device
  // resolution, generated by scripts/gen-splash.py. Filename is locked to the
  // apple-splash-<w>-<h>.png pattern so the path can't escape the folder.
  const splashMatch = path.match(/^\/splash\/(apple-splash-\d+-\d+\.png)$/);
  if (splashMatch) {
    const file = frontendStaticFile(`splash/${splashMatch[1]}`);
    if (!file || !(await file.exists()))
      return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  // ghostty-web's WASM VT engine (the Shell tab's terminal). buildFrontend
  // copies it into FRONTEND_DIST; application/wasm keeps
  // WebAssembly.instantiateStreaming happy. Stable (unhashed) name — the
  // shell requests a fixed path — so revalidate instead of immutable.
  if (path === "/ghostty-vt.wasm") {
    const wasm = frontendDistFile("ghostty-vt.wasm");
    if (wasm && (await wasm.exists())) {
      return new Response(wasm, {
        headers: {
          "Content-Type": "application/wasm",
          "Cache-Control": "public, max-age=3600, must-revalidate",
        },
      });
    }
  }

  // Built SPA assets (prod only). Content-hashed filenames → cache forever.
  // JS/CSS/maps are gzipped (computed once, then memoised); images and fonts
  // already carry compact encodings and are served byte-for-byte.
  const assetMatch =
    frontend &&
    path.match(/^\/([\w.-]+\.(?:js|css|map|webp|png|jpe?g|svg|woff2))$/);
  if (assetMatch && frontend) {
    const name = assetMatch[1];
    const file = frontendDistFile(name);
    const type = builtAssetContentType(name);
    if (file && type && (await file.exists())) {
      const compress = /\.(?:js|css|map)$/.test(name);
      const headers: Record<string, string> = {
        "Content-Type": `${type}${compress ? "; charset=utf-8" : ""}`,
        "Cache-Control": "public, max-age=31536000, immutable",
      };
      if (
        compress &&
        (req.headers.get("accept-encoding") || "").includes("gzip")
      ) {
        let gz = frontend.gzip.get(name);
        if (!gz) {
          gz = new Blob([
            Bun.gzipSync(new Uint8Array(await file.arrayBuffer())),
          ]);
          frontend.gzip.set(name, gz);
        }
        headers["Content-Encoding"] = "gzip";
        headers["Vary"] = "Accept-Encoding";
        return new Response(gz, { headers });
      }
      return new Response(file, { headers });
    }
    // An absent content-hashed asset belongs to a retired bundle, not to the
    // client-side router. Returning the SPA document here turns the real 404
    // into a misleading strict-MIME error for dynamic imports.
    if (type)
      return new Response("Not found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
  }
  if (path === "/manifest.webmanifest") {
    return Response.json(pwaManifest(publicPrefix), {
      headers: { "Content-Type": "application/manifest+json" },
    });
  }

  // Universal links for the desktop app (packages/clients/mac): lets plain
  // https://<instance-host>/… links open the app once it's signed with the
  // associated-domains entitlement. Both spec locations, since Apple has
  // probed the bare path historically. Caveat: a private host (tailnet-only,
  // behind a VPN) can't be fetched by Apple's AASA CDN, so team devices need
  // the entitlement's `?mode=developer` alternate (direct fetch) for links to
  // activate; harmless for everyone else.
  if (
    path === "/.well-known/apple-app-site-association" ||
    path === "/apple-app-site-association"
  ) {
    const configuredIds = configuredIntegration("clients").appleAppIds;
    const appIDs = Array.isArray(configuredIds)
      ? configuredIds.filter((id): id is string => typeof id === "string")
      : [];
    return Response.json(
      {
        applinks: {
          apps: [],
          details: [
            {
              appIDs,
              components: [{ "/": "/*" }],
            },
          ],
        },
      },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  }

  return undefined;
}
