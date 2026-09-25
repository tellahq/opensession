/**
 * Portal routes for a session workspace: status, declared-Portal start, and
 * per-Portal stop/restart. Every handler returns a Response for a matched
 * route or undefined to fall through (see routes/index.ts).
 */

import type { RouteContext } from "./context";
import {
  getPreviewStatus,
  getSandboxPreviewStatus,
  portalRouteAuthorized,
  recipeStartOptions,
  sandboxPreviewIdentityContext,
  seedHostEnvFiles,
  type PreviewStatus,
} from "../preview";
import { findSessionAsync } from "../session-cache";
import {
  portalSandboxProvider,
  portalsInSandbox,
  sandboxForPortals,
} from "../portal-sandbox";
import { existsSync } from "fs";
import {
  hostPortalRouteStatus,
  restartPortalService,
  restartSandboxPortalService,
  startPortalService,
  startSandboxPortalService,
  stopPortalService,
  stopSandboxPortalService,
  wakeHostPortalRoute,
} from "../portal-supervisor";
import {
  restartRunnerPortal,
  runnerPortalPreviewStatus,
  startRunnerPortal,
  stopRunnerPortal,
} from "../runner-portals";
import { getRepo } from "../worktree";
import { configuredServer } from "../config";
import { portalNavigationRequest } from "../portal-sign-in";
import { hostPortalActivity } from "../portal-lifecycle";
import { portalWaitingResponse } from "../portal-waiting-page";
import { sleepingSandboxPortalStatus } from "../sandbox-portals";
import type { UnifiedSession } from "../types";
import { createWorkloadIdentityEnv } from "../workload-identity";

export { recipeCommand } from "../preview";

const EMPTY_STATUS: PreviewStatus = { services: [], portalRecipes: [] };

/** How long a navigation waits for route recovery before it gets the
 * waiting page instead. A relay rebuild after a gateway restart finishes
 * inside this; a Sandbox wake or a dev server relaunch does not. */
const PORTAL_RECOVERY_GRACE_MS = 2_000;
const PORTAL_WAITING_RETRY_SECONDS = 3;

function portalSessionUrl(sessionId: string | null): string | undefined {
  if (!sessionId) return undefined;
  const base = configuredServer().publicBaseUrl.replace(/\/+$/, "");
  return `${base}/session/${encodeURIComponent(sessionId)}`;
}

export function unavailableSandboxPreviewStatus(
  session: Pick<UnifiedSession, "sandbox">,
): PreviewStatus | null {
  const sandbox = session.sandbox;
  if (!sandbox?.provider) return null;
  return {
    ...EMPTY_STATUS,
    sandboxLifecycle: sandbox.lifecycle || "preparing",
  };
}

/**
 * Mark a host session's Portal status with the Portal Sandbox its project
 * runs Portals in (portal-sandbox.ts): the provider, and the machine's state
 * when it is not the live one the status was read from. The recipes stay
 * those of the host worktree while no machine is up, so a Portal can be
 * started (which provisions or wakes it) and retried after a failure.
 */
export function withPortalSandbox(
  session: Pick<
    UnifiedSession,
    | "id"
    | "source"
    | "sandbox"
    | "portalSandbox"
    | "runner"
    | "repo"
    | "mode"
    | "branch"
    | "worktreeDir"
    | "automationId"
    | "automation"
  >,
  status: PreviewStatus,
  live: boolean,
): PreviewStatus {
  if (session.sandbox?.sandboxId) return status;
  const record = session.portalSandbox;
  const provider = record?.provider ?? portalSandboxProvider(session);
  if (!provider) return status;
  const lifecycle = live
    ? "awake"
    : record
      ? record.lifecycle || (record.sandboxId ? "sleeping" : "preparing")
      : undefined;
  return {
    ...status,
    ...(lifecycle && lifecycle !== "awake"
      ? { sandboxLifecycle: lifecycle }
      : {}),
    portalSandbox: {
      provider,
      ...(lifecycle ? { lifecycle } : {}),
      ...(record?.lastLifecycleError
        ? { error: record.lastLifecycleError }
        : {}),
    },
  };
}

export class PortalStartError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Start one of a session's declared Portals wherever its Portals run: a
 * Runner, the workspace Sandbox, a Portal Sandbox (provisioned on the first
 * start), or this machine. `recipeId` omitted starts the first recipe with a
 * command. Returns the Portal status afterwards.
 */
