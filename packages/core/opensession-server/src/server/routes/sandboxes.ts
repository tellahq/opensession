/** Workspace sandbox connections, defaults, qualification and environments. */

import { requestUser, type RouteContext } from "./context";
import { sandboxCapabilityStatus } from "../sandbox/config";
import { sandboxIngressStatus } from "../sandbox/caddy-ingress";
import {
  sandboxDefaultsStatus,
  savePersonalSandboxDefault,
  saveRepoPortalSandbox,
  saveRepoSandboxDefault,
  saveWorkspaceSandboxDefault,
} from "../sandbox/defaults";
import { REPOS } from "../worktree";
import {
  connectSandboxProvider,
  disconnectSandboxProvider,
  getSandboxConnection,
  isWorkspaceSandboxProvider,
  safeSandboxConnections,
  updateSandboxConnection,
  type SandboxConnectionSettings,
} from "../sandbox/connections";
import {
  listSandboxOperations,
  startSandboxOperation,
} from "../sandbox/operations";
import { qualifySandboxConnection } from "../sandbox/qualification";
import {
  listSandboxEnvironments,
  scheduleSandboxEnvironment,
  setSandboxEnvironmentKeepReady,
} from "../sandbox/environments";
import type { SandboxMachineSettings } from "../sandbox/prewarm";

function errorResponse(error: unknown, status = 400): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

async function connectionPayload(ctx: Pick<RouteContext, "authUser">) {
  return {
    connections: safeSandboxConnections(),
    operations: listSandboxOperations(),
    ingress: await sandboxIngressStatus(),
  };
}

function qualificationOperation(
  provider: Parameters<typeof qualifySandboxConnection>[0],
) {
  return startSandboxOperation({ kind: "qualification", provider }, (update) =>
    qualifySandboxConnection(provider, update),
  );
}

export async function handleSandboxesRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  if (path === "/api/sandbox/status" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user")) || "Anonymous";
    const repo = url.searchParams.get("repo") || undefined;
    return Response.json({
      ...sandboxCapabilityStatus(),
      ...(await connectionPayload(ctx)),
      defaults: sandboxDefaultsStatus(user, repo),
    });
  }

  if (path === "/api/sandbox/connections" && req.method === "GET") {
    return Response.json(await connectionPayload(ctx));
  }

  if (path === "/api/sandbox/environments" && req.method === "GET") {
    return Response.json({ environments: await listSandboxEnvironments() });
  }

  const keepReadyMatch = path.match(
    /^\/api\/sandbox\/environments\/([^/]+)\/([^/]+)\/keep-ready$/,
  );
  if (keepReadyMatch && req.method === "PUT") {
    const repo = decodeURIComponent(keepReadyMatch[1]!);
    const provider = decodeURIComponent(keepReadyMatch[2]!);
    if (!isWorkspaceSandboxProvider(provider)) {
      return errorResponse(
        `Unknown workspace sandbox provider "${provider}"`,
        404,
      );
    }
    if (!(repo in REPOS)) return errorResponse(`Unknown repo "${repo}"`, 404);
    const body = (await req.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    if (!body || typeof body.enabled !== "boolean")
      return errorResponse("enabled must be a boolean");
    try {
      await setSandboxEnvironmentKeepReady(repo, provider, body.enabled);
      return Response.json({ environments: await listSandboxEnvironments() });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const environmentMatch = path.match(
    /^\/api\/sandbox\/environments\/([^/]+)\/([^/]+)\/rebuild$/,
  );
  if (environmentMatch && req.method === "POST") {
    const repo = decodeURIComponent(environmentMatch[1]!);
    const provider = decodeURIComponent(environmentMatch[2]!);
    if (!isWorkspaceSandboxProvider(provider)) {
      return errorResponse(
        `Unknown workspace sandbox provider "${provider}"`,
        404,
      );
    }
    const body = (await req.json().catch(() => ({}))) as {
      settings?: SandboxMachineSettings;
    };
    const operation = scheduleSandboxEnvironment(repo, provider, {
      rebuild: true,
      user: requestUser(ctx) || "workspace-admin",
      settings: body.settings,
    });
    return Response.json({ operation }, { status: 202 });
  }

  if (path === "/api/sandbox/defaults" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.scope !== "string" ||
      typeof body.value !== "string"
    ) {
      return errorResponse("scope and value are required");
    }
    const user = requestUser(ctx, body.user) || "Anonymous";
    try {
      if (body.scope === "workspace") {
        saveWorkspaceSandboxDefault(body.value);
      } else if (body.scope === "personal") {
        savePersonalSandboxDefault(user, body.value);
      } else if (body.scope === "repo") {
        if (typeof body.repo !== "string" || !(body.repo in REPOS))
          return errorResponse("repo must name a registered repository");
        saveRepoSandboxDefault(body.repo, body.value);
      } else if (body.scope === "repo-portals") {
        if (typeof body.repo !== "string" || !(body.repo in REPOS))
          return errorResponse("repo must name a registered repository");
        saveRepoPortalSandbox(body.repo, body.value);
      } else {
        return errorResponse(
          "scope must be workspace, personal, repo, or repo-portals",
        );
      }
      return Response.json({
        defaults: sandboxDefaultsStatus(
          user,
          typeof body.repo === "string" ? body.repo : undefined,
        ),
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const match = path.match(
    /^\/api\/sandbox\/connections\/([^/]+)(?:\/(connect|test|repair))?$/,
  );
  if (match) {
    const provider = decodeURIComponent(match[1]!);
    const action = match[2];
    if (!isWorkspaceSandboxProvider(provider)) {
      return errorResponse(
        `Unknown workspace sandbox provider "${provider}"`,
        404,
      );
    }

    if (action === "connect" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      try {
        connectSandboxProvider(provider, {
          secret:
            typeof body.secret === "string"
              ? body.secret
              : typeof body.apiKey === "string"
                ? body.apiKey
                : undefined,
          settings:
            body.settings && typeof body.settings === "object"
              ? (body.settings as SandboxConnectionSettings)
              : undefined,
        });
        const operation = qualificationOperation(provider);
        return Response.json(
          { ...(await connectionPayload(ctx)), operation },
          { status: 202 },
        );
      } catch (error) {
        return errorResponse(error);
      }
    }

    if (!action && req.method === "PATCH") {
      const body = (await req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!body) return errorResponse("expected a JSON body");
      try {
        updateSandboxConnection(provider, {
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
          settings:
            body.settings && typeof body.settings === "object"
              ? (body.settings as SandboxConnectionSettings)
              : undefined,
        });
        return Response.json(await connectionPayload(ctx));
      } catch (error) {
        return errorResponse(error);
      }
    }

    if ((action === "test" || action === "repair") && req.method === "POST") {
      if (!getSandboxConnection(provider))
        return errorResponse(`${provider} is not connected`, 404);
      const operation = qualificationOperation(provider);
      return Response.json(
        { ...(await connectionPayload(ctx)), operation },
        { status: 202 },
      );
    }

    if (!action && req.method === "DELETE") {
      const body = (await req.json().catch(() => ({}))) as {
        confirm?: boolean;
      };
      if (body.confirm !== true) {
        return errorResponse("Disconnect confirmation is required");
      }
      disconnectSandboxProvider(provider);
      return Response.json(await connectionPayload(ctx));
    }
  }

  return undefined;
}
