/** Fixed local run-host launcher shared by the executor service and the
 * gateway's rollout fallback. It accepts no caller-provided command or path. */

import { existsSync } from "fs";
import { readFile } from "node:fs/promises";
import { userInfo } from "os";
import { homeDir, statePath } from "../server/paths";
import {
  BUN_BIN,
  HOST_ENTRY,
  HOST_JOURNAL_NAME,
  REPO_ROOT,
  runnerHostArgv,
} from "../runner-host/protocol";

export const RUN_HOST_HELPER = "/usr/local/libexec/opensession-run-host";
export const RUN_HOST_HELPER_VERSION = 2;

/** Fixed compatibility probe; old helpers reject the new action. No operator
 * boolean and no fallback to the ordinary entrypoint for personal work. */
export async function verifyPersonalRunHostHelper(): Promise<void> {
  const proc = Bun.spawn(["sudo", "-n", RUN_HOST_HELPER, "check-personal"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  try {
    if ((await proc.exited) !== 0)
      throw new Error(
        "Personal run-host runtime requires an updated full deployment",
      );
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyRunHostHelper(): Promise<void> {
  if (!existsSync(RUN_HOST_HELPER))
    throw new Error("run-host helper is not installed");
  const proc = Bun.spawn(
    [
      "sudo",
      "-n",
      RUN_HOST_HELPER,
      "check-version",
      String(RUN_HOST_HELPER_VERSION),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [error, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `run-host helper version check failed: ${error.trim().slice(0, 400)}`,
    );
}
const ENV_FILE = statePath(".opensession.env");

export function runHostUnitName(hostId: string): string {
  return `bks-run-${hostId}`;
}

export async function launchHostUnitDirect(
  hostId: string,
  dir: string,
  specHash?: string,
): Promise<void> {
  if (!specHash) throw new Error("run-host launch requires a spec hash");
  const spec = JSON.parse(await readFile(`${dir}/spec.json`, "utf8"));
  const personal = Object.hasOwn(spec, "personalRepo");
  if (personal) {
    await verifyPersonalRunHostHelper();
    const proc = Bun.spawn(hostUnitArgs(hostId, dir, specHash, true), {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await proc.exited) !== 0)
      throw new Error("Personal run-host launch failed");
    return;
  }
  const user = userInfo();
  if (!existsSync(RUN_HOST_HELPER) && user.uid === 0) {
    throw new Error("legacy run-host launch refuses to run an agent as root");
  }
  const args = existsSync(RUN_HOST_HELPER)
    ? hostUnitArgs(hostId, dir, specHash)
    : legacyHostUnitArgs(hostId, dir, user.uid, user.gid, specHash);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [error, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `systemd-run exited ${code}: ${error.trim().slice(0, 400)}`,
    );
  }
}

/** One-release migration path for boxes that already grant the old fixed
 * systemd-run launcher. Fresh and reinstalled boxes always use the helper. */
export function legacyHostUnitArgs(
  hostId: string,
  dir: string,
  uid: number,
  gid: number,
  specHash: string,
): string[] {
  const env = (kv: string) => ["-p", `Environment=${kv}`];
  return [
    "sudo",
    "-n",
    "systemd-run",
    "--collect",
    "--quiet",
    `--unit=${runHostUnitName(hostId)}`,
    `--description=Open Session run host ${hostId}`,
    `--uid=${uid}`,
    `--gid=${gid}`,
    "-p",
    `WorkingDirectory=${REPO_ROOT}`,
    "-p",
    `EnvironmentFile=${ENV_FILE}`,
    ...env(`HOME=${homeDir()}`),
    ...env(`PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`),
    ...env("NODE_ENV=production"),
    ...env(`OPENSESSION_RUN_JOURNAL=${dir}/${HOST_JOURNAL_NAME}`),
    ...env(`OPENSESSION_RUN_SPEC_HASH=${specHash}`),
    "-p",
    "IPAddressDeny=169.254.169.254/32",
    "-p",
    "StandardOutput=journal",
    "-p",
    "StandardError=journal",
    ...runnerHostArgv(BUN_BIN, HOST_ENTRY, `${dir}/spec.json`),
  ];
}

export function hostUnitArgs(
  hostId: string,
  dir: string,
  specHash: string,
  personal = false,
): string[] {
  return [
    "sudo",
    "-n",
    RUN_HOST_HELPER,
    personal ? "launch-personal" : "launch",
    hostId,
    dir,
    specHash,
  ];
}

export async function stopHostUnitDirect(hostId: string): Promise<void> {
  const proc = Bun.spawn(
    existsSync(RUN_HOST_HELPER)
      ? ["sudo", "-n", RUN_HOST_HELPER, "stop", hostId]
      : ["sudo", "-n", "systemctl", "stop", runHostUnitName(hostId)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [error, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `systemctl stop exited ${code}: ${error.trim().slice(0, 400)}`,
    );
  }
}

export async function hostUnitActive(hostId: string): Promise<boolean> {
  const proc = Bun.spawn(["systemctl", "is-active", runHostUnitName(hostId)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  const state = output.trim();
  if (["inactive", "failed", "unknown"].includes(state)) return false;
  if (state) return true;
  throw new Error(`systemctl is-active exited ${code} without a unit state`);
}
