/**
 * Local dev-server ("preview") status + control for a session's worktree.
 *
 * A repository preview writes its allocated ports to `<worktree>/.ports.conf`:
 *
 *   WEBAPP_PORT=3300
 *   INSTANT_PORT=5968
 *   ...
 *
 * `next dev` binds 0.0.0.0, but the webapp can't just be opened at
 * `http://<host>:<WEBAPP_PORT>`: it needs a *secure* (HTTPS) origin to be a
 * trusted context (WebCrypto etc.), and Next dev only hydrates over an origin
 * it's been told to trust. So for each running webapp we expose a dedicated
 * HTTPS port on the tailnet host via Caddy (which already holds the ts.net
 * cert), reverse-proxying to the webapp's port. The session's worktree must
 * have been started with `ALLOWED_DEV_ORIGINS=<host>` so Next dev hydrates over
 * that origin. The preview URL is then
 * `https://<host>:<httpsPort>`.
 *
 * The bring-up itself is repo-generic: resolvePreviewBoot picks a committed
 * `.agents/start.sh` from the target repo first, then the repo's configured
 * `previewCommand` — one chain shared by host and sandboxed previews.
 */
import { $ } from "bun";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { getAgentAwsEnv } from "./aws-creds";
import {
  createWorkloadIdentityEnv,
  type WorkloadIdentityContext,
} from "./workload-identity";
import { audit } from "./audit";
import {
  ensureRemoteSandboxPortalAgent,
  forgetRemoteSandboxPortalAgents,
  listPortalServices,
  listSandboxPortalServices,
} from "./portal-supervisor";
import {
  revokeSandboxPortalGrants,
  revokeSandboxPortalRelay,
} from "./sandbox-portal-relay";
import {
  cacheSandboxPortals,
  dropCachedSandboxPortals,
} from "./sandbox-portals";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import {
  lookupSandboxHttpsPort,
  releaseSandboxPreviewPorts,
  sandboxHttpsPortFor,
} from "./sandbox/preview-ports";
import type { Sandbox } from "./sandbox/provider";
import { shellQuoteWord } from "./sandbox/adapters/bootstrap";
import {
  DEFAULT_SANDBOX_PREVIEW_PORTS,
  sandboxConfig,
  usesOutboundSandboxPortalRelay,
} from "./sandbox/config";
import { configuredRepos, configuredServer, type Repo } from "./config";
import { repoForPath, repoForPathOrNull } from "./worktree";
import {
  claimPoolPreview,
  poolClaimFor,
  poolPreviewLive,
  previewPoolEnabled,
  releasePoolPreview,
  resumePoolSyncIfNeeded,
  SEED_ENV_FILES,
} from "./preview-pool";
import {
  previewScopeSystemdArgs,
  previewScopeUnit,
  stopUserScope,
  systemdUserEnv,
  systemdUserScopesAvailable,
} from "./systemd-scopes";

export interface PreviewService {
  /** Friendly label, e.g. "Webapp". */
  name: string;
  /** Raw .ports.conf key, e.g. "WEBAPP_PORT". */
  key: string;
  port: number;
  /** Derived from `state`, never probed separately: `state === "awake"`. */
  running: boolean;
  pids: number[];
  /** Authenticated URL for this individual service when it is reachable. */
  previewUrl?: string | null;
  /** Session supervisor metadata for an agent-created Portal. */
  description?: string;
  defaultPath?: string;
  /** The one lifecycle field. A managed Portal takes it from its supervisor;
   *  an unmanaged .ports.conf service gets it from the single port probe. */
  state: "starting" | "awake" | "sleeping" | "waking" | "failed" | "stopped";
  managed?: boolean;
}

export interface PreviewPortalRecipe {
  /** Stable, URL-safe identifier used by the direct start endpoint. */
  id: string;
  /** Human-facing service name shown in the Portals panel. */
  name: string;
  /** Optional one-line explanation supplied by the repository. */
  description?: string;
  /** Direct command supervised by Open Session in the session workspace. */
  command?: string;
  /** Legacy agent-assisted starter. New recipes should declare command. */
  skill?: string;
  /** Environment/.ports.conf key assigned to the supervised port. */
  serviceKey?: string;
  /** Optional fixed port for projects whose tooling requires a known range. */
  port?: number;
  /** How long this service may take to bind its port. */
  readyTimeoutSeconds?: number;
}

export interface PreviewStatus {
  hasPortsConf: boolean;
  /** WEBAPP_PORT, or null if the worktree has no .ports.conf yet. */
  webappPort: number | null;
  /** Whether the webapp itself is currently listening. */
  running: boolean;
  /** True while `startPreview` is bringing the dev server up (not yet listening). */
  starting: boolean;
  /** HTTPS preview URL (Caddy-fronted) when the webapp is up, else null. */
  previewUrl: string | null;
  /** Whether a bring-up mechanism exists for this worktree's repo (repo
   *  `.agents/start.sh` → config `previewCommand`).
   *  False = the Start button can't do anything; the UI shows what to add. */
  bootable: boolean;
  services: PreviewService[];
  /** Declarative, skill-backed starters from .agents/portals.json. */
  portalRecipes: PreviewPortalRecipe[];
}

export function recipeCommand(recipe: PreviewPortalRecipe): string {
  if (!recipe.command)
    throw new Error("This Portal still needs an agent-assisted starter.");
  const exports = [
    recipe.serviceKey ? `export ${recipe.serviceKey}="$PORT"` : "",
    recipe.serviceKey === "WEBAPP_PORT"
      ? 'export WEBAPP_PORT="$PORT" PREVIEW_URL="$PORTAL_URL"'
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  return `bash -c ${shellQuoteWord(`${exports ? `${exports}; ` : ""}exec ${recipe.command}`)}`;
}

export function recipeStartOptions(recipe: PreviewPortalRecipe) {
  return {
    name: recipe.id,
    command: recipeCommand(recipe),
    ...(recipe.port ? { port: recipe.port } : {}),
    ...(recipe.serviceKey ? { key: recipe.serviceKey } : {}),
    ...(recipe.description ? { description: recipe.description } : {}),
    ...(recipe.readyTimeoutSeconds
      ? { readyTimeoutMs: recipe.readyTimeoutSeconds * 1_000 }
      : {}),
  };
}

/** Parse the safe, declarative contents of .agents/portals.json. */
export function parsePreviewPortalRecipes(
  raw: string | null,
): PreviewPortalRecipe[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { portals?: unknown };
    if (!Array.isArray(parsed.portals)) return [];
    return parsed.portals
      .slice(0, 12)
      .flatMap((value): PreviewPortalRecipe[] => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return [];
        const item = value as Record<string, unknown>;
        const name = typeof item.name === "string" ? item.name.trim() : "";
        const skill =
          typeof item.skill === "string" &&
          /^[a-z0-9][a-z0-9-]{0,63}$/.test(item.skill.trim())
            ? item.skill.trim()
            : undefined;
        const idValue = typeof item.id === "string" ? item.id.trim() : skill;
        const id =
          idValue && /^[a-z][a-z0-9-]{0,62}$/.test(idValue)
            ? idValue
            : undefined;
        const command =
          typeof item.command === "string" &&
          item.command.trim().length <= 2_000
            ? item.command.trim()
            : undefined;
        if (!name || name.length > 80 || !id || (!command && !skill)) return [];
        const description =
          typeof item.description === "string" &&
          item.description.trim().length <= 240
            ? item.description.trim()
            : undefined;
        const serviceKey =
          typeof item.serviceKey === "string" &&
          /^[A-Z][A-Z0-9_]*_PORT$/.test(item.serviceKey)
            ? item.serviceKey
            : undefined;
        const port =
          Number.isInteger(item.port) &&
          Number(item.port) >= 1_024 &&
          Number(item.port) <= 19_000
            ? Number(item.port)
            : undefined;
        const readyTimeoutSeconds =
          Number.isInteger(item.readyTimeoutSeconds) &&
          Number(item.readyTimeoutSeconds) >= 5 &&
          Number(item.readyTimeoutSeconds) <= 300
            ? Number(item.readyTimeoutSeconds)
            : undefined;
        return [
          {
            id,
            name,
            ...(description ? { description } : {}),
            ...(command ? { command } : {}),
            ...(skill ? { skill } : {}),
            ...(serviceKey ? { serviceKey } : {}),
            ...(port ? { port } : {}),
            ...(readyTimeoutSeconds ? { readyTimeoutSeconds } : {}),
          },
        ];
      });
  } catch {
    return [];
  }
}

function hostPreviewPortalRecipes(worktreeDir: string): PreviewPortalRecipe[] {
  try {
    return parsePreviewPortalRecipes(
      readFileSync(join(worktreeDir, LIFECYCLE_DIR, "portals.json"), "utf8"),
    );
  } catch {
    return [];
  }
}

/** Absolute instance preview-command directories that sandbox providers need
 *  to mount read-only at the same path. */
export function externalPreviewCommandDirs(): string[] {
  return [
    ...new Set(
      Object.values(configuredRepos())
        .map((repo) => repo.previewCommand?.trim().split(/\s+/)[0])
        .filter((command): command is string => !!command?.startsWith("/"))
        .map(dirname),
    ),
  ];
}

