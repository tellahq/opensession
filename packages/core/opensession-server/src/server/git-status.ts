/**
 * Local git state for a session's worktree — the Conductor-style status header
 * and "Git status" rows (ahead of remote → Push, behind main → Update, dirty
 * tree → Commit). Complements pr-info.ts, which covers the GitHub side.
 *
 * origin/<base> is refreshed with a throttled fetch so "behind main" is honest
 * without hammering the remote from every open panel.
 *
 * Sandbox-aware (sandbox rollout Phase 2): callers may pass a
 * WorkspaceExec (workspaceExecFor) so every git command — including fetch,
 * pull and push, which then use the sandbox's mounted read-only creds — runs
 * inside the session's sandbox. Omitted = the host path, unchanged.
 */
import { $ } from "bun";
import { audited } from "./audit";
import { personaName } from "./config";
import { isSharedCheckoutDir } from "./worktree";
import type { WorkspaceExec } from "./sandbox/workspace-exec";

/** `git -C <dir> <args>` on the host (Bun $) or through the workspace exec.
 *  Throws on non-zero exit, matching the Bun $ .text() call sites here. */
async function gitText(
  dir: string,
  args: string[],
  exec?: WorkspaceExec,
): Promise<string> {
  const argv = ["git", "-C", dir, ...args];
  if (exec) {
    const r = await exec(argv);
    if (r.exitCode !== 0)
      throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
    return r.stdout;
  }
  return await $`${argv}`.quiet().text();
}

export interface GitStatusInfo {
  branch: string | null;
  /** Branch has a published remote counterpart, configured or inferred. */
  hasUpstream: boolean;
  /** Commits ahead of / behind the upstream tracking ref. */
  ahead: number;
  behind: number;
  /** Commits on origin/<base> that this branch doesn't have. */
  behindBase: number;
  baseBranch: string;
  /** Dirty files in the working tree (staged + unstaged + untracked). */
  uncommittedFiles: number;
  /**
   * This dir is a repo's shared checkout rather than a per-session worktree
   * (Open Session's own repo works this way — every session edits one tree on
   * the default branch), so the working tree also holds other sessions' edits.
   * `uncommittedFiles` is then scoped to the files this session wrote, and
   * anything that commits must name paths rather than stage the tree.
   */
  sharedCheckout: boolean;
  /**
   * The dirty files, when the count is scoped to this session (capped). Lets
   * the UI commit exactly these paths instead of everything in the tree.
   */
  uncommittedPaths?: string[];
}

/** Most paths a scoped status reports back; enough to name them in a prompt. */
const MAX_SCOPED_PATHS = 40;

/**
 * Paths out of `git status --porcelain`: two status columns, a space, then the
 * path — quoted when it has odd characters, and `old -> new` for a rename, of
 * which only the new path exists on disk.
 */
export function porcelainPaths(status: string): string[] {
  const out: string[] = [];
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    if (path.startsWith('"') && path.endsWith('"')) {
      try {
        path = JSON.parse(path) as string;
      } catch {
        path = path.slice(1, -1);
      }
    }
    if (path) out.push(path);
  }
  return out;
}

/** Select the credential transport for the process that will run Git. Host
 * calls use the stable Open Session helper supplied by github-auth. Local
 * Docker calls cannot reach that host path, so they use gh inside the
 * container. Remote sandboxes and Runners keep their own projected transport. */
export function gitCredentialEnvForExec(
  env?: Record<string, string>,
  exec?: WorkspaceExec,
): Record<string, string> | undefined {
  if (!env) return undefined;
  if (exec?.remote) return undefined;
  if (!exec?.sandboxed) return env;
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) return undefined;
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: "!gh auth git-credential",
  };
}

const FETCH_TTL = 90_000;
const lastFetch = new Map<string, number>();

/** Prefer Git's actionable final diagnostic over fetch progress such as
 * `From github.com:…`, which otherwise consumes the UI's whole error line. */
export function gitFailureMessage(output: string, fallback: string): string {
  const lines = output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostic = [...lines]
    .reverse()
    .find((line) => /^(?:fatal|error):\s*/i.test(line));
  return (diagnostic || lines.at(-1) || fallback)
    .replace(/^(?:fatal|error):\s*/i, "")
    .slice(0, 300);
}

