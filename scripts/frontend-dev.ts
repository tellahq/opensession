/**
 * Frontend-only dev server: serves THIS worktree's SPA (Bun's HTML-import dev
 * pipeline — edits picked up on refresh) while proxying every API call and the
 * UI WebSocket to the production backend, so the UI runs against live data
 * without running a local backend or syncing state files.
 *
 *   bun scripts/frontend-dev.ts          # http://127.0.0.1:3851
 *   OS1_LOGIN=<github-login> ...         # whose identity to use
 *   OS1_UPSTREAM=https://... ...         # backend (default local :3850)
 *
 * Auth: production requires the GitHub-sign-in session. The proxy attaches
 * YOUR web-session Bearer token (the same tokens curl/CDP callers use — see
 * web-auth.ts) to upstream requests server-side; it never reaches the browser.
 * The token is cached at ~/.opensession-frontend-dev-token.json (0600) and
 * validated against /api/auth/status at startup; only when missing/expired is
 * a fresh one fetched from the server over SSH. Sliding 90d expiry + the
 * proxy's own traffic keep the cached token alive indefinitely in practice.
 *
 * ⚠️  Writes are real: prompts, steers, archives etc. hit production. This is
 * a live frontend against the live backend — treat clicks accordingly.
 *
 * HMR invariants (Bun dev pipeline):
 * - Component modules must export ONLY React components — one stray helper
 *   export (a hook/util/const) disqualifies the module from Fast Refresh and
 *   silently downgrades every edit of it to a full page reload (all session
 *   data refetched). Put shared helpers in src/frontend/lib/ instead.
 * - CSS hot-swaps land in document.adoptedStyleSheets (not the original
 *   <link>) — check computed styles, not styleSheets, when verifying.
 * - Big working-tree churn (rebase/checkout) can leave the watcher serving a
 *   stale build with no error — restart this server after git surgery.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  compileAssets,
  FRONTEND_DIST,
  FRONTEND_SRC,
  renderIndexHtml,
} from "../packages/core/opensession-server/src/server/frontend-build";

const UPSTREAM = process.env.OS1_UPSTREAM || "http://127.0.0.1:3850";
const WS_UPSTREAM = UPSTREAM.replace(/^http/, "ws") + "/ws";
const LOGIN = process.env.OS1_LOGIN || process.env.USER || "developer";
const SSH_HOST = process.env.OS1_SSH_HOST || "";
const PORT = Number(process.env.PORT || 3851);
const TOKEN_CACHE = (() => {
  const home = homedir();
  const current = join(home, ".opensession", "frontend-dev-token.json");
  const legacy = join(home, ".opensession-frontend-dev-token.json");
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
})();

async function tokenValid(candidate: string): Promise<boolean> {
  try {
    const res = await fetch(`${UPSTREAM}/api/auth/status`, {
      headers: { authorization: `Bearer ${candidate}` },
    });
    return res.ok && (await res.json()).authenticated === true;
  } catch {
    return false;
  }
}

async function loadToken(): Promise<string> {
  if (process.env.OS1_TOKEN) return process.env.OS1_TOKEN;
  if (!SSH_HOST && UPSTREAM.startsWith("http://127.0.0.1")) return "";
  try {
    const cached = JSON.parse(readFileSync(TOKEN_CACHE, "utf8"));
    if (
      cached.login === LOGIN &&
      cached.upstream === UPSTREAM &&
      (await tokenValid(cached.token))
    ) {
      return cached.token;
    }
  } catch {}
  const fresh = fetchTokenViaSsh();
  mkdirSync(dirname(TOKEN_CACHE), { recursive: true });
  writeFileSync(
    TOKEN_CACHE,
    JSON.stringify({
      login: LOGIN,
      upstream: UPSTREAM,
      token: fresh,
      fetchedAt: Date.now(),
    }),
    { mode: 0o600 },
  );
  return fresh;
}

function fetchTokenViaSsh(): string {
  if (!SSH_HOST)
    throw new Error(
      "Set OS1_SSH_HOST or OS1_TOKEN for an authenticated upstream",
    );
  const proc = Bun.spawnSync([
    "ssh",
    "-o",
    "BatchMode=yes",
    SSH_HOST,
    "cat ~/.opensession/web-sessions.json 2>/dev/null || cat ~/.opensession-web-sessions.json",
  ]);
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    throw new Error(
      `ssh ${SSH_HOST} failed — token fetch requires SSH access to the server`,
    );
  }
  const rows: { token: string; login: string; lastSeenAt: number }[] =
    JSON.parse(proc.stdout.toString()).sessions;
  const mine = rows
    .filter((s) => s.login === LOGIN)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  if (!mine) {
    throw new Error(
      `no web session for login "${LOGIN}" on the server — sign in at ${UPSTREAM} once, or set OS1_LOGIN`,
    );
  }
  return mine.token;
}

const token = await loadToken();
console.log(`Proxying as ${LOGIN} → ${UPSTREAM}`);

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.delete("host");
  headers.delete("cookie");
  const res = await fetch(UPSTREAM + url.pathname + url.search, {
    method: req.method,
    headers,
    body: req.body,
    redirect: "manual",
    // @ts-expect-error streaming request bodies need half-duplex
    duplex: "half",
  });
  // fetch already decompressed the body; re-advertising the encoding would
  // corrupt the response.
  const h = new Headers(res.headers);
  h.delete("content-encoding");
  h.delete("content-length");
  return new Response(res.body, { status: res.status, headers: h });
}

type Bridge = { up: WebSocket; buf: (string | Uint8Array)[] | null };

const spaRoutes = [
  "/",
  "/index.html",
  "/new",
  "/session/*",
  "/automations",
  "/security",
  "/goals",
  "/connections",
  "/settings",
  "/archived",
  "/catchup",
  "/reviews",
  "/reviews/*",
  "/support/*",
];
const proxied = [
  "/api/*",
  "/uploads/*",
  "/backstage/*",
  "/opensession/*",
  "/icon.png",
  "/icon-192.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  "/sw.js",
  "/splash/*",
];

const DEV_REFRESH = `<script>
(() => {
  let version = null;
  setInterval(async () => {
    try {
      const next = await (await fetch("/__version", { cache: "no-store" })).text();
      if (version !== null && next !== version) location.reload();
      version = next;
    } catch {}
  }, 1000);
})();
</script>`;

let meta = await compileAssets();
let shellHtml = renderIndexHtml(meta).replace(
  "</head>",
  `${DEV_REFRESH}\n</head>`,
);
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
let rebuilding: Promise<void> | null = null;
watch(FRONTEND_SRC, { recursive: true }, (_event, file) => {
  if (!file || !/\.(tsx?|css|html)$/.test(file.toString())) return;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    if (rebuilding) return;
    rebuilding = (async () => {
      try {
        const next = await compileAssets();
        meta = next;
        shellHtml = renderIndexHtml(next).replace(
          "</head>",
          `${DEV_REFRESH}\n</head>`,
        );
        console.log(`[frontend] rebuilt ${file}`);
      } catch (error) {
        console.error("[frontend] rebuild failed", error);
      } finally {
        rebuilding = null;
      }
    })();
  }, 200);
});

function shell(): Response {
  return new Response(shellHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const server = Bun.serve<Bridge>({
  port: PORT,
  development: false,
  idleTimeout: 240,
  routes: {
    "/__version": () => new Response(`${meta.entryName}|${meta.sxName}`),
    ...Object.fromEntries(spaRoutes.map((p) => [p, shell])),
    ...Object.fromEntries(proxied.map((p) => [p, proxy])),
  },
  // The WS upgrade lives in the fetch fallback (not routes): Bun's router
  // tries to send a response after a route handler, which tears down an
  // upgraded socket.
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (
        server.upgrade(req, {
          data: { up: null as unknown as WebSocket, buf: [] },
        })
      ) {
        return undefined;
      }
      return new Response("upgrade failed", { status: 400 });
    }
    const asset = url.pathname.slice(1);
    if (meta.assets.includes(asset) || asset === "ghostty-vt.wasm") {
      const file = Bun.file(join(FRONTEND_DIST, asset));
      if (await file.exists()) return new Response(file);
    }
    // SPA fallback, like prod's: any other extension-less GET is a client
    // route (e.g. /workspace/*) — serve the rewritten shell. Bun-internal
    // paths (/_bun/* — HMR socket, dev assets) must never hit this.
    if (
      req.method === "GET" &&
      !url.pathname.includes(".") &&
      !url.pathname.startsWith("/_bun")
    ) {
      return shell();
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      console.log("[ws] client connected, dialing upstream");
      // Bun's client WebSocket supports custom headers — ride the Bearer.
      const up = new WebSocket(WS_UPSTREAM, {
        // @ts-expect-error Bun extension
        headers: { authorization: `Bearer ${token}` },
      });
      ws.data.up = up;
      up.addEventListener("open", () => {
        console.log("[ws] upstream open");
        for (const m of ws.data.buf ?? []) up.send(m);
        ws.data.buf = null;
      });
      up.addEventListener("message", (e) => ws.send(e.data));
      up.addEventListener("close", (e) => {
        console.log("[ws] upstream closed", e.code, e.reason);
        ws.close();
      });
      up.addEventListener("error", (e: any) => {
        console.log("[ws] upstream error", e?.message ?? "");
        ws.close();
      });
    },
    message(ws, message) {
      if (ws.data.buf) ws.data.buf.push(message);
      else ws.data.up.send(message);
    },
    close(ws) {
      ws.data.up?.close();
    },
  },
});

console.log(`Frontend dev server: http://127.0.0.1:${PORT}/`);