// ── Bring-up resolution (ONE chain, shared by host + sandbox previews) ────────
// The boot command should live IN the target repo, not in opensession: a
// committed `.agents/start.sh` (matching docker.ts's workspace-setup hook)
// beats instance config (`previewCommand` on the repos registry entry). Docs:
// deploy/sandbox/README.md "Previews in sandboxes".

// The repo lifecycle dir (docs/repo-lifecycle.md): `.agents/setup` (one-shot
// provisioning), `.agents/resume` (idempotent post-wake repair; reader lands
// with the sandbox plan's Phase 1), `.agents/start.sh` (dev-server bring-up),
// `.agents/preview.json` (warm routes).
const LIFECYCLE_DIR = ".agents";

/** What a repo's committed lifecycle directory provides. Read straight off
 *  the main checkout for Settings → Setup, which tells operators whether
 *  sessions in that repo can install deps and boot a preview on their own.
 *  Docs: docs/repo-lifecycle.md. */
export interface RepoLifecycle {
  /** The lifecycle dir (`.agents`), or null when the repo doesn't commit one. */
  dir: string | null;
  setup: boolean;
  start: boolean;
  previewJson: boolean;
}

/** Inspect `repoRoot`'s lifecycle dir. */
export function repoLifecycle(repoRoot: string): RepoLifecycle {
  const base = `${repoRoot}/${LIFECYCLE_DIR}`;
  if (existsSync(base)) {
    return {
      dir: LIFECYCLE_DIR,
      setup: existsSync(`${base}/setup`),
      start: existsSync(`${base}/start.sh`),
      previewJson: existsSync(`${base}/preview.json`),
    };
  }
  return { dir: null, setup: false, start: false, previewJson: false };
}

export interface PreviewBoot {
  kind: "repo-script" | "preview-command";
  /** `sh -c`-ready command; every path component passes assertSafePath. */
  cmd: string;
  /** `.agents/setup` next to the resolved start.sh when present — the
   *  one-shot sibling hook (repo-script kind only). */
  setupScript?: string;
}

/**
 * Resolve how to bring `worktreeDir`'s dev server up. `exists` abstracts the
 * filesystem so the same chain serves host previews (fs) and sandboxed ones
 * (in-container `test -f`). Returns null when the repo has no boot mechanism
 * at all — the UI surfaces that as a disabled Start button.
 */
export async function resolvePreviewBoot(
  worktreeDir: string,
  repo: Pick<Repo, "id" | "previewCommand">,
  exists: (path: string) => Promise<boolean> | boolean,
): Promise<PreviewBoot | null> {
  const startSh = `${worktreeDir}/${LIFECYCLE_DIR}/start.sh`;
  if (await exists(startSh)) {
    const setupHook = `${worktreeDir}/${LIFECYCLE_DIR}/setup`;
    return {
      kind: "repo-script",
      cmd: `bash ${assertSafePath(startSh)}`,
      setupScript: (await exists(setupHook)) ? setupHook : undefined,
    };
  }
  if (repo.previewCommand) {
    // Absolute previewCommands may not exist in this environment (e.g. a host
    // path the sandbox image doesn't carry) — fall through instead of failing.
    if (
      !repo.previewCommand.startsWith("/") ||
      (await exists(repo.previewCommand))
    ) {
      return {
        kind: "preview-command",
        cmd: `${repo.previewCommand} ${assertSafePath(worktreeDir)}`,
      };
    }
    // Once per worktree — status polls re-resolve every few seconds for
    // sandboxes that don't carry the script (e.g. remote providers).
    if (!warnedMissingPreviewCommand.has(worktreeDir)) {
      warnedMissingPreviewCommand.add(worktreeDir);
      console.warn(
        `[preview] previewCommand ${repo.previewCommand} (repo ${repo.id}) not present here — trying the fallback chain`,
      );
    }
  }
  return null;
}

const hostExists = (p: string) => existsSync(p);
const warnedMissingPreviewCommand = new Set<string>();

/** Remote providers sometimes return a signed preview URL. It is never a
 * browser or Caddy upstream. This loopback-only relay holds that URL and its
 * provider headers on the server side, so Caddy has one safe invariant: every
 * Portal route targets localhost. */
type RemotePortalRelay = {
  upstream: string;
  headers?: Record<string, string>;
  server: ReturnType<typeof Bun.serve>;
};
const remotePortalRelays: Map<string, RemotePortalRelay> = ((
  globalThis as any
).__opensessionRemotePortalRelays ??= new Map());

function relayKey(sandboxId: string, port: number): string {
  return `${sandboxId}:${port}`;
}

function relayTarget(upstream: string, requestUrl: string): string {
  const base = new URL(upstream);
  const incoming = new URL(requestUrl);
  base.pathname =
    `${base.pathname.replace(/\/$/, "")}/${incoming.pathname.replace(/^\//, "")}`.replace(
      /\/{2,}/g,
      "/",
    );
  base.search = incoming.search;
  return base.toString();
}

function localRelayFor(
  sandboxId: string,
  port: number,
  upstream: string,
  headers?: Record<string, string>,
): string {
  const key = relayKey(sandboxId, port);
  const current = remotePortalRelays.get(key);
  if (
    current?.upstream === upstream &&
    JSON.stringify(current.headers || {}) === JSON.stringify(headers || {})
  )
    return `127.0.0.1:${current.server.port}`;
  if (current) {
    try {
      current.server.stop(true);
    } catch {}
    remotePortalRelays.delete(key);
  }
  const connections = new Map<any, WebSocket>();
  const server = Bun.serve<{ url: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, relayServer) {
      const upgrade =
        request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (upgrade) {
        return relayServer.upgrade(request, { data: { url: request.url } })
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 });
      }
      const forwarded = new Headers(request.headers);
      forwarded.delete("host");
      forwarded.delete("connection");
      forwarded.delete("content-length");
      for (const [name, value] of Object.entries(headers || {}))
        forwarded.set(name, value);
      return fetch(relayTarget(upstream, request.url), {
        method: request.method,
        headers: forwarded,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
        redirect: "manual",
      });
    },
    websocket: {
      open(ws) {
        const remoteUrl = relayTarget(
          upstream.replace(/^http/, "ws"),
          ws.data.url,
        );
        const remote = new (WebSocket as any)(remoteUrl, {
          headers,
        }) as WebSocket;
        connections.set(ws, remote);
        remote.addEventListener("message", (event) => ws.send(event.data));
        remote.addEventListener("close", () => {
          try {
            ws.close();
          } catch {}
        });
        remote.addEventListener("error", () => {
          try {
            ws.close();
          } catch {}
        });
      },
      message(ws, message) {
        connections.get(ws)?.send(message);
      },
      close(ws) {
        try {
          connections.get(ws)?.close();
        } catch {}
        connections.delete(ws);
      },
    },
  });
  remotePortalRelays.set(key, { upstream, headers, server });
  return `127.0.0.1:${server.port}`;
}

// Worktrees with an in-flight `startPreview` (worktreeDir -> started-at ms).
// Parked on globalThis so it survives --hot reloads. Entries are cleared when
// the webapp comes up, when the bring-up process exits, or after a TTL (so a
// crashed/never-finished start eventually stops reporting "starting").
const gStart = globalThis as unknown as {
  __previewStarting?: Map<string, number>;
  __previewStartPgids?: Map<string, number>;
  __sandboxPreviewAwsRefresh?: Map<string, number>;
};
const starting: Map<string, number> = (gStart.__previewStarting ??= new Map());
// worktreeDir -> process group of the in-flight bring-up (see startPreview's
// setsid). Lets stopPreview cancel a start whose services aren't listening yet.
const startPgids: Map<string, number> = (gStart.__previewStartPgids ??=
  new Map());
const sandboxAwsRefresh: Map<string, number> =
  (gStart.__sandboxPreviewAwsRefresh ??= new Map());
const START_TTL_MS = 5 * 60_000;
const SANDBOX_AWS_REFRESH_MS = 10 * 60_000;

function isStarting(worktreeDir: string): boolean {
  const t = starting.get(worktreeDir);
  if (t == null) return false;
  if (Date.now() - t > START_TTL_MS) {
    starting.delete(worktreeDir);
    return false;
  }
  return true;
}

function recordPreviewReady(
  worktreeDir: string,
  environment: "worktree" | "sandbox",
  provider?: string,
): void {
  const startedAt = starting.get(worktreeDir);
  if (startedAt == null) return;
  audit({
    kind: "preview_ready_metric",
    environment,
    provider: provider || "host",
    ready_ms: Date.now() - startedAt,
    workspace: basename(worktreeDir),
  });
}

const SERVICE_NAMES: Record<string, string> = {
  WEBAPP_PORT: "Webapp",
  INSTANT_PORT: "Instant API",
  WEBAPP_WORKFLOW_PORT: "Workflow",
  WEBAPP_EMAILS_PREVIEW_PORT: "Emails preview",
  TEMPORAL_PORT: "Temporal",
  TEMPORAL_UI_PORT: "Temporal UI",
};

