#!/usr/bin/env bun

import { createGoalSelfMcpServer } from "./src/agents/slack/goal-tools";
import { type AgentModule } from "./src/agents/types";
import { loadIntegrations } from "./src/server/integrations/load";
import {
  activeAgentRunCount,
  activeDetachedAgentRunCount,
  resumeInterruptedRuns,
} from "./src/server/agent-runner";
import { startAccountHealthMonitor } from "./src/server/account-health";
import { startAnalyticsPrewarm } from "./src/server/analytics";
import { startDiskGc } from "./src/server/disk-gc";
import { startWorktreeReaper } from "./src/server/worktree-reaper";
import { startPortalReaper } from "./src/server/portal-supervisor";
import { startRunnerPortalReaper } from "./src/server/runner-portals";
import { startTodoReminderTicker } from "./src/server/todos";
import { startGeneratedTitleSweep } from "./src/server/generated-titles";
import { startLiveActivitySync } from "./src/server/live-activities";
import { startSessionListRuntimeSync } from "./src/server/session-list-runtime-sync";
import {
  drainPendingTranscriptWakeBatch,
  drainPendingTranscriptWakesAfter,
} from "./src/server/actor-transcript";
import { makeAskHandler, restorePendingAsks } from "./src/server/asks";
import {
  activeAutomationPreparationCount,
  automationResumeMcpForSession,
  ensureConfiguredAutomations,
  getWebhookRoutes,
  resumePendingAutomationRuns,
  setEventSessionCallback,
  settleResumedAutomationRun,
  startScheduler,
} from "./src/server/automations";
import { startUsagePoller } from "./src/server/claude-accounts";
import { startCodexUsagePoller } from "./src/server/codex-accounts";
import {
  FRONTEND_SRC,
  IS_DEV,
  SPA_HEADERS,
  ensureFrontendBuilt,
  frontend,
  isPrebuiltFrontend,
  preloadPreparedFrontend,
  scheduleFrontendRebuild,
  sharedCheckoutEditors,
  spaEntry,
} from "./src/server/frontend-build";
import { configuredIntegration } from "./src/server/config";
import { initHumanAsks } from "./src/server/human-asks";
import { interactiveMcpServers } from "./src/server/interactive-mcp";
import {
  homeDir,
  OPENSESSION_SESSIONS_DIR,
  stateDir,
} from "./src/server/paths";
import { shouldRedirectLegacyPublicPath } from "./src/server/legacy-public-prefix";
import { startPlainArchiveSweep } from "./src/server/plain-archive";
import { devInstanceBootError, isDevInstance } from "./src/server/dev-mode";
import { startPrReviewNotificationTicker } from "./src/server/pr-review-notifications";
import { startPublicIngress } from "./src/server/public-ingress";
import { ensureCloudflareTunnel } from "./src/server/ingress-settings";
import { startPrivateAppCertificateRenewal } from "./src/server/private-app-domain";
import {
  creationOwnsPrompt,
  readActiveShutdownSnapshot,
  recoverableLocalHostSnapshotRecords,
  recordRecoveredRunEvent,
  persistRecoveredRunUsage,
  restorePromptQueues,
  resumeDrainedSessions,
  settleRecoveredCreationOpening,
  snapshotActiveSessions,
  startLoopTicker,
} from "./src/server/run-session";
import { startMcpHttpServer, startRunRpcServer } from "./src/server/run-rpc";
import {
  handleSandboxWsUpgrade,
  startTimerPoisonHeartbeat,
  timerPoisonRequestCheck,
} from "./src/server/run-ws";
import {
  githubReconnectRequired,
  startGithubTokenRefresher,
} from "./src/server/github-auth";
import { startGoalTicker } from "./src/server/goal-runner";
import { startSessionHistoryIndexing } from "./src/server/session-index";
import { startEventLoopLagMonitor } from "./src/server/system-stats";
import { ensureWarmTemplateScheduler } from "./src/server/warm-template";
import { handleRunnerWsUpgrade } from "./src/server/runner-ws";
import { handleSandboxPortalRelayUpgrade } from "./src/server/sandbox-portal-relay";
import { handleWorkloadIdentityRequest } from "./src/server/workload-identity";
import {
  enrichSessionRuntime,
  findSession,
  findSessionAsync,
  getCachedSessions,
  invalidateSessionsCache,
  reconcileRecoverableSafetyFences,
  recordRunOutcome,
  startSessionOwnershipWatchdog,
  stopSessionOwnershipWatchdog,
} from "./src/server/session-cache";
import { getSessionControl } from "./src/server/session-control";
import { buildReposNote } from "./src/server/session-repos";
import { destroySessionSandbox } from "./src/server/session-sandbox";
import { getAllSessions } from "./src/server/sessions";
import {
  crossSiteViolation,
  ensureAutomationWebSession,
  keypadBearerAuthorized,
  migrateSessionsToGithubUser,
  resolveWebAuth,
  type WebIdentity,
  webAuthRequired,
} from "./src/server/web-auth";
import { configureWebhookRoutes } from "./src/server/webhook-server";
import { prImagePublicRoutes } from "./src/server/pr-images";
import {
  sessionHtmlWithSocialMeta,
  sessionSocialCardPublicRoutes,
  socialSessionIdFromPath,
} from "./src/server/session-social-card";
import { sweepArchivedWorktrees } from "./src/server/worktree";
import { type WSClientData, broadcastToAll } from "./src/server/ws-hub";
import { mkdirSync, watch, writeFileSync } from "fs";
import { join } from "node:path";

// Side-effect modules: these must be loaded even when the entry references
// nothing from them — they register builders and listeners. Registration is a
// cheap in-memory assignment and stays at module scope; anything that binds a
// socket or arms a ticker is started explicitly instead (see the listener
// block below and the boot block further down), so importing the server graph
// from a script or a test never touches live resources.
import "./src/server/interactive-mcp"; // registerInteractiveMcpBuilder
import { hydratePersistedQueueState } from "./src/server/queue-state";
import { hydrateScheduledPromptTimers } from "./src/server/scheduled-prompts";
import { beginShutdown } from "./src/server/shutdown-state";
import { setServiceReadiness } from "./src/server/service-readiness";
import {
  acquireGatewayActivationLease,
  waitForGatewayActivationIfStandby,
  waitForRuntimePeerGeneration,
} from "./src/server/gateway-activation";
import {
  reconcileSessionKernelOwnership,
  sessionKernel,
  startSessionKernelActor,
  startSessionKernelRuntime,
  stopSessionKernelRuntime,
} from "./src/server/session-kernel";
import { activeRunRecords } from "./src/server/run-journal";
import {
  markInterruptedWorkflows,
  pauseWorkflowsForShutdown,
} from "./src/server/workflow-store";
import { recoverInterruptedWorkflows } from "./src/server/workflow-runner";
import "./src/server/session-control-wiring"; // opensession-sessions MCP + Slack-link bridge
import "./src/server/keychain"; // registers the keychain human-ask domain handler
import { websocketHandlers } from "./src/server/ws-handlers";
import { routeHandlers, type RouteContext } from "./src/server/routes";

