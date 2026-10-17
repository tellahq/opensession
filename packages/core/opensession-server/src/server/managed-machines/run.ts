/**
 * Run one operator-configured command for a managed machine.
 *
 * argv only, never a shell: an agent's command reaches `exec` as one final
 * argument, which the configured prefix (for example `bash -lc` on the far
 * side of `ssh` or `kubectl exec`) interprets on the machine. The child gets
 * PATH and HOME from the server plus the operator's `env`, nothing else, so
 * the server's own secrets are not inherited. Output is bounded, and a
 * timeout or cancellation kills the child (SIGTERM, then SIGKILL).
 */

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
};

export type CommandRunner = (
  argv: string[],
  options: {
    env?: Record<string, string>;
    timeoutMs: number;
    stdin?: string;
    signal?: AbortSignal;
    maxOutput?: number;
  },
) => Promise<CommandResult>;

const DEFAULT_MAX_OUTPUT = 200_000;
const KILL_GRACE_MS = 5_000;

export function commandEnv(
  extra: Record<string, string> | undefined,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    PATH: base.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(base.HOME ? { HOME: base.HOME } : {}),
    ...extra,
  };
}

async function collect(
  stream: ReadableStream<Uint8Array> | null | undefined,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  for await (const chunk of stream) {
    if (text.length >= max) {
      truncated = true;
      continue; // keep draining so the child never blocks on a full pipe
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  if (text.length > max) {
    text = text.slice(0, max);
    truncated = true;
  }
  return { text, truncated };
}

export const runCommand: CommandRunner = async (argv, options) => {
  const max = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  if (options.signal?.aborted)
    return { code: -1, stdout: "", stderr: "", cancelled: true };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      env: commandEnv(options.env),
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      code: -1,
      stdout: "",
      stderr: `Could not run ${argv[0]}: ${(error as Error).message}`,
    };
  }
  if (options.stdin !== undefined) {
    const sink = proc.stdin as import("bun").FileSink;
    sink.write(options.stdin);
    void sink.end();
  }
  let timedOut = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    proc.kill("SIGTERM");
    killTimer ??= setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    kill();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      collect(proc.stdout as ReadableStream<Uint8Array>, max),
      collect(proc.stderr as ReadableStream<Uint8Array>, max),
      proc.exited,
    ]);
    return {
      code: timedOut || cancelled ? -1 : code,
      stdout: stdout.text + (stdout.truncated ? "\n[output truncated]" : ""),
      stderr: stderr.text + (stderr.truncated ? "\n[output truncated]" : ""),
      ...(timedOut ? { timedOut } : {}),
      ...(cancelled ? { cancelled } : {}),
    };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
};