function friendly(key: string): string {
  if (SERVICE_NAMES[key]) return SERVICE_NAMES[key];
  return key
    .replace(/_PORT$/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse .ports.conf text into ordered {key, port} entries. */
function parsePortsText(text: string): { key: string; port: number }[] {
  const out: { key: string; port: number }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+_PORT)\s*=\s*(\d+)\s*$/);
    if (m) out.push({ key: m[1], port: parseInt(m[2], 10) });
  }
  return out;
}

/** Parse `<worktree>/.ports.conf` into ordered {key, port} entries. */
function readPorts(worktreeDir: string): { key: string; port: number }[] {
  const file = join(worktreeDir, ".ports.conf");
  if (!existsSync(file)) return [];
  return parsePortsText(readFileSync(file, "utf8"));
}

/**
 * One process-wide socket snapshot for every open session's Preview poll.
 * `ss -p` walks the host process table, so spawning it once per service made
 * PreviewButton polling consume a core and delayed unrelated session traffic.
 * A short stale window is harmless for a control that polls every 3 to 8s.
 */
const LISTENER_SNAPSHOT_TTL_MS = 2_000;
let listenerSnapshot: { raw: string; at: number } | null = null;
let listenerSnapshotRefresh: Promise<string> | null = null;

async function listenerSnapshotRaw(): Promise<string> {
  if (
    listenerSnapshot &&
    Date.now() - listenerSnapshot.at < LISTENER_SNAPSHOT_TTL_MS
  ) {
    return listenerSnapshot.raw;
  }
  if (!listenerSnapshotRefresh) {
    listenerSnapshotRefresh = $`ss -tlnpH`
      .quiet()
      .nothrow()
      .text()
      .then((raw) => {
        listenerSnapshot = { raw, at: Date.now() };
        return raw;
      })
      .finally(() => {
        listenerSnapshotRefresh = null;
      });
  }
  return await listenerSnapshotRefresh;
}

/** Select socket rows by the local-address column, not by a loose substring
 * that could match the peer address or a PID. Exported for the parser test. */
export function listenerLinesForPort(raw: string, port: number): string[] {
  return raw.split("\n").filter((line) => {
    const localAddress = line.trim().split(/\s+/)[3];
    return localAddress?.endsWith(`:${port}`) ?? false;
  });
}

/** PIDs with a LISTEN socket on a TCP port (empty if none are visible). */
async function listenersOnPort(port: number): Promise<number[]> {
  const lines = listenerLinesForPort(await listenerSnapshotRaw(), port);
  const pids = new Set<number>();
  for (const line of lines)
    for (const match of line.matchAll(/pid=(\d+)/g))
      pids.add(parseInt(match[1], 10));
  return [...pids];
}

/** Is anything listening on the port, regardless of pid visibility? */
async function portListening(port: number): Promise<boolean> {
  return listenerLinesForPort(await listenerSnapshotRaw(), port).length > 0;
}

async function pgidOf(pid: number): Promise<number | null> {
  const raw = await $`ps -o pgid= -p ${pid}`.quiet().nothrow().text();
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── HTTPS preview exposure via Caddy ──────────────────────────────────────────
// Caddy (admin API on localhost:2019) already terminates TLS for this machine's
// ts.net hostname. We add one reverse-proxy server per running webapp, on a
// deterministic high port, so each session gets its own secure origin.

const caddyAdmin = () => configuredServer().caddyAdmin.replace(/\/+$/, "");
const caddyFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
const g = globalThis as unknown as {
  __previewRoutes?: Map<number, string>;
  __previewHost?: string;
};
// httpsPort -> upstream + request-header signature we've already configured
// (survives --hot reloads). Provider preview tokens rotate on sandbox restart,
// so the headers are part of idempotency even when the URL stays unchanged.
const previewRoutes: Map<number, string> = (g.__previewRoutes ??= new Map());

/** Caddy may outlive Open Session. Auth must fail closed for a route the
 * current process has not rediscovered and registered, or a stale Caddy
 * upstream could survive a restart and later point at an unrelated listener. */
export function portalRouteAuthorized(httpsPort: number): boolean {
  return Number.isInteger(httpsPort) && previewRoutes.has(httpsPort);
}

/** Hostname shared with the OpenSession UI so its auth cookie rides across
 * preview ports. Operators can override it explicitly with PREVIEW_HOST. */
export async function previewHost(): Promise<string> {
  if (g.__previewHost) return g.__previewHost;
  const host = configuredServer().previewHost;
  g.__previewHost = host;
  return host;
}

// Webapp dev ports are 3100-3999 and globally unique among running servers, so
// +6000 gives a unique, stable preview port in 9100-9999. (Preview-pool
// container host ports come from the same range so this scheme covers them.)
export function httpsPortFor(webappPort: number): number {
  return webappPort + 6000;
}

/** Host services occupy globally unique TCP ports, so the translated HTTPS
 * port is collision-free too. Keep it below the sandbox allocation namespace
 * ([20000, 28000)); unusually-high service ports remain visible but unlinked. */
function hostServiceHttpsPort(port: number): number | null {
  const httpsPort = httpsPortFor(port);
  return httpsPort > 0 && httpsPort < 20_000 ? httpsPort : null;
}

/** Caddy JSON for one permission-coupled portal. The first reverse proxy is
 *  the JSON expansion of Caddy's `forward_auth`: a 2xx response continues to
 *  the app upstream; any auth rejection is returned directly. The browser's
 *  Open Session cookie is same-host and therefore rides across HTTPS ports. */
export function previewServerConfig(
  httpsPort: number,
  upstream: string,
  host: string,
) {
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(upstream)) {
    throw new Error("Portal Caddy routes must target a loopback relay");
  }
  const authPort = configuredServer().port;
  const serviceProxy = {
    handler: "reverse_proxy",
    upstreams: [{ dial: upstream }],
  };
  return {
    listen: [`:${httpsPort}`],
    routes: [
      {
        match: [{ host: [host] }],
        handle: [
          {
            handler: "subroute",
            routes: [
              {
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: `127.0.0.1:${authPort}` }],
                    rewrite: {
                      method: "GET",
                      uri: `/api/portal-auth/${httpsPort}`,
                    },
                    headers: {
                      request: {
                        set: {
                          "X-Forwarded-Method": ["{http.request.method}"],
                          "X-Forwarded-Uri": ["{http.request.uri}"],
                        },
                      },
                    },
                    handle_response: [
                      {
                        match: { status_code: [2] },
                        routes: [{ handle: [{ handler: "vars" }] }],
                      },
                    ],
                  },
                  serviceProxy,
                ],
              },
            ],
          },
        ],
        terminal: true,
      },
    ],
  };
}

/** Add/refresh the Caddy server for this webapp (idempotent, cached). */
async function ensurePreviewRoute(
  httpsPort: number,
  upstream: string,
  host: string,
  requestHeaders: Record<string, string> = {},
): Promise<boolean> {
  const signature = JSON.stringify([upstream, requestHeaders]);
  const path = `${caddyAdmin()}/config/apps/http/servers/preview_${httpsPort}`;
  if (previewRoutes.get(httpsPort) === signature) {
    // A Caddyfile reload replaces dynamic admin-API routes without notifying
    // this process. Verify the cached route still exists before trusting it,
    // otherwise status can report a URL whose listener was silently removed.
    try {
      if ((await caddyFetch(path)).ok) return true;
    } catch {}
    previewRoutes.delete(httpsPort);
  }
  const server = previewServerConfig(httpsPort, upstream, host);
  const put = () =>
    caddyFetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(server),
    });
  try {
    // PUT creates the key; if it already exists (e.g. Caddy kept the server
    // across a opensession restart, so our cache is cold) it 409s — drop it and
    // recreate so the route always ends up pointing at the current webapp port.
    let res = await put();
    if (res.status === 409) {
      await caddyFetch(path, { method: "DELETE" }).catch(() => {});
      res = await put();
    }
    if (!res.ok) return false;
    previewRoutes.set(httpsPort, signature);
    return true;
  } catch {
    return false;
  }
}

async function removePreviewRoute(httpsPort: number): Promise<void> {
  if (!previewRoutes.has(httpsPort)) return;
  try {
    await caddyFetch(
      `${caddyAdmin()}/config/apps/http/servers/preview_${httpsPort}`,
      { method: "DELETE" },
    );
  } catch {}
  previewRoutes.delete(httpsPort);
}

/** Expose a pre-built loopback relay through the same permission-coupled
 * Caddy wrapper used by every Sandbox Portal. The caller never passes a remote
 * address, so a Runner cannot turn this into a network tunnel. */
export async function ensureAuthenticatedPortalRoute(
  httpsPort: number,
  upstream: string,
): Promise<string | null> {
  const host = await previewHost();
  return (await ensurePreviewRoute(httpsPort, upstream, host))
    ? `https://${host}:${httpsPort}`
    : null;
}

export async function dropAuthenticatedPortalRoute(
  httpsPort: number,
): Promise<void> {
  await removePreviewRoute(httpsPort);
}

