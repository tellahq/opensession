import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { CommandResult, CommandSpec } from "./types";
import { redact } from "./security";

const OUTPUT_LIMIT = 200_000;

export function findExecutable(name: string): string | undefined {
  if (isAbsolute(name)) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return undefined;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export async function runCommand(
  spec: CommandSpec,
  options: { timeoutMs?: number; extraEnv?: Record<string, string> } = {},
): Promise<CommandResult> {
  const executable = findExecutable(spec.executable);
  if (!executable) throw new Error(`Executable not found: ${spec.executable}`);
  const started = Date.now();
  const proc = Bun.spawn([executable, ...spec.args], {
    cwd: spec.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      ...options.extraEnv,
    },
  });
  const timeout = setTimeout(
    () => proc.kill("SIGTERM"),
    options.timeoutMs ?? 20 * 60_000,
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timeout));
  return {
    command: redact([spec.executable, ...spec.args].join(" ")),
    exitCode,
    stdout: redact(stdout.slice(-OUTPUT_LIMIT)),
    stderr: redact(stderr.slice(-OUTPUT_LIMIT)),
    durationMs: Date.now() - started,
  };
}

export async function runChecked(
  spec: CommandSpec,
  options: { timeoutMs?: number; extraEnv?: Record<string, string> } = {},
): Promise<CommandResult> {
  const result = await runCommand(spec, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${result.command} failed (${result.exitCode})\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}
