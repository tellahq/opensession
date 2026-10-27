/** Per-session sandbox status and explicit lifecycle controls. */

import { noteSandboxActivity, sandboxSleepsAt } from "../sandbox/idle";
import { sandboxAgentStatus } from "../sandbox/agent-channel";

/** When the idle timers would put the machine to sleep, if it is tracked. */
function idleSleepsAtIso(sandboxId: string): string | undefined {
  const at = sandboxSleepsAt(sandboxId);
  return at ? new Date(at).toISOString() : undefined;
}
import { existsSync } from "node:fs";
import { isAgentSessionBusy } from "../agent-runner";
import { audit } from "../audit";
import { getGitStatus, type GitStatusInfo } from "../git-status";
import { hostRunBusy } from "../host-registry";
import { stopAllPortalServices } from "../portal-supervisor";
import { getSandboxProvider } from "../sandbox";
import { ensureSandboxWithTransientRetry } from "../sandbox/reliability";
import {
  isRemoteSandboxProvider,
  isRetiredSandboxProvider,
  resolveRequestedSandbox,
  resolveRequestedSandboxGpu,
} from "../sandbox/config";
import {
  recordedTrustPolicy,
  type SandboxTrustPolicy,
} from "../sandbox/adapters/bootstrap";
import {
  checkpointHostWorkspace,
  checkpointSessionWorkspace,
  restorableCheckpoint,
  restoreCheckpointToHostWorktree,
  type CheckpointOutcome,
} from "../sandbox/checkpoint";
import { withSessionLifecycleLane } from "../sandbox/lifecycle-lane";
import type { SandboxSessionSpec } from "../sandbox/provider";
import { suspendSandboxPreviewRoutes } from "../preview";
import {
  findSessionAsync,
  touchNativeSession,
  touchNativeSessionStrict,
} from "../session-cache";
import { resolveWorktreeTarget } from "../session-repos";
import {
  activeSandboxFor,
  teardownRecordedSandbox,
  teardownSandbox,
} from "../session-sandbox";
import { releasePortalSandbox } from "../portal-sandbox";
import { sessionTouchedPaths } from "../session-touched";
import type { SandboxCheckpointRecord } from "../types";
import {
  createWorktreeForExistingBranch,
  getRepo,
  isSharedCheckoutDir,
} from "../worktree";
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
  | "sandboxCheckpoint"
  | "sandboxGpu"
>;

type AttachSession = Pick<
  StoredSession,
  | "mode"
  | "repo"
  | "sandbox"
  | "runner"
  | "automation"
  | "automationId"
  | "sandboxGpu"
>;

/**
 * Why a session cannot move into a Sandbox on `provider`, or null when it
 * can. A session already in a Sandbox may move to a different provider: its
 * work travels through a checkpoint. The same provider is refused because
 * there is nothing to move to.
 */
export function sandboxAttachRefusal(
  session: AttachSession,
  provider?: string,
  gpu?: string,
): string | null {
  // A recorded provider without a Sandbox id is a move that has not
  // materialized (still preparing, or failed); moving again retries it.
  // Another GPU on the same provider is a move too (Modal without a GPU to
  // Modal with a T4, a T4 to an L4).
  if (
    session.sandbox?.sandboxId &&
    session.sandbox.provider !== "local" &&
    (!provider ||
      (session.sandbox.provider === provider &&
        (session.sandboxGpu || undefined) === (gpu || undefined)))
  )
    return `This session already runs on ${session.sandbox.provider}${session.sandboxGpu ? ` with a ${session.sandboxGpu} GPU` : ""}.`;
  if (session.runner?.id)
    return "This session runs on a Runner. Start a new session to use a Sandbox.";
  if (session.automationId || session.automation)
    return "An automation's sessions take their Sandbox from the automation.";
  if (session.mode !== "code" || !session.repo)
    return "Only code sessions with a repository can move to a Sandbox.";
  return null;
}