export async function getPreviewStatus(
  worktreeDir: string,
): Promise<PreviewStatus> {
  // Pool-backed previews: claims persist on disk but sync timers don't —
  // re-attach after a process restart (cheap no-op otherwise).
  resumePoolSyncIfNeeded(worktreeDir);
  // docker-proxy listens for the container's whole life, so for a pool claim
  // "running" must mean "the dev server inside answers", not "port open".
  const poolLive = await poolPreviewLive(worktreeDir);
  // Remote-backend claims (daytona) carry their own public preview origin —
  // no host port, no Caddy route, no .ports.conf involvement at all.
  const remoteClaim = poolClaimFor(worktreeDir);
  if (remoteClaim?.previewUrl) {
    return {
      hasPortsConf: true,
      webappPort: null,
      running: poolLive === true,
      starting: poolLive !== true,
      previewUrl: poolLive === true ? remoteClaim.previewUrl : null,
      bootable: true,
      services: [
        {
          name: "Webapp",
          key: "WEBAPP_PORT",
          port: 0,
          running: poolLive === true,
          pids: [],
          state: poolLive === true ? "awake" : "starting",
        },
      ],
      portalRecipes: hostPreviewPortalRecipes(worktreeDir),
    };
  }
  const ports = readPorts(worktreeDir);
  const portalRecipes = hostPreviewPortalRecipes(worktreeDir);
  const portalRecords = await listPortalServices(worktreeDir);
  const portalByKey = new Map(
    portalRecords.map((record) => [record.key, record]),
  );
  const observedServices: PreviewService[] = await Promise.all(
    ports.map(async ({ key, port }): Promise<PreviewService> => {
      const portal = portalByKey.get(key);
      // A managed Portal has one liveness owner: listPortalServices already
      // probed this port. Probing it again here is what let a stopped Portal
      // whose port had been taken over report itself as running.
      if (portal) {
        return {
          name:
            portalRecipes.find((recipe) => recipe.serviceKey === key)?.name ??
            portal.name,
          key,
          port,
          running: portal.state === "awake",
          pids: portal.pid ? [portal.pid] : [],
          ...(portal.description ? { description: portal.description } : {}),
          ...(portal.defaultPath ? { defaultPath: portal.defaultPath } : {}),
          state: portal.state,
          managed: true,
        };
      }
      const pids = await listenersOnPort(port);
      // Root-owned listeners (docker-proxy fronting a preview-pool container)
      // show no pid to non-root `ss -p` — a listening socket counts as
      // running even when we can't see who owns it.
      const awake =
        key === "WEBAPP_PORT" && poolLive != null
          ? poolLive
          : pids.length > 0 || (await portListening(port));
      const state = awake ? "awake" : "stopped";
      return {
        name: friendly(key),
        key,
        port,
        running: state === "awake",
        pids,
        state,
      };
    }),
  );
  const host = await previewHost();
  // Every listening .ports.conf service is a Portal, not just WEBAPP_PORT.
  // Routes share the same authenticated Caddy wrapper; high source ports that
  // would overlap the sandbox namespace stay visible without a link.
  const services: PreviewService[] = [];
  for (const service of observedServices) {
    const httpsPort = hostServiceHttpsPort(service.port);
    let previewUrl: string | null = null;
    if (service.state === "awake" && httpsPort != null) {
      if (
        await ensurePreviewRoute(httpsPort, `127.0.0.1:${service.port}`, host)
      ) {
        previewUrl = `https://${host}:${httpsPort}`;
      }
    } else if (httpsPort != null) {
      await removePreviewRoute(httpsPort);
    }
    services.push({ ...service, previewUrl });
  }
  const webapp = services.find((s) => s.key === "WEBAPP_PORT");
  const previewUrl = webapp?.previewUrl || null;
  const repo = repoForPathOrNull(worktreeDir);

  if (services.some((service) => service.previewUrl)) {
    writeHostTunnelsEnv(worktreeDir, services);
  } else {
    try {
      unlinkSync(join(worktreeDir, ".tunnels.env"));
    } catch {}
  }

  // Once the webapp is listening, the bring-up is done — clear any "starting".
  if (webapp?.running) {
    recordPreviewReady(worktreeDir, "worktree");
    starting.delete(worktreeDir);
  }

  return {
    hasPortsConf: ports.length > 0,
    webappPort: webapp?.port ?? null,
    running: !!webapp?.running,
    // poolLive === false: a pool claim exists but its dev server isn't
    // answering yet (big-delta claims REBOOT the container's dev tree) —
    // that IS a bring-up in progress. Without it the button saw
    // running:false starting:false right after a claim and closed its own
    // interstitial ("opens then closes itself, and then I have no tab").
    starting:
      !webapp?.running && (isStarting(worktreeDir) || poolLive === false),
    previewUrl,
    bootable:
      !!webapp?.running ||
      (repo != null &&
        (await resolvePreviewBoot(worktreeDir, repo, hostExists)) != null),
    services,
    portalRecipes,
  };
}

function writeHostTunnelsEnv(
  worktreeDir: string,
  services: PreviewService[],
): void {
  const values: string[] = [];
  const webapp = services.find(
    (service) => service.key === "WEBAPP_PORT" && service.previewUrl,
  );
  if (webapp?.previewUrl) values.push(`PREVIEW_URL=${webapp.previewUrl}`);
  for (const service of services) {
    if (!service.previewUrl) continue;
    values.push(`PREVIEW_URL_${service.port}=${service.previewUrl}`);
    values.push(
      `PORTAL_${service.key.replace(/_PORT$/, "")}_URL=${service.previewUrl}`,
    );
  }
  try {
    writeFileSync(join(worktreeDir, ".tunnels.env"), values.join("\n") + "\n");
    const dotGit = join(worktreeDir, ".git");
    let gitDir = dotGit;
    if (existsSync(dotGit)) {
      try {
        const marker = readFileSync(dotGit, "utf8").match(
          /^gitdir:\s*(.+)$/m,
        )?.[1];
        if (marker) gitDir = resolve(worktreeDir, marker.trim());
      } catch {}
    }
    const exclude = join(gitDir, "info", "exclude");
    if (existsSync(dirname(exclude))) {
      const prior = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      if (!prior.split("\n").includes(".tunnels.env")) {
        writeFileSync(
          exclude,
          `${prior}${prior && !prior.endsWith("\n") ? "\n" : ""}.tunnels.env\n`,
        );
      }
    }
  } catch {}
}

/**
 * Screenshot the running preview with headless Chrome (PNG bytes). The preview
 * origin is Caddy's tailnet cert, but Chrome runs before trust is guaranteed —
 * hence --ignore-certificate-errors; --virtual-time-budget lets the SPA settle
 * before the shot, and the whole thing is bounded by `timeout` so a wedged
 * renderer can't hold the request open.
 */
export async function capturePreviewScreenshot(
  worktreeDir: string,
  opts?: { width?: number; height?: number; status?: PreviewStatus },
): Promise<Buffer> {
  // Sandboxed sessions pass their own status (getSandboxPreviewStatus) — the
  // host status below can't see in-container listeners.
  const status = opts?.status ?? (await getPreviewStatus(worktreeDir));
  if (!status.running || !status.previewUrl) {
    throw new Error("Preview isn't running — start it first");
  }
  const out = `/tmp/backstage-preview-shot-${process.pid}-${Date.now()}.png`;
  const w = opts?.width || 1440;
  const h = opts?.height || 900;
  try {
    await $`timeout 45 google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars --ignore-certificate-errors --window-size=${w},${h} --virtual-time-budget=12000 --screenshot=${out} ${status.previewUrl}`.quiet();
    const buf = Buffer.from(await Bun.file(out).arrayBuffer());
    if (!buf.length) throw new Error("Screenshot came back empty");
    return buf;
  } finally {
    try {
      unlinkSync(out);
    } catch {}
  }
}

/** Fresh `.ports.conf` body in dev-services.sh format (harmless
 *  for repos that ignore it — a lifecycle start.sh just reads $WEBAPP_PORT). */
function freshPortsConfText(webappPort: number, comment: string): string {
  const rand = (min: number, max: number) =>
    min + Math.floor(Math.random() * (max - min + 1));
  return [
    "# Port configuration for development services",
    `# Seeded by opensession (${comment}): WEBAPP_PORT is the port the preview`,
    "# is fronted at — do not hand-edit it.",
    `WEBAPP_PORT=${webappPort}`,
    `INSTANT_PORT=${rand(5100, 5999)}`,
    `WEBAPP_WORKFLOW_PORT=${rand(6100, 6999)}`,
    `WEBAPP_EMAILS_PREVIEW_PORT=${rand(6100, 6999)}`,
    `TEMPORAL_PORT=${rand(7200, 7999)}`,
    `TEMPORAL_UI_PORT=${rand(8200, 8999)}`,
    "",
  ].join("\n");
}

/** Seed/adopt `<worktree>/.ports.conf` (host fs variant of
 *  seedSandboxPortsConf): rewrite only WEBAPP_PORT when the file exists. */
