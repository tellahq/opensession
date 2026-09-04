/**
 * Portal status for a session workspace, host or Sandbox.
 *
 * A workspace's services live in `<worktree>/.ports.conf`:
 *
 *   # opensession-portal {"name":"tella-local","key":"WEBAPP_PORT",...}
 *   WEBAPP_PORT=3300
 *   INSTANT_PORT=5968
 *
 * Supervised Portals (portal-supervisor.ts) own the `# opensession-portal`
 * records; plain `KEY_PORT=` lines are services the repository's own tooling
 * started. Every listening service gets an authenticated HTTPS origin on this
 * machine's host via Caddy (forward_auth against /api/portal-auth, then a
 * reverse proxy to a loopback upstream), so each session gets its own secure
 * origin: `https://<host>:<httpsPort>`.
 *
 * Host services map to `port + 6000`; Sandbox services get an allocated port
 * from [20000, 28000) keyed by (sandboxId, port) — sandbox/preview-ports.ts.
 * Remote Sandboxes cannot be dialed from this host, so their upstream is the
 * outbound Portal relay (sandbox-portal-relay.ts).
 */
import { $ } from "bun";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  ensureRemoteSandboxPortalAgent,
  forgetRemoteSandboxPortalAgents,
  listPortalServices,
  listSandboxPortalServices,
} from "./portal-supervisor";
import { revokeSandboxPortalGrants } from "./sandbox-portal-relay";
import {
  cacheSandboxPortals,
  dropCachedSandboxPortals,
} from "./sandbox-portals";
import {
  lookupSandboxHttpsPort,
  releaseSandboxPreviewPorts,
  sandboxHttpsPortFor,
} from "./sandbox/preview-ports";
import type { Sandbox } from "./sandbox/provider";
import { shellQuoteWord } from "./sandbox/adapters/bootstrap";
import { usesOutboundSandboxPortalRelay } from "./sandbox/config";
import { configuredServer } from "./config";
import type { WorkloadIdentityContext } from "./workload-identity";

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
  services: PreviewService[];
  /** Declarative starters from .agents/portals.json. */
  portalRecipes: PreviewPortalRecipe[];
  /** Present when the session's Sandbox cannot be inspected right now. */
  sandboxLifecycle?:
    | "preparing"
    | "awake"
    | "sleeping"
    | "waking"
    | "needs_attention";
}

/** The declared Portal a repository considers its main app: the one keyed
 *  WEBAPP_PORT, else the first recipe. */
export function defaultPortalRecipe(
  recipes: PreviewPortalRecipe[],
): PreviewPortalRecipe | undefined {
  return (
    recipes.find((recipe) => recipe.serviceKey === "WEBAPP_PORT") ?? recipes[0]
  );
}