// Under the stable supervisor, PORT/HOST remain the public address while the
// child binds the private backend override. Direct and dev launches keep the
// original PORT/HOST behavior.
const PORT = parseInt(
  process.env.OPENSESSION_GATEWAY_BACKEND_PORT || process.env.PORT || "3850",
);
const HOST =
  process.env.OPENSESSION_GATEWAY_BACKEND_HOST ||
  process.env.HOST ||
  "127.0.0.1";
const HOME = homeDir();
const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

// Gateway-only candidates validate the already-running peer generations before
// the supervisor drains the active child. A mismatch then rejects the candidate
// with no user-visible cut-over. Coordinated candidates cannot precheck changed
// peers because those peers start only after the old gateway is fenced.
const precheckRuntimePeers =
  process.env.OPENSESSION_GATEWAY_PRECHECK_PEERS === "1";
if (process.env.OPENSESSION_GATEWAY_ROLE === "standby")
  preloadPreparedFrontend();
if (precheckRuntimePeers)
  await waitForRuntimePeerGeneration({ timeoutMs: 5_000 });
// A supervised standby is allowed to preload this import graph, but it cannot
// proceed into even the earliest shared-state, socket, Worker, timer, or
// integration effect until its parent explicitly activates the exact nonce.
await waitForGatewayActivationIfStandby();
if (!precheckRuntimePeers) await waitForRuntimePeerGeneration();
// The OS lock is the final ownership fence. A supervisor crash or stale parent
// can leave an old child serving, but no replacement may cross into effects
// until that process has exited and released this lease.
const gatewayOwnership = globalThis as typeof globalThis & {
  __opensessionGatewayActivationLease?: Awaited<
    ReturnType<typeof acquireGatewayActivationLease>
  >;
};
if (!gatewayOwnership.__opensessionGatewayActivationLease) {
  gatewayOwnership.__opensessionGatewayActivationLease =
    await acquireGatewayActivationLease();
}
// Standby describes only the preload phase. After the nonce and ownership
// fences release, this child owns ingress and later frontend promotions must
// be allowed to replace the stable shell served by the supervisor.
process.env.OPENSESSION_GATEWAY_ROLE = "active";

// A dev instance (OPENSESSION_DEV=1, src/server/dev-mode.ts) sharing the live
// state is the fleet-outage class bug: the run-rpc unix socket lives under the
// sessions dir, and a second instance would unlink and steal it from the
// production process (2026-07-16/17). Refuse to boot without isolation.
// This check now runs BEFORE any listener is bound (the binds moved out of
// module scope, below), and run-rpc.ts still carries the same fail-closed
// guard around the socket bind itself.
{
  const devBootError = devInstanceBootError();
  if (devBootError) {
    console.error(devBootError);
    process.exit(1);
  }
}

// Listeners the server owns. Deliberately started HERE and not as module side
// effects: interactive-mcp.ts used to bind both at import, so any script, test
// or one-off bun process reaching that import chain took the live server's
// run-rpc socket out from under it (2026-07-16, 2026-07-17, 2026-08-16).
// Outside the __opensessionBooted block on purpose — both are idempotent and
// re-point their handler through globalThis, which is how a `bun --hot` reload
// picks up new code without rebinding.
startRunRpcServer();
startMcpHttpServer();
// Same reasoning for the timer-poison heartbeat: re-checked on every
// evaluation, which is exactly when a hot reload may have killed the timers.
startTimerPoisonHeartbeat();

mkdirSync(SESSIONS_DIR, { recursive: true });

// --- Hot-reload support (bun --hot) ---------------------------------------
// Under `bun --hot`, editing a module re-evaluates this entry file in the SAME
// process, preserving `globalThis`. We exploit that so simple tweaks apply
// without dropping WebSocket clients or killing in-flight runs: live state
// (watchers, pending questions, queues) is parked on globalThis so the fresh
// module binding reuses the same instances, the HTTP/WS server is reloaded in
// place rather than rebound, and all one-time setup (agents, schedulers, timers,
// signal handlers) is guarded behind `__opensessionBooted` so it never stacks.
// Long-lived agent *loop code* still needs a real restart — but that's now
// graceful (see SIGTERM handler below). A plain `bun run` (no --hot) just runs
// each branch once, exactly as before.
const g = globalThis as any;

// The actor owns the writable kernel store before any gateway projection hydrates.
if (!g.__opensessionBooted) await startSessionKernelActor();

// Loaded agents (Plain/Linear/Slack/Stripe/…). Module-scoped because request
// handlers (health routes) read it, and globalThis-backed so the set survives a
// hot reload (loadAgents runs only on a real boot, inside the guard below).
let agents: AgentModule[] = (g.__agents as AgentModule[] | undefined) ?? [];

// A cold process must load durable interaction state before it can accept a
// request that persists these globalThis-backed maps. Hot reloads reuse the
// live maps and skip this branch.
if (!g.__opensessionBooted && !isDevInstance()) {
  initHumanAsks();
  await restorePendingAsks();
  await hydratePersistedQueueState();
}

const gatewayProcessLabel = process.env.OPENSESSION_GATEWAY_BACKEND_PORT
  ? "gateway backend"
  : "server";
console.log(
  `Starting Open Session ${gatewayProcessLabel} on ${HOST}:${PORT}...`,
);

// The SPA bundle, before anything can ask for it. frontend-build.ts used to
// compile it at import instead, which meant any script or test that reached a
// route module built the whole app — the same import-time-resource hazard the
// listeners above moved out of module scope. Awaited here rather than lazily
// per request so a cold boot still binds with the shell ready, and idempotent,
// so a `bun --hot` reload passes straight through.
await ensureFrontendBuilt();

// Reuse the listening server across hot reloads so existing WebSocket clients
// and in-flight runs survive a tweak; a fresh `bun run` just creates it once.
// On every hot re-evaluation the freshly evaluated handlers (routes/fetch/
// websocket) are swapped into the LIVE server via server.reload() — a bare
// `??=` binding would keep the first evaluation's closures serving forever,
// which is exactly how route edits silently stopped hot-applying.
function hotServe(
  options: Parameters<typeof Bun.serve<WSClientData>>[0],
): import("bun").Server<WSClientData> {
  const live = g.__opensessionServer as
    | import("bun").Server<WSClientData>
    | undefined;
  if (!live) return (g.__opensessionServer = Bun.serve<WSClientData>(options));
  try {
    // reload's declared type is narrower than the full serve options, but it
    // accepts (and swaps) routes/fetch/websocket at runtime.
    live.reload(options as any);
  } catch (e) {
    console.error(
      "[hot-reload] server.reload failed — old handlers keep serving:",
      e,
    );
  }
  return live;
}