/** Restore the gitignored env files a repo's boot script requires.
 *
 *  A warm-template refresh deliberately excludes `.env*` from what it seeds
 *  into a worktree, and nothing else puts them back — the comment there still
 *  points at a `seedWebappEnv` that no longer exists. A repo's
 *  `.agents/start.sh` can exit on a missing `.env.local`, so the Preview button
 *  fails outright for any worktree where an agent never happened to run the
 *  repo's own local setup.
 *
 *  Only fills gaps: a worktree copy may carry deliberate per-session edits
 *  (the dev-auth bypass among them), so an existing file is never overwritten. */
function seedHostEnvFiles(worktreeDir: string, repo: Repo | undefined): void {
  if (!repo?.repo || resolve(repo.repo) === resolve(worktreeDir)) return;
  for (const rel of SEED_ENV_FILES) {
    const dest = join(worktreeDir, rel);
    const src = join(repo.repo, rel);
    if (existsSync(dest) || !existsSync(src)) continue;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(src, "utf8"));
      console.log(`[preview] seeded ${rel} into ${basename(worktreeDir)}`);
    } catch (e) {
      console.warn(`[preview] seeding ${rel} into ${worktreeDir} failed:`, e);
    }
  }
}

function seedHostPortsConf(worktreeDir: string, webappPort: number): void {
  const file = join(worktreeDir, ".ports.conf");
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    // The line may be absent (a pool-preview release strips it) — append
    // instead of silently replacing nothing, or the claim's port never lands.
    writeFileSync(
      file,
      /^WEBAPP_PORT=/m.test(text)
        ? text.replace(/^WEBAPP_PORT=.*$/m, `WEBAPP_PORT=${webappPort}`)
        : `WEBAPP_PORT=${webappPort}\n${text}`,
    );
  } else {
    writeFileSync(file, freshPortsConfText(webappPort, "host preview"));
  }
}

/** A webapp port for a host repo-script boot: the worktree's existing
 *  .ports.conf entry when nothing else is listening on it, else a free
 *  random port from the host webapp dev range (3100-3999). */
async function allocateHostWebappPort(
  worktreeDir: string,
): Promise<number | null> {
  // portListening, not pid-counting: preview-pool containers publish on this
  // same range via docker-proxy (root-owned, no pid visible to ss -p) — the
  // pid check once handed a session a port already serving another session's
  // pool container, so both "opened the same preview".
  const existing = readPorts(worktreeDir).find(
    (p) => p.key === "WEBAPP_PORT",
  )?.port;
  if (existing && !(await portListening(existing))) return existing;
  for (let i = 0; i < 20; i++) {
    const port = 3100 + Math.floor(Math.random() * 900);
    if (!(await portListening(port))) return port;
  }
  return null;
}

// One-shot lifecycle `.agents/setup` stamps for HOST previews (the sandbox
// path runs the hook at workspace materialization instead — see
// sandbox/adapters).
// Stamped per worktree; "settled" once run, success or not, mirroring the
// sandbox semantics: setup never blocks or retries.
const SETUP_STAMP_DIR = join(OPENSESSION_SESSIONS_DIR, "preview-setup");
function setupStampPath(worktreeDir: string): string {
  return join(SETUP_STAMP_DIR, worktreeDir.replace(/\//g, "_") + ".done");
}

/**
 * Bring the session's dev server up if it isn't already, using the shared
 * resolution chain (repo `.agents/start.sh` → config `previewCommand` →
 * a built-in fallback). Bring-ups can take minutes (first build) — so we spawn the
 * command in the background and return immediately with `starting: true`;
 * callers poll `getPreviewStatus` to see it flip to `running`.
 *
 * Environment contract (same as sandbox boots): `OPENSESSION_BOOT_MODE=fresh`
 * always; repo-script boots additionally get `WEBAPP_PORT` (allocated here and
 * seeded into .ports.conf so status can see it) and `PREVIEW_URL`. The legacy
 * rungs (previewCommand/fallback) own their .ports.conf themselves.
 *
 * AWS: the opensession service cgroup denies IMDS (IPAddressDeny in
 * opensession.service), so children spawned here can never mint instance-role
 * creds on their own, which is what silently broke a repo bring-up whose
 * `aws` preflight and prebuilt-WASM S3 install both needed creds. Inject
 * the same short-lived credentials agent runs get (aws-creds.ts).
 */
export async function startPreview(
  worktreeDir: string,
): Promise<PreviewStatus> {
  const status = await getPreviewStatus(worktreeDir);
  if (status.running || status.starting) return status;
  const repo = repoForPathOrNull(worktreeDir);
  if (!repo) return status;

  // Warm preview pool: adopt an already-booted container when one is ready —
  // the claim syncs the worktree into it and hands back its host port; from
  // there the normal status path (listener on the port -> Caddy route) takes
  // over. Falls through to the host boot when the pool has nothing warm.
  try {
    if (previewPoolEnabled(repo.id)) {
      const claim = await claimPoolPreview(repo.id, worktreeDir);
      if (claim) {
        // Remote-backend claims carry a previewUrl and no host port — the
        // status path serves them directly, no .ports.conf involvement.
        if (claim.hostPort) seedHostPortsConf(worktreeDir, claim.hostPort);
        return await getPreviewStatus(worktreeDir);
      }
    }
  } catch (e) {
    console.warn(
      `[preview] pool claim for ${worktreeDir} failed (falling back to host boot):`,
      e,
    );
  }

  const boot = await resolvePreviewBoot(worktreeDir, repo, hostExists);
  if (!boot) return status; // nothing to run (status.bootable is false)

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(await getAgentAwsEnv()),
    OPENSESSION_BOOT_MODE: "fresh",
  };

  let cmd = boot.cmd;
  if (boot.kind === "repo-script") {
    const port = await allocateHostWebappPort(worktreeDir);
    if (port == null) {
      console.warn(
        `[preview] ${worktreeDir}: no free webapp port for the repo-script boot`,
      );
      return status;
    }
    seedHostPortsConf(worktreeDir, port);
    seedHostEnvFiles(worktreeDir, repo);
    env.WEBAPP_PORT = String(port);
    env.PREVIEW_URL = `https://${await previewHost()}:${httpsPortFor(port)}`;
    // One-shot sibling hook, stamped per worktree; failure never blocks the
    // start (matches the sandbox workspace-setup semantics).
    const stamp = setupStampPath(worktreeDir);
    if (boot.setupScript && !existsSync(stamp)) {
      try {
        mkdirSync(SETUP_STAMP_DIR, { recursive: true });
      } catch {}
      cmd =
        `bash ${assertSafePath(boot.setupScript)}; touch ${assertSafePath(stamp)}; ` +
        cmd;
    }
  }

  starting.set(worktreeDir, Date.now());
  try {
    const log = openSync(
      `/tmp/backstage-preview-${basename(worktreeDir)}.log`,
      "a",
    );
    // Prefer a resource-controlled user scope. It contains the entire preview
    // tree (Next/Turbopack, workflow, email, compilers) and survives a server
    // restart without sharing opensession.service's memory budget. `setsid`
    // remains inside it as the portable stop fallback and writes dev-pgid for
    // older previews / hosts without a reachable user manager.
    const innerCmd = [
      "setsid",
      "bash",
      "-c",
      `mkdir -p .ports && echo $$ > .ports/dev-pgid; ${cmd}`,
    ];
    const scoped = systemdUserScopesAvailable();
    const unit = previewScopeUnit(worktreeDir);
    const spawnCmd = scoped
      ? [
          "systemd-run",
          "--user",
          "--scope",
          "--collect",
          "--quiet",
          `--unit=${unit}`,
          ...previewScopeSystemdArgs(),
          "--property=TimeoutStopSec=5",
          "--",
          ...innerCmd,
        ]
      : innerCmd;
    const proc = Bun.spawn(spawnCmd, {
      cwd: worktreeDir,
      env: {
        ...(env as Record<string, string>),
        ...(scoped ? systemdUserEnv(env) : {}),
      },
      stdout: log,
      stderr: log,
      stdin: "ignore",
    });
    if (!scoped) startPgids.set(worktreeDir, proc.pid);
    // Don't hold the event loop open on it, and clear the flag when it exits
    // (success flips to running via polling; failure/exit stops "starting").
    proc.unref();
    proc.exited.then(() => {
      starting.delete(worktreeDir);
      if (!scoped) startPgids.delete(worktreeDir);
      try {
        closeSync(log);
      } catch {}
    });
  } catch {
    starting.delete(worktreeDir);
    startPgids.delete(worktreeDir);
  }
  return { ...status, starting: true, bootable: true };
}

/**
 * Stop the session's dev server. We can't use `just dev-stop` — it `pkill -f
 * "next dev"` globally and would kill every other session's webapp. Instead we
 * find the process group behind this worktree's ports and signal just that
 * group, which also takes down the `while true; do next dev; done` supervisor
 * (so it doesn't respawn) without touching anything outside the worktree.
 *
 * Safety: a PID is only eligible if its cwd is inside `worktreeDir`, so the
 * opensession server (and unrelated worktrees) can never be a target.
 */
export async function stopPreview(worktreeDir: string): Promise<PreviewStatus> {
  starting.delete(worktreeDir); // a stop cancels any in-flight "starting" state
  // Pool-backed preview: the "dev server" is a claimed warm container, not a
  // host process tree — release it (stops the sync loop, destroys the
  // container) and let the normal status path report the now-empty port.
  console.log(`[preview] stop: releasing pool claim for ${worktreeDir}`);
  if (await releasePoolPreview(worktreeDir)) {
    // Strip the pool's port from .ports.conf: a later HOST fallback boot
    // would otherwise adopt the now-free port ("existing" fast path in
    // allocateHostWebappPort), and any stale tab/status pointing at the old
    // port would silently show whatever serves there next.
    const conf = join(worktreeDir, ".ports.conf");
    if (existsSync(conf)) {
      try {
        const text = readFileSync(conf, "utf8");
        writeFileSync(conf, text.replace(/^WEBAPP_PORT=.*\n?/m, ""));
      } catch {}
    }
    return getPreviewStatus(worktreeDir);
  }
  const ports = readPorts(worktreeDir);
  const pgids = new Set<number>();
  // New host previews have a deterministic transient scope, so this also
  // catches a bring-up that has not written dev-pgid or opened a port yet.
  stopUserScope(previewScopeUnit(worktreeDir));
  // An in-flight bring-up has nothing listening yet, so the port scan below
  // can't see it — kill its dedicated process group (set up via setsid in
  // startPreview) so cancelling mid-start actually stops the build/dev server.
  const startPgid = startPgids.get(worktreeDir);
  if (startPgid && startPgid > 1) pgids.add(startPgid);
  // Also pick up any PGID written to disk by ensure-up.sh — covers the agent-
  // invoked path (where startPgids has no entry) and restarted opensession
  // (in-memory map is empty after restart).
  const pgidFile = join(worktreeDir, ".ports", "dev-pgid");
  if (existsSync(pgidFile)) {
    try {
      const pgid = parseInt(readFileSync(pgidFile, "utf8").trim(), 10);
      if (!isNaN(pgid) && pgid > 1) pgids.add(pgid);
    } catch {}
  }
  for (const { port } of ports) {
    for (const pid of await listenersOnPort(port)) {
      let cwd = "";
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {}
      if (!cwd || !(cwd === worktreeDir || cwd.startsWith(worktreeDir + "/")))
        continue;
      const pgid = await pgidOf(pid);
      if (pgid && pgid > 1) pgids.add(pgid);
    }
  }

  for (const pgid of pgids) {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {}
  }
  // Give it a moment to exit cleanly, then SIGKILL whatever's still around.
  await new Promise((r) => setTimeout(r, 1500));
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, 0); // throws if the group is already gone
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }
  try {
    unlinkSync(join(worktreeDir, ".ports", "dev-pgid"));
  } catch {}

  return getPreviewStatus(worktreeDir);
}

