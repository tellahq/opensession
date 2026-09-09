/** Per-session sandbox status and explicit lifecycle controls. */

import { existsSync } from "node:fs";
import { audit } from "../audit";
import { getGitStatus, type GitStatusInfo } from "../git-status";
import { hostRunBusy } from "../host-registry";
import { stopAllPortalServices } from "../portal-supervisor";
import { hasActiveRunFor } from "../run-journal";
import { getSandboxProvider } from "../sandbox";
import { ensureSandboxWithTransientRetry } from "../sandbox/reliability";
import {
  isRemoteSandboxProvider,
  isRetiredSandboxProvider,
  resolveRequestedSandbox,
} from "../sandbox/config";
import {
  recordedTrustPolicy,
  type SandboxTrustPolicy,
} from "../sandbox/adapters/bootstrap";
import type { SandboxSessionSpec } from "../sandbox/provider";
import {
  dropSandboxPreviewRoutes,
  suspendSandboxPreviewRoutes,
} from "../preview";
import {
  findSessionAsync,
  touchNativeSession,
  touchNativeSessionStrict,
} from "../session-cache";
import { resolveWorktreeTarget } from "../session-repos";
import { sessionTouchedPaths } from "../session-touched";
import { isSharedCheckoutDir } from "../worktree";
import type { RouteContext } from "./context";

type StoredSession = NonNullable<Awaited<ReturnType<typeof findSessionAsync>>>;

type RecreateSession = Pick<
  StoredSession,
  | "id"
  | "repo"
  | "branch"
  | "mode"
  | "worktreeDir"
  | "automation"
  | "automationId"
>;

type AttachSession = Pick<
  StoredSession,
  "mode" | "repo" | "sandbox" | "runner" | "automation" | "automationId"
>;

/** Why a host session cannot move into a Sandbox, or null when it can. */
export function sandboxAttachRefusal(session: AttachSession): string | null {
  // A recorded provider without a Sandbox id is a move that has not
  // materialized (still preparing, or failed); moving again retries it.
  if (session.sandbox?.sandboxId && session.sandbox.provider !== "local")
    return "This session already runs in a Sandbox.";
  if (session.runner?.id)
    return "This session runs on a Runner. Start a new session to use a Sandbox.";
  if (session.automationId || session.automation)
    return "An automation's sessions take their Sandbox from the automation.";
  if (session.mode !== "code" || !session.repo)
    return "Only code sessions with a repository can move to a Sandbox.";
  return null;
}

/**
 * What a Sandbox's fresh clone of origin would not have, phrased for the
 * person deciding whether to move anyway; null when everything is published.
 */
export function unpublishedWorkSummary(
  git: Pick<
    GitStatusInfo,
    "branch" | "hasUpstream" | "ahead" | "uncommittedFiles"
  >,
): string | null {
  const parts: string[] = [];
  if (git.uncommittedFiles > 0)
    parts.push(
      `${git.uncommittedFiles} uncommitted ${git.uncommittedFiles === 1 ? "file" : "files"}`,
    );
  if (!git.hasUpstream)
    parts.push(
      git.branch
        ? `the branch ${git.branch}, which was never pushed`
        : "an unpushed branch",
    );
  else if (git.ahead > 0)
    parts.push(
      `${git.ahead} unpushed ${git.ahead === 1 ? "commit" : "commits"}`,
    );
  if (!parts.length) return null;
  return `This machine has ${parts.join(" and ")}. The Sandbox clones the branch from origin, so push first, or move anyway and leave them here.`;
}

/**
 * Provision the Sandbox a session just moved into, off the request. The next
 * turn's own ensure() queues behind this one on the provider's per-session
 * lock and adopts the result, so a message sent meanwhile does not start a
 * second Sandbox; it only waits.
 */
async function provisionAttachedSandbox(
  session: StoredSession,
  provider: string,
): Promise<void> {
  const recorded = async () => {
    const current = await findSessionAsync(session.id);
    // Only the move this call started may finish it: a later move, a turn
    // that recorded the Sandbox first, or a detach leaves nothing to write.
    return current?.sandbox?.provider === provider && !current.sandbox.sandboxId
      ? current.sandbox
      : null;
  };
  try {
    const sandbox = await ensureSandboxWithTransientRetry(
      getSandboxProvider(provider),
      {
        sessionId: session.id,
        repo: session.repo,
        branch: session.branch || undefined,
        mode: session.mode,
        cwd: session.worktreeDir || undefined,
        attachedDirs: (session.attachedRepos || [])
          .map((r) => r.dir)
          .filter(Boolean),
      },
    );
    const current = await recorded();
    if (!current) return;
    touchNativeSession(session.id, {
      sandbox: {
        ...current,
        sandboxId: sandbox.id,
        workspace: sandbox.workspace,
        lifecycle: "awake",
        lastLifecycleError: undefined,
      },
    });
    console.log(`[sandbox] ${session.id}: moved into ${sandbox.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[sandbox] ${session.id}: could not provision the ${provider} Sandbox it moved to:`,
      message,
    );
    const current = await recorded();
    if (!current) return;
    touchNativeSession(session.id, {
      sandbox: {
        ...current,
        lifecycle: "needs_attention",
        lastLifecycleError: message,
      },
    });
  }
}

