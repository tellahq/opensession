/**
 * Resource-controlled transient scopes used by Open Session on Linux.
 *
 * Limits are deliberately applied at the scope boundary rather than to the
 * model process alone: agent shell commands, MCP proxies, compilers, and dev
 * servers are descendants of the engine and must count against the same
 * budget. The parent opensession.slice supplies the host-wide aggregate fuse;
 * per-scope limits keep one user/server or preview from consuming that fuse.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const UID = typeof process.getuid === "function" ? process.getuid() : 1000;
export const SYSTEMD_USER_RUNTIME = `/run/user/${UID}`;

export const ENGINE_SLICE = "opensession-agents.slice";
export const PREVIEW_SLICE = "opensession-previews.slice";

type LimitEnv = Record<string, string | undefined>;

function value(env: LimitEnv, name: string, fallback: string): string {
  const configured = env[name]?.trim();
  // systemd byte/task/CPU properties accept integers with an optional binary
  // suffix or percentage. Fail closed to the known-good default on typos.
  return configured &&
    /^(?:infinity|\d+(?:\.\d+)?[KMGTPE]?%?)$/i.test(configured)
    ? configured
    : fallback;
}

function property(name: string, configured: string): string {
  return `--property=${name}=${configured}`;
}

export function engineScopeSystemdArgs(env: LimitEnv = process.env): string[] {
  return [
    `--slice=${ENGINE_SLICE}`,
    property("MemoryHigh", value(env, "OPENSESSION_ENGINE_MEMORY_HIGH", "6G")),
    property("MemoryMax", value(env, "OPENSESSION_ENGINE_MEMORY_MAX", "12G")),
    property("MemorySwapMax", value(env, "OPENSESSION_ENGINE_SWAP_MAX", "1G")),
    property("TasksMax", value(env, "OPENSESSION_ENGINE_TASKS_MAX", "1024")),
    property("OOMPolicy", "stop"),
  ];
}

export function previewScopeSystemdArgs(env: LimitEnv = process.env): string[] {
  return [
    `--slice=${PREVIEW_SLICE}`,
    property("MemoryHigh", value(env, "OPENSESSION_PREVIEW_MEMORY_HIGH", "8G")),
    property("MemoryMax", value(env, "OPENSESSION_PREVIEW_MEMORY_MAX", "12G")),
    property("MemorySwapMax", value(env, "OPENSESSION_PREVIEW_SWAP_MAX", "1G")),
    property("TasksMax", value(env, "OPENSESSION_PREVIEW_TASKS_MAX", "768")),
    property("CPUQuota", value(env, "OPENSESSION_PREVIEW_CPU_QUOTA", "600%")),
    property("OOMPolicy", "stop"),
  ];
}

export function systemdUserEnv(
  env: LimitEnv = process.env,
): Record<string, string> {
  return {
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || SYSTEMD_USER_RUNTIME,
  };
}

export function systemdUserScopesAvailable(): boolean {
  return (
    existsSync(`${SYSTEMD_USER_RUNTIME}/systemd/private`) &&
    !!Bun.which("systemd-run")
  );
}

function selfCgroup(): string {
  try {
    return readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

export function processRunsInControlPlane(cgroup = selfCgroup()): boolean {
  return cgroup.includes("/opensession-control.slice/");
}

/**
 * Move a gateway-owned engine command into the low-priority user workload
 * slice. Detached run hosts already live in opensession-workloads.slice and
 * must stay there so stopping their unit still kills every descendant.
 */
export function controlPlaneWorkloadCommand(
  command: string[],
  unit: string,
  options: {
    env?: LimitEnv;
    cgroup?: string;
    scopesAvailable?: boolean;
  } = {},
): { command: string[]; env: Record<string, string>; unit?: string } {
  const env = options.env ?? process.env;
  const shouldScope =
    processRunsInControlPlane(options.cgroup) &&
    (options.scopesAvailable ?? systemdUserScopesAvailable());
  if (!shouldScope) return { command, env: env as Record<string, string> };
  return {
    command: [
      "systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      `--unit=${unit}`,
      ...engineScopeSystemdArgs(env),
      "--property=TimeoutStopSec=2",
      "--",
      ...command,
    ],
    env: { ...(env as Record<string, string>), ...systemdUserEnv(env) },
    unit,
  };
}

/** Stable, path-private unit name used to stop a preview after a server restart. */
export function previewScopeUnit(worktreeDir: string): string {
  const hash = createHash("sha256")
    .update(worktreeDir)
    .digest("hex")
    .slice(0, 16);
  return `opensession-preview-${hash}`;
}

export function stopUserScope(unit: string): void {
  try {
    Bun.spawn({
      cmd: ["systemctl", "--user", "stop", "--no-block", `${unit}.scope`],
      env: systemdUserEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {}
}