const sessionSpaEntry = (() => {
  const bundle = frontend;
  if (!bundle) return spaEntry;
  return async (req: Request) => {
    if (!bundle.version)
      return new Response("Frontend is still building", { status: 503 });
    const pathname = new URL(req.url).pathname;
    const id = socialSessionIdFromPath(pathname);
    // findSessionAsync reads a native session directly and otherwise scans
    // cooperatively, so a deep link opens without blocking the event loop
    // while a large sidebar cache warms.
    const session = id ? await findSessionAsync(id) : undefined;
    return new Response(
      session
        ? sessionHtmlWithSocialMeta(bundle.indexHtml, session, pathname)
        : bundle.indexHtml,
      { headers: SPA_HEADERS },
    );
  };
})();

const server: import("bun").Server<WSClientData> = hotServe({
  port: PORT,
  hostname: HOST,
  // The plain-triage route waits for worktree+session boot (~15-60s);
  // Bun's default 10s idleTimeout would drop the connection mid-wait
  idleTimeout: 240,

  // The SPA shell is served at the bare domain root only (os.tella.dev,
  // 2026-07-10) — no path prefix. Old /opensession + /backstage page URLs
  // 301 onto the root form in the fetch preamble below.
  //
  // Keep this list complete for every client-side route: the SPA fallback
  // further down is gated on the PROD bundle (`frontend` is null under
  // OPENSESSION_DEV=1), so on a dev/demo instance anything missing here
  // 404s instead of deep-linking — /workspace/<id>/review did exactly
  // that (2026-08-05).
  routes: Object.fromEntries(
    [
      "/",
      "/index.html",
      // Client-side routes must serve the SPA shell, not the raw file
      "/new",
      "/welcome",
      "/session/*",
      "/workspace/*",
      "/pr/*",
      "/automations",
      "/automations/*",
      "/security",
      "/goals",
      "/goals/*",
      "/tasks",
      "/analytics",
      "/reports",
      "/reports/*",
      "/support-tinder",
      "/connections",
      "/settings",
      "/settings/*",
      "/archived",
      "/catchup",
      "/reviews",
      "/reviews/*",
      "/support/*",
    ].map((p) => [
      p,
      p === "/session/*" || p === "/workspace/*" ? sessionSpaEntry : spaEntry,
    ]),
  ),

  async fetch(req) {
    // Timer-poisoning watchdog: timer delivery can die process-wide while
    // HTTP keeps serving. Requests are the one signal
    // that keeps flowing, so each one runs the O(1) staleness check; a
    // confirmed poisoning self-restarts the process (run-ws.ts tripwire).
    timerPoisonRequestCheck();
    const url = new URL(req.url);
    const workloadIdentity = await handleWorkloadIdentityRequest(req);
    if (workloadIdentity) return workloadIdentity;
    // The bare domain root is the ONLY public URL form (os.tella.dev,
    // 2026-07-10 — prefixes dropped) and handlers below match bare
    // paths. Historical prefixes (/opensession, then the pre-rename
    // /backstage) are accepted here and stripped: page loads 301 to the
    // root form; everything else normalizes silently instead of
    // redirecting — WebSocket upgrades (dial-back URLs baked into
    // RUNNING sandboxes carry a prefix) and API calls from
    // not-yet-reloaded tabs (a redirect would break POSTs).
    let path = url.pathname;
    const publicPrefix =
      path === "/opensession" || path.startsWith("/opensession/")
        ? "/opensession"
        : path === "/backstage" || path.startsWith("/backstage/")
          ? "/backstage"
          : "";
    if (publicPrefix) {
      path = path.slice(publicPrefix.length) || "/";
      if (
        shouldRedirectLegacyPublicPath(
          req.method,
          req.headers.get("upgrade"),
          path,
        )
      ) {
        return Response.redirect(path + url.search, 301);
      }
    }

    // Cross-site rejection (web-auth.ts crossSiteViolation): browser
    // cross-site mutations and cross-site UI-WS upgrades are refused
    // regardless of auth mode — SameSite=Lax already blocks the cookie
    // riding along, but no-sign-in deployments have no cookie at all.
    // Non-browser callers (no Origin/Sec-Fetch-Site) pass through; the
    // sandbox run-ws/rpc-ws dial-backs are machine clients gated by
    // their own per-launch tokens and never match these paths.
    {
      const mutation =
        path.startsWith("/api/") &&
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        req.method !== "OPTIONS";
      if (mutation || path === "/ws") {
        const violation = crossSiteViolation(req);
        if (violation) {
          return Response.json(
            { error: `Cross-site request rejected (${violation})` },
            { status: 403 },
          );
        }
      }
    }

    // GitHub-backed sign-in gate (src/server/web-auth.ts) — active only
    // when per-user GitHub auth is opted in (config integrations.github.
    // userPrAuth). Every API call and the UI WebSocket then require the
    // HttpOnly session cookie (or a Bearer token from the sessions file,
    // for curl/CDP callers). Exempt: /api/auth/* (how you get in), the
    // sandbox run-ws/rpc-ws dial-backs (own per-launch token gate), and
    // page/asset loads (the sign-in screen must render). The verified
    // identity rides RouteContext and the WS upgrade data, where it
    // overrides any client-claimed user name.
    const hostedLoopback = isLoopbackHostname(url.hostname);
    let authUser: WebIdentity | null = null;
    // A dead GitHub grant is a dead session, and the 401 says so rather
    // than pretending the cookie went missing: the client then asks for a
    // reconnect instead of a sign-in it thinks it already did.
    let reconnectRequired = false;
    if (webAuthRequired()) {
      authUser = resolveWebAuth(req);
      // Server-local CDP/CLI traffic has its own machine principal. A
      // teammate's cookie must never let automation act as that person.
      if (hostedLoopback && authUser?.automation !== true) authUser = null;
      // Refused, never destroyed (githubReconnectRequired): the person
      // re-authorizes and both halves are repaired, and if GitHub itself
      // is the problem, turning userPrAuth off restores everyone.
      if (
        authUser &&
        authUser.automation !== true &&
        githubReconnectRequired(authUser.login)
      ) {
        reconnectRequired = true;
        authUser = null;
      }
      // GET /api/health stays open: it's the liveness signal for
      // deploy.sh's post-restart poll, monitors, and the client's
      // bootId-change detection — all pre-auth by nature.
      const openHealth =
        req.method === "GET" &&
        (path === "/api/health" || path === "/live" || path === "/ready");
      const keypadBearer =
        path === "/api/keypad" &&
        req.method === "GET" &&
        keypadBearerAuthorized(req);
      // The Open Session mac shell's Squirrel updater and Chrome's extension
      // updater (os1-chrome) fetch their update feeds and artifacts
      // with plain clients (no cookies); tailnet-only exposure makes
      // these safe to leave open, like /api/health.
      const openOs1Update =
        (path.startsWith("/api/packages/clients/mac/") ||
          path.startsWith("/api/packages/clients/chrome/") ||
          // v0.4.0 and earlier point Squirrel at this legacy prefix.
          path.startsWith("/api/os1-mac/") ||
          path.startsWith("/api/os1-chrome/")) &&
        req.method === "GET";
      // A Runner dialling in has no browser session: it registers with a
      // one-time pairing code and then heartbeats with its own bearer
      // token. Both routes do their own authentication AND require the
      // caller to be on the tailnet (src/server/runners.ts),
      // so the sign-in gate would only make them impossible to use.
      const openRunnerAuth =
        (path === "/api/runners/register" ||
          path === "/api/runners/heartbeat") &&
        req.method === "POST";
      // The keychain broker's caller is an agent subprocess on
      // loopback with no browser session. Its own credential is the
      // grant id in the path: unguessable, scoped to one credential
      // and one session's approved purpose, method/path-limited,
      // expiring, revocable and audited per call (src/server/
      // keychain.ts). Same reasoning as the node routes above.
      const openKeychainBroker = path.startsWith("/api/keychain/broker/");
      if (
        !authUser &&
        !openHealth &&
        !keypadBearer &&
        !openOs1Update &&
        !openRunnerAuth &&
        !openKeychainBroker &&
        ((path.startsWith("/api/") && !path.startsWith("/api/auth/")) ||
          path === "/ws" ||
          // Agent-published apps (src/server/deploys.ts). Explicitly
          // listed because /d/ is a page-ish path, and page loads are
          // otherwise left open so the sign-in screen can render — a
          // published app must get Open Session's audience, not a
          // wider one.
          /^\/(?:opensession\/)?d\//.test(path))
      ) {
        return Response.json(
          reconnectRequired
            ? {
                error: "Reconnect your GitHub account to continue.",
                reconnectRequired: true,
              }
            : { error: "Sign in required" },
          { status: 401 },
        );
      }
    }

    // Every API/asset route lives in src/server/routes/* — ordered domain
    // handlers that return undefined to fall through. Only the WebSocket
    // upgrades, the SPA fallback and the 404 stay here (they need `server`
    // or must run last).
    const ctx: RouteContext = { req, url, path, publicPrefix, authUser };
    for (const handler of routeHandlers) {
      const res = await handler(ctx);
      if (res) return res;
    }

    // WebSocket upgrade
    if (path === "/ws") {
      // The verified identity is stamped in the historical picker format
      // (first name — what createdBy/attribution have always stored);
      // the GitHub login rides along for createdByLogin stamping.
      const authFirst = authUser ? authUser.name.split(" ")[0] : null;
      const upgraded = server.upgrade(req, {
        data: {
          watchingSessionId: null,
          user: authFirst,
          authUser: authFirst,
          authLogin: authUser?.login || null,
          authAutomation: authUser?.automation === true,
          // Headful/headless CDP browsers used by agents open the hosted app
          // through loopback and can leave inspection tabs alive for days. They
          // may subscribe to transcripts, but are never a human looking at the
          // session. Local-profile clients are deliberately exempt: loopback is
          // their real user-facing transport.
          away: hostedLoopback || authUser?.automation === true,
          // Internal presence provenance only: when a face is reported on a
          // session its owner never opened, the watch needs to be traceable to
          // web / native / TUI / a local-profile proxy without logging tokens.
          ...({
            presenceClient: req.headers.get("user-agent") || "unknown",
            presenceSuppressed: hostedLoopback || authUser?.automation === true,
          } as Record<string, unknown>),
        },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // Sandbox WS transport (Phase 3): run hosts + MCP proxies inside
    // sandboxes dial back here instead of sharing unix sockets. BOTH
    // routes are gated BEFORE the upgrade on the run's per-launch
    // wsToken (hostId-keyed, registered only by ws-transport launches —
    // docker-ws / remote adapters), constant-time compared; rpc-ws
    // additionally needs ?host=<hostId>. Plain run-rpc tokens are NOT
    // network credentials: on a sandbox-less deployment the registry is
    // empty and every upgrade here is a 403. See src/server/run-ws.ts.
    // Runners dial back here (src/server/runner-ws.ts). Its own block:
    // nesting it inside the sandbox condition meant it never ran and the
    // path fell through to the SPA fallback, which answered 200.
    // Tailnet-gated and token-authenticated before the upgrade.
    if (path === "/runner-ws") {
      const rejected = handleRunnerWsUpgrade(req, server, path);
      return rejected ?? (undefined as any);
    }
    if (path === "/sandbox-portal-ws") {
      return handleSandboxPortalRelayUpgrade(req, server, path);
    }

    if (path.startsWith("/run-ws/") || path === "/rpc-ws") {
      return handleSandboxWsUpgrade(req, server, path);
    }

    // SPA fallback: any unmatched non-API GET serves the app shell, so
    // client-side routes deep-link correctly even when they're missing
    // from the explicit `routes` map above (which has silently 404'd
    // every newly added view — settings, actions — until someone
    // remembered to register it).
    if (
      frontend &&
      (req.method === "GET" || req.method === "HEAD") &&
      !path.startsWith("/api/")
    ) {
      return new Response(frontend.indexHtml, {
        headers: SPA_HEADERS,
      });
    }

    // 404
    return Response.json({ error: "Not found" }, { status: 404 });
  },

  // UI WebSocket handlers live in src/server/ws-handlers.ts (sandbox
  // transport sockets are delegated to run-ws.ts inside them).
  websocket: websocketHandlers,

  // Dev mode (HMR + error overlay + browser-console streaming) only when
  // explicitly asked for — the systemd service is production, and the overlay
  // pops "Script error." boxes on iOS with no diagnostics behind them.
  development:
    process.env.OPENSESSION_DEV === "1"
      ? {
          hmr: true,
          console: true,
        }
      : false,
});

console.log(
  `Open Session ${gatewayProcessLabel} running at http://${HOST}:${PORT}/`,
);

// --- Agent loading and webhook server ---

async function loadAgents(): Promise<AgentModule[]> {
  // Every integration is declared in src/server/integrations/registry.ts;
  // this is a loop over that registry, not a hand-written chain. Add an
  // integration there, not here.
  return await loadIntegrations({
    onSessionInvalidate: () => {
      invalidateSessionsCache();
    },
  });
}

// One-time startup: agents, schedulers, recurring timers, and signal handlers.
// Guarded behind __opensessionBooted so a `bun --hot` reload never double-starts
// any of it — the already-running agents/timers keep going untouched (only a
// real restart reloads their code, and that restart is now graceful, below).
if (!g.__opensessionBooted) {
  // Pi runs Claude Max through the installed `claude` CLI (the Anthropic
  // bridge hands the Agent SDK pathToClaudeCodeExecutable); nothing bundled
  // stands in for it. Warn at boot, loudly, if it is not a usable executable,
  // but keep serving: the operator fixes it by installing the CLI, not by
  // restarting a dead server.
  {
    const { configuredPaths } = await import("./src/server/config");
    const { existsSync } = await import("fs");
    const configured = configuredPaths().claudeBin;
    const claudeBin =
      configured && configured !== "claude" ? configured : Bun.which("claude");
    if (!claudeBin || !existsSync(claudeBin)) {
      console.error(
        "[engine] the `claude` CLI is not installed — Anthropic turns cannot run.\n" +
          "[engine] install it: curl -fsSL https://claude.ai/install.sh | bash",
      );
    } else {
      console.log(`[engine] claude CLI ${claudeBin}`);
    }
  }

  // Pi's SDK can take over a minute to load cold. Keep the loader import-inert,
  // then warm it explicitly from the process boot owner when Pi is enabled.
  void import("./src/server/pi-config")
    .then(async ({ piEngineEnabled }) => {
      if (!piEngineEnabled()) return;
      const { prewarmPiSdk } = await import("./src/server/pi-runner");
      await prewarmPiSdk();
    })
    .catch((error) =>
      console.warn("[pi-runner] Pi SDK prewarm failed:", error),
    );

  // Dev instances (src/server/dev-mode.ts) skip background work here:
  // no agents, no webhook intake, no schedulers/sweeps, no detached-server
  // adoption — a second instance next to production must never double-send
  // or steal live runs. State writes are additionally isolated (the
  // devInstanceBootError guard at the top of this file enforces it).
  const devInstance = isDevInstance();
  startSessionListRuntimeSync();
  if (!devInstance) {
    startLiveActivitySync();

    // Restore completed sandbox prewarms and maintain any explicit keep-ready
    // targets. This is a boot hook rather than a module-scope side effect.
    void import("./src/server/sandbox/prewarm")
      .then(async ({ startPrewarmPool }) => {
        // Restoration happens synchronously before the first sweep await. Do not
        // make snapshot maintenance wait behind slow provider orphan cleanup.
        const poolStartup = startPrewarmPool();
        const { startSandboxEnvironmentMaintenance } =
          await import("./src/server/sandbox/environments");
        startSandboxEnvironmentMaintenance();
        // Modal has no docker daemon to piggyback on: its idle stop is a
        // server-owned sweep (checkpoint → terminate → lifecycle sleeping).
        // Armed here so an idle sandbox left by a previous process is still
        // stopped even if no new ensure/get ever runs.
        const { ensureModalIdleSweep } =
          await import("./src/server/sandbox/adapters/modal");
        ensureModalIdleSweep();
        await poolStartup;
      })
      .catch((e) => console.error("[sandbox-prewarm] startup failed:", e));

    // Build the exact public route allowlist before binding the one isolated
    // ingress gateway. Webhooks, sandbox callbacks and workload identity share
    // :3860; the private app on :3850 is never part of this listener.
    agents = await loadAgents();
    g.__agents = agents;
    const webhookRoutes = getWebhookRoutes(() => {
      invalidateSessionsCache();
    });
    for (const [key, handler] of prImagePublicRoutes()) {
      webhookRoutes.set(key, handler);
    }
    for (const [key, handler] of sessionSocialCardPublicRoutes()) {
      webhookRoutes.set(key, handler);
    }
    configureWebhookRoutes(agents, webhookRoutes);
    try {
      startPublicIngress();
      ensureCloudflareTunnel();
      startPrivateAppCertificateRenewal();
    } catch (e) {
      console.error("[public-ingress] failed to start:", e);
    }

    // Optional instance seed pack. Generic installations start empty; existing
    // records and anything created through the UI are unaffected.
    if (configuredIntegration("seeds").enabled === true) {
      try {
        ensureConfiguredAutomations();
      } catch (e) {
        console.error("[seeds] Failed to seed instance automations:", e);
      }
    }

    // Published internal apps (src/server/deploys.ts) are supervised child
    // processes, so a restart of this server takes them with it — bring back
    // everything that wasn't deliberately stopped.
    try {
      const { relaunchDeploys } = await import("./src/server/deploys");
      relaunchDeploys();
    } catch (e) {
      console.error("[deploys] relaunch on boot failed:", e);
    }

    // Cron-scheduled automations + internal event bus (agents → automations)
    const onAutomationSession = () => invalidateSessionsCache();
    setEventSessionCallback(onAutomationSession);
    const resumedAutomationIntents =
      resumePendingAutomationRuns(onAutomationSession);
    if (resumedAutomationIntents)
      console.log(
        `[automations] Resumed ${resumedAutomationIntents} pre-launch intent(s)`,
      );
    startScheduler(onAutomationSession);
    startPrReviewNotificationTicker();

    // Scheduled prompts are durable SessionKernel timers. The runtime starts
    // after run recovery below; hydrate their rows before that gate opens.
    hydrateScheduledPromptTimers();

    // Archive triage sessions when their Plain ticket is done.
    startPlainArchiveSweep(() => {
      invalidateSessionsCache();
    });

    // Unattended installs stage a Claude token in the env or a file; import it
    // into the pool before anything can ask for an account.
    // Poll per-account Claude usage (drives account picking + the Connections UI)
    startUsagePoller();
    // Poll supported ChatGPT/Codex rate-limit windows per registered CODEX_HOME.
    startCodexUsagePoller();

    // DM account owners when pool credentials expire or break (account-health.ts)
    startAccountHealthMonitor();

    // Reclaim rust target/ build caches from idle worktrees we keep (disk-gc.ts)
    startDiskGc();

    // Keep the Analytics presets' summaries warm so the view opens instantly
    // (analytics.ts — gh fetches + composed summaries are disk-cached too)
    startAnalyticsPrewarm();

    // Remove worktrees whose work is merged / PR closed, sweep removal husks.
    // Re-enrich the cached rows on every pass: stored session rows do not carry
    // live Pi/actor run state, and reaping an old-but-running session is destructive.
    startWorktreeReaper(() => enrichSessionRuntime(getCachedSessions()));

    // Portal processes survive a coordinator restart by design. Reconcile their
    // durable owner records immediately and keep reaping deleted-session husks.
    startPortalReaper(getAllSessions);
    startRunnerPortalReaper();

    // Desk todo reminders: push + Slack DM when a remindAt passes (todos.ts)
    startTodoReminderTicker();

    // Keep per-user GitHub grants fresh (github-auth.ts). One process only: a
    // refresh rotates the shared refresh token, so a second ticker anywhere
    // invalidates the grant.
    startGithubTokenRefresher();

    // Warm dev-server pool + warm git templates: docker-level sweeps, so only
    // the server that owns the daemon runs them.
    ensureWarmTemplateScheduler();

    // Fire due /loop self-prompts and wake due goals — both start real engine
    // runs, so they belong to this process alone.
    startLoopTicker();
    startGoalTicker();

    // Finished sessions push durable per-session history index timers. This
    // registers the handler only; it never scans the session fleet.
    startSessionHistoryIndexing();

    // Gateway event-loop lag telemetry for /api/health and the health MCP tool
    // (system-stats.ts). The session-performance contract only measures the
    // client; this is the server-side counterpart.
    startEventLoopLagMonitor();

    // Re-try sidebar titles whose one-shot died in flight (a restart, or an
    // engine-spawn outage) — without this they stay raw forever.
    startGeneratedTitleSweep(() => {
      invalidateSessionsCache();
    });
  } else {
    agents = [];
    g.__agents = agents;
    console.log(
      "[dev-mode] Dev instance: background agents, webhooks and schedulers are disabled",
    );
  }

  // code.storage-hosted repos: make sure existing main checkouts have the
  // URL-scoped credential helper wired, so ambient git fetch/push mints fresh
  // JWTs. Idempotent (read-before-write) and a no-op unless
  // integrations.codeStorage is configured; runs in every boot mode because
  // registration isn't the only way a checkout appears.
  void import("./src/server/codestorage/remote")
    .then((m) => m.adoptCsCheckouts())
    .catch((e) =>
      console.error("[codestorage] checkout credential adoption failed:", e),
    );

  // Resume Claude runs a previous process left in-flight (restart/crash), then
  // wake any session that finished its turn during the shutdown drain (so the
  // journal no longer held it). Together these wake every session that was
  // active before the restart.
  // Dev instances skip the whole block: their isolated namespace has nothing
  // to resume, and resumeInterruptedRuns/restorePromptQueues re-prompt and
  // re-deliver — the classic double-send if any state were shared.
  if (!devInstance) {
    setServiceReadiness("recovering");
    setTimeout(() => {
      void (async () => {
        try {
          // Release only actor-proven repairable safety fences before claiming the
          // run journal. If this happens later in the watchdog, the boot recovery
          // sweep has already skipped the quarantined lineage and its terminal host
          // receipt can remain stranded behind a ghost owner until another restart.
          await reconcileRecoverableSafetyFences();
          const shutdownRecords = readActiveShutdownSnapshot();
          const resumedIds = await resumeInterruptedRuns(
            async (bksSessionId, terminalEvent, recoveredRun) => {
              if (bksSessionId && terminalEvent) {
                const failed =
                  terminalEvent.type === "error" ||
                  !!terminalEvent.usageLimitExhausted;
                const settlementErrors: unknown[] = [];
                try {
                  await persistRecoveredRunUsage(
                    bksSessionId,
                    terminalEvent,
                    recoveredRun?.runKey,
                  );
                } catch (error) {
                  settlementErrors.push(error);
                }
                try {
                  await recordRunOutcome(
                    bksSessionId,
                    failed
                      ? terminalEvent.content ||
                          terminalEvent.result ||
                          "Recovered run failed"
                      : null,
                    // A resumed run can land in a fresh engine session (reattach
                    // failed and the re-prompt rotated), and the error path never
                    // persists that id — so name it here, or the failure chip is
                    // written into the transcript the conversation left behind.
                    {
                      ...(recoveredRun?.runKey
                        ? {
                            runId: recoveredRun.runKey,
                            runGeneration:
                              sessionKernel(bksSessionId).runStateProjection()
                                .generation,
                            projectionId: `outcome:${recoveredRun.runKey}`,
                          }
                        : {}),
                      engineSessionId: terminalEvent.sessionId,
                      noticeLabel: terminalEvent.usageLimitExhausted
                        ? "Run stopped"
                        : undefined,
                    },
                  );
                } catch (error) {
                  settlementErrors.push(error);
                }
                if (recoveredRun?.promptEntryId) {
                  try {
                    await settleRecoveredCreationOpening(
                      bksSessionId,
                      recoveredRun.promptEntryId,
                      failed
                        ? terminalEvent.content ||
                            terminalEvent.result ||
                            "Recovered opening run failed"
                        : undefined,
                      recoveredRun.runKey,
                    );
                  } catch (error) {
                    settlementErrors.push(error);
                  }
                }
                // The in-process settleRun died with the restart — close the
                // automation ledger entry here or it stays "running" forever.
                settleResumedAutomationRun(
                  bksSessionId,
                  failed
                    ? terminalEvent.content ||
                        terminalEvent.result ||
                        "Recovered run failed"
                    : null,
                );
                if (settlementErrors.length)
                  throw new AggregateError(
                    settlementErrors,
                    "Recovered run settlement was incomplete",
                  );
              }
              invalidateSessionsCache();
            },
            // Re-attach the AskUserQuestion handler so a run that was blocked on an
            // ask (web UI or Slack escalation) can ask again after the restart instead
            // of dead-ending headless. Automations stay headless by design.
            (bksSessionId) => {
              const session = findSession(bksSessionId);
              if (
                !session ||
                session.source !== "opensession" ||
                session.automation
              )
                return undefined;
              return makeAskHandler(bksSessionId);
            },
            (bksSessionId, user) => {
              // Fail-soft: a broken rebuild must degrade the resumed run to
              // tool-less, never wedge the boot-resume sweep.
              try {
                const session = findSession(bksSessionId);
                if (!session || session.source !== "opensession")
                  return undefined;
                // Automation-owned sessions rebuild the run's OWN server set
                // (report/papercuts/workflows/self/turn — the automation bar,
                // never the interactive admin/sessions surface). Required for pi
                // resumes: in-process engines hold no surviving stdio proxies, so
                // without this the re-prompted run is tool-less. Harmless for
                // pi — its rebuilt proxies resolve through run-rpc's
                // fail-closed automation fallback either way.
                if (session.automation)
                  return automationResumeMcpForSession(session, bksSessionId);
                const servers: Record<string, unknown> = session.goalId
                  ? {
                      ...interactiveMcpServers(user, bksSessionId),
                      "opensession-goal-self": createGoalSelfMcpServer(
                        session.goalId,
                      ),
                    }
                  : interactiveMcpServers(user, bksSessionId);
                return servers;
              } catch (e) {
                console.error(
                  `[runner] In-process MCP rebuild failed for ${bksSessionId}:`,
                  e,
                );
                return undefined;
              }
            },
            (bksSessionId) => {
              const session = findSession(bksSessionId);
              if (
                !session ||
                session.source !== "opensession" ||
                session.automation
              )
                return undefined;
              return buildReposNote(session);
            },
            recordRecoveredRunEvent,
            recoverableLocalHostSnapshotRecords(shutdownRecords),
            (run) =>
              !!run.osSessionId &&
              !!run.promptEntryId &&
              !!(run.runnerId || run.sandboxId) &&
              creationOwnsPrompt(run.osSessionId, run.promptEntryId),
          );
          if (resumedIds.length > 0) {
            console.log(
              `[runner] Resumed ${resumedIds.length} interrupted run(s) from before restart`,
            );
            invalidateSessionsCache();
          }
          resumeDrainedSessions(new Set(resumedIds), shutdownRecords);
          // Re-deliver messages that were queued/steered when the process went down.
          await restorePromptQueues(new Set(resumedIds));
          const ownedSessionIds = new Set(
            activeRunRecords()
              .map((run) => run.osSessionId)
              .filter((id): id is string => !!id),
          );
          for (const id of resumedIds) ownedSessionIds.add(id);
          const staleKernelOwners =
            await reconcileSessionKernelOwnership(ownedSessionIds);
          if (staleKernelOwners.length)
            console.warn(
              `[session-kernel] Settled ${staleKernelOwners.length} session(s) without a recoverable run owner`,
            );
        } catch (error) {
          throw error;
        }
        markInterruptedWorkflows();
        const recoveredWorkflows = await recoverInterruptedWorkflows();
        if (recoveredWorkflows.length)
          console.log(
            `[workflow] Recovered ${recoveredWorkflows.length} interrupted workflow(s)`,
          );
        // Transcript mutations commit their durable wake before gateway bus
        // delivery. Drain crash-window wakes before readiness so a replacement or
        // deletion does not wait for another mutation to become visible.
        const transcriptWakeBatch = await drainPendingTranscriptWakeBatch();
        if (transcriptWakeBatch.drained > 0)
          console.log(
            `[transcript] Reconciled ${transcriptWakeBatch.drained} pending wake(s) before readiness`,
          );
        if (!transcriptWakeBatch.complete)
          void drainPendingTranscriptWakesAfter(
            transcriptWakeBatch.nextAfter,
          ).catch((error) =>
            console.error("[transcript] background wake drain failed:", error),
          );
        // Only now may durable timers and effects wake actors: every recovery
        // stage above completed and ownership is established.
        startSessionKernelRuntime();
        startSessionOwnershipWatchdog();
        setServiceReadiness("ready");
      })().catch((error) => {
        setServiceReadiness("failed", error);
        console.error(
          "[session-kernel] recovery gate failed; restarting fail-closed:",
          error,
        );
        setTimeout(() => process.exit(1), 1_000).unref?.();
      });
      // Yield once so the listener and boot-time registries finish installing,
      // then recover immediately. The old fixed 1.5s delay had no ownership or
      // readiness prerequisite and only extended every handoff.
    }, 0);
  } else {
    setServiceReadiness("ready");
  }

  // Ongoing hygiene (every 6h): remove worktrees of sessions that were manually
  // archived more than 14 days ago and have no WIP. Destructive on the shared
  // filesystem/docker daemon, so dev instances skip it too.
  if (!devInstance)
    setInterval(
      async () => {
        try {
          const removed = await sweepArchivedWorktrees(getAllSessions(), 14);
          if (removed.length > 0) {
            console.log(
              `[worktree-sweep] Removed ${removed.length} clean worktree(s): ${removed.join(", ")}`,
            );
            invalidateSessionsCache();
          }
        } catch (e) {
          console.error("[worktree-sweep] Sweep failed:", e);
        }
        // Sandboxes of long-idle archived sessions, same cadence as the
        // worktree sweep: containers + engine-state volumes are provider-owned
        // and safe to drop (bind-mode worktrees belong to the sweep above and
        // are untouched). Volume-mode workspaces die with the sandbox — the
        // documented contract of that mode (push your work). A revived session
        // just re-ensures a fresh container on its next prompt.
        try {
          const cutoff = Date.now() - 14 * 86_400_000;
          for (const s of getAllSessions()) {
            if (!s.sandbox?.sandboxId || !s.archived || s.isRunning) continue;
            if (new Date(s.lastActivity).getTime() >= cutoff) continue;
            destroySessionSandbox(s, "archive-sweep", true);
          }
        } catch (e) {
          console.error("[sandbox-sweep] Sweep failed:", e);
        }
      },
      6 * 60 * 60 * 1000,
    );

  // Run agent startup hooks
  for (const agent of agents) {
    try {
      await agent.startup();
      console.log(`[agents] ${agent.name} agent started`);
    } catch (e) {
      console.error(`[agents] ${agent.name} agent startup failed:`, e);
    }
  }

  // Graceful shutdown: stop taking new work, let in-flight runs reach a natural
  // stopping point (bounded), then exit — instead of killing every run mid-turn.
  // Anything still running after the drain window is picked up by the run
  // journal on the next boot (resumeInterruptedRuns), so nothing is lost.
  // 10s default: enough for short preparation/finalization work to settle
  // without making every busy deploy wait a full minute. Anything still running
  // is resumed from the run journal on the next boot (and self-heals transient
  // failures via the fallback graph), so this bound costs a little redo work,
  // not lost work. Must stay below the unit's TimeoutStopSec (80s), or
  // systemd SIGKILLs the process mid-drain.
  const DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_MS || "10000");
  const HANDOFF_DRAIN_TIMEOUT_MS = parseInt(
    process.env.HANDOFF_SHUTDOWN_DRAIN_MS || "1000",
  );
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    setServiceReadiness("draining");
    // Cross-module flag: run-session's queue drain parks new prompts from
    // here on (the next boot delivers them) instead of starting turns that
    // race the drain deadline.
    beginShutdown();
    // With poisoned timers (see run-ws.ts tripwire)
    // every `await sleep` and Promise.race timeout below would wedge forever
    // and systemd would SIGKILL us at TimeoutStopSec (observed: an 80s
    // "restart"). Nothing timer-driven can drain anyway, so skip straight to
    // snapshot → stop → exit; the journal resumes/reattaches runs on boot.
    const timersDead = !!(globalThis as any).__timersPoisonedAt;
    // Announce and yield before any shutdown bookkeeping. The session snapshot
    // and runtime teardown can block the event loop for seconds under load,
    // which used to make a real restart look like unexplained UI slowness.
    broadcastToAll({ type: "server_restarting" });
    if (!timersDead) await new Promise((r) => setTimeout(r, 50));
    stopSessionKernelRuntime();
    stopSessionOwnershipWatchdog();
    console.log(
      `[shutdown] ${signal} — stopping intake and draining in-flight runs…` +
        (timersDead ? " (timers poisoned: skipping every timed wait)" : ""),
    );
    // Snapshot active sessions BEFORE the drain — the drain lets runs finish
    // their turn and clear themselves from the journal, so this is the only
    // record of sessions that should be woken on the next boot. Dev
    // instances skip it (nothing resumes them, and a snapshot must never
    // make the production boot try to wake dev sessions).
    if (!devInstance) snapshotActiveSessions();
    const pausedWorkflows = pauseWorkflowsForShutdown();
    if (pausedWorkflows)
      console.log(
        `[shutdown] paused ${pausedWorkflows} workflow(s) for journal recovery`,
      );
    // Best-effort attribution: a session-triggered `systemctl restart` shows
    // up as an in-flight run in this checkout (sharedCheckoutEditors). The
    // marker file lets the NEXT boot's hello frame name the culprit in the
    // post-restart toast; the `by` here feeds the pre-restart overlay.
    const restartBy = sharedCheckoutEditors();
    try {
      // A dev instance must not overwrite the production restart marker.
      if (!devInstance) {
        writeFileSync(
          stateDir("last-restart.json"),
          JSON.stringify({
            by: restartBy || "",
            at: new Date().toISOString(),
            signal,
          }),
        );
      }
    } catch {}
    // Update the already-visible notice when attribution is available, then
    // yield once more so that frame flushes before agent teardown.
    if (restartBy) broadcastToAll({ type: "server_restarting", by: restartBy });
    if (!timersDead) await new Promise((r) => setTimeout(r, 100));
    // Stop agents from accepting new work (Slack socket, webhook intake, …).
    // BOUNDED: an agent shutdown that awaits a flaky network call (e.g. the
    // Slack socket close during a Slack outage) used to hang here for the
    // whole TimeoutStopSec — the drain loop below never even started and
    // systemd SIGKILLed everything at 140s (observed 2026-07-09 10:15).
    for (const agent of timersDead ? [] : agents) {
      const t0 = Date.now();
      try {
        const r = await Promise.race([
          Promise.resolve(agent.shutdown()).then(() => "ok" as const),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000)),
        ]);
        if (r === "timeout") {
          console.warn(
            `[shutdown] ${agent.name} shutdown still pending after 10s — moving on`,
          );
        } else {
          console.log(
            `[shutdown] ${agent.name} stopped (${Date.now() - t0}ms)`,
          );
        }
      } catch (e) {
        console.error(`[shutdown] ${agent.name} shutdown error:`, e);
      }
    }
    // Wait for runner-driven runs (web UI / automations / loops) to settle —
    // but ONLY the ones a restart would actually kill. Runs on DETACHED
    // engine servers (pi-detach.ts) survive the restart: their
    // detached run-host units live outside this unit's cgroup and keep
    // executing, and the next boot adopts the servers + reattaches the runs
    // from the journal. Waiting on those would just delay the restart.
    const undrainable = () =>
      Math.max(
        activeAutomationPreparationCount(),
        Math.max(0, activeAgentRunCount() - activeDetachedAgentRunCount()),
      );
    const drainTimeoutMs =
      signal === "SIGUSR2" ? HANDOFF_DRAIN_TIMEOUT_MS : DRAIN_TIMEOUT_MS;
    const deadline = timersDead ? 0 : Date.now() + drainTimeoutMs;
    let n = undrainable();
    while (n > 0 && Date.now() < deadline) {
      console.log(`[shutdown] waiting on ${n} in-flight run(s)…`);
      await new Promise((r) => setTimeout(r, 500));
      n = undrainable();
    }
    if (n > 0) {
      console.log(
        `[shutdown] ${n} run(s) still active after ${drainTimeoutMs}ms — the journal will resume them on restart`,
      );
    } else {
      console.log("[shutdown] all in-flight runs drained cleanly");
    }
    const surviving = activeDetachedAgentRunCount();
    if (surviving > 0) {
      console.log(
        `[shutdown] ${surviving} run(s) continue on detached engine servers — reattaching on next boot`,
      );
    }
    // Keep HTTP available while runs drain. Stopping the listener before the
    // bounded wait made Caddy return 502 for the full drain window on every
    // deploy. Shutdown-aware intake above already parks new agent work.
    try {
      server.stop();
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGUSR2", () => void gracefulShutdown("SIGUSR2"));
  // The run-ws timer-poison tripwire calls this when timer death is confirmed:
  // same snapshot+exit path as a signal, and the
  // timersDead branch above keeps it free of timed waits. systemd's
  // Restart=always then boots a clean process within RestartSec.
  (globalThis as any).__poisonExit = () =>
    void gracefulShutdown("TIMER_POISON");

  // Frontend live-reload: rebuild the SPA bundle in-process when its source
  // changes, so a CSS/frontend tweak no longer needs a `systemctl restart` that
  // interrupts every running session. `kill -USR2 <pid>` forces it too (drop-in
  // for restart in a deploy script). Guarded by __opensessionBooted so a hot
  // reload doesn't stack watchers/handlers. recursive watch needs Linux ≥ 6.x
  // (we're on 6.17) — fine here.
  // A prebuilt bundle (compiled binary's embedded assets, or a release
  // tarball's .frontend-dist) has no src/frontend tree to watch.
  if (!IS_DEV && frontend && isPrebuiltFrontend()) {
    console.log("[frontend] Prebuilt bundle: source rebuilds are off");
  } else if (!IS_DEV && frontend) {
    try {
      const watcher = watch(FRONTEND_SRC, { recursive: true }, (_evt, file) => {
        if (file && /\.(tsx?|css|html)$/.test(file.toString())) {
          scheduleFrontendRebuild(`watch:${file}`);
        }
      });
      process.on("exit", () => watcher.close());
      console.log(`[frontend] Watching ${FRONTEND_SRC} for live rebuilds`);
    } catch (e) {
      console.error(
        "[frontend] Could not start file-watch (use /api/rebuild-frontend):",
        e,
      );
    }
  }

  // One-time (marker-guarded): when GitHub web sign-in is active, backfill
  // createdByLogin on pre-existing sessions so they belong to the same
  // verified person after the identity switch. No-op while the feature is
  // off — flipping it on in config takes effect at the next boot. Dev
  // instances skip it: a differently-configured dev boot must never
  // re-decide the migration over its (or worse, shared) session files.
  try {
    if (!devInstance) {
      ensureAutomationWebSession();
      migrateSessionsToGithubUser();
    }
  } catch (e) {
    console.error("[web-auth] session migration failed:", e);
  }

  // Demo dataset hook: seeds synthetic sessions/state in-process (live asks
  // can't be faked from disk). The module is optional — type-erased dynamic
  // import so the tree typechecks without it, catch so boot never dies.
  if (process.env.OPENSESSION_DEMO === "1") {
    void import("./src/server/demo" as string)
      .then((m) => (m as { startDemo: () => Promise<void> }).startDemo())
      .catch((e) => console.error("[demo] startDemo failed:", e));
  }

  g.__opensessionBooted = true;
}
