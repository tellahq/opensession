/**
 * Async subprocess runner for code paths that used to call
 * child_process.spawnSync on the server's main thread. spawnSync blocks
 * Bun's single event loop for the child's entire runtime — a `wt delete`
 * on a large repo takes ~10s, and the boot-time worktree cleanup running a
 * string of them froze every HTTP request, WebSocket upgrade and transcript
 * load server-wide (2026-07-23). The result shape mirrors spawnSync's
 * (status/stdout/stderr) so call sites convert 1:1; status is null when the
 * process was killed by the timeout or failed to spawn.
 */
export interface RunCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number; inheritStdio?: boolean } = {},
): Promise<RunCommandResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: opts.inheritStdio ? "inherit" : "pipe",
      stderr: opts.inheritStdio ? "inherit" : "pipe",
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {}
      }, opts.timeoutMs);
    }
    const [stdout, stderr, status] = await Promise.all([
      opts.inheritStdio || !proc.stdout
        ? Promise.resolve("")
        : new Response(proc.stdout).text(),
      opts.inheritStdio || !proc.stderr
        ? Promise.resolve("")
        : new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timer) clearTimeout(timer);
    return { status: timedOut ? null : status, stdout, stderr };
  } catch (e) {
    return {
      status: null,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}