// ── Sandboxed previews (docs/self-hosting-sandboxes.md) ──────────────────
// A sandboxed session's dev server runs INSIDE its container, so the host-side
// mechanics above can't see it: `ss` can't observe container listeners, and
// signaling host process groups can't stop them. These variants keep the same
// PreviewStatus shape and reuse the identical Caddy plumbing — the only change
// is the upstream: instead of dialing the dev port directly, Caddy dials the
// container port's PUBLISHED loopback host port (docker -p at container
// create, config `previewPorts`; see docker.ts). A port that isn't published
// stays previewUrl-less — add it to previewPorts and let the container be
// recreated. Callers route here only when the session's sandbox container is
// actually running (the same active check as workspace-exec).
//
// The https route key is NAMESPACED away from host previews: host routes use
// webappPort + 6000 (9100-9999), sandbox routes use an allocated port from
// [20000, 28000) keyed by (sandboxId, containerPort) and persisted — see
// sandbox/preview-ports.ts for why deriving it from the webapp port number
// (the old TODO(sandbox-preview-collision)) could collide with host previews
// and with other sandboxes.

/** Only ever called with provider-constructed paths; mirror docker.ts's
 *  assertion so nothing surprising reaches an in-container `sh -c`. */
function assertSafePath(p: string): string {
  if (!/^[A-Za-z0-9_\/.@:-]+$/.test(p)) {
    throw new Error(`refusing unsafe path for in-container exec: ${p}`);
  }
  return p;
}

const SANDBOX_PREVIEW_AWS_DIR = "/tmp/opensession-preview-aws";

/**
 * Write the short-lived AWS scope to a sandbox-local shared credentials file.
 * Some repositories export AWS_PROFILE in direnv; AWS SDK v3 then ignores
 * otherwise-valid AWS_ACCESS_KEY_ID variables unless that named profile exists.
 *
 * Secrets are passed only through Sandbox.exec's env seam. The command text is
 * static, so provider logs and process listings never receive credential values.
 */
export async function writeSandboxPreviewAwsCredentials(
  sandbox: Sandbox,
  awsEnv: Record<string, string>,
  profile?: string,
): Promise<Record<string, string>> {
  if (!awsEnv.AWS_ACCESS_KEY_ID || !awsEnv.AWS_SECRET_ACCESS_KEY) return awsEnv;
  const safeProfile =
    profile && /^[A-Za-z0-9_+=,.@-]+$/.test(profile) ? profile : "";
  const credentialsFile = `${SANDBOX_PREVIEW_AWS_DIR}/credentials`;
  const configFile = `${SANDBOX_PREVIEW_AWS_DIR}/config`;
  const script = `set -eu
umask 077
mkdir -p ${SANDBOX_PREVIEW_AWS_DIR}
profile="$OPENSESSION_AWS_PROFILE"
write_section() {
  printf 'aws_access_key_id = %s\n' "$AWS_ACCESS_KEY_ID"
  printf 'aws_secret_access_key = %s\n' "$AWS_SECRET_ACCESS_KEY"
  if [ -n "\${AWS_SESSION_TOKEN:-}" ]; then
    printf 'aws_session_token = %s\n' "$AWS_SESSION_TOKEN"
  fi
}
{
  printf '[default]\n'
  write_section
  if [ -n "$profile" ] && [ "$profile" != default ]; then
    printf '\n[%s]\n' "$profile"
    write_section
  fi
} > ${credentialsFile}
{
  printf '[default]\nregion = %s\n' "$AWS_REGION"
  if [ -n "$profile" ] && [ "$profile" != default ]; then
    printf '\n[profile %s]\nregion = %s\n' "$profile" "$AWS_REGION"
  fi
} > ${configFile}
chmod 600 ${credentialsFile} ${configFile}`;
  const env = {
    ...awsEnv,
    AWS_REGION: awsEnv.AWS_REGION || awsEnv.AWS_DEFAULT_REGION || "us-east-1",
    OPENSESSION_AWS_PROFILE: safeProfile,
  };
  const result = await sandbox.exec(["sh", "-c", script], { env });
  if (result.exitCode !== 0) {
    console.warn(
      `[preview] ${sandbox.id}: could not write sandbox AWS profile: ${result.stderr.trim().slice(0, 200)}`,
    );
    return awsEnv;
  }
  return {
    ...awsEnv,
    AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
    AWS_CONFIG_FILE: configFile,
  };
}

async function sandboxPreviewAwsEnv(
  sandbox: Sandbox,
  worktreeDir: string,
  force = false,
): Promise<Record<string, string>> {
  const now = Date.now();
  const previous = sandboxAwsRefresh.get(sandbox.id) ?? 0;
  const awsEnv = await getAgentAwsEnv();
  const pointers = {
    ...awsEnv,
    AWS_SHARED_CREDENTIALS_FILE: `${SANDBOX_PREVIEW_AWS_DIR}/credentials`,
    AWS_CONFIG_FILE: `${SANDBOX_PREVIEW_AWS_DIR}/config`,
  };
  if (!force && now - previous < SANDBOX_AWS_REFRESH_MS) return pointers;
  const env = await writeSandboxPreviewAwsCredentials(
    sandbox,
    awsEnv,
    repoForPath(worktreeDir).previewAwsProfile,
  );
  if (env.AWS_SHARED_CREDENTIALS_FILE) sandboxAwsRefresh.set(sandbox.id, now);
  return env;
}

/** True when a TCP connect to 127.0.0.1:<port> succeeds INSIDE the sandbox. */
async function sandboxPortListening(
  sandbox: Sandbox,
  port: number,
): Promise<boolean> {
  const r = await sandbox.exec([
    "timeout",
    "2",
    "bash",
    "-c",
    `exec 3<>/dev/tcp/127.0.0.1/${port}`,
  ]);
  return r.exitCode === 0;
}