/**
 * Move a host session into a Sandbox. The record says "preparing" and the
 * Sandbox is provisioned in the background; the next turn takes the same path
 * as a Sandbox session's first turn, seeding a fresh engine from the stored
 * transcript, and adopts the Sandbox whether it is ready or still booting.
 */
async function attachSandbox(
  ctx: RouteContext,
  session: StoredSession,
): Promise<Response> {
  const body = (await ctx.req.json().catch(() => ({}))) as {
    provider?: unknown;
    confirm?: unknown;
  };
  const refusal = sandboxAttachRefusal(session);
  if (refusal) return Response.json({ error: refusal }, { status: 409 });
  if (hostRunBusy(session.id) || hasActiveRunFor(session.id))
    return Response.json(
      { error: "Wait for the agent to finish before moving this session." },
      { status: 409 },
    );
  const resolved = resolveRequestedSandbox(
    typeof body.provider === "string" && body.provider ? body.provider : true,
    session.repo,
    session.model,
  );
  if (!resolved.ok)
    return Response.json({ error: resolved.error }, { status: 400 });
  const provider = resolved.provider;
  if (!provider)
    return Response.json(
      { error: "Name the Sandbox provider to move to: daytona or box." },
      { status: 400 },
    );
  const target = resolveWorktreeTarget(session);
  if (target && existsSync(target.dir)) {
    // A shared checkout holds every session's edits; count only this one's.
    const ownPaths = isSharedCheckoutDir(target.dir)
      ? await sessionTouchedPaths(session, target.dir)
      : undefined;
    const unpublished = unpublishedWorkSummary(
      await getGitStatus(target.dir, target.defaultBranch, undefined, ownPaths),
    );
    if (unpublished && body.confirm !== true)
      return Response.json(
        { error: unpublished, confirmRequired: true },
        { status: 428 },
      );
    // The Portals on this machine belong to the worktree the agent leaves;
    // the Sandbox starts its own from the repository's declarations.
    await stopAllPortalServices({
      sessionId: session.id,
      worktreeDir: target.dir,
    });
  }
  await touchNativeSessionStrict(session.id, {
    sandbox: {
      provider,
      lifecycle: "preparing",
      // Remote providers never mount the host worktree; recording volume
      // intent now routes workspace reads to the Sandbox once it exists.
      ...(isRemoteSandboxProvider(provider)
        ? { workspace: "volume" as const }
        : {}),
    },
  });
  audit({ msg: "sandbox_attach", session_id: session.id, provider });
  const moved = (await findSessionAsync(session.id)) || session;
  void provisionAttachedSandbox(moved, provider);
  return Response.json(await sandboxView(moved));
}

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
  if (isRetiredSandboxProvider(recorded.provider)) {
    return {
      enabled: true,
      provider: recorded.provider,
      workspace: recorded.workspace,
      status: "gone" as const,
      lifecycle: "needs_attention" as const,
      lastLifecycleError: `The ${recorded.provider} Sandbox provider has been retired. Start a new session to continue this work in a Sandbox.`,
      materialized: false,
      canPause: false,
      canResume: false,
    };
  }
  if (!recorded.sandboxId) {
    // Nothing exists yet: a fresh or just-moved session provisions on its
    // next turn. Without the recorded lifecycle the client reads "gone" as
    // Needs attention.
    return {
      enabled: true,
      provider: recorded.provider,
      workspace: recorded.workspace,
      status: "gone" as const,
      lifecycle: recorded.lifecycle ?? ("preparing" as const),
      lastLifecycleError: recorded.lastLifecycleError,
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
    canDesktop: Boolean(provider.desktop),
    logs,
  };
}

export async function handleSandboxRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const match = ctx.path.match(
    /^\/api\/sessions\/([^/]+)\/sandbox(?:\/(pause|resume|recreate|desktop|attach))?$/,
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
  if (action === "attach") {
    try {
      return await attachSandbox(ctx, session);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }
  const recorded = session.sandbox;
  if (!recorded?.provider || !recorded.sandboxId)
    return Response.json(
      { error: "Session has no materialized sandbox" },
      { status: 400 },
    );
  if (isRetiredSandboxProvider(recorded.provider))
    return Response.json(
      {
        error: `The ${recorded.provider} Sandbox provider has been retired; start a new session on Daytona or Box.`,
      },
      { status: 410 },
    );
  if (action === "desktop") {
    // Watching the desktop is the point while the agent is working, so this
    // is not behind the lifecycle lock. The URL is a bearer secret; log the
    // request, never the URL.
    const provider = getSandboxProvider(recorded.provider);
    if (!provider.desktop)
      return Response.json(
        { error: `${recorded.provider} does not expose a desktop` },
        { status: 400 },
      );
    try {
      const desktop = await provider.desktop(recorded.sandboxId);
      audit({
        msg: "sandbox_desktop",
        session_id: session.id,
        provider: recorded.provider,
        sandbox_id: recorded.sandboxId,
      });
      return Response.json(desktop);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json(
        { error: message },
        { status: /wake the sandbox/i.test(message) ? 409 : 502 },
      );
    }
  }
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
      // The Portal URLs stay up through sleep; opening one wakes the Sandbox.
      suspendSandboxPreviewRoutes(recorded.sandboxId);
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
