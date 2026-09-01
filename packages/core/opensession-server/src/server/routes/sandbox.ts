/** Per-session sandbox status and explicit lifecycle controls. */

import { audit } from "../audit";
import { hostRunBusy } from "../host-registry";
import { getSandboxProvider } from "../sandbox";
import {
  recordedTrustPolicy,
  type SandboxTrustPolicy,
} from "../sandbox/adapters/bootstrap";
import type { SandboxSessionSpec } from "../sandbox/provider";
import { dropSandboxPreviewRoutes } from "../preview";
import { findSessionAsync, touchNativeSession } from "../session-cache";
import type { RouteContext } from "./context";

type RecreateSession = Pick<
  NonNullable<Awaited<ReturnType<typeof findSessionAsync>>>,
  | "id"
  | "repo"
  | "branch"
  | "mode"
  | "worktreeDir"
  | "automation"
  | "automationId"
>;

/**
 * The ensure() spec a recreate re-enters the provider with. The trust policy
 * belongs to the sandbox, so `trust` is what it was RECORDED with, read before
 * destroy() deletes that record. Without it an automation's sandbox comes back
 * "interactive": no egress firewall, no credential-minimal projection, under a
 * contract documented as fail-closed (provider.ts). Providers that keep no
 * such record still fail closed on the profile for an automation-owned session.
 */
export function recreateSandboxSpec(
  session: RecreateSession,
  trust: SandboxTrustPolicy | null,
): SandboxSessionSpec {
  const trustProfile =
    trust?.trustProfile ||
    (session.automationId || session.automation ? "automation" : undefined);
  return {
    sessionId: session.id,
    repo: session.repo,
    branch: session.branch || undefined,
    mode: session.mode,
    cwd: session.worktreeDir || undefined,
    ...(trustProfile ? { trustProfile } : {}),
    ...(trust ? { egressAllowlist: trust.egressAllowlist } : {}),
  };
}

async function sandboxView(
  session: NonNullable<Awaited<ReturnType<typeof findSessionAsync>>>,
) {
  const recorded = session.sandbox;
  if (!recorded?.provider) return { enabled: false, status: "none" as const };
  if (!recorded.sandboxId) {
    return {
      enabled: true,
      provider: recorded.provider,
      workspace: recorded.workspace,
      status: "gone" as const,
      materialized: false,
    };
  }
  const provider = getSandboxProvider(recorded.provider);
  const sandbox = await provider.get(recorded.sandboxId);
  const status = sandbox ? await sandbox.status() : "gone";
  const lifecycle =
    recorded.lifecycle ||
    (status === "running"
      ? "awake"
      : status === "stopped"
        ? "sleeping"
        : "needs_attention");
  let logs: { setup?: string; resume?: string } | undefined;
  if (sandbox && status === "running") {
    const read = async (suffix: "setup" | "resume") => {
      const result = await sandbox.exec([
        "sh",
        "-c",
        `f=$(find /home/ubuntu/.opensession/lifecycle -maxdepth 1 -name '*-${suffix}.log' -type f 2>/dev/null | head -1); [ -z "$f" ] || tail -c 12000 "$f"`,
      ]);
      return result.exitCode === 0 && result.stdout ? result.stdout : undefined;
    };
    logs = { setup: await read("setup"), resume: await read("resume") };
  }
  return {
    enabled: true,
    provider: recorded.provider,
    sandboxId: recorded.sandboxId,
    workspace: recorded.workspace,
    status,
    lifecycle,
    lastLifecycleError: recorded.lastLifecycleError,
    materialized: status !== "gone",
    busy: hostRunBusy(session.id),
    cwd: sandbox?.cwd || session.worktreeDir || null,
    canPause: Boolean(provider.pause),
    canResume: Boolean(provider.resume),
    logs,
  };
}

export async function handleSandboxRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const match = ctx.path.match(
    /^\/api\/sessions\/([^/]+)\/sandbox(?:\/(pause|resume|recreate))?$/,
  );
  if (!match) return undefined;
  const session = await findSessionAsync(decodeURIComponent(match[1]!));
  if (!session)
    return Response.json({ error: "Session not found" }, { status: 404 });
  const action = match[2];
  if (!action && ctx.req.method === "GET") {
    try {
      return Response.json(await sandboxView(session));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }
  if (!action || ctx.req.method !== "POST") return undefined;
  const recorded = session.sandbox;
  if (!recorded?.provider || !recorded.sandboxId)
    return Response.json(
      { error: "Session has no materialized sandbox" },
      { status: 400 },
    );
  if (hostRunBusy(session.id))
    return Response.json(
      { error: "Sandbox lifecycle is locked while the agent is running" },
      { status: 409 },
    );
  const provider = getSandboxProvider(recorded.provider);
  try {
    if (action === "pause") {
      if (!provider.pause)
        return Response.json(
          { error: `${recorded.provider} does not expose manual pause` },
          { status: 400 },
        );
      await dropSandboxPreviewRoutes(recorded.sandboxId, {
        preservePortalCache: true,
      });
      touchNativeSession(session.id, {
        sandbox: {
          ...recorded,
          lifecycle: "sleeping",
          lastLifecycleError: undefined,
        },
      });
      await provider.pause(recorded.sandboxId);
    } else if (action === "resume") {
      if (!provider.resume)
        return Response.json(
          { error: `${recorded.provider} does not expose manual resume` },
          { status: 400 },
        );
      touchNativeSession(session.id, {
        sandbox: {
          ...recorded,
          lifecycle: "waking",
          lastLifecycleError: undefined,
        },
      });
      await provider.resume(recorded.sandboxId);
    } else {
      const body = (await ctx.req.json().catch(() => ({}))) as {
        confirm?: boolean;
      };
      if (body.confirm !== true)
        return Response.json(
          {
            error:
              "Recreate deletes unpushed sandbox workspace data; confirm is required",
          },
          { status: 400 },
        );
      // destroy() deletes the provider's state file, so the sandbox's
      // recorded trust policy has to be read before it.
      const spec = recreateSandboxSpec(
        session,
        recordedTrustPolicy(recorded.provider, session.id),
      );
      touchNativeSession(session.id, {
        sandbox: {
          ...recorded,
          lifecycle: "preparing",
          lastLifecycleError: undefined,
        },
      });
      await dropSandboxPreviewRoutes(recorded.sandboxId);
      await provider.destroy(recorded.sandboxId);
      const recreated = await provider.ensure(spec);
      touchNativeSession(session.id, {
        sandbox: {
          ...recorded,
          sandboxId: recreated.id,
          workspace: recreated.workspace,
          lifecycle: "awake",
          lastLifecycleError: undefined,
        },
      });
    }
    if (action === "resume")
      touchNativeSession(session.id, {
        sandbox: {
          ...recorded,
          lifecycle: "awake",
          lastLifecycleError: undefined,
        },
      });
    audit({
      msg: `sandbox_${action}`,
      session_id: session.id,
      sandbox_id: recorded.sandboxId,
      provider: recorded.provider,
    });
    return Response.json(
      await sandboxView((await findSessionAsync(session.id)) || session),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    touchNativeSession(session.id, {
      sandbox: {
        ...recorded,
        lifecycle: "needs_attention",
        lastLifecycleError: message.slice(0, 240),
      },
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