export async function getSandboxPreviewStatus(
  sandbox: Sandbox,
  worktreeDir: string,
  sessionId?: string,
): Promise<PreviewStatus> {
  // .ports.conf via the sandbox exec — works for bind mounts and is the only
  // way for volume-mode workspaces (no host copy).
  const conf = await sandbox.exec(["cat", ".ports.conf"]);
  const ports = conf.exitCode === 0 ? parsePortsText(conf.stdout) : [];
  const portalRecords = await listSandboxPortalServices(sandbox);
  const portalByKey = new Map(
    portalRecords.map((record) => [record.key, record]),
  );
  const portalsManifest = await sandbox.exec([
    "cat",
    `${LIFECYCLE_DIR}/portals.json`,
  ]);
  const portalRecipes = parsePreviewPortalRecipes(
    portalsManifest.exitCode === 0 ? portalsManifest.stdout : null,
  );
  const services: PreviewService[] = [];
  // Remote providers can publish a port on demand. Docker/microVM providers
  // may ignore this hint when their mappings are fixed at sandbox creation.
  const portMap = usesOutboundSandboxPortalRelay(sandbox.provider)
    ? {}
    : await sandbox.ports(ports.map((service) => service.port));
  const host = await previewHost();
  for (const { key, port } of ports) {
    const portal = portalByKey.get(key);
    // One probe per service. A managed Portal's state comes from
    // listSandboxPortalServices, which already spent that container round
    // trip; only unmanaged .ports.conf entries are connected to here.
    const state = portal
      ? portal.state
      : (await sandboxPortListening(sandbox, port))
        ? "awake"
        : "stopped";
    const running = state === "awake";
    let previewUrl: string | null = null;
    if (running && usesOutboundSandboxPortalRelay(sandbox.provider)) {
      previewUrl = sessionId
        ? await ensureRemoteSandboxPortalAgent({ sessionId, sandbox, port })
        : null;
    } else if (running) {
      const entry = portMap[port];
      const published = typeof entry === "number" ? entry : entry?.hostPort;
      const privateUpstream =
        typeof entry === "object" ? entry?.upstream : undefined;
      const directUrl = typeof entry === "object" ? entry?.url : undefined;
      const requestHeaders =
        typeof entry === "object" ? entry?.requestHeaders : undefined;
      if (directUrl || published || privateUpstream) {
        const httpsPort = sandboxHttpsPortFor(sandbox.id, port);
        const upstream =
          directUrl || privateUpstream
            ? localRelayFor(
                sandbox.id,
                port,
                directUrl || `http://${privateUpstream}`,
                requestHeaders,
              )
            : `127.0.0.1:${published}`;
        if (await ensurePreviewRoute(httpsPort, upstream, host, requestHeaders))
          previewUrl = `https://${host}:${httpsPort}`;
      }
    } else {
      const allocated = lookupSandboxHttpsPort(sandbox.id, port);
      if (allocated != null) await removePreviewRoute(allocated);
    }
    // PIDs are container-internal — meaningless to the host UI; leave empty.
    services.push({
      name:
        portalRecipes.find((recipe) => recipe.serviceKey === key)?.name ??
        portal?.name ??
        friendly(key),
      key,
      port,
      running,
      pids: [],
      previewUrl,
      ...(portal?.description ? { description: portal.description } : {}),
      ...(portal?.defaultPath ? { defaultPath: portal.defaultPath } : {}),
      state,
      ...(portal ? { managed: true } : {}),
    });
  }
  const webapp = services.find((s) => s.key === "WEBAPP_PORT");

  const tunnelValues: Record<string, string> = {};
  if (webapp?.previewUrl) tunnelValues.PREVIEW_URL = webapp.previewUrl;
  for (const service of services) {
    if (!service.previewUrl) continue;
    tunnelValues[`PREVIEW_URL_${service.port}`] = service.previewUrl;
    tunnelValues[`PORTAL_${service.key.replace(/_PORT$/, "")}_URL`] =
      service.previewUrl;
  }
  if (Object.keys(tunnelValues).length) {
    await writeSandboxTunnelsEnv(sandbox, worktreeDir, tunnelValues);
  }

  const previewUrl = webapp?.previewUrl || null;
  if (webapp?.running && !previewUrl) {
    console.warn(
      `[preview] ${sandbox.id}: webapp on ${webapp.port} is up in-container but the port isn't published — add it to sandbox previewPorts`,
    );
  }

  if (webapp?.running) {
    recordPreviewReady(worktreeDir, "sandbox", sandbox.provider);
    starting.delete(worktreeDir);
  }

  // Shared-file credentials rotate under long-running preview processes. This
  // also repairs portals started before profile vending existed as soon as a
  // status poll rediscovers them.
  if (services.some((service) => service.running)) {
    await sandboxPreviewAwsEnv(sandbox, worktreeDir).catch((error) =>
      console.warn(
        `[preview] ${sandbox.id}: AWS profile refresh failed:`,
        error,
      ),
    );
  }

  const status: PreviewStatus = {
    hasPortsConf: ports.length > 0,
    webappPort: webapp?.port ?? null,
    running: !!webapp?.running,
    starting: !webapp?.running && isStarting(worktreeDir),
    previewUrl,
    bootable:
      !!webapp?.running ||
      (await resolvePreviewBoot(
        worktreeDir,
        repoForPath(worktreeDir),
        sandboxExists(sandbox),
      )) != null,
    services,
    portalRecipes,
  };
  if (sessionId) cacheSandboxPortals(sessionId, sandbox.id, services);
  return status;
}

/** `exists` predicate for resolvePreviewBoot inside a sandbox. */
function sandboxExists(sandbox: Sandbox): (p: string) => Promise<boolean> {
  return async (p) => (await sandbox.exec(["test", "-f", p])).exitCode === 0;
}

/**
 * Seed `<worktree>/.ports.conf` so the in-container dev flow adopts the
 * chosen (pre-published) webapp port instead of allocating a random one that
 * isn't published. A repo's dev-services.sh may SOURCE an existing
 * .ports.conf and keeps any port that's free — inside the container's fresh
 * netns ours always is. When the file already exists we rewrite only the
 * WEBAPP_PORT line; when it's absent we write the full six-key file in
 * dev-services.sh's format (harmless for repos that ignore it — a lifecycle
 * start.sh just reads $WEBAPP_PORT from its env).
 */
export async function seedSandboxPortsConf(
  sandbox: Sandbox,
  worktreeDir: string,
  webappPort: number,
): Promise<void> {
  const conf = assertSafePath(`${worktreeDir}/.ports.conf`);
  const fresh = freshPortsConfText(webappPort, "sandbox preview").replace(
    /\n/g,
    "\\n",
  );
  await sandbox.exec([
    "sh",
    "-c",
    `if [ -f ${conf} ]; then ` +
      `if grep -q '^WEBAPP_PORT=' ${conf}; then sed -i 's/^WEBAPP_PORT=.*/WEBAPP_PORT=${webappPort}/' ${conf}; ` +
      `else printf '\\nWEBAPP_PORT=${webappPort}\\n' >> ${conf}; fi; ` +
      `else printf '${fresh}' > ${conf}; fi`,
  ]);
}