/** Why a Sandbox session cannot move back to this machine, or null. */
export function sandboxDetachRefusal(session: AttachSession): string | null {
  if (
    !session.sandbox?.provider ||
    !isRemoteSandboxProvider(session.sandbox.provider)
  )
    return "This session already runs on this machine.";
  if (session.automationId || session.automation)
    return "An automation's sessions stay in the automation's Sandbox.";
  if (session.mode !== "code" || !session.repo)
    return "Only code sessions with a repository can move to this machine.";
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

function restoreSpec(
  checkpoint: SandboxCheckpointRecord | undefined,
): Pick<SandboxSessionSpec, "restoreCheckpoint"> {
  return checkpoint
    ? {
        restoreCheckpoint: {
          ref: checkpoint.ref,
          commit: checkpoint.commit,
          branch: checkpoint.branch,
        },
      }
    : {};
}

/**
 * The session as it stands once the lifecycle lane is ours, or the refusal
 * to send when it was deleted while the request waited its turn. A queued
 * operation never acts on the copy it was requested with: that record may
 * describe a Sandbox, a checkpoint, or a session that no longer exists.
 */
async function currentOnLane(
  sessionId: string,
): Promise<{ session: StoredSession } | { response: Response }> {
  const session = await findSessionAsync(sessionId);
  if (session) return { session };
  return {
    response: Response.json(
      { error: "The session was deleted while this request waited." },
      { status: 410 },
    ),
  };
}

/**
 * Refusal while a turn is admitted or running. Checked on the session's
 * lifecycle lane, after claiming it: run admission reserves the session and
 * then waits for the lane, so a reservation seen here belongs to a turn that
 * starts the moment the lane is free, and the workspace is that turn's.
 */
function lifecycleBusyRefusal(sessionId: string): Response | null {
  if (!hostRunBusy(sessionId) && !isAgentSessionBusy(sessionId)) return null;
  return Response.json(
    { error: "Wait for the agent to finish before changing this Sandbox." },
    { status: 409 },
  );
}

/**
 * The recorded checkpoint, when it may stand in for a Sandbox that cannot be
 * reached: only one taken on the session's current branch is restorable
 * (checkpoint.ts). `missing` says why there is none, for the refusal.
 */
function recordedCheckpoint(
  session: Pick<StoredSession, "branch" | "sandboxCheckpoint">,
): { checkpoint?: SandboxCheckpointRecord; missing: string } {
  const checkpoint = restorableCheckpoint(session);
  if (checkpoint) return { checkpoint, missing: "" };
  const stale = session.sandboxCheckpoint;
  return {
    missing: stale
      ? `its last checkpoint was taken on branch ${stale.branch}, not ${session.branch}`
      : "no checkpoint exists",
  };
}

const attachedSandboxProvisions = new Map<string, symbol>();

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
  const attempt = Symbol();
  attachedSandboxProvisions.set(session.id, attempt);
  const recorded = async () => {
    const current = await findSessionAsync(session.id);
    if (attachedSandboxProvisions.get(session.id) !== attempt) return null;
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
        ...restoreSpec(session.sandboxCheckpoint),
        ...(session.sandboxGpu ? { gpu: session.sandboxGpu } : {}),
      },
    );
    await withSessionLifecycleLane(session.id, async () => {
      const current = await recorded();
      if (!current) return;
      await touchNativeSessionStrict(session.id, {
        sandbox: {
          ...current,
          sandboxId: sandbox.id,
          workspace: sandbox.workspace,
          lifecycle: "awake",
          lastLifecycleError: undefined,
        },
      });
      console.log(`[sandbox] ${session.id}: moved into ${sandbox.id}`);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[sandbox] ${session.id}: could not provision the ${provider} Sandbox it moved to:`,
      message,
    );
    await withSessionLifecycleLane(session.id, async () => {
      const current = await recorded();
      if (!current) return;
      await touchNativeSessionStrict(session.id, {
        sandbox: {
          ...current,
          lifecycle: "needs_attention",
          lastLifecycleError: message,
        },
      });
    });
  } finally {
    if (attachedSandboxProvisions.get(session.id) === attempt)
      attachedSandboxProvisions.delete(session.id);
  }
}

/**
 * Checkpoint a Sandbox session's workspace, waking the Sandbox if it sleeps.
 * Returns the outcome, or null when the Sandbox cannot be reached at all.
 */
async function checkpointFromSandbox(
  session: StoredSession,
): Promise<CheckpointOutcome | null> {
  const sandbox = await activeSandboxFor(session, { wake: true });
  if (!sandbox) return null;
  return checkpointSessionWorkspace(session, sandbox);
}

/**
 * What may replace or destroy a Sandbox: a checkpoint taken from it NOW
 * (`pushed` or `unchanged`), or the recorded one when the Sandbox cannot be
 * reached at all. A reachable Sandbox whose state cannot be captured is
 * never destroyed on the strength of an older checkpoint, because the work
 * since then exists nowhere else; `reason` says why instead. Returns the
 * session as it stands after the checkpoint so the caller's spec carries the
 * fresh record.
 */
async function freshCheckpoint(
  session: StoredSession,
): Promise<
  | { ok: true; session: StoredSession; reachable: boolean }
  | { ok: false; reachable: boolean; status: 409 | 502; reason: string }
> {
  let outcome: CheckpointOutcome | null;
  try {
    outcome = await checkpointFromSandbox(session);
  } catch (error) {
    return {
      ok: false,
      reachable: true,
      status: 502,
      reason: `Could not checkpoint the Sandbox: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  if (!outcome) {
    const recorded = recordedCheckpoint(session);
    if (recorded.checkpoint) return { ok: true, session, reachable: false };
    return {
      ok: false,
      reachable: false,
      status: 409,
      reason: `The Sandbox cannot be reached and ${recorded.missing}, so its work cannot be carried over.`,
    };
  }
  if (outcome.state === "skipped")
    return {
      ok: false,
      reachable: true,
      status: 409,
      reason: `This session's work cannot be checkpointed (${outcome.reason}), so the Sandbox's files would be lost. Push from the Sandbox first.`,
    };
  const current = await currentOnLane(session.id);
  if ("response" in current)
    return {
      ok: false,
      reachable: true,
      status: 409,
      reason: "The session was deleted while this request waited.",
    };
  return { ok: true, reachable: true, session: current.session };
}

/**
 * Release a session's current Sandbox because the session is leaving it:
 * Portal routes are dropped and the machine is destroyed. The caller has
 * already checkpointed what it needs.
 */
async function releaseSandbox(session: StoredSession, why: string) {
  const recorded = session.sandbox;
  if (!recorded || !isRemoteSandboxProvider(recorded.provider)) return;
  // Also retire failed/in-flight provisioning, before the move erases its
  // provider selection. A failed retirement must leave that selection intact
  // so the person can retry instead of silently leaking paid compute.
  const id = await teardownRecordedSandbox(session.id, recorded);
  console.log(
    `[sandbox] ${session.id}: released ${id || "unmaterialized Sandbox"} (${why})`,
  );
}

/**
 * Move a session into a Sandbox. From this machine, the worktree's state is
 * checkpointed first so uncommitted work travels along; only when no
 * checkpoint is possible does the old "push first, or move anyway" question
 * apply. From another Sandbox, that Sandbox is checkpointed and released.
 * The record says "preparing" and the new Sandbox is provisioned in the
 * background; the next turn adopts it whether it is ready or still booting.
 */
async function attachSandbox(
  ctx: RouteContext,
  session: StoredSession,
): Promise<Response> {
  const body = (await ctx.req.json().catch(() => ({}))) as {
    provider?: unknown;
    gpu?: unknown;
    confirm?: unknown;
  };
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
  // A GPU for the machine being moved into (Modal only).
  const gpuChoice = resolveRequestedSandboxGpu(body.gpu, provider);
  if (!gpuChoice.ok)
    return Response.json({ error: gpuChoice.error }, { status: 400 });
  const gpu = gpuChoice.gpu;
  const refusal = sandboxAttachRefusal(session, provider, gpu);
  if (refusal) return Response.json({ error: refusal }, { status: 409 });

  const fromSandbox =
    !!session.sandbox?.sandboxId &&
    isRemoteSandboxProvider(session.sandbox.provider);
  if (fromSandbox) {
    // Sandbox to Sandbox: the work exists only on the old machine, so the
    // move is refused unless a checkpoint taken NOW holds it. Only a Sandbox
    // that cannot be reached at all falls back to the recorded checkpoint.
    const fresh = await freshCheckpoint(session);
    if (!fresh.ok)
      return Response.json(
        {
          error: fresh.reachable
            ? fresh.reason
            : `${fresh.reason} Wake it first, or rebuild it.`,
        },
        { status: fresh.status },
      );
  } else {
    const target = resolveWorktreeTarget(session);
    if (target && existsSync(target.dir)) {
      let outcome: CheckpointOutcome = { state: "skipped", reason: "unknown" };
      try {
        outcome = await checkpointHostWorkspace(session, target.dir);
      } catch (error) {
        console.warn(
          `[sandbox] ${session.id}: host checkpoint before move failed:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (outcome.state === "skipped") {
        // A shared checkout holds every session's edits; count only this one's.
        const ownPaths = isSharedCheckoutDir(target.dir)
          ? await sessionTouchedPaths(session, target.dir)
          : undefined;
        const unpublished = unpublishedWorkSummary(
          await getGitStatus(
            target.dir,
            target.defaultBranch,
            undefined,
            ownPaths,
          ),
        );
        if (unpublished && body.confirm !== true)
          return Response.json(
            { error: unpublished, confirmRequired: true },
            { status: 428 },
          );
        // Moving without a checkpoint must not restore a stale one.
        if (session.sandboxCheckpoint)
          await touchNativeSessionStrict(session.id, {
            sandboxCheckpoint: undefined,
          });
      }
      // The Portals on this machine belong to the worktree the agent leaves;
      // the Sandbox starts its own from the repository's declarations.
      await stopAllPortalServices({
        sessionId: session.id,
        worktreeDir: target.dir,
      });
    }
    // A Portal Sandbox served this machine's worktree; the workspace Sandbox
    // runs the Portals from now on.
    await releasePortalSandbox(session, `moving to ${provider}`);
  }
  await releaseSandbox(session, `moving to ${provider}`);
  await touchNativeSessionStrict(session.id, {
    // The GPU the new machine carries; none clears an earlier one.
    sandboxGpu: gpu,
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
  audit({
    msg: "sandbox_attach",
    session_id: session.id,
    provider,
    ...(gpu ? { gpu } : {}),
    from: fromSandbox ? session.sandbox?.provider : "local",
  });
  const moved = (await findSessionAsync(session.id)) || session;
  void provisionAttachedSandbox(moved, provider);
  return Response.json(await sandboxView(moved));
}

/**
 * Move a Sandbox session back to this machine: checkpoint the Sandbox, restore
 * the checkpoint into a worktree here, and release the Sandbox. Without a
 * reachable Sandbox the last checkpoint is used; without any checkpoint the
 * move needs `confirm` and starts from the branch as origin has it.
 */
async function detachSandbox(
  ctx: RouteContext,
  session: StoredSession,
): Promise<Response> {
  const body = (await ctx.req.json().catch(() => ({}))) as {
    confirm?: unknown;
  };
  const refusal = sandboxDetachRefusal(session);
  if (refusal) return Response.json({ error: refusal }, { status: 409 });
  if (!session.branch)
    return Response.json(
      { error: "This session has no branch to move." },
      { status: 409 },
    );
  const repo = getRepo(session.repo);
  // The checkpoint the move restores: one taken now from a reachable Sandbox,
  // or the recorded one when the Sandbox is gone. A reachable Sandbox whose
  // state cannot be captured now yields none, whatever was recorded earlier:
  // restoring an older checkpoint would silently replace the newer work.
  let checkpoint: SandboxCheckpointRecord | undefined;
  let reachable = false;
  let skippedReason: string | undefined;
  const recorded = recordedCheckpoint(session);
  if (session.sandbox?.sandboxId) {
    try {
      const outcome = await checkpointFromSandbox(session);
      reachable = outcome !== null;
      if (!outcome) checkpoint = recorded.checkpoint;
      else if (outcome.state === "skipped") skippedReason = outcome.reason;
      else checkpoint = outcome.checkpoint;
    } catch (error) {
      return Response.json(
        {
          error: `Could not checkpoint the Sandbox: ${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 502 },
      );
    }
  } else {
    checkpoint = recorded.checkpoint;
  }
  if (!checkpoint && body.confirm !== true)
    return Response.json(
      {
        error: reachable
          ? `This session's work cannot be checkpointed (${skippedReason}), so the move would start from the branch as origin has it. Push from the Sandbox first, or move anyway and leave the Sandbox's files behind.`
          : `The Sandbox cannot be reached and ${recorded.missing}. Move anyway to continue from the branch as origin has it.`,
        confirmRequired: true,
      },
      { status: 428 },
    );
  let dir: string;
  try {
    dir = checkpoint
      ? await restoreCheckpointToHostWorktree(
          repo,
          session.branch,
          checkpoint,
          session.worktreeDir ?? undefined,
        )
      : await createWorktreeForExistingBranch(session.branch, repo.id);
  } catch (error) {
    return Response.json(
      {
        error: `Could not prepare a worktree on this machine: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 409 },
    );
  }
  await releaseSandbox(session, "moving to this machine");
  await touchNativeSessionStrict(session.id, {
    sandbox: { provider: "local" },
    // Back on this machine: the GPU went with the Sandbox.
    sandboxGpu: undefined,
    worktreeDir: dir,
    // A move that carried nothing must not leave a checkpoint that predates
    // the work it left behind, or a later move would restore that instead.
    ...(checkpoint ? {} : { sandboxCheckpoint: undefined }),
    // The engine's state lived in the Sandbox; the next turn seeds a fresh
    // engine from the stored transcript, as a move into a Sandbox does.
    claudeSessionId: undefined,
    codexThreadId: undefined,
  });
  audit({
    msg: "sandbox_detach",
    session_id: session.id,
    provider: session.sandbox?.provider,
    sandbox_id: session.sandbox?.sandboxId,
    checkpoint: checkpoint?.commit,
  });
  console.log(`[sandbox] ${session.id}: moved to this machine at ${dir}`);
  return Response.json(
    await sandboxView((await findSessionAsync(session.id)) || session),
  );
}

/**
 * The ensure() spec a recreate re-enters the provider with. The trust policy
 * belongs to the sandbox, so `trust` is what it was RECORDED with, read before
 * destroy() deletes that record. Without it an automation's sandbox comes back
 * "interactive": no egress firewall, no credential-minimal projection, under a
 * contract documented as fail-closed (provider.ts). Providers that keep no
 * such record still fail closed on the profile for an automation-owned session.
 * The session's last checkpoint rides along so the rebuilt Sandbox continues
 * from it instead of from origin's branch tip.
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
    ...(session.sandboxGpu ? { gpu: session.sandboxGpu } : {}),
    ...(trustProfile ? { trustProfile } : {}),
    ...(trust ? { egressAllowlist: trust.egressAllowlist } : {}),
    ...restoreSpec(session.sandboxCheckpoint),
  };
}

function checkpointView(session: Pick<StoredSession, "sandboxCheckpoint">) {
  const checkpoint = session.sandboxCheckpoint;
  return checkpoint
    ? {
        checkpoint: {
          at: checkpoint.at,
          commit: checkpoint.commit,
          branch: checkpoint.branch,
        },
      }
    : {};
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
      ...checkpointView(session),
    };
  }
  if (recorded.provider === "local")
    return {
      enabled: false,
      status: "none" as const,
      ...checkpointView(session),
    };
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
      lifecycleNote: recorded.lifecycleNote,
      materialized: false,
      ...checkpointView(session),
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
    lifecycleNote: recorded.lifecycleNote,
    materialized: status !== "gone",
    busy: hostRunBusy(session.id),
    cwd: sandbox?.cwd || session.worktreeDir || null,
    canPause: Boolean(provider.pause),
    canResume: Boolean(provider.resume),
    canDesktop: Boolean(provider.desktop),
    // Commands reach the machine through its Sandbox agent while that is
    // connected, through the provider's own lane otherwise.
    agentConnected: sandboxAgentStatus(recorded.sandboxId).connected,
    sleepsAt: idleSleepsAtIso(recorded.sandboxId),
    logs,
    ...checkpointView(session),
  };
}

export async function handleSandboxRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const match = ctx.path.match(
    /^\/api\/sessions\/([^/]+)\/sandbox(?:\/(pause|resume|recreate|desktop|attach|detach|checkpoint))?$/,
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
  if (action === "attach" || action === "detach") {
    try {
      // The whole move runs on the session's lifecycle lane: checkpoint,
      // release of the old machine, and the final record update, with run
      // admission waiting on the lane and refused while a turn is admitted.
      return await withSessionLifecycleLane(session.id, async () => {
        const current = await currentOnLane(session.id);
        if ("response" in current) return current.response;
        const busy = lifecycleBusyRefusal(current.session.id);
        if (busy) return busy;
        return action === "attach"
          ? attachSandbox(ctx, current.session)
          : detachSandbox(ctx, current.session);
      });
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
        error: `The ${recorded.provider} Sandbox provider has been retired; start a new session on Daytona or Boat.`,
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
      noteSandboxActivity(
        { sandboxId: recorded.sandboxId, sessionId: session.id },
        "human",
      );
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
  return withSessionLifecycleLane(session.id, () =>
    runSandboxLifecycleAction(ctx, session, action),
  );
}

/**
 * checkpoint, pause, resume, and recreate, on the session's lifecycle lane:
 * the capture, the machine change, and the record update land before any
 * turn is admitted, and none of them starts while a turn is admitted.
 */
async function runSandboxLifecycleAction(
  ctx: RouteContext,
  requested: StoredSession,
  action: string,
): Promise<Response> {
  // The record may have changed while the request waited its turn on the
  // lane (a move, rebuild, or deletion ahead of it): act on the Sandbox as
  // it is now, never on the copy the request came with.
  const current = await currentOnLane(requested.id);
  if ("response" in current) return current.response;
  const session = current.session;
  const recorded = session.sandbox;
  if (
    !recorded?.provider ||
    !recorded.sandboxId ||
    recorded.sandboxId !== requested.sandbox?.sandboxId
  )
    return Response.json(
      { error: "The Sandbox changed while this request waited. Try again." },
      { status: 409 },
    );
  const busy = lifecycleBusyRefusal(session.id);
  if (busy) return busy;
  const provider = getSandboxProvider(recorded.provider);
  try {
    if (action === "checkpoint") {
      const outcome = await checkpointFromSandbox(session);
      if (!outcome)
        return Response.json(
          { error: "The Sandbox cannot be reached right now." },
          { status: 409 },
        );
      if (outcome.state === "skipped")
        return Response.json(
          { error: `Nothing to checkpoint: ${outcome.reason}.` },
          { status: 409 },
        );
    } else if (action === "pause") {
      if (!provider.pause)
        return Response.json(
          { error: `${recorded.provider} does not expose manual pause` },
          { status: 400 },
        );
      // Save what the Sandbox holds before it stops; a stop that later turns
      // into a lost disk then costs nothing.
      await checkpointFromSandbox(session).catch((error) =>
        console.warn(
          `[sandbox] ${session.id}: checkpoint before sleep failed:`,
          error instanceof Error ? error.message : String(error),
        ),
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
      noteSandboxActivity(
        { sandboxId: recorded.sandboxId, sessionId: session.id },
        "human",
      );
    } else {
      const body = (await ctx.req.json().catch(() => ({}))) as {
        confirm?: boolean;
        discard?: boolean;
      };
      if (body.confirm !== true)
        return Response.json(
          {
            error:
              "Rebuilding replaces the Sandbox machine; confirm is required",
          },
          { status: 400 },
        );
      // The rebuild continues from a checkpoint taken now; a Sandbox that is
      // already lost rebuilds from its last one. A reachable Sandbox whose
      // state cannot be captured is destroyed only with an explicit `discard`,
      // and then continues from the branch as origin has it, never from an
      // older checkpoint that would masquerade as the current files.
      let current = session;
      const fresh = await freshCheckpoint(session);
      if (fresh.ok) current = fresh.session;
      else if (body.discard !== true)
        return Response.json(
          {
            error: `${fresh.reason} Or rebuild anyway from the branch as origin has it.`,
            discardRequired: true,
          },
          { status: 428 },
        );
      else {
        await touchNativeSessionStrict(session.id, {
          sandboxCheckpoint: undefined,
        });
        const cleared = await currentOnLane(session.id);
        if ("response" in cleared) return cleared.response;
        current = cleared.session;
      }
      // destroy() deletes the provider's state file, so the sandbox's
      // recorded trust policy has to be read before it.
      const spec = recreateSandboxSpec(
        current,
        recordedTrustPolicy(recorded.provider, session.id),
      );
      touchNativeSession(session.id, {
        sandbox: {
          ...recorded,
          lifecycle: "preparing",
          lastLifecycleError: undefined,
        },
      });
      await teardownSandbox(recorded.provider, recorded.sandboxId);
      const recreated = await provider.ensure(spec);
      touchNativeSession(session.id, {
        sandbox: {
          ...recorded,
          sandboxId: recreated.id,
          workspace: recreated.workspace,
          lifecycle: "awake",
          lastLifecycleError: undefined,
        },
        // The engine's database lived in the machine that is gone.
        claudeSessionId: undefined,
        codexThreadId: undefined,
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
    if (action !== "checkpoint")
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