export async function startSessionPortal(
  session: UnifiedSession,
  recipeId?: string,
  startOptions: { ownTurn?: boolean } = {},
): Promise<PreviewStatus> {
  // A project that runs its Portals in a Sandbox of their own gets
  // that Sandbox provisioned here, on the first start.
  const sandbox = session.worktreeDir
    ? await sandboxForPortals(session, {
        wake: true,
        provision: true,
        ownTurn: startOptions.ownTurn,
      })
    : null;
  if (portalsInSandbox(session) && !sandbox)
    throw new PortalStartError(409, "This session's Sandbox is unavailable");
  if (!session.worktreeDir)
    throw new PortalStartError(400, "Session has no Portal workspace");
  const current = sandbox
    ? await getSandboxPreviewStatus(sandbox, session.worktreeDir, session.id)
    : await getPreviewStatus(session.worktreeDir);
  const recipe = current.portalRecipes.find((candidate) =>
    recipeId ? candidate.id === recipeId : Boolean(candidate.command),
  );
  if (!recipe) throw new PortalStartError(404, "Portal recipe not found");
  const options = recipeStartOptions(recipe);
  if (session.runner) {
    await startRunnerPortal({
      session,
      user: session.startedBy || undefined,
      ...options,
    });
    return await runnerPortalPreviewStatus(
      session,
      session.startedBy || undefined,
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
    return withPortalSandbox(
      session,
      await getSandboxPreviewStatus(sandbox, session.worktreeDir, session.id),
      true,
    );
  }
  if (!existsSync(session.worktreeDir))
    throw new PortalStartError(400, "Session has no Portal workspace");
  seedHostEnvFiles(session.worktreeDir);
  await startPortalService({
    sessionId: session.id,
    worktreeDir: session.worktreeDir,
    ...options,
  });
  return await getPreviewStatus(session.worktreeDir);
}

export async function handlePreviewRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  // Caddy-backed Portals authenticate every request through this endpoint
  // before proxying it to a session service. The global API auth gate has
  // already verified the Open Session cookie/Bearer token; returning 204 lets
  // Caddy continue, while an unauthenticated request never reaches here.
  if (/^\/api\/portal-auth\/\d+$/.test(path) && req.method === "GET") {
    const httpsPort = Number(path.slice(path.lastIndexOf("/") + 1));
    // A person opening a page gets HTML while the route comes back: a
    // waiting page that refreshes itself, and a way back to the session
    // when the Portal is gone. A fetch or an asset load keeps the JSON
    // status and waits for the rebuild, since nobody is looking at it.
    const navigation = portalNavigationRequest(req);
    const notActive = (sessionId: string | null) =>
      navigation
        ? portalWaitingResponse({
            state: "unavailable",
            sessionUrl: portalSessionUrl(sessionId),
          })
        : Response.json(
            { error: "Portal route is not active" },
            { status: 404, headers: { "Cache-Control": "no-store" } },
          );
    let recoveredNow = false;
    try {
      // Host Portals keep their authenticated Caddy route while sleeping. A
      // real navigation wakes one; background fetches from stale tabs do not.
      const hostPortal = await hostPortalRouteStatus(httpsPort - 6_000);
      if (hostPortal) {
        if (!portalRouteAuthorized(httpsPort))
          return notActive(hostPortal.sessionId);
        if (hostPortal.state === "sleeping") {
          if (!navigation) return notActive(hostPortal.sessionId);
          const outcome = await Promise.race([
            wakeHostPortalRoute(httpsPort - 6_000),
            Bun.sleep(PORTAL_RECOVERY_GRACE_MS).then(() => "pending" as const),
          ]);
          if (outcome === "pending")
            return portalWaitingResponse({
              state: "waking",
              retrySeconds: PORTAL_WAITING_RETRY_SECONDS,
              sessionUrl: portalSessionUrl(hostPortal.sessionId),
            });
          recoveredNow = true;
        } else if (
          hostPortal.state === "starting" ||
          hostPortal.state === "waking"
        ) {
          return navigation
            ? portalWaitingResponse({
                state: "waking",
                retrySeconds: PORTAL_WAITING_RETRY_SECONDS,
                sessionUrl: portalSessionUrl(hostPortal.sessionId),
              })
            : notActive(hostPortal.sessionId);
        } else if (hostPortal.state !== "awake") {
          return notActive(hostPortal.sessionId);
        }
      } else {
        const {
          recoverSandboxPortalRoute,
          sandboxPortalRouteConnected,
          sandboxPortalRouteSession,
          sandboxPortalRouteStarting,
        } = await import("../sandbox-portal-recovery");
        // Caddy routes and their authorization can outlive the outbound relay.
        // Verify both on every authenticated request; a disconnected sandbox
        // gets a fresh sidecar before Caddy proxies to a dead loopback socket.
        if (
          !portalRouteAuthorized(httpsPort) ||
          !sandboxPortalRouteConnected(httpsPort)
        ) {
          // Only a person's navigation may wake a sleeping Sandbox: it is an
          // explicit action, where a fetch from an old tab is not.
          const recovery = recoverSandboxPortalRoute(httpsPort, {
            wake: navigation,
          });
          if (navigation) {
            const outcome = await Promise.race([
              recovery,
              Bun.sleep(PORTAL_RECOVERY_GRACE_MS).then(
                () => "pending" as const,
              ),
            ]);
            if (outcome === "pending")
              return portalWaitingResponse({
                state: "waking",
                retrySeconds: PORTAL_WAITING_RETRY_SECONDS,
              });
            recoveredNow = outcome;
          } else {
            recoveredNow = await recovery;
          }
          if (!recoveredNow)
            return notActive(sandboxPortalRouteSession(httpsPort));
        }
        // The route is live but its service may still be booting (a start the
        // agent or a wake kicked off). Proxying now would reach a port nobody
        // listens on and show a bare 502; keep the person on the waiting page.
        if (navigation && sandboxPortalRouteStarting(httpsPort))
          return portalWaitingResponse({
            state: "waking",
            retrySeconds: PORTAL_WAITING_RETRY_SECONDS,
          });
      }
    } catch (error) {
      console.warn(`[portals] Portal ${httpsPort} recovery failed:`, error);
      return notActive(null);
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
    // Only authenticated, authorized Portal traffic counts. Session-list and
    // readiness polling never extend a host preview's idle lifetime.
    hostPortalActivity.touch(httpsPort - 6_000);
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Portal status for a session workspace: which services (.ports.conf) are
  // listening and the Portals the repository declares. Never wakes a Sandbox.
  {
    const m = path.match(/^\/api\/sessions\/(.+)\/preview$/);
    if (m && req.method === "GET") {
      const session = await findSessionAsync(decodeURIComponent(m[1]));
      if (!session)
        return Response.json({ error: "Session not found" }, { status: 404 });
      if (session.runner)
        return Response.json(
          await runnerPortalPreviewStatus(
            session,
            session.startedBy || undefined,
          ),
        );
      const sbx = session.worktreeDir ? await sandboxForPortals(session) : null;
      if (sbx)
        return Response.json(
          withPortalSandbox(
            session,
            await getSandboxPreviewStatus(
              sbx,
              session.worktreeDir!,
              session.id,
            ),
            true,
          ),
        );
      const recorded = session.sandbox?.sandboxId
        ? session.sandbox
        : session.portalSandbox?.sandboxId
          ? session.portalSandbox
          : undefined;
      if (recorded?.sandboxId) {
        const sleeping = sleepingSandboxPortalStatus(
          session.id,
          recorded.sandboxId,
        );
        if (sleeping)
          return Response.json(
            withPortalSandbox(
              session,
              {
                ...sleeping,
                sandboxLifecycle: recorded.lifecycle || "sleeping",
              },
              false,
            ),
          );
      }
      const unavailableSandbox = unavailableSandboxPreviewStatus(session);
      if (unavailableSandbox) return Response.json(unavailableSandbox);
      if (!session.worktreeDir || !existsSync(session.worktreeDir))
        return Response.json(EMPTY_STATUS);
      return Response.json(
        withPortalSandbox(
          session,
          await getPreviewStatus(session.worktreeDir),
          false,
        ),
      );
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
        return Response.json(await startSessionPortal(session, m[2]));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: error instanceof PortalStartError ? error.status : 400 },
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
          ? await sandboxForPortals(session, { wake: m[3] === "restart" })
          : null;
        if (
          (session.sandbox?.sandboxId || session.portalSandbox?.sandboxId) &&
          !sandbox
        )
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
            withPortalSandbox(
              session,
              await getSandboxPreviewStatus(
                sandbox,
                session.worktreeDir!,
                session.id,
              ),
              true,
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