// Same command path as the remote runner bootstrap and Docker image. Preview
// lifecycle scripts are launched by provider SDK shells, which do not
// consistently source ~/.profile; without an explicit PATH a correctly
// installed Bun/CLI can still look missing.
const SANDBOX_PREVIEW_PATH =
  "/home/ubuntu/.bun/bin:/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * `.tunnels.env` contract (adopted from background-agents): when a sandbox
 * preview starts, opensession writes `<worktree>/.tunnels.env` — a dotenv file
 * in-container dev processes can source/read to learn their public URLs:
 *
 *   PREVIEW_URL=https://<host>:<httpsPort>          # the primary (webapp) URL
 *   PREVIEW_URL_<containerPort>=https://…           # one var per exposed port
 *
 * Stale files are removed on container (re)start (docker.ts's ensure) and on
 * preview stop; each preview start rewrites it whole.
 */
async function writeSandboxTunnelsEnv(
  sandbox: Sandbox,
  worktreeDir: string,
  vars: Record<string, string>,
): Promise<void> {
  const file = assertSafePath(`${worktreeDir}/.tunnels.env`);
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${shellQuoteWord(v)}`)
    .join("\n");
  await sandbox.exec([
    "sh",
    "-c",
    `printf '%s\\n' ${shellQuoteWord(body)} > ${shellQuoteWord(file)}`,
  ]);
  // Keep it out of the session diff: one idempotent line in the repo's shared
  // info/exclude (a repo may not gitignore .tunnels.env).
  await sandbox.exec([
    "sh",
    "-c",
    `ex="$(git rev-parse --git-path info/exclude 2>/dev/null)" && [ -n "$ex" ] && ` +
      `{ grep -qxF ".tunnels.env" "$ex" 2>/dev/null || echo ".tunnels.env" >> "$ex"; } || true`,
  ]);
}

/**
 * Bring the dev server up INSIDE the sandbox. Selecting a sandbox is the
 * explicit opt-in. The flow (docs in deploy/sandbox/README.md "Previews in
 * sandboxes"):
 *
 *  1. Pick a webapp port from the container's PRE-PUBLISHED preview range
 *     (docker -p at create; config `previewPorts`, default 3300-3302) —
 *     preferring the worktree's existing .ports.conf entry when it's one of
 *     them, else the first published port nothing listens on. All busy =
 *     range exhausted; we refuse with a warning (fallback: raise
 *     `previewPorts` in ~/.opensession-sandbox.json and let the container be
 *     recreated — mounts/ports are create-time).
 *  2. Seed .ports.conf with that port and write the .tunnels.env contract
 *     (PREVIEW_URL against the allocated sandbox https port).
 *  3. Run the bring-up, detached in-container, with WEBAPP_PORT/PREVIEW_URL/
 *     OPENSESSION_BOOT_MODE in its env. Command resolution (lifecycle
 *     convention): `<worktree>/.agents/start.sh` when present, else the
 *     repo's configured `previewCommand`.
 */
export function sandboxPreviewIdentityContext(
  sandbox: Pick<Sandbox, "id" | "provider">,
  repoId: string,
  trustProfile: "interactive" | "automation",
): WorkloadIdentityContext {
  return {
    sandboxId: sandbox.id,
    provider: sandbox.provider,
    lifecycle: "preview",
    repoId,
    trustProfile,
  };
}

export async function startSandboxPreview(
  sandbox: Sandbox,
  worktreeDir: string,
  sessionId?: string,
  trustProfile: "interactive" | "automation" = "interactive",
): Promise<PreviewStatus> {
  if (usesOutboundSandboxPortalRelay(sandbox.provider) && !sessionId)
    throw new Error("A remote Sandbox Portal requires its session identity.");
  const status = await getSandboxPreviewStatus(sandbox, worktreeDir, sessionId);
  if (status.running || status.starting) return status;

  // 1. Allocate a webapp port from the pre-published range.
  const portMap = usesOutboundSandboxPortalRelay(sandbox.provider)
    ? {}
    : await sandbox.ports();
  const publishedPorts = (
    usesOutboundSandboxPortalRelay(sandbox.provider)
      ? (sandboxConfig().previewPorts ?? [...DEFAULT_SANDBOX_PREVIEW_PORTS])
      : Object.keys(portMap).map(Number)
  )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!publishedPorts.length) {
    console.warn(
      `[preview] ${sandbox.id}: no preview ports are published — configure previewPorts and recreate the container`,
    );
    return status;
  }
  let port: number | null =
    status.webappPort != null && publishedPorts.includes(status.webappPort)
      ? status.webappPort
      : null;
  if (port == null) {
    for (const p of publishedPorts) {
      if (!(await sandboxPortListening(sandbox, p))) {
        port = p;
        break;
      }
    }
  }
  if (port == null) {
    console.warn(
      `[preview] ${sandbox.id}: preview port range exhausted (${publishedPorts.join(",")} all busy) — ` +
        `stop one, or widen previewPorts in ~/.opensession-sandbox.json and recreate the container`,
    );
    return status;
  }

  // 2. Resolve the bring-up command — the same chain as host previews
  //    (repo .agents/start.sh → previewCommand), with
  //    existence checked in-container.
  const boot = await resolvePreviewBoot(
    worktreeDir,
    repoForPath(worktreeDir),
    sandboxExists(sandbox),
  );
  if (!boot) {
    console.warn(
      `[preview] ${sandbox.id}: no .agents/start.sh or usable repo previewCommand in the sandbox — cannot start`,
    );
    return status;
  }
  const cmd = boot.cmd;

  // 3. Seed ports + tunnels, then launch detached in its own session (setsid
  //    → pgid recorded so stop can kill the whole tree; ensure-up.sh's inner
  //    `just dev` overwrites .ports/dev-pgid with its own group, which is the
  //    one that outlives the bring-up — either way the file points at the
  //    right group).
  await seedSandboxPortsConf(sandbox, worktreeDir, port);
  const entry = portMap[port];
  const directUrl = typeof entry === "object" ? entry.url : undefined;
  const privateUpstream =
    typeof entry === "object" ? entry.upstream : undefined;
  const published = typeof entry === "number" ? entry : entry?.hostPort;
  const requestHeaders =
    typeof entry === "object" ? entry.requestHeaders : undefined;
  const remotePortalUrl =
    usesOutboundSandboxPortalRelay(sandbox.provider) && sessionId
      ? await ensureRemoteSandboxPortalAgent({ sessionId, sandbox, port })
      : null;
  const upstream = remotePortalUrl
    ? undefined
    : directUrl || privateUpstream
      ? localRelayFor(
          sandbox.id,
          port,
          directUrl || `http://${privateUpstream}`,
          requestHeaders,
        )
      : `127.0.0.1:${published}`;
  const httpsPort = sandboxHttpsPortFor(sandbox.id, port);
  const host = await previewHost();
  const previewUrl = `https://${host}:${httpsPort}`;
  if (
    !remotePortalUrl &&
    !(await ensurePreviewRoute(httpsPort, upstream!, host, requestHeaders))
  ) {
    console.warn(
      `[preview] ${sandbox.id}: Caddy did not accept the sandbox preview portal route`,
    );
  }
  await writeSandboxTunnelsEnv(sandbox, worktreeDir, {
    PREVIEW_URL: previewUrl,
    [`PREVIEW_URL_${port}`]: previewUrl,
  });

  starting.set(worktreeDir, Date.now());
  const bootMode = sandbox.bootMode || "fresh";
  // A matching workload-identity grant is the sandbox credential boundary.
  // Retain the legacy instance credential path only for repositories that do
  // not have a grant yet, so migrations do not turn existing previews off.
  const workloadIdentityEnv = createWorkloadIdentityEnv(
    sandboxPreviewIdentityContext(
      sandbox,
      repoForPath(worktreeDir).id,
      trustProfile,
    ),
  );
  const awsEnv = Object.keys(workloadIdentityEnv).length
    ? {}
    : await sandboxPreviewAwsEnv(sandbox, worktreeDir, true);
  const r = await sandbox.exec(
    [
      "sh",
      "-c",
      `mkdir -p .ports && nohup setsid env HOME=/home/ubuntu PATH=${shellQuoteWord(SANDBOX_PREVIEW_PATH)} ` +
        `WEBAPP_PORT=${port} PREVIEW_URL=${shellQuoteWord(previewUrl)} ` +
        `OPENSESSION_BOOT_MODE=${shellQuoteWord(bootMode)} ` +
        `bash -c 'echo $$ > .ports/dev-pgid; exec ${cmd}' >> /tmp/backstage-preview.log 2>&1 &`,
    ],
    { env: { ...awsEnv, ...workloadIdentityEnv } },
  );
  if (r.exitCode !== 0) starting.delete(worktreeDir);
  return { ...status, starting: r.exitCode === 0 };
}

/**
 * Stop a sandboxed session's dev server: drop the Caddy route(s), signal the
 * bring-up's process group (.ports/dev-pgid, in-container), and clear the
 * .tunnels.env contract. pkill by pattern is safe HERE (unlike on the host,
 * where it was the "kills every session's webapp" trap) because the container
 * only ever hosts this one session's processes.
 */
export async function stopSandboxPreview(
  sandbox: Sandbox,
  worktreeDir: string,
): Promise<PreviewStatus> {
  starting.delete(worktreeDir);
  sandboxAwsRefresh.delete(sandbox.id);
  const conf = await sandbox.exec(["cat", ".ports.conf"]);
  const ports = conf.exitCode === 0 ? parsePortsText(conf.stdout) : [];
  for (const service of ports) {
    revokeSandboxPortalRelay(sandbox.id, service.port);
    forgetRemoteSandboxPortalAgents(sandbox.id, service.port);
    const allocated = lookupSandboxHttpsPort(sandbox.id, service.port);
    if (allocated != null) await removePreviewRoute(allocated);
  }
  await sandbox.exec([
    "bash",
    "-c",
    `[ -f .ports/dev-pgid ] && kill -TERM -- "-$(cat .ports/dev-pgid)" 2>/dev/null; true`,
  ]);
  await sandbox.exec(["pkill", "-f", "next dev"]);
  await sandbox.exec(["pkill", "-f", ".agents/start.sh"]);
  await sandbox.exec([
    "sh",
    "-c",
    `rm -f .ports/dev-pgid .tunnels.env ${SANDBOX_PREVIEW_AWS_DIR}/credentials ${SANDBOX_PREVIEW_AWS_DIR}/config`,
  ]);
  return getSandboxPreviewStatus(sandbox, worktreeDir);
}

/**
 * Teardown hook for DockerProvider.destroy(): release the sandbox's https
 * allocations and drop any Caddy routes still pointing at them.
 */
export async function dropSandboxPreviewRoutes(
  sandboxId: string,
  options: { preservePortalCache?: boolean } = {},
): Promise<void> {
  revokeSandboxPortalGrants(sandboxId);
  forgetRemoteSandboxPortalAgents(sandboxId);
  if (!options.preservePortalCache) dropCachedSandboxPortals(sandboxId);
  for (const [key, relay] of remotePortalRelays) {
    if (!key.startsWith(`${sandboxId}:`)) continue;
    try {
      relay.server.stop(true);
    } catch {}
    remotePortalRelays.delete(key);
  }
  for (const httpsPort of releaseSandboxPreviewPorts(sandboxId)) {
    // removePreviewRoute only touches routes this process cached — a destroy
    // right after a restart may miss the cache, so delete unconditionally.
    previewRoutes.delete(httpsPort);
    try {
      await caddyFetch(
        `${caddyAdmin()}/config/apps/http/servers/preview_${httpsPort}`,
        {
          method: "DELETE",
        },
      );
    } catch {}
  }
}
