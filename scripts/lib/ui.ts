/**
 * Terminal output helpers shared by the `opensession` CLI.
 *
 * Deliberately dependency-free: the CLI is the first thing a fresh install
 * runs, sometimes before `bun install` has finished, so it must work with
 * nothing but Bun itself.
 *
 * Colour is suppressed when stdout is not a TTY or NO_COLOR is set, so piping
 * `opensession doctor` into a file or a log collector stays readable.
 */

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

/** A blank line then a bold section title. */
export function heading(title: string): void {
  console.log(`\n${bold(title)}`);
}

export function info(message: string): void {
  console.log(`  ${message}`);
}

export function ok(message: string, detail?: string): void {
  console.log(`  ${green("ok")}      ${message}${detail ? ` ${dim(detail)}` : ""}`);
}

export function warn(message: string, detail?: string): void {
  console.log(`  ${yellow("warn")}    ${message}${detail ? ` ${dim(detail)}` : ""}`);
}

export function fail(message: string, detail?: string): void {
  console.log(`  ${red("fail")}    ${message}${detail ? ` ${dim(detail)}` : ""}`);
}

export function wrote(path: string, detail?: string): void {
  console.log(`  ${green("wrote")}   ${path}${detail ? ` ${dim(detail)}` : ""}`);
}

/**
 * Prompting rules, matching what openclaw's installer settled on:
 * test stdin (`-t 0`), never stdout — otherwise `install.sh > log.txt`
 * silently turns an interactive install into a defaults-only one. NO_PROMPT=1
 * forces non-interactive for scripted installs.
 */
export function canPrompt(): boolean {
  if (process.env.NO_PROMPT === "1") return false;
  return Boolean(process.stdin.isTTY);
}

export function ask(question: string, fallback: string): string {
  if (!canPrompt()) return fallback;
  const answer = prompt(`  ${question} ${dim(`[${fallback}]`)}`);
  return answer?.trim() || fallback;
}

export function askYesNo(question: string, fallback: boolean): boolean {
  if (!canPrompt()) return fallback;
  const answer = prompt(`  ${question} ${dim(fallback ? "[Y/n]" : "[y/N]")}`)
    ?.trim()
    .toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
}

/** Run a command, returning its exit code and captured output. */
export async function run(
  cmd: string[],
  opts: { cwd?: string; quiet?: boolean; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdout: opts.quiet ? "pipe" : "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Run a command with output streamed straight through to the terminal. */
export async function runInherit(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}
