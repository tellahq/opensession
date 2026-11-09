/**
 * Run a service-restarting CLI command safely from inside Open Session.
 *
 * On macOS, `opensession restart` (and `update`, `stop`, and `bind`, which
 * restart too) boots the server's launchd job out and then bootstraps it
 * again. `launchctl bootout` unloads the job, so `KeepAlive` no longer
 * applies, and kills the job's whole process tree. A CLI started from a
 * session shell is in that tree: it dies between the two steps, nothing ever
 * runs `bootstrap`, and the server stays down until someone restarts it by
 * hand.
 *
 * So when the CLI finds itself running under one of Open Session's own
 * launchd jobs, it hands the whole command to a one-shot launchd job of its
 * own, outside the server's process tree, and returns. That job runs the
 * command to completion (including `update`'s health check and rollback) and
 * writes its output to `~/.opensession/logs/cli-handoff.log`.
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { HOME, OPENSESSION_HOME, REPO_ROOT, SHIM_PATH } from "./paths";
import { isCompiledBinary } from "../../packages/core/opensession-server/src/runner-host/exe";
import { run } from "./ui";

export const LAUNCHD_HANDOFF_LABEL = "dev.opensession.cli-handoff";
/** Set in the handoff job, so it never hands off again. */
export const CLI_HANDOFF_ENV = "OPENSESSION_CLI_HANDOFF";
export const CLI_HANDOFF_PLIST = join(OPENSESSION_HOME, "cli-handoff.plist");
export const CLI_HANDOFF_LOG = join(
  OPENSESSION_HOME,
  "logs",
  "cli-handoff.log",
);

/** Commands that restart or stop the launchd jobs. */
export function cliCommandRestartsService(argv: readonly string[]): boolean {
  const [command, ...rest] = argv;
  if (command === "restart" || command === "stop" || command === "bind")
    return true;
  if (command === "update")
    return !rest.some((a) =>
      ["--check", "--no-restart", "--help", "-h"].includes(a),
    );
  return false;
}

type RunCommand = typeof run;