export function recipeCommand(recipe: PreviewPortalRecipe): string {
  if (!recipe.command)
    throw new Error("This Portal still needs an agent-assisted starter.");
  // PORT and PORTAL_URL are the contract. A recipe that names its service key
  // also gets that key exported, and the WEBAPP_PORT/PREVIEW_URL pair keeps
  // repositories written against the earlier host Preview contract booting.
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

// The repo lifecycle dir (docs/repo-lifecycle.md): `.agents/setup` (one-shot
// provisioning), `.agents/resume` (runs on every wake), `.agents/portals.json`
// (the services Open Session can supervise).
const LIFECYCLE_DIR = ".agents";

function hostPreviewPortalRecipes(worktreeDir: string): PreviewPortalRecipe[] {
  try {
    return parsePreviewPortalRecipes(
      readFileSync(join(worktreeDir, LIFECYCLE_DIR, "portals.json"), "utf8"),
    );
  } catch {
    return [];
  }
}

/** What a repo's committed lifecycle directory provides. Read straight off
 *  the main checkout for Settings → Setup, which tells operators whether
 *  sessions in that repo can prepare themselves and expose their app.
 *  Docs: docs/repo-lifecycle.md. */
export interface RepoLifecycle {
  /** The lifecycle dir (`.agents`), or null when the repo doesn't commit one. */
  dir: string | null;
  setup: boolean;
  resume: boolean;
  /** `.agents/portals.json` declares at least one Portal. */
  portals: boolean;
}

/** Inspect `repoRoot`'s lifecycle dir. */
export function repoLifecycle(repoRoot: string): RepoLifecycle {
  const base = `${repoRoot}/${LIFECYCLE_DIR}`;
  if (existsSync(base)) {
    return {
      dir: LIFECYCLE_DIR,
      setup: existsSync(`${base}/setup`),
      resume: existsSync(`${base}/resume`),
      portals: hostPreviewPortalRecipes(repoRoot).length > 0,
    };
  }
  return { dir: null, setup: false, resume: false, portals: false };
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
 * One process-wide socket snapshot for every open session's Portal poll.
 * `ss -p` walks the host process table, so spawning it once per service made
 * status polling consume a core and delayed unrelated session traffic.
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

// ── HTTPS exposure via Caddy ──────────────────────────────────────────────────
// Caddy (admin API on localhost:2019) already terminates TLS for this machine's
// host name. We add one reverse-proxy server per listening service, on a
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
// (survives --hot reloads).
const previewRoutes: Map<number, string> = (g.__previewRoutes ??= new Map());

/** Caddy may outlive Open Session. Auth must fail closed for a route the
 * current process has not rediscovered and registered, or a stale Caddy
 * upstream could survive a restart and later point at an unrelated listener. */
export function portalRouteAuthorized(httpsPort: number): boolean {
  return Number.isInteger(httpsPort) && previewRoutes.has(httpsPort);
}

/** Hostname shared with the OpenSession UI so its auth cookie rides across
 * Portal ports. Operators can override it explicitly with PREVIEW_HOST. */
export async function previewHost(): Promise<string> {
  if (g.__previewHost) return g.__previewHost;
  const host = configuredServer().previewHost;
  g.__previewHost = host;
  return host;
}

// Host dev ports are 3100-3999 and globally unique among running servers, so
// +6000 gives a unique, stable HTTPS port in 9100-9999.
export function httpsPortFor(port: number): number {
  return port + 6000;
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

/** Add/refresh the Caddy server for this service (idempotent, cached). */
async function ensurePreviewRoute(
  httpsPort: number,
  upstream: string,
  host: string,
): Promise<boolean> {
  const signature = JSON.stringify([upstream]);
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
    // across an opensession restart, so our cache is cold) it 409s — drop it
    // and recreate so the route always points at the current upstream.
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

/** Portal status for a host workspace. */
export async function getPreviewStatus(
  worktreeDir: string,
): Promise<PreviewStatus> {
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
      // Root-owned listeners show no pid to non-root `ss -p` — a listening
      // socket counts as running even when we can't see who owns it.
      const awake = pids.length > 0 || (await portListening(port));
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
  return { services, portalRecipes };
}

// ── Sandbox Portals (docs/self-hosting-sandboxes.md) ─────────────────────────
// A Sandbox session's services run INSIDE the sandbox, so the host-side
// mechanics above can't see them: `ss` can't observe remote listeners. These
// variants keep the same PreviewStatus shape and reuse the identical Caddy
// plumbing; the upstream is the authenticated outbound Portal relay.

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

/** The repository's declared Portals as seen from inside the Sandbox. */
export async function sandboxPortalRecipes(
  sandbox: Sandbox,
): Promise<PreviewPortalRecipe[]> {
  const manifest = await sandbox.exec(["cat", `${LIFECYCLE_DIR}/portals.json`]);
  return parsePreviewPortalRecipes(
    manifest.exitCode === 0 ? manifest.stdout : null,
  );
}

export async function getSandboxPreviewStatus(
  sandbox: Sandbox,
  worktreeDir: string,
  sessionId?: string,
): Promise<PreviewStatus> {
  // .ports.conf via the sandbox exec: the workspace has no host copy.
  const conf = await sandbox.exec(["cat", ".ports.conf"]);
  const ports = conf.exitCode === 0 ? parsePortsText(conf.stdout) : [];
  const portalRecords = await listSandboxPortalServices(sandbox);
  const portalByKey = new Map(
    portalRecords.map((record) => [record.key, record]),
  );
  const portalRecipes = await sandboxPortalRecipes(sandbox);
  const services: PreviewService[] = [];
  const relayed = usesOutboundSandboxPortalRelay(sandbox.provider);
  const host = await previewHost();
  for (const { key, port } of ports) {
    const portal = portalByKey.get(key);
    // One probe per service. A managed Portal's state comes from
    // listSandboxPortalServices, which already spent that round trip; only
    // unmanaged .ports.conf entries are connected to here.
    const state = portal
      ? portal.state
      : (await sandboxPortListening(sandbox, port))
        ? "awake"
        : "stopped";
    const running = state === "awake";
    let previewUrl: string | null = null;
    if (running && relayed) {
      previewUrl = sessionId
        ? await ensureRemoteSandboxPortalAgent({ sessionId, sandbox, port })
        : null;
    } else if (running) {
      const entry = (await sandbox.ports([port]))[port];
      const published = typeof entry === "number" ? entry : entry?.hostPort;
      if (published) {
        const httpsPort = sandboxHttpsPortFor(sandbox.id, port);
        if (await ensurePreviewRoute(httpsPort, `127.0.0.1:${published}`, host))
          previewUrl = `https://${host}:${httpsPort}`;
      }
    } else {
      const allocated = lookupSandboxHttpsPort(sandbox.id, port);
      if (allocated != null) await removePreviewRoute(allocated);
    }
    // PIDs are sandbox-internal — meaningless to the host UI; leave empty.
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
  const status: PreviewStatus = { services, portalRecipes };
  if (sessionId) cacheSandboxPortals(sessionId, sandbox.id, services);
  return status;
}

/**
 * Teardown hook for a destroyed or replaced Sandbox: release its https
 * allocations and drop any Caddy routes still pointing at them.
 */
export async function dropSandboxPreviewRoutes(
  sandboxId: string,
  options: { preservePortalCache?: boolean } = {},
): Promise<void> {
  revokeSandboxPortalGrants(sandboxId);
  forgetRemoteSandboxPortalAgents(sandboxId);
  if (!options.preservePortalCache) dropCachedSandboxPortals(sandboxId);
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
