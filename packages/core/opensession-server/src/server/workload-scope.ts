/**
 * Keep work the gateway starts, but that is not the gateway, out of the
 * latency-sensitive control slice.
 *
 * The gateway service lives in opensession-control.slice, which outweighs
 * agent workloads 10:1 for CPU and shares the service's MemoryHigh with every
 * child. Model CLIs, stdio MCP servers, published apps, host terminals,
 * dependency installs and transcoders started straight from the gateway used
 * to inherit that cgroup: about 30 bridge `claude` processes (6 GB) sat next
 * to the event loop and competed with it for CPU and memory.
 *
 * `workloadArgv` wraps a command in a transient systemd user scope in the
 * agent workload slice. The scope execs the command in place, so the pid,
 * stdio, cwd, environment and signals the caller sees are unchanged. Outside
 * the control plane (tests, dev instances, macOS) the command is returned
 * as is.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  SYSTEMD_USER_RUNTIME,
  engineScopeSystemdArgs,
  processRunsInControlPlane,
  systemdUserScopesAvailable,
} from "./systemd-scopes";

/** Re-check availability now and then: the user manager can come and go. */
const AVAILABILITY_TTL_MS = 60_000;
let availability: { at: number; scope: boolean } | null = null;

function shouldScope(): boolean {
  const now = Date.now();
  if (!availability || now - availability.at > AVAILABILITY_TTL_MS)
    availability = {
      at: now,
      scope: processRunsInControlPlane() && systemdUserScopesAvailable(),
    };
  return availability.scope;
}

/** Test seam: force scoping on or off, or `null` to detect again. */
export function __setWorkloadScopingForTest(scope: boolean | null): void {
  availability = scope === null ? null : { at: Date.now(), scope };
}

/** A unit name that never collides: `opensession-<kind>-<random>`. */
export function workloadUnitName(kind: string): string {
  const safe = kind.replace(/[^a-z0-9-]/g, "-").slice(0, 32) || "task";
  return `opensession-${safe}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * The argv that runs `argv` in its own workload scope. `/usr/bin/env` supplies
 * the user manager's runtime dir, so the result works with any spawn API and
 * any (even minimal) caller environment.
 */
export function workloadArgv(argv: string[], kind: string): string[] {
  if (!shouldScope()) return argv;
  return [
    "/usr/bin/env",
    `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || SYSTEMD_USER_RUNTIME}`,
    "systemd-run",
    "--user",
    "--scope",
    "--collect",
    "--quiet",
    `--unit=${workloadUnitName(kind)}`,
    ...engineScopeSystemdArgs(),
    "--property=TimeoutStopSec=2",
    "--",
    ...argv,
  ];
}

/** `{ command, args }` form of workloadArgv (stdio MCP transports, spawn). */
export function workloadCommand(
  command: string,
  args: string[],
  kind: string,
): { command: string; args: string[] } {
  const [head, ...rest] = workloadArgv([command, ...args], kind);
  return { command: head!, args: rest };
}

/**
 * `spawnClaudeCodeProcess` for the Agent SDK: the SDK's own spawn, with the
 * Claude Code CLI (and the MCP servers it starts) in a workload scope.
 */
export function spawnClaudeCodeInWorkload(
  kind: string,
): (options: ClaudeSpawnOptions) => SpawnedProcess {
  return (options) => {
    const { command, args } = workloadCommand(
      options.command,
      options.args,
      kind,
    );
    return spawn(command, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  };
}

/**
 * Processes sharing the gateway's control-plane cgroup, other than the
 * gateway and its supervisor, counted by command name. Anything listed here
 * competes with the event loop; /api/health reports it so a new spawn site
 * that skipped workloadArgv shows up. `null` outside the control plane.
 */
export async function controlPlaneResidents(): Promise<{
  count: number;
  byCommand: Record<string, number>;
} | null> {
  let own: string;
  try {
    own = await readFile("/proc/self/cgroup", "utf8");
  } catch {
    return null;
  }
  if (!processRunsInControlPlane(own)) return null;
  const path = own.trim().split("\n")[0]?.split("::")[1];
  if (!path) return null;
  let pids: number[];
  try {
    pids = (await readFile(`/sys/fs/cgroup${path}/cgroup.procs`, "utf8"))
      .split("\n")
      .map(Number)
      .filter((pid) => pid > 0 && pid !== process.pid && pid !== process.ppid);
  } catch {
    return null;
  }
  const byCommand: Record<string, number> = {};
  for (const pid of pids.slice(0, 500)) {
    const name = await readFile(`/proc/${pid}/comm`, "utf8").then(
      (comm) => comm.trim(),
      () => null,
    );
    if (name) byCommand[name] = (byCommand[name] ?? 0) + 1;
  }
  return { count: pids.length, byCommand };
}
