/**
 * LocalProvider — the host-worktree default behind the Sandbox interface
 * (docs/self-hosting-sandboxes.md). The "sandbox" is just the host: `ensure` resolves a
 * workspace exactly the way the existing session paths do (delegating to
 * worktree.ts — never duplicating its git logic), `exec` runs on the host via
 * Bun's `$`. Runs never launch through a Sandbox handle: every session's
 * agent loop runs on this server (run-session.ts).
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
import { providerFor } from "../models";
import {
  getRepo,
  repoForPath,
  listWorktrees,
  createWorktree,
  reviveWorktree,
  sharedCheckoutForNewSessions,
} from "../worktree";
import type {
  ExecOpts,
  ExecResult,
  PortMap,
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