/** The pid of a loaded launchd job, from `launchctl print`. */
async function launchdJobPid(
  target: string,
  runCommand: RunCommand,
): Promise<number | null> {
  const printed = await runCommand(["launchctl", "print", target], {
    quiet: true,
  });
  if (printed.code !== 0) return null;
  const match = printed.stdout.match(/^\s*pid = (\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

/** Every ancestor pid of `pid`, nearest first, from one `ps` listing. */
export function ancestorPids(psListing: string, pid: number): number[] {
  const parent = new Map<number, number>();
  for (const line of psListing.split("\n")) {
    const [child, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(child) && Number.isFinite(ppid))
      parent.set(child!, ppid!);
  }
  const ancestors: number[] = [];
  let current = parent.get(pid);
  while (
    current &&
    current > 1 &&
    current !== pid &&
    !ancestors.includes(current)
  ) {
    ancestors.push(current);
    current = parent.get(current);
  }
  return ancestors;
}

/** Whether this process descends from one of the given launchd jobs. */
export async function runsUnderLaunchdJobs(
  labels: readonly string[],
  opts: { domain: string; pid?: number; runCommand?: RunCommand },
): Promise<boolean> {
  const runCommand = opts.runCommand ?? run;
  const jobPids = new Set<number>();
  for (const label of labels) {
    const pid = await launchdJobPid(`${opts.domain}/${label}`, runCommand);
    if (pid) jobPids.add(pid);
  }
  if (!jobPids.size) return false;
  const ps = await runCommand(["ps", "-A", "-o", "pid=,ppid="], {
    quiet: true,
  });
  if (ps.code !== 0) return false;
  return ancestorPids(ps.stdout, opts.pid ?? process.pid).some((p) =>
    jobPids.has(p),
  );
}

const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The command that runs the CLI from outside this process: the stable
 * `opensession` shim of a release install (which an update repoints), or
 * this checkout's CLI for a source install. */
export function cliInvocation(compiled = isCompiledBinary()): string[] {
  if (compiled) return [SHIM_PATH];
  return [process.execPath, join(REPO_ROOT, "scripts", "cli.ts")];
}

export function renderHandoffPlist(input: {
  programArguments: readonly string[];
  path: string;
  log: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_HANDOFF_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${input.programArguments.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(HOME)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(input.path)}</string>
    <key>HOME</key><string>${xml(HOME)}</string>
    <key>${CLI_HANDOFF_ENV}</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>LaunchOnlyOnce</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${xml(input.log)}</string>
  <key>StandardErrorPath</key><string>${xml(input.log)}</string>
</dict>
</plist>
`;
}

export type HandoffResult =
  | { handedOff: false }
  | { handedOff: true; code: number; message: string };

/**
 * Hand `argv` to a one-shot launchd job when this CLI runs under one of the
 * `serviceLabels` jobs; otherwise do nothing. The caller runs the command
 * itself when this returns `handedOff: false`.
 */
export async function handOffIfUnderService(
  argv: readonly string[],
  opts: {
    serviceLabels: readonly string[];
    domain: string;
    runCommand?: RunCommand;
    pid?: number;
    bootstrap: (
      label: string,
      plist: string,
    ) => Promise<{ code: number; stderr: string }>;
    bootout: (label: string) => Promise<{ code: number; stderr: string }>;
    writePlist?: (path: string, contents: string) => void;
    env?: Record<string, string | undefined>;
    cli?: string[];
  },
): Promise<HandoffResult> {
  const env = opts.env ?? process.env;
  if (env[CLI_HANDOFF_ENV] === "1") return { handedOff: false };
  if (!cliCommandRestartsService(argv)) return { handedOff: false };
  const runCommand = opts.runCommand ?? run;
  if (
    !(await runsUnderLaunchdJobs(opts.serviceLabels, {
      domain: opts.domain,
      runCommand,
      ...(opts.pid ? { pid: opts.pid } : {}),
    }))
  )
    return { handedOff: false };

  const target = `${opts.domain}/${LAUNCHD_HANDOFF_LABEL}`;
  const previous = await runCommand(["launchctl", "print", target], {
    quiet: true,
  });
  if (previous.code === 0 && /^\s*state = running\s*$/m.test(previous.stdout))
    return {
      handedOff: true,
      code: 1,
      message: `A previous \`opensession ${argv[0]}\` is still running outside this session. Follow it in ${CLI_HANDOFF_LOG}.`,
    };
  if (previous.code === 0) {
    // A finished handoff stays loaded but idle; unload it before reusing
    // its label.
    const unloaded = await opts.bootout(LAUNCHD_HANDOFF_LABEL);
    if (unloaded.code !== 0)
      return {
        handedOff: true,
        code: 1,
        message: `Could not clear the previous handoff job: ${unloaded.stderr}`,
      };
  }

  const plist = renderHandoffPlist({
    programArguments: [...(opts.cli ?? cliInvocation()), ...argv],
    path: env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    log: CLI_HANDOFF_LOG,
  });
  (
    opts.writePlist ??
    ((path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      mkdirSync(dirname(CLI_HANDOFF_LOG), { recursive: true });
      writeFileSync(path, contents, { mode: 0o600 });
    })
  )(CLI_HANDOFF_PLIST, plist);
  const started = await opts.bootstrap(
    LAUNCHD_HANDOFF_LABEL,
    CLI_HANDOFF_PLIST,
  );
  if (started.code !== 0)
    return {
      handedOff: true,
      code: 1,
      message: `Could not start \`opensession ${argv[0]}\` outside this session: ${started.stderr}`,
    };
  return {
    handedOff: true,
    code: 0,
    message:
      `This shell runs under the Open Session server, which \`opensession ${argv[0]}\` stops. ` +
      `It now runs as its own launchd job so it can finish; this session's turn may end when the server restarts. ` +
      `Output: ${CLI_HANDOFF_LOG}`,
  };
}
