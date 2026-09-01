#!/usr/bin/env bun
/**
 * Detached macOS self-deploy controller.
 *
 * launchctl runs this as a transient user job so replacing the Open Session
 * LaunchAgents cannot kill the rollout that owns their health gate. Linux uses
 * deploy/self-deploy.sh and its systemd-specific protocol instead.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { acquireMacDeployLock } from "../packages/core/opensession-server/src/server/macos-deploy-lock";

interface Options {
  unit: string;
  target: string;
  checkout: string;
  state: string;
  bun: string;
  home: string;
  healthUrl: string;
}

interface DeployResult {
  ok: boolean;
  action: string;
  sha: string;
  previousSha: string;
  target: string;
  startedAt: string;
  finishedAt: string;
  durationSecs: number;
  message: string;
}

const SHA_RE = /^[0-9a-f]{40,64}$/;
const KERNEL_SCHEMA_REL =
  "packages/core/opensession-server/src/server/session-kernel/schema-version";
const COALESCE_MS = 15_000;
const COALESCE_MAX_MS = 60_000;

export function parseMacSelfDeployArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith("--") || value === undefined)
      throw new Error(`invalid argument near ${name || "end of command"}`);
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const unit = required("--unit");
  if (!/^opensession-self-deploy-[0-9]{13}$/.test(unit))
    throw new Error("--unit is not a self-deploy launchd label");
  const target = required("--sha");
  if (!SHA_RE.test(target)) throw new Error("--sha must be an exact commit");
  const absolute = (name: string): string => {
    const value = required(name);
    if (!value.startsWith("/")) throw new Error(`${name} must be absolute`);
    return resolve(value);
  };
  return {
    unit,
    target,
    checkout: absolute("--checkout"),
    state: absolute("--state"),
    bun: absolute("--bun"),
    home: absolute("--home"),
    healthUrl: required("--health-url"),
  };
}

async function capture(
  command: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${command[0]} exited ${code}: ${(stderr || stdout).trim().slice(0, 1200)}`,
    );
  }
  return stdout.trim();
}

function atomicWrite(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${crypto.randomUUID()}`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

async function git(checkout: string, args: string[]): Promise<string> {
  return await capture(["git", "-C", checkout, ...args]);
}

async function isAncestor(
  checkout: string,
  older: string,
  newer: string,
): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "-C", checkout, "merge-base", "--is-ancestor", older, newer],
    { stdout: "ignore", stderr: "ignore" },
  );
  return (await proc.exited) === 0;
}

function publishRequest(state: string, target: string): void {
  atomicWrite(join(state, "requests", target), `${Date.now()}\n`);
}

async function coalescedTarget(
  options: Options,
  current: string | null,
  requested: string,
): Promise<string> {
  const requests = join(options.state, "requests");
  let quietDeadline = Date.now() + COALESCE_MS;
  const hardDeadline = Date.now() + COALESCE_MAX_MS;
  let signature = "";
  while (Date.now() < quietDeadline && Date.now() < hardDeadline) {
    const next = readdirSync(requests)
      .filter((name) => SHA_RE.test(name))
      .map((name) => `${name}:${statSync(join(requests, name)).mtimeMs}`)
      .sort()
      .join("|");
    if (signature && next !== signature)
      quietDeadline = Math.min(Date.now() + COALESCE_MS, hardDeadline);
    signature = next;
    await Bun.sleep(1000);
  }

  let target = requested;
  for (const candidate of readdirSync(requests).filter((name) =>
    SHA_RE.test(name),
  )) {
    if (current && !(await isAncestor(options.checkout, current, candidate)))
      continue;
    if (await isAncestor(options.checkout, target, candidate))
      target = candidate;
  }
  return target;
}

function schemaVersion(releaseRoot: string): number {
  try {
    const value = readFileSync(
      join(releaseRoot, KERNEL_SCHEMA_REL),
      "utf8",
    ).trim();
    return /^\d+$/.test(value) ? Number(value) : 0;
  } catch {
    return 0;
  }
}

function recordSchemaFloor(state: string, releaseRoot: string): void {
  const path = join(state, "minimum-kernel-schema");
  const next = schemaVersion(releaseRoot);
  let current = 0;
  try {
    current = Number(readFileSync(path, "utf8").trim()) || 0;
  } catch {}
  if (next > current) atomicWrite(path, `${next}\n`);
}

function rollbackIsCompatible(state: string, releaseRoot: string): boolean {
  let required = 0;
  try {
    required = Number(
      readFileSync(join(state, "minimum-kernel-schema"), "utf8").trim(),
    );
  } catch {}
  return schemaVersion(releaseRoot) >= required;
}

async function pollHealth(
  url: string,
  expectedGeneration: string,
): Promise<boolean> {
  let successes = 0;
  let bootId = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    await Bun.sleep(2000);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      const generation = body.match(/"generation":"([^"]+)"/)?.[1] || "";
      if (generation !== expectedGeneration)
        throw new Error(`expected generation ${expectedGeneration}`);
      const nextBootId = body.match(/"bootId":"([^"]+)"/)?.[1] || "";
      if (bootId && nextBootId !== bootId) successes = 0;
      bootId = nextBootId;
      successes += 1;
      if (successes >= 3) return true;
    } catch {
      successes = 0;
      bootId = "";
    }
  }
  return false;
}

async function sessionKernelReady(
  expectedGeneration?: string,
): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:3849/ready", {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return false;
    const body = await response.text();
    return (
      body.includes('"ready":true') &&
      (!expectedGeneration ||
        body.includes(`"generation":"${expectedGeneration}"`))
    );
  } catch {
    return false;
  }
}

async function waitForSessionKernel(generation: string): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await sessionKernelReady(generation)) return true;
    await Bun.sleep(500);
  }
  return false;
}

function writeResult(
  options: Options,
  startedAt: string,
  startedMs: number,
  target: string,
  result: Omit<
    DeployResult,
    "target" | "startedAt" | "finishedAt" | "durationSecs"
  >,
): void {
  const value: DeployResult = {
    ...result,
    target,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationSecs: Math.round((Date.now() - startedMs) / 1000),
  };
  const json = `${JSON.stringify(value)}\n`;
  atomicWrite(join(options.state, "last-result.json"), json);
  const timestamp = startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  atomicWrite(
    join(options.state, "results", `${timestamp}-${value.action}.json`),
    json,
  );
}

function requireStableLaunchAgents(options: Options): void {
  const current = join(options.state, "current");
  for (const path of [
    join(options.home, "Library/LaunchAgents/dev.opensession.server.plist"),
    join(
      options.home,
      "Library/LaunchAgents/dev.opensession.session-kernel.plist",
    ),
    join(options.home, ".opensession/OpenSession"),
    join(options.home, ".opensession/OpenSessionKernel"),
  ]) {
    if (!readFileSync(path, "utf8").includes(current))
      throw new Error(
        `macOS service at ${path} is not pinned through ${current}; run opensession service install once`,
      );
  }
}

async function reloadLaunchAgents(
  options: Options,
  generation: string,
  log: (message: string) => void,
): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  try {
    await capture([
      "launchctl",
      "kickstart",
      "-k",
      `${domain}/dev.opensession.session-kernel`,
    ]);
  } catch (error) {
    log(
      `SessionKernel kickstart reported an error; checking readiness: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!(await waitForSessionKernel(generation)))
    throw new Error(
      `SessionKernel did not become ready on generation ${generation.slice(0, 10)}`,
    );
  try {
    await capture([
      "launchctl",
      "kickstart",
      "-k",
      `${domain}/dev.opensession.server`,
    ]);
  } catch (error) {
    log(
      `gateway kickstart reported an error; checking health: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runMacSelfDeploy(options: Options): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error("the macOS deploy controller only runs on Darwin");
  if (!existsSync(options.checkout) || !existsSync(options.bun))
    throw new Error("deploy checkout or Bun executable is missing");

  mkdirSync(options.state, { recursive: true, mode: 0o700 });
  mkdirSync(join(options.state, "requests"), { recursive: true, mode: 0o700 });
  mkdirSync(join(options.state, "results"), { recursive: true, mode: 0o700 });
  const logPath = join(options.state, "self-deploy.log");
  const log = (message: string) => {
    const line = `[self-deploy:macos] ${new Date().toISOString()} ${message}\n`;
    appendFileSync(logPath, line);
    process.stdout.write(line);
  };
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  publishRequest(options.state, options.target);
  const releaseScript = join(
    dirname(import.meta.dir),
    "deploy",
    "release-checkout.sh",
  );
  const releaseEnv = {
    ...process.env,
    HOME: options.home,
    OPENSESSION_DEPLOY_CHECKOUT: options.checkout,
    OPENSESSION_DEPLOY_STATE: options.state,
    OPENSESSION_BUN_BIN: options.bun,
  } as Record<string, string>;
  const release = async (args: string[]): Promise<string> =>
    await capture(["/bin/bash", releaseScript, ...args], { env: releaseEnv });

  let releaseLock: (() => void) | null = null;
  let current = "";
  let selectedTarget = options.target;
  try {
    releaseLock = await acquireMacDeployLock(options.state);
    await git(options.checkout, ["fetch", "--prune", "origin"]);
    try {
      current = await release(["current-sha"]);
    } catch {}

    if (
      current &&
      (current === options.target ||
        (await isAncestor(options.checkout, options.target, current)))
    ) {
      rmSync(join(options.state, "requests", options.target), { force: true });
      if (
        current === options.target &&
        (await pollHealth(options.healthUrl, current))
      ) {
        writeResult(options, startedAt, startedMs, options.target, {
          ok: true,
          action: "deploy",
          sha: current,
          previousSha: current,
          message: "release was already selected and is healthy",
        });
      }
      log(
        `request ${options.target.slice(0, 10)} already deployed or superseded`,
      );
      return;
    }
    if (
      current &&
      !(await isAncestor(options.checkout, current, options.target))
    ) {
      throw new Error(
        `target ${options.target.slice(0, 10)} does not advance current ${current.slice(0, 10)}`,
      );
    }

    selectedTarget = await coalescedTarget(
      options,
      current || null,
      options.target,
    );
    if (selectedTarget !== options.target)
      log(
        `coalescing ${options.target.slice(0, 10)} into ${selectedTarget.slice(0, 10)}`,
      );
    const target = selectedTarget;
    const targetRoot = await release(["prepare-frontend", target]);
    requireStableLaunchAgents(options);
    if (!(await sessionKernelReady()))
      throw new Error(
        "SessionKernel is not healthy; refusing to restart the LaunchAgents",
      );

    if (current) {
      atomicWrite(join(options.state, "last-known-good"), `${current}\n`);
      log(`pinned last-known-good ${current.slice(0, 10)}`);
    } else {
      log(
        "bootstrapping the first immutable macOS release without a rollback pin",
      );
    }

    await release(["switch", target]);
    recordSchemaFloor(options.state, targetRoot);
    log(`reloading LaunchAgents on ${target.slice(0, 10)}`);
    try {
      await reloadLaunchAgents(options, target, log);
    } catch (error) {
      log(
        `LaunchAgent reload did not complete; checking service health before rollback: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (await pollHealth(options.healthUrl, target)) {
      for (const request of readdirSync(join(options.state, "requests"))) {
        if (
          SHA_RE.test(request) &&
          (await isAncestor(options.checkout, request, target))
        )
          rmSync(join(options.state, "requests", request), { force: true });
      }
      writeResult(options, startedAt, startedMs, selectedTarget, {
        ok: true,
        action: "deploy",
        sha: target,
        previousSha: current,
        message: "deployed and healthy through macOS LaunchAgents",
      });
      log(`healthy after LaunchAgent reload; deployed ${target.slice(0, 10)}`);
      return;
    }

    if (!current) {
      writeResult(options, startedAt, startedMs, selectedTarget, {
        ok: false,
        action: "rollback-needed",
        sha: target,
        previousSha: "",
        message:
          "first macOS immutable release was unhealthy and has no rollback pin",
      });
      throw new Error(
        "target was unhealthy and no previous immutable release exists",
      );
    }

    const previousRoot = await release(["path", current]);
    if (!rollbackIsCompatible(options.state, previousRoot)) {
      writeResult(options, startedAt, startedMs, selectedTarget, {
        ok: false,
        action: "rollback-needed",
        sha: target,
        previousSha: current,
        message:
          "target was unhealthy; rollback is blocked by the durable SessionKernel schema floor",
      });
      throw new Error(
        "target was unhealthy and schema compatibility blocks rollback",
      );
    }

    log(`target unhealthy; rolling back to ${current.slice(0, 10)}`);
    await release(["switch", current]);
    try {
      await reloadLaunchAgents(options, current, log);
    } catch (error) {
      log(
        `rollback LaunchAgent reload did not complete; checking health: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (await pollHealth(options.healthUrl, current)) {
      writeResult(options, startedAt, startedMs, selectedTarget, {
        ok: false,
        action: "deploy",
        sha: current,
        previousSha: current,
        message: `deploy of ${target} was unhealthy; rolled back and healthy again`,
      });
      throw new Error("target was unhealthy; rollback restored service health");
    }

    writeResult(options, startedAt, startedMs, selectedTarget, {
      ok: false,
      action: "rollback-needed",
      sha: target,
      previousSha: current,
      message:
        "target was unhealthy and the macOS LaunchAgent rollback also failed health",
    });
    throw new Error("target and rollback both failed health");
  } catch (error) {
    const existing = join(options.state, "last-result.json");
    let belongsToRun = false;
    try {
      belongsToRun =
        JSON.parse(readFileSync(existing, "utf8")).startedAt === startedAt;
    } catch {}
    if (!belongsToRun) {
      writeResult(options, startedAt, startedMs, selectedTarget, {
        ok: false,
        action: "deploy",
        sha: current || "unknown",
        previousSha: current,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    releaseLock?.();
    // launchctl submit keeps short-lived jobs registered and respawns them.
    // Removing our own label terminates this process after durable result/log
    // writes, preventing an already-covered deploy from restarting forever.
    Bun.spawnSync(["launchctl", "remove", options.unit], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}

if (import.meta.main) {
  const options = parseMacSelfDeployArgs(process.argv.slice(2));
  await runMacSelfDeploy(options);
}
