/**
 * Per-session sandbox lifecycle helpers (Daytona/Box): tear-down on
 * delete/archive and "is the sandbox actually live right now" checks used by
 * the Portal routes. The run-path launch lives in run-session.ts.
 */

import { getSandboxProvider, type Sandbox } from "./sandbox";
import {
  isRemoteSandboxProvider,
  sandboxesEnabled,
  sandboxProviderConfigured,
} from "./sandbox/config";
import { touchNativeSession } from "./session-cache";
import { dropSandboxPreviewRoutes } from "./preview";
import {
  listSandboxPortalServices,
  portalsToRestore,
  readSandboxPortalRecords,
  restartSandboxPortalService,
} from "./portal-supervisor";
import {
  recipeStartOptions,
  sandboxPortalRecipes,
  sandboxPreviewIdentityContext,
} from "./preview";
import { createWorkloadIdentityEnv } from "./workload-identity";
import { getRepo } from "./worktree";
import { revokeWorkloadIdentityForSandbox } from "./workload-identity";
import type { UnifiedSession } from "./types";

/**
 * Tear down a session's sandbox, including its workspace disk (documented
 * data loss: push your work). Best-effort and detached so a provider hiccup
 * never blocks the caller
 * (session delete, archive sweep). `clearSandboxId` drops the stale id from
 * the session file so later sweeps don't re-destroy — only for sessions that
 * keep existing (the archive sweep); a deleted session has no file to touch.
 */
export function destroySessionSandbox(
  session: UnifiedSession,
  why: string,
  clearSandboxId = false,
): void {
  const sb = session.sandbox;
  if (!sb?.sandboxId) return;
  if (!isRemoteSandboxProvider(sb.provider)) return;
  void (async () => {
    try {
      revokeWorkloadIdentityForSandbox(sb.sandboxId!);
      await dropSandboxPreviewRoutes(sb.sandboxId!);
      await getSandboxProvider(sb.provider).destroy(sb.sandboxId!);
      console.log(
        `[sandbox] destroyed ${sb.sandboxId} for ${session.id} (${why})`,
      );
      if (clearSandboxId && session.source === "opensession")
        touchNativeSession(session.id, {
          sandbox: { ...sb, sandboxId: undefined },
        });
    } catch (e) {
      console.warn(
        `[sandbox] destroy ${sb.sandboxId} for ${session.id} (${why}) failed:`,
        e,
      );
    }
  })();
}

/**
 * Resolve a live sandbox. Status inspection is deliberately non-waking: a
 * sleeping session remains readable and its Portals sidebar must not spend
 * compute merely to render. Callers performing an explicit compute action pass
 * `wake: true`.
 */
export async function activeSandboxFor(
  session: UnifiedSession,
  options: { wake?: boolean } = {},
): Promise<Sandbox | null> {
  const sb = session.sandbox;
  if (!sb?.provider || !sb.sandboxId) return null;
  if (!sandboxesEnabled()) return null;
  if (isRemoteSandboxProvider(sb.provider)) {
    if (!sandboxProviderConfigured(sb.provider)) return null;
    try {
      const provider = getSandboxProvider(sb.provider);
      let sandbox = await provider.get(sb.sandboxId);
      let woke = false;
      if (
        sandbox &&
        (await sandbox.status()) === "stopped" &&
        options.wake &&
        provider.resume
      ) {
        if (session.source === "opensession")
          touchNativeSession(session.id, {
            sandbox: {
              ...sb,
              lifecycle: "waking",
              lastLifecycleError: undefined,
            },
          });
        sandbox = await provider.resume(sb.sandboxId);
        woke = true;
        if (
          sandbox &&
          (await sandbox.status()) === "running" &&
          session.source === "opensession"
        )
          touchNativeSession(session.id, {
            sandbox: {
              ...sb,
              lifecycle: "awake",
              lastLifecycleError: undefined,
            },
          });
      }
      if (sandbox && (await sandbox.status()) === "running") {
        if (woke) await restoreSandboxPortals(session, sandbox);
        return sandbox;
      }
      return null;
    } catch (error) {
      if (options.wake && session.source === "opensession")
        touchNativeSession(session.id, {
          sandbox: {
            ...sb,
            lifecycle: "needs_attention",
            lastLifecycleError:
              error instanceof Error
                ? error.message.slice(0, 240)
                : String(error).slice(0, 240),
          },
        });
      return null;
    }
  }
  return null;
}

/**
 * Bring a woken Sandbox's Portals back. A sleeping sandbox keeps its disk and
 * therefore its `.ports.conf` registry, but none of its processes: every
 * record still marked live is a service the user had running when the
 * sandbox went to sleep. Restart each one with the same command, port, and
 * (for declared Portals) trusted recipe env, so the URLs the user already has
 * keep working after the wake. Failures are logged per Portal and never fail
 * the wake itself.
 *
 * `onlyDead` is for a Sandbox this process did not wake: the provider may
 * have stopped and restarted it on its own, leaving the registry intact and
 * the processes gone. Probe first and restart only the Portals whose process
 * is missing, so a healthy dev server survives a mere gateway restart.
 */
export async function restoreSandboxPortals(
  session: UnifiedSession,
  sandbox: Sandbox,
  options: { onlyDead?: boolean } = {},
): Promise<void> {
  let records;
  try {
    records = await readSandboxPortalRecords(sandbox);
  } catch (error) {
    console.warn(`[sandbox] ${sandbox.id}: could not read Portals:`, error);
    return;
  }
  let live = records.filter(
    (record) => record.state !== "stopped" && record.state !== "failed",
  );
  if (live.length && options.onlyDead) {
    try {
      live = portalsToRestore(live, await listSandboxPortalServices(sandbox));
    } catch (error) {
      console.warn(`[sandbox] ${sandbox.id}: could not probe Portals:`, error);
      return;
    }
  }
  if (!live.length) return;
  const recipes = await sandboxPortalRecipes(sandbox).catch(() => []);
  const repoId = session.repo ? getRepo(session.repo).id : undefined;
  const env = repoId
    ? createWorkloadIdentityEnv(
        sandboxPreviewIdentityContext(sandbox, repoId, "interactive"),
      )
    : undefined;
  for (const record of live) {
    const recipe = recipes.find(
      (candidate) => candidate.id === record.name && candidate.command,
    );
    try {
      await restartSandboxPortalService({
        sessionId: session.id,
        sandbox,
        ...(recipe ? recipeStartOptions(recipe) : { name: record.name }),
        port: record.port,
        env,
      });
      console.log(
        `[sandbox] ${sandbox.id}: restored Portal ${record.name} on ${record.port}`,
      );
    } catch (error) {
      console.warn(
        `[sandbox] ${sandbox.id}: could not restore Portal ${record.name}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
