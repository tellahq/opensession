/**
 * LocalProvider — the host-worktree default behind the Sandbox interface
 * (docs/self-hosting-sandboxes.md). The "sandbox" is just the host: `ensure` resolves a
 * workspace exactly the way the existing session paths do (delegating to
 * worktree.ts — never duplicating its git logic), `exec` runs on the host via
 * Bun's `$`, and `launchRun` is the current in-process `runAgent` path.
 *
 * Identical to the plain host path by construction:
 *  - `ensure` only *reuses* the resolution helpers the create/prompt paths
 *    already call (getRepo/listWorktrees/createWorktree/reviveWorktree), so a
 *    cwd derived through it is byte-identical to one derived without it.
 *  - `destroy` is a no-op: local worktree lifecycle stays with
 *    removeWorktree/sweepArchivedWorktrees — a sandbox teardown must never
 *    delete a worktree that outlives the session concept today.
 */

import { $ } from "bun";
import { existsSync } from "fs";
import {
  runAgent,
  steerAgentRun,
  interruptAndSteerAgentRun,
  cancelAgentRun,
} from "../agent-runner";
import { modelSupportsSteer, providerFor } from "../models";
import {
  getRepo,
  repoForPath,
  listWorktrees,
  createWorktree,
  reviveWorktree,
  sharedCheckoutForNewSessions,
} from "../worktree";
import type { RunHostSpec } from "../../runner-host/protocol";
import type {
  ExecOpts,
  ExecResult,
  PortMap,
  RunHandle,
  RunHandleCallbacks,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "./provider";

const ID_PREFIX = "local:";

/** Local sandbox ids encode the workspace path — the host dir IS the sandbox. */
function idFor(cwd: string): string {
  return `${ID_PREFIX}${cwd}`;
}

function cwdFromId(sandboxId: string): string | null {
  return sandboxId.startsWith(ID_PREFIX)
    ? sandboxId.slice(ID_PREFIX.length)
    : null;
}

function makeLocalSandbox(cwd: string): Sandbox {
  return {
    id: idFor(cwd),
    provider: "local",
    cwd,

    // One-shot host command in the workspace. Never throws on non-zero exit.
    async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
      const shell = opts?.env
        ? $.env({ ...process.env, ...opts.env } as any)
        : $;
      // Bun's shell expands an array interpolation into escaped argv words.
      const r = await shell`${cmd}`.cwd(cwd).nothrow().quiet();
      return {
        exitCode: r.exitCode,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
      };
    },

    // The existing in-process runner path, mapped from the serializable spec
    // exactly like host-client's in-process fallback (runAgentHosted).
    launchRun(spec: RunHostSpec, cb?: RunHandleCallbacks): RunHandle {
      const gen = runAgent({
        prompt: spec.prompt,
        sessionId: spec.engineSessionId,
        cwd,
        mode: spec.mode,
        model: spec.model,
        images: spec.images,
        forkSession: spec.forkSession,
        resumeSessionAt: spec.resumeSessionAt,
        mcpServers: spec.mcpServers ?? "all",
        inProcessMcp: cb?.inProcessMcp?.(),
        reposNote: spec.reposNote,
        deniedTools: spec.deniedTools,
        publicationPolicy: spec.publicationPolicy,
        confirmTools: spec.confirmTools,
        aws: spec.aws,
        author: spec.author,
        user: spec.user,
        fallbackModel: spec.fallbackModel,
        journal: {
          osSessionId: spec.osSessionId,
          kind: spec.journalKind || "prompt",
        },
        // spec.hostId is the admitted run token (see maybeLaunchSandboxedRun);
        // carrying it keeps exact-token Stop latching working in-process.
        startToken: spec.hostId,
        onAskUser: cb?.onAskUser,
      });
      // In-process runs register their own control handles keyed by session
      // ids — steer/cancel route through the same agent-runner helpers the WS
      // handlers use, so behavior matches a directly-started run.
      const ids = [spec.osSessionId, spec.engineSessionId];
      return {
        events: () => gen,
        steerable: modelSupportsSteer(spec.model),
        steer: (text, images) => steerAgentRun(ids, text, images),
        interruptSteer: (text, images) =>
          interruptAndSteerAgentRun(ids, text, images),
        cancel: () => {
          void cancelAgentRun(...ids);
          return true;
        },
      };
    },

    // Local runs share the host network; preview.ts owns port allocation.
    async ports(): Promise<PortMap> {
      return {};
    },

    // A local sandbox is "running" as long as its workspace dir exists —
    // there is no stopped state on the host.
    async status(): Promise<SandboxStatus> {
      return existsSync(cwd) ? "running" : "gone";
    },
  };
}

export class LocalProvider implements SandboxProvider {
  readonly id = "local" as const;

  /**
   * Resolve the session's workspace, mirroring the existing paths 1:1:
   *  - explicit `cwd` (an existing session's worktreeDir) is reused as-is,
   *    reviving it from `branch` when the dir was cleaned up and falling back
   *    to the repo's main checkout when it can't be (runSessionPromptInner);
   *  - ask mode and sharedCheckout repos run on the main checkout
   *    (create_session paths);
   *  - code mode reuses the worktree already on `branch` or creates one via
   *    createWorktree (optionally stacked on `base`).
   */
  async ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    if (spec.cwd) {
      if (existsSync(spec.cwd)) return makeLocalSandbox(spec.cwd);
      const repo = spec.repo ? getRepo(spec.repo) : repoForPath(spec.cwd);
      if (spec.branch) {
        try {
          return makeLocalSandbox(await reviveWorktree(spec.branch, repo.id));
        } catch {
          return makeLocalSandbox(repo.repo);
        }
      }
      return makeLocalSandbox(repo.repo);
    }

    const repo = getRepo(spec.repo);
    if (spec.mode === "ask" || sharedCheckoutForNewSessions(repo)) {
      return makeLocalSandbox(repo.repo);
    }
    if (!spec.branch) {
      throw new Error(
        "code-mode local sandbox needs a branch for its worktree",
      );
    }
    const existing = (await listWorktrees(repo.id)).find(
      (w) => w.branch === spec.branch,
    );
    const cwd =
      existing?.path ||
      (await createWorktree(
        spec.branch,
        repo.id,
        spec.base ? { base: spec.base } : undefined,
      ));
    return makeLocalSandbox(cwd);
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const cwd = cwdFromId(sandboxId);
    if (!cwd) return null;
    return existsSync(cwd) ? makeLocalSandbox(cwd) : null;
  }

  /**
   * No-op by design: local worktrees are managed by removeWorktree and the
   * archived-worktree sweep, and the shared main checkouts must never be
   * touched. Destroying a *sandbox* only ever tears down provider-owned
   * resources — the local provider owns none.
   */
  async destroy(_sandboxId: string): Promise<void> {}
}