async function refreshBase(
  dir: string,
  baseBranch: string,
  exec?: WorkspaceExec,
): Promise<void> {
  const last = lastFetch.get(dir) || 0;
  if (Date.now() - last < FETCH_TTL) return;
  lastFetch.set(dir, Date.now());
  try {
    await gitText(
      dir,
      ["fetch", "origin", baseBranch, "--no-tags", "--quiet"],
      exec,
    );
  } catch {
    // Offline or no remote — counts fall back to the last-known tracking refs.
  }
}

export async function getGitStatus(
  dir: string,
  baseBranch = "main",
  exec?: WorkspaceExec,
  /**
   * Repo-relative paths this session wrote (sessionTouchedPaths). Pass them for
   * a shared checkout, where the working tree is everyone's: the dirty count is
   * then this session's own files rather than the tree's.
   */
  ownPaths?: string[],
): Promise<GitStatusInfo> {
  // Fire-and-forget: the fetch is only there to keep origin/<base> current for
  // the NEXT poll. Awaiting it made every TTL-expired status call block on a
  // network round-trip — the status header polls every 45s, so counts computed
  // from refs one poll old are an honest trade for an instant response.
  void refreshBase(dir, baseBranch, exec);

  let branch: string | null = null;
  try {
    branch =
      (await gitText(dir, ["branch", "--show-current"], exec)).trim() || null;
  } catch {}

  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;
  try {
    const counts = (
      await gitText(
        dir,
        ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        exec,
      )
    ).trim();
    const [b, a] = counts.split(/\s+/).map((n) => parseInt(n) || 0);
    hasUpstream = true;
    behind = b || 0;
    ahead = a || 0;
  } catch {
    // A plain `git push origin <branch>` publishes the branch without writing
    // branch.<name>.remote/merge. Treat its remote-tracking ref as the upstream
    // anyway; comparing against the base would mislabel every feature commit as
    // unpushed even when origin/<branch> is exactly at HEAD.
    if (branch) {
      try {
        const counts = (
          await gitText(
            dir,
            ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`],
            exec,
          )
        ).trim();
        const [b, a] = counts.split(/\s+/).map((n) => parseInt(n) || 0);
        hasUpstream = true;
        behind = b || 0;
        ahead = a || 0;
      } catch {}
    }
    // No configured or inferred upstream: commits past the base are local-only.
    if (!hasUpstream) {
      try {
        ahead =
          parseInt(
            (
              await gitText(
                dir,
                ["rev-list", "--count", `origin/${baseBranch}..HEAD`],
                exec,
              )
            ).trim(),
          ) || 0;
      } catch {}
    }
  }

  let behindBase = 0;
  try {
    behindBase =
      parseInt(
        (
          await gitText(
            dir,
            ["rev-list", "--count", `HEAD..origin/${baseBranch}`],
            exec,
          )
        ).trim(),
      ) || 0;
  } catch {}

  const sharedCheckout = isSharedCheckoutDir(dir);
  let uncommittedFiles = 0;
  let uncommittedPaths: string[] | undefined;
  try {
    const status = await gitText(dir, ["status", "--porcelain"], exec);
    const paths = porcelainPaths(status);
    if (ownPaths) {
      const own = new Set(ownPaths);
      const mine = paths.filter((p) => own.has(p));
      uncommittedFiles = mine.length;
      uncommittedPaths = mine.slice(0, MAX_SCOPED_PATHS);
    } else {
      uncommittedFiles = paths.length;
    }
  } catch {}

  return {
    branch,
    hasUpstream,
    ahead,
    behind,
    behindBase,
    baseBranch,
    uncommittedFiles,
    sharedCheckout,
    uncommittedPaths,
  };
}

/**
 * Update the worktree — the Pull/Update action in the status header. Pulling
 * the branch's own upstream stays fast-forward-only. Updating from the base
 * merges origin/<base> locally: a feature branch necessarily diverges from its
 * base, so `pull --ff-only origin main` could never perform the update the UI
 * promised. The merge preserves published history and the existing Push action
 * can publish it without a force-push.
 */
export async function gitPull(
  dir: string,
  fromBase?: string,
  exec?: WorkspaceExec,
  env?: Record<string, string>,
): Promise<{ ok: true } | { error: string }> {
  return audited(
    {
      context: "sessions",
      action: "git_pull",
      args: {
        dir,
        fromBase: fromBase || null,
        sandboxed: exec?.sandboxed || undefined,
      },
    },
    async () => {
      const operationEnv = gitCredentialEnvForExec(env, exec);
      async function run(
        args: string[],
      ): Promise<{ stdout: string; stderr: string; code: number }> {
        if (exec) {
          const r = await exec(
            args,
            operationEnv ? { env: operationEnv } : undefined,
          );
          return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
        }
        const proc = Bun.spawn(args, {
          env: { ...process.env, ...operationEnv },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, code };
      }

      if (!fromBase) {
        const result = await run(["git", "-C", dir, "pull", "--ff-only"]);
        if (result.code !== 0)
          return {
            error: gitFailureMessage(result.stderr, "Git pull failed"),
          } as const;
        return { ok: true } as const;
      }

      const status = await run(["git", "-C", dir, "status", "--porcelain"]);
      if (status.code !== 0)
        return {
          error: (status.stderr || "Could not inspect the worktree")
            .trim()
            .slice(0, 300),
        } as const;
      if (status.stdout.trim())
        return {
          error: "Commit or discard the uncommitted changes before updating.",
        } as const;

      const fetch = await run([
        "git",
        "-C",
        dir,
        "fetch",
        "origin",
        fromBase,
        "--no-tags",
        "--quiet",
      ]);
      if (fetch.code !== 0)
        return {
          error: gitFailureMessage(
            fetch.stderr,
            `Could not fetch origin/${fromBase}`,
          ),
        } as const;

      const merge = await run([
        "git",
        "-C",
        dir,
        "merge",
        "--no-edit",
        "--no-autostash",
        `origin/${fromBase}`,
      ]);
      if (merge.code !== 0) {
        const mergeState = await run([
          "git",
          "-C",
          dir,
          "rev-parse",
          "--verify",
          "MERGE_HEAD",
        ]);
        if (mergeState.code === 0) {
          const abort = await run(["git", "-C", dir, "merge", "--abort"]);
          if (abort.code !== 0)
            return {
              error: `Update failed and Git could not restore the worktree: ${(
                abort.stderr ||
                merge.stderr ||
                merge.stdout ||
                "unknown error"
              )
                .trim()
                .slice(0, 220)}`,
            } as const;
          return {
            error: `Could not update automatically because this branch conflicts with ${fromBase}. Ask ${personaName()} to resolve the conflicts.`,
          } as const;
        }
        return {
          error: (merge.stderr || merge.stdout || "Could not update the branch")
            .trim()
            .slice(0, 300),
        } as const;
      }
      return { ok: true } as const;
    },
  );
}

/**
 * Push the worktree's current branch (sets upstream on first push). Audited —
 * this publishes commits. Never forces; a rejected push surfaces as an error
 * for the human (or the session) to resolve.
 */
export async function gitPush(
  dir: string,
  branch: string,
  exec?: WorkspaceExec,
  env?: Record<string, string>,
): Promise<{ ok: true } | { error: string }> {
  return audited(
    {
      context: "sessions",
      action: "git_push",
      args: { dir, branch, sandboxed: exec?.sandboxed || undefined },
    },
    async () => {
      const operationEnv = gitCredentialEnvForExec(env, exec);
      const args = ["git", "-C", dir, "push", "-u", "origin", "HEAD"];
      let err: string;
      let code: number;
      if (exec) {
        const r = await exec(
          args,
          operationEnv ? { env: operationEnv } : undefined,
        );
        err = r.stderr;
        code = r.exitCode;
      } else {
        const proc = Bun.spawn(args, {
          env: { ...process.env, ...operationEnv },
          stdout: "pipe",
          stderr: "pipe",
        });
        [err, code] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
      }
      if (code !== 0)
        return { error: gitFailureMessage(err, "Git push failed") } as const;
      return { ok: true } as const;
    },
  );
}
