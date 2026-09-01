/**
 * Privileged, admin-only migration helpers for persistent Runners.
 *
 * SSH and Kubernetes are deliberately bootstrap transports, never session
 * transports. Configuration is operator-owned under
 * integrations.runnersBootstrap, so workspace records never contain a private
 * key, kubeconfig, raw host address supplied by a browser, or a generic remote
 * command. After the fixed `runner connect` action succeeds, normal work uses
 * the Runner's outbound authenticated control channel exclusively.
 */

import { existsSync } from "fs";
import { configuredIntegration, configuredServer } from "./config";
import { bindRunnerPairingMigration } from "./runners";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const HOST = /^[A-Za-z0-9._:-]{1,253}$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const WORKLOAD = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export type SshBootstrapTarget = {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  fingerprint: string;
  knownHostsPath: string;
  runnerCommand: string;
};

export type KubernetesBootstrapTarget = {
  id: string;
  label: string;
  context: string;
  namespace: string;
  workload: string;
  /** Reviewed manifest for the dedicated Deployment and persistent volume. */
  manifestPath: string;
  container?: string;
  runnerCommand: string;
};

export type RunnerBootstrapConfig = {
  ssh: SshBootstrapTarget[];
  kubernetes: KubernetesBootstrapTarget[];
};

function string(value: unknown, max = 300): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= max
    ? value.trim()
    : null;
}

function absolutePath(value: unknown): string | null {
  const path = string(value, 1_000);
  return path && path.startsWith("/") ? path : null;
}

function executable(value: unknown): string | null {
  const path = absolutePath(value);
  return path && !/[\n\r\0]/.test(path) ? path : null;
}

/** Tolerantly parse only the small, named operator inventory. */
export function parseRunnerBootstrapConfig(
  value: unknown,
): RunnerBootstrapConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const ssh = (Array.isArray(raw.ssh) ? raw.ssh : []).flatMap(
    (entry): SshBootstrapTarget[] => {
      const item =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {};
      const id = string(item.id, 64);
      const label = string(item.label, 160);
      const host = string(item.host, 253);
      const user = string(item.user, 64);
      const fingerprint = string(item.fingerprint, 200);
      const knownHostsPath = absolutePath(item.knownHostsPath);
      const runnerCommand =
        executable(item.runnerCommand) ?? "/usr/local/bin/opensession";
      const port =
        typeof item.port === "number" &&
        Number.isInteger(item.port) &&
        item.port > 0 &&
        item.port <= 65_535
          ? item.port
          : 22;
      if (
        !id ||
        !label ||
        !host ||
        !user ||
        !fingerprint ||
        !knownHostsPath ||
        !ID.test(id) ||
        !HOST.test(host) ||
        !USER.test(user) ||
        !fingerprint.startsWith("SHA256:")
      )
        return [];
      return [
        {
          id,
          label,
          host,
          user,
          port,
          fingerprint,
          knownHostsPath,
          runnerCommand,
        },
      ];
    },
  );
  const kubernetes = (
    Array.isArray(raw.kubernetes) ? raw.kubernetes : []
  ).flatMap((entry): KubernetesBootstrapTarget[] => {
    const item =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const id = string(item.id, 64);
    const label = string(item.label, 160);
    const context = string(item.context, 180);
    const namespace = string(item.namespace, 63);
    const workload = string(item.workload, 63);
    const manifestPath = absolutePath(item.manifestPath);
    const container = string(item.container, 63) ?? undefined;
    const runnerCommand =
      executable(item.runnerCommand) ?? "/usr/local/bin/opensession";
    if (
      !id ||
      !label ||
      !context ||
      !namespace ||
      !workload ||
      !manifestPath ||
      !ID.test(id) ||
      !WORKLOAD.test(namespace) ||
      !WORKLOAD.test(workload) ||
      (container && !WORKLOAD.test(container))
    )
      return [];
    return [
      {
        id,
        label,
        context,
        namespace,
        workload,
        manifestPath,
        container,
        runnerCommand,
      },
    ];
  });
  return { ssh, kubernetes };
}

export function configuredRunnerBootstrapTargets(): RunnerBootstrapConfig {
  return parseRunnerBootstrapConfig(configuredIntegration("runnersBootstrap"));
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function output(
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    proc.stdin?.write(input);
    proc.stdin?.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    code,
    stdout: stdout.slice(0, 8_000),
    stderr: stderr.slice(0, 8_000),
  };
}

