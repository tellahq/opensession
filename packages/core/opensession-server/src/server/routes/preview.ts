/**
 * Dev-server ("Preview") lifecycle for a session's worktree: status, screenshot, start, stop.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import {
  getPreviewStatus,
  getSandboxPreviewStatus,
  portalRouteAuthorized,
  recipeStartOptions,
  sandboxPreviewIdentityContext,
  startPreview,
  startSandboxPreview,
  stopPreview,
  stopSandboxPreview,
} from "../preview";
import { findSessionAsync } from "../session-cache";
import { activeSandboxFor } from "../session-sandbox";
import { existsSync } from "fs";
import {
  restartPortalService,
  restartSandboxPortalService,
  startPortalService,
  startSandboxPortalService,
  stopPortalService,
  stopSandboxPortalService,
} from "../portal-supervisor";
import {
  restartRunnerPortal,
  runnerPortalPreviewStatus,
  startRunnerPortal,
  stopRunnerPortal,
} from "../runner-portals";
import { getRepo } from "../worktree";
import { sleepingSandboxPortalStatus } from "../sandbox-portals";
import type { UnifiedSession } from "../types";
import { createWorkloadIdentityEnv } from "../workload-identity";

export { recipeCommand } from "../preview";

export function unavailableSandboxPreviewStatus(
  session: Pick<UnifiedSession, "sandbox">,
) {
  const sandbox = session.sandbox;
  if (!sandbox?.provider) return null;
  return {
    hasPortsConf: false,
    webappPort: null,
    running: false,
    starting:
      sandbox.lifecycle === "preparing" || sandbox.lifecycle === "waking",
    previewUrl: null,
    bootable: false,
    services: [],
    sandboxLifecycle: sandbox.lifecycle || "preparing",
  };
}

export async function handlePreviewRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // Caddy-backed Portals authenticate every request through this endpoint
  // before proxying it to a session service. The global API auth gate has
  // already verified the Open Session cookie/Bearer token; returning 204 lets
  // Caddy continue, while an unauthenticated request never reaches here.
  if (/^\/api\/portal-auth\/\d+$/.test(path) && req.method === "GET") {
    const httpsPort = Number(path.slice(path.lastIndexOf("/") + 1));
    let recoveredNow = false;
    try {
      const { recoverSandboxPortalRoute, sandboxPortalRouteConnected } =
        await import("../sandbox-portal-recovery");
      // Caddy routes and their authorization can outlive the outbound relay.
      // Verify both on every authenticated request; a disconnected sandbox
      // gets a fresh sidecar before Caddy proxies to a dead loopback socket.
      if (
        !portalRouteAuthorized(httpsPort) ||
        !sandboxPortalRouteConnected(httpsPort)
      ) {
        recoveredNow = await recoverSandboxPortalRoute(httpsPort);
        if (!recoveredNow) {
          return Response.json(
            { error: "Portal route is not active" },
            { status: 404, headers: { "Cache-Control": "no-store" } },
          );
        }
      }
    } catch (error) {
      console.warn(`[preview] Portal ${httpsPort} recovery failed:`, error);
      return Response.json(
        { error: "Portal route is not active" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (recoveredNow) {
      // Caddy chose the old loopback upstream before forward_auth ran. A
      // same-origin redirect makes the browser retry against the route we
      // just replaced, instead of continuing to that dead process and
      // surfacing one misleading 502.
      return new Response(null, {
        status: 307,
        headers: {
          "Cache-Control": "no-store",
          Location: req.headers.get("x-forwarded-uri") || "/",
        },
      });
    }
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Local dev-server ("Preview") status for a session's worktree — which
  // services (.ports.conf) are listening, so the header can link to the
  // webapp and show/stop running processes.
  {
    const m = path.match(/^\/api\/sessions\/(.+)\/preview$/);
    if (m && req.method === "GET") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      // Sandboxed session with a running container: the dev server (if
      // any) lives in-container — status/ports/Caddy go through the
      // sandbox. Otherwise the host path below, unchanged.
      // Who this preview belongs to — the interstitial displays it so a
      // stale/reused tab can never masquerade as another session's wait.
      const who = {
        sessionTitle: session.title || null,
        sessionBranch: session.branch || null,
      };
      if (session.runner)
        return Response.json({
          ...(await runnerPortalPreviewStatus(
            session,
            session.startedBy || undefined,
          )),
          ...who,
        });
      const sbx = session.worktreeDir ? await activeSandboxFor(session) : null;
      if (sbx)
        return Response.json({
          ...(await getSandboxPreviewStatus(
            sbx,
            session.worktreeDir!,
            session.id,
          )),
          ...who,
        });
      if (session.sandbox?.sandboxId) {
        const sleeping = sleepingSandboxPortalStatus(
          session.id,
          session.sandbox.sandboxId,
        );
        if (sleeping) return Response.json({ ...sleeping, ...who });
      }
      const unavailableSandbox = unavailableSandboxPreviewStatus(session);
      if (unavailableSandbox)
        return Response.json({ ...unavailableSandbox, ...who });
      if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
        return Response.json({
          hasPortsConf: false,
          webappPort: null,
          running: false,
          starting: false,
          previewUrl: null,
          services: [],
          ...who,
        });
      }
      return Response.json({
        ...(await getPreviewStatus(session.worktreeDir)),
        ...who,
      });
    }
  }

  // Screenshot the running preview (headless Chrome → PNG).
  {
    const m = path.match(/^\/api\/sessions\/(.+)\/preview\/screenshot$/);
    if (m && req.method === "POST") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      const runnerStatus = session.runner
        ? await runnerPortalPreviewStatus(
            session,
            session.startedBy || undefined,
          )
        : null;
      const sbx = session.worktreeDir
        ? await activeSandboxFor(session, { wake: true })
        : null;
      const unavailableSandbox = unavailableSandboxPreviewStatus(session);
      if (!sbx && unavailableSandbox)
        return Response.json(
          { ...unavailableSandbox, error: "Sandbox is not ready for Preview" },
          { status: 409 },
        );
      if (
        !session.worktreeDir ||
        (!existsSync(session.worktreeDir) && !sbx && !runnerStatus)
      )
        return Response.json(
          { error: "Session has no worktree" },
          { status: 400 },
        );
      try {
        const { capturePreviewScreenshot } =
          await import("../../server/preview");
        // Sandboxed previews: hand the capture the sandbox-derived status
        // (host status can't see in-container listeners); the URL itself
        // is an ordinary Caddy-fronted https origin either way.
        const png = await capturePreviewScreenshot(session.worktreeDir, {
          ...(runnerStatus
            ? { status: runnerStatus }
            : sbx
              ? {
                  status: await getSandboxPreviewStatus(
                    sbx,
                    session.worktreeDir,
                    session.id,
                  ),
                }
              : {}),
        });
        return new Response(new Uint8Array(png), {
          headers: { "Content-Type": "image/png" },
        });
      } catch (e: any) {
        return Response.json(
          { error: e?.message || "Screenshot failed" },
          { status: 500 },
        );
      }
    }
  }

  // Start the session's dev server if it isn't up yet.
  {
    const m = path.match(/^\/api\/sessions\/(.+)\/preview\/start$/);
    if (m && req.method === "POST") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      const sbx = session.worktreeDir
        ? await activeSandboxFor(session, { wake: true })
        : null;
      if (sbx)
        return Response.json(
          await startSandboxPreview(sbx, session.worktreeDir!, session.id),
        );
      const unavailableSandbox = unavailableSandboxPreviewStatus(session);
      if (unavailableSandbox)
        return Response.json(
          { ...unavailableSandbox, error: "Sandbox is not ready for Preview" },
          { status: 409 },
        );
      if (session.runner) {
        const status = await runnerPortalPreviewStatus(
          session,
          session.startedBy || undefined,
        );
        if (status.running || status.starting) return Response.json(status);
        const repo = session.repo ? getRepo(session.repo) : undefined;
        const command = repo?.previewCommand
          ? `${repo.previewCommand} .`
          : "exec bash .agents/start.sh";
        await startRunnerPortal({
          session,
          user: session.startedBy || undefined,
          name: "webapp",
          command,
          description: "Repository app",
        });
        return Response.json(
          await runnerPortalPreviewStatus(
            session,
            session.startedBy || undefined,
          ),
        );
      }
      if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
        return Response.json({
          hasPortsConf: false,
          webappPort: null,
          running: false,
          starting: false,
          previewUrl: null,
          services: [],
        });
      }
      return Response.json(await startPreview(session.worktreeDir));
    }
  }

  // Stop the session's dev server (scoped to its worktree's process group).
  {
    const m = path.match(/^\/api\/sessions\/(.+)\/preview\/stop$/);
    if (m && req.method === "POST") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      // Sandboxed dev servers are stopped in-container (host pgids can't
      // reach them); also drops the Caddy route.
      const sbx = session.worktreeDir ? await activeSandboxFor(session) : null;
      if (sbx)
        return Response.json(
          await stopSandboxPreview(sbx, session.worktreeDir!),
        );
      const unavailableSandbox = unavailableSandboxPreviewStatus(session);
      if (unavailableSandbox) return Response.json(unavailableSandbox);
      if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
        return Response.json({
          hasPortsConf: false,
          webappPort: null,
          running: false,
          starting: false,
          previewUrl: null,
          services: [],
        });
      }
      return Response.json(await stopPreview(session.worktreeDir));
    }
  }

  // Declared repository Portals start directly under the supervisor. This is
  // an explicit compute action, so it may wake a sleeping Sandbox. The recipe
  // is re-read from the session workspace instead of accepting a browser-sent
  // command.
  {
    const m = path.match(
      /^\/api\/sessions\/(.+)\/portals\/([a-z0-9-]+)\/start$/,
    );
    if (m && req.method === "POST") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      try {
        const sandbox = session.worktreeDir
          ? await activeSandboxFor(session, { wake: true })
          : null;
        if (session.sandbox?.sandboxId && !sandbox)
          return Response.json(
            { error: "This session's Sandbox is unavailable" },
            { status: 409 },
          );
        if (!session.worktreeDir)
          return Response.json(
            { error: "Session has no Portal workspace" },
            { status: 400 },
          );
        const current = sandbox
          ? await getSandboxPreviewStatus(
              sandbox,
              session.worktreeDir,
              session.id,
            )
          : await getPreviewStatus(session.worktreeDir);
        const recipe = current.portalRecipes.find(
          (candidate) => candidate.id === m[2],
        );
        if (!recipe)
          return Response.json(
            { error: "Portal recipe not found" },
            { status: 404 },
          );
        const options = recipeStartOptions(recipe);
        if (session.runner) {
          await startRunnerPortal({
            session,
            user: session.startedBy || undefined,
            ...options,
          });
          return Response.json(
            await runnerPortalPreviewStatus(
              session,
              session.startedBy || undefined,
            ),
          );
        }
        if (sandbox) {
          const repo = getRepo(session.repo);
          const env = createWorkloadIdentityEnv(
            sandboxPreviewIdentityContext(sandbox, repo.id, "interactive"),
          );
          await startSandboxPortalService({
            sessionId: session.id,
            sandbox,
            ...options,
            env,
          });
          return Response.json(
            await getSandboxPreviewStatus(
              sandbox,
              session.worktreeDir,
              session.id,
            ),
          );
        }
        if (!existsSync(session.worktreeDir))
          return Response.json(
            { error: "Session has no Portal workspace" },
            { status: 400 },
          );
        await startPortalService({
          sessionId: session.id,
          worktreeDir: session.worktreeDir,
          ...options,
        });
        return Response.json(await getPreviewStatus(session.worktreeDir));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    }
  }

  // A Portal control is scoped to the named service in this session's own
  // workspace. An explicit restart is allowed to wake a Sandbox; stop stays
  // non-waking so an inspection action never starts compute by accident.
  {
    const m = path.match(
      /^\/api\/sessions\/(.+)\/portals\/([a-z0-9-]+)\/(stop|restart)$/,
    );
    if (m && req.method === "POST") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      try {
        if (session.runner) {
          if (m[3] === "stop")
            await stopRunnerPortal({
              session,
              user: session.startedBy || undefined,
              name: m[2],
            });
          else
            await restartRunnerPortal({
              session,
              user: session.startedBy || undefined,
              name: m[2],
            });
          return Response.json(
            await runnerPortalPreviewStatus(
              session,
              session.startedBy || undefined,
            ),
          );
        }
        const sandbox = session.worktreeDir
          ? await activeSandboxFor(session, { wake: m[3] === "restart" })
          : null;
        if (session.sandbox?.sandboxId && !sandbox)
          return Response.json(
            { error: "This session's Sandbox is sleeping or unavailable" },
            { status: 409 },
          );
        if (sandbox) {
          if (m[3] === "stop")
            await stopSandboxPortalService({
              sessionId: session.id,
              sandbox,
              name: m[2],
            });
          else {
            const status = await getSandboxPreviewStatus(
              sandbox,
              session.worktreeDir!,
              session.id,
            );
            const recipe = status.portalRecipes.find(
              (candidate) => candidate.id === m[2] && candidate.command,
            );
            const env = recipe
              ? createWorkloadIdentityEnv(
                  sandboxPreviewIdentityContext(
                    sandbox,
                    getRepo(session.repo).id,
                    "interactive",
                  ),
                )
              : undefined;
            await restartSandboxPortalService({
              sessionId: session.id,
              sandbox,
              ...(recipe ? recipeStartOptions(recipe) : { name: m[2] }),
              env,
            });
          }
          return Response.json(
            await getSandboxPreviewStatus(
              sandbox,
              session.worktreeDir!,
              session.id,
            ),
          );
        }
        if (!session.worktreeDir || !existsSync(session.worktreeDir))
          return Response.json(
            { error: "Session has no Portal workspace" },
            { status: 400 },
          );
        if (m[3] === "stop")
          await stopPortalService({
            sessionId: session.id,
            worktreeDir: session.worktreeDir,
            name: m[2],
          });
        else
          await restartPortalService({
            sessionId: session.id,
            worktreeDir: session.worktreeDir,
            name: m[2],
          });
        return Response.json(await getPreviewStatus(session.worktreeDir));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}
