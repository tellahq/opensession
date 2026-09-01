/**
 * workspace-exec — the single choke point that decides WHERE a session's
 * workspace commands run (docs/self-hosting-sandboxes.md).
 *
 * The four host-filesystem-coupled surfaces (file-index.ts @-mention search,
 * git-diff.ts, git-status.ts push/pull/status, and their opensession.ts routes)
 * take an optional `WorkspaceExec`; callers derive it per request via
 * `workspaceExecFor(session, dir)`:
 *
 *  - No sandbox: a host exec via Bun's `$` in the workspace dir.
 *  - ACTIVE docker sandbox (session opted in, provider materialized, config
 *    still says docker, kill-switch absent, container ACTUALLY running): a
 *    `docker exec -w <dir>` in the session's container.
 *
 * A stopped durable remote sandbox is transparently resumed for a read. That
 * is the orb-style contract: diff/status/@-mentions are user intent and must
 * wake the workspace rather than fail because the idle policy worked. A
 * provider without an explicit resume capability still fails closed; falling
 * back to a stale/nonexistent host path could inspect or mutate the wrong tree.
 *
 * With Phase 1 bind mounts this routing is functionally redundant — host git
 * sees the same files. The POINT is the seam: volume-only workspaces (below)
 * and Phase 3 remote providers have no host copy at all, and every surface
 * that goes through here keeps working there unchanged.
 *
 * The decision (config read + one docker inspect) is made once per
 * `workspaceExecFor` call and cached on the returned closure — call it once
 * per request, not per command. No global state.
 */

import { $ } from "bun";
import { sandboxesEnabled, sandboxProviderConfigured } from "./config";
import { isRemoteSandboxProvider } from "./config";
import { dockerContainerStatus, rawDockerExec } from "./docker";
import type { ExecOpts, ExecResult } from "./provider";

/**
 * An exec bound to one workspace. `sandboxed`/`remote` let surfaces pick
 * strategies (e.g. git-diff reads untracked-file contents with fs when the
 * workspace is host-visible, via exec when it only exists in the sandbox).
 */
export type WorkspaceExec = ((
  cmd: string[],
  opts?: ExecOpts,
) => Promise<ExecResult>) & {
  /** Commands run inside a sandbox container (docker exec). */
  readonly sandboxed: boolean;
  /** The workspace exists ONLY inside the sandbox (volume mode / remote
   *  provider) — host fs reads of workspace files won't work. */
  readonly remote: boolean;
};

/** The minimal session shape the routing decision needs (UnifiedSession and
 *  NativeSessionFile both satisfy it). */
export interface WorkspaceExecSession {
  id?: string;
  createdBy?: string | null;
  sandbox?: { provider?: string; sandboxId?: string; workspace?: string };
  runner?: { id: string; workspacePath: string };
  worktreeDir?: string | null;
  repo?: string;
}

/** Host exec in `dir` via Bun's `$` — argv-array interpolation (no shell
 *  splitting), never throws on non-zero exit. Today's behavior, verbatim. */
export function hostWorkspaceExec(dir: string): WorkspaceExec {
  const exec = async (cmd: string[], opts?: ExecOpts): Promise<ExecResult> => {
    if (opts?.timeoutMs) {
      const proc = Bun.spawn(cmd, {
        cwd: dir,
        env: { ...process.env, ...opts.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: opts.timeoutMs,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    }
    const shell = opts?.env ? $.env({ ...process.env, ...opts.env } as any) : $;
    const r = await shell`${cmd}`.cwd(dir).nothrow().quiet();
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  };
  return Object.assign(exec, { sandboxed: false, remote: false } as const);
}

/** True when the session's workspace lives only inside its sandbox (volume
 *  mode) — host `existsSync(worktreeDir)` guards must not short-circuit it. */
export function hasRemoteWorkspace(
  session: WorkspaceExecSession | null | undefined,
): boolean {
  return session?.sandbox?.workspace === "volume" || !!session?.runner;
}

/**
 * Resolve the exec for a session's workspace. `dir` defaults to the session's
 * primary `worktreeDir`; pass an attached repo's dir explicitly to target it
 * (attached repos are host worktrees, so they resolve to host exec unless the
 * sandbox actually mounts them). Never throws — every failure mode falls back
 * to the host exec, which is exactly the no-sandbox behavior.
 */
export async function workspaceExecFor(
  session: WorkspaceExecSession | null | undefined,
  dir?: string,
): Promise<WorkspaceExec> {
  const cwd = dir || session?.worktreeDir || "";
  const host = hostWorkspaceExec(cwd);
  if (session?.runner && session.repo && cwd === session.runner.workspacePath) {
    try {
      const { execRunnerWorkspace } = await import("../runner-ws");
      const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
      return Object.assign(
        async (cmd: string[], opts?: ExecOpts) => {
          if (opts?.env && Object.keys(opts.env).length) {
            return {
              exitCode: 1,
              stdout: "",
              stderr:
                "Runner workspace commands cannot inject environment variables",
            };
          }
          const result = await execRunnerWorkspace(session.runner!.id, {
            sessionId: session.id || "",
            repo: session.repo!,
            user: session.createdBy || undefined,
            workspacePath: cwd,
            command: cmd.map(quote).join(" "),
          });
          return {
            exitCode: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        },
        { sandboxed: false, remote: true } as const,
      );
    } catch {
      return Object.assign(
        async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "Runner workspace is unavailable",
        }),
        { sandboxed: false, remote: true } as const,
      );
    }
  }
  const sb = session?.sandbox;
  if (!cwd || !sb?.provider || !sb.sandboxId) return host;
  const unavailableRemote = Object.assign(
    async (): Promise<ExecResult> => ({
      exitCode: 1,
      stdout: "",
      stderr: `remote sandbox ${sb.sandboxId} is unavailable`,
    }),
    { sandboxed: true, remote: true } as const,
  );
  try {
    if (!sandboxesEnabled()) {
      return sb.workspace === "volume" ? unavailableRemote : host;
    }
    if (isRemoteSandboxProvider(sb.provider)) {
      if (!sandboxProviderConfigured(sb.provider)) return unavailableRemote;
      const { getSandboxProvider } = await import("./index");
      const provider = getSandboxProvider(sb.provider);
      let sandbox = await provider.get(sb.sandboxId);
      if (
        sandbox &&
        (await sandbox.status()) === "stopped" &&
        provider.resume
      ) {
        sandbox = await provider.resume(sb.sandboxId);
      }
      if (!sandbox || (await sandbox.status()) !== "running")
        return unavailableRemote;
      return Object.assign(
        (cmd: string[], opts?: ExecOpts) => sandbox.exec(cmd, opts),
        { sandboxed: true, remote: true } as const,
      );
    }
    if (sb.provider !== "docker") return host;
    // Provider-configured, not config-default: a session may have picked
    // docker explicitly while the config default is another provider.
    if (!sandboxProviderConfigured("docker")) return host;
    if ((await dockerContainerStatus(sb.sandboxId)) !== "running") return host;
    const exec = rawDockerExec(sb.sandboxId, cwd);
    return Object.assign((cmd: string[], opts?: ExecOpts) => exec(cmd, opts), {
      sandboxed: true,
      remote: sb.workspace === "volume",
    } as const);
  } catch {
    return sb.workspace === "volume" ? unavailableRemote : host;
  }
}