async function verifySshFingerprint(target: SshBootstrapTarget): Promise<void> {
  if (!existsSync(target.knownHostsPath))
    throw new Error("The configured SSH known-hosts file is unavailable.");
  const keys = await output([
    "ssh-keyscan",
    "-T",
    "10",
    "-p",
    String(target.port),
    target.host,
  ]);
  if (keys.code !== 0 || !keys.stdout.trim())
    throw new Error("SSH connection or host-key lookup failed.");
  const fingerprints = await output(["ssh-keygen", "-lf", "-"], keys.stdout);
  if (
    fingerprints.code !== 0 ||
    !fingerprints.stdout.includes(target.fingerprint)
  ) {
    throw new Error(
      "The SSH host fingerprint does not match the configured pin.",
    );
  }
}

function connectCommand(
  command: string,
  server: string,
  code: string,
  name: string,
): string {
  return `exec ${[command, "runner", "connect", "--server", server, "--code", code, "--name", name].map(quote).join(" ")}`;
}

export async function bootstrapSshRunner(
  targetId: string,
  code: string,
): Promise<{ target: SshBootstrapTarget; phase: "pairing" }> {
  const target = configuredRunnerBootstrapTargets().ssh.find(
    (candidate) => candidate.id === targetId,
  );
  if (!target) throw new Error("That SSH Runner target is not configured.");
  if (
    !bindRunnerPairingMigration(code, {
      kind: "ssh",
      label: target.label,
      host: target.host,
      user: target.user,
      port: target.port,
    })
  )
    throw new Error("The Runner pairing code is invalid or expired.");
  await verifySshFingerprint(target);
  const remote = connectCommand(
    target.runnerCommand,
    configuredServer().publicBaseUrl,
    code,
    target.label,
  );
  const result = await output([
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${target.knownHostsPath}`,
    "-p",
    String(target.port),
    `${target.user}@${target.host}`,
    remote,
  ]);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || "The SSH Runner bootstrap command failed.",
    );
  return { target, phase: "pairing" };
}

export async function bootstrapKubernetesRunner(
  targetId: string,
  code: string,
): Promise<{ target: KubernetesBootstrapTarget; phase: "pairing" }> {
  const target = configuredRunnerBootstrapTargets().kubernetes.find(
    (candidate) => candidate.id === targetId,
  );
  if (!target)
    throw new Error("That Kubernetes Runner target is not configured.");
  if (
    !bindRunnerPairingMigration(code, {
      kind: "kubernetes",
      label: target.label,
      context: target.context,
      namespace: target.namespace,
      workload: target.workload,
    })
  )
    throw new Error("The Runner pairing code is invalid or expired.");
  if (!existsSync(target.manifestPath))
    throw new Error("The configured Runner workload manifest is unavailable.");
  const common = [
    "kubectl",
    "--context",
    target.context,
    "--namespace",
    target.namespace,
  ];
  const applied = await output([
    ...common,
    "apply",
    "--server-side",
    "--field-manager=opensession-runner-bootstrap",
    "-f",
    target.manifestPath,
  ]);
  if (applied.code !== 0)
    throw new Error(
      applied.stderr.trim() ||
        "The configured Runner workload could not be deployed.",
    );
  const ready = await output([
    ...common,
    "rollout",
    "status",
    `deployment/${target.workload}`,
    "--timeout=60s",
  ]);
  if (ready.code !== 0) {
    const diagnostics = await output([...common, "get", "pods", "-o", "wide"]);
    const detail = diagnostics.stdout.trim().slice(0, 4_000);
    throw new Error(
      `${ready.stderr.trim() || "The configured Runner workload is not ready."}${detail ? ` Scheduling diagnostics:\n${detail}` : ""}`,
    );
  }
  const command = connectCommand(
    target.runnerCommand,
    configuredServer().publicBaseUrl,
    code,
    target.label,
  );
  const exec = await output([
    ...common,
    "exec",
    `deployment/${target.workload}`,
    ...(target.container ? ["--container", target.container] : []),
    "--",
    "sh",
    "-lc",
    command,
  ]);
  if (exec.code !== 0)
    throw new Error(
      exec.stderr.trim() || "The Kubernetes Runner bootstrap command failed.",
    );
  return { target, phase: "pairing" };
}
