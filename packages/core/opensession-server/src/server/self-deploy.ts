/**
 * opensession-self-deploy — agent-callable self-deploy of THIS Open Session
 * instance. One action tool (deploy_self) plus a read tool (deploy_status).
 *
 * Frontend-only targets are prepared, bundled, validated and atomically
 * promoted in process without a service restart. Every other ordinary target
 * is only pre-validated and LAUNCHED here: pointer swap → health-gated rollback
 * lives in deploy/self-deploy.sh, spawned as a transient SYSTEM unit via the
 * root-owned validating runtime helper so it survives the restart it triggers.
 * Results land as JSON in the deploy state dir, which deploy_status reads back.
 *
 * Trust model: interactive-only + isAdmin, wired EXCLUSIVELY through
 * interactiveMcpServers (src/server/interactive-mcp.ts) like its siblings.
 * Automation runs never receive it — runSessionPrompt hands automations only
 * the papercuts server, and the run-rpc fallback builder fails closed for
 * automation-owned sessions — because a restart (and a git deploy) is a
 * control surface that untrusted event/ticket text must never reach.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { platform, userInfo } from "os";
import { resolve as resolvePath } from "path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { RUN_HOST_HELPER } from "../executor/host-unit";
import { homeDir, stateDir } from "./paths";
import { isDevInstance } from "./dev-mode";
import { acquireMacDeployLock } from "./macos-deploy-lock";
import {
  activateFrontendRelease,
  type FrontendReleasePointer,
} from "./frontend-build";
import { writeFileAtomic } from "./shared/atomic-write";
import { broadcastToAll } from "./ws-hub";

const g = globalThis as any;

const REPO_ROOT = resolvePath(import.meta.dir, "../../../../..");

/** The shared WIP checkout used only as a git object source. Self-deploy never
 *  checks out, merges, resets, or installs dependencies in this tree. */
export function deployCheckout(): string {
  return process.env.OPENSESSION_DEPLOY_CHECKOUT || REPO_ROOT;
}

/** Where the script keeps its pin/marker/result/log files. Must match the
 *  script's OPENSESSION_DEPLOY_STATE default. */
export function deployStateDir(): string {
  return process.env.OPENSESSION_DEPLOY_STATE || stateDir("deploy");
}

/** Shape written by deploy/self-deploy.sh's write_result — keep in sync. */
export interface SelfDeployResult {
  ok: boolean;
  action: "deploy" | "rollback" | "rollback-needed" | string;
  sha?: string;
  previousSha?: string;
  target?: string;
  startedAt?: string;
  finishedAt?: string;
  durationSecs?: number;
  message?: string;
}

/** Parse a result JSON written by the script; null on garbage (a half-written
 *  or foreign file must degrade to "no result", not throw). */
export function parseDeployResult(raw: string): SelfDeployResult | null {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    if (typeof v.ok !== "boolean" || typeof v.action !== "string") return null;
    return v as SelfDeployResult;
  } catch {
    return null;
  }
}

/** Age of the last-deploy-marker (epoch seconds as text) in ms; null when the
 *  content isn't a plain epoch (missing/corrupt marker = no deploy window). */
export function markerAgeMs(
  markerContent: string,
  nowMs: number = Date.now(),
): number | null {
  const trimmed = markerContent.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return nowMs - Number(trimmed) * 1000;
}

export const WATCHDOG_WINDOW_MS = 15 * 60_000;

export interface DeployState {
  pin: string | null;
  markerAgeMs: number | null;
  result: SelfDeployResult | null;
  frontend?: FrontendReleasePointer | null;
  frontendResult?: SelfDeployResult | null;
}

/** Read the script's state files (best-effort — every file is optional). */
export function readDeployState(
  stateDir: string = deployStateDir(),
  nowMs: number = Date.now(),
): DeployState {
  const readText = (p: string): string | null => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  };
  const marker = readText(`${stateDir}/last-deploy-marker`);
  const resultRaw = readText(`${stateDir}/last-result.json`);
  const frontendRaw = readText(`${stateDir}/frontend-current.json`);
  const frontendResultRaw = readText(`${stateDir}/last-frontend-result.json`);
  let frontend: FrontendReleasePointer | null = null;
  try {
    const parsed = frontendRaw ? JSON.parse(frontendRaw) : null;
    if (
      parsed &&
      typeof parsed.sha === "string" &&
      typeof parsed.baseSha === "string" &&
      typeof parsed.releaseRoot === "string"
    ) {
      frontend = parsed as FrontendReleasePointer;
    }
  } catch {}
  const backendSha = readText(
    `${stateDir}/current/.opensession-release`,
  )?.trim();
  if (frontend && frontend.baseSha !== backendSha) frontend = null;
  return {
    pin: readText(`${stateDir}/last-known-good`)?.trim() || null,
    markerAgeMs: marker === null ? null : markerAgeMs(marker, nowMs),
    result: resultRaw === null ? null : parseDeployResult(resultRaw),
    frontend,
    frontendResult:
      frontendResultRaw === null ? null : parseDeployResult(frontendResultRaw),
  };
}

/** Human-readable deploy_status body. */
export function formatDeployStatus(
  state: DeployState,
  stateDir: string = deployStateDir(),
): string {
  const lines: string[] = [];
  const r = state.result;
  if (!r) {
    lines.push(`No self-deploy result recorded yet (state dir: ${stateDir}).`);
  } else {
    lines.push(
      `Last self-deploy: ${r.ok ? "OK" : "FAILED"} (${r.action})` +
        (r.sha ? ` — now at ${r.sha.slice(0, 10)}` : ""),
    );
    if (r.message) lines.push(`  ${r.message}`);
    if (r.finishedAt)
      lines.push(
        `  finished ${r.finishedAt} (took ${r.durationSecs ?? "?"}s, target ${r.target ?? "?"})`,
      );
    if (!r.ok && r.action === "rollback-needed" && r.previousSha)
      lines.push(
        `  ACTION NEEDED: restore release ${r.previousSha.slice(0, 10)} manually.`,
      );
  }
  lines.push(
    state.pin
      ? `Last-known-good pin: ${state.pin.slice(0, 10)}`
      : "Last-known-good pin: none recorded",
  );
  if (state.frontend) {
    lines.push(
      `Frontend pin: ${state.frontend.sha.slice(0, 10)} (restart-free promotion over backend ${state.frontend.baseSha.slice(0, 10)})`,
    );
  } else {
    lines.push("Frontend pin: follows the backend release");
  }
  if (state.frontendResult) {
    lines.push(
      `Last frontend promotion: ${state.frontendResult.ok ? "OK" : "FAILED"}` +
        (state.frontendResult.sha
          ? ` (${state.frontendResult.sha.slice(0, 10)})`
          : "") +
        (state.frontendResult.message
          ? ` — ${state.frontendResult.message}`
          : ""),
    );
  }
  if (
    state.markerAgeMs !== null &&
    state.markerAgeMs >= 0 &&
    state.markerAgeMs <= WATCHDOG_WINDOW_MS
  ) {
    const mins = Math.round(state.markerAgeMs / 60000);
    lines.push(
      `Watchdog window: OPEN (last deploy restart ~${mins} min ago; auto-rollback armed for 15 min)`,
    );
  } else if (
    state.markerAgeMs !== null &&
    state.markerAgeMs > WATCHDOG_WINDOW_MS
  ) {
    const mins = Math.round(state.markerAgeMs / 60000);
    lines.push(
      `Watchdog window: closed (last deploy restart ~${mins} min ago; 15 min rollback window expired)`,
    );
  } else {
    lines.push("Watchdog window: closed (no recent self-deploy restart)");
  }
  lines.push(`Log: ${stateDir}/self-deploy.log`);
  return lines.join("\n");
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

const FRONTEND_PREFIX = "packages/core/opensession-server/src/frontend/";
const ROOT_DEPLOY_PATHS = new Set([
  "deploy/deploy.sh",
  "deploy/self-deploy.sh",
  "deploy/release-checkout.sh",
  "deploy/install-executor-credential.sh",
  "deploy/install-session-kernel-credential.sh",
  "deploy/install-run-host-helper.sh",
  "deploy/install-resource-control.sh",
  "deploy/opensession-run-host",
  "opensession.service",
  "opensession.socket",
  "opensession-ingress.service",
  "opensession-executor.service",
  "opensession-session-kernel.service",
  "packages/core/opensession-server/src/server/gateway-ingress.ts",
  "packages/core/opensession-server/src/server/gateway-routing.ts",
  "packages/core/opensession-server/src/server/gateway-tcp-proxy.ts",
  "packages/core/opensession-server/src/server/stable-frontend.ts",
]);

/** Files the unprivileged self-deploy path cannot install. Letting one of these
 * fall through to an ordinary source restart reports a healthy deployment while
 * the root-owned live artifact remains on the previous release. */
export function requiresRootDeploy(
  paths: string[],
  hostPlatform: NodeJS.Platform = process.platform,
): boolean {
  if (hostPlatform === "darwin") return false;
  return paths.some(
    (path) => ROOT_DEPLOY_PATHS.has(path) || path.startsWith("deploy/systemd/"),
  );
}

/** Strict allowlist: if any runtime path outside the web frontend changes, use
 * the health-gated service rollout. Documentation may ride with a UI commit. */
export function isFrontendOnlyRelease(paths: string[]): boolean {
  let hasFrontend = false;
  for (const path of paths) {
    if (path.startsWith(FRONTEND_PREFIX)) {
      hasFrontend = true;
      continue;
    }
    if (path === "AGENTS.md" || path.startsWith("docs/")) continue;
    return false;
  }
  return hasFrontend;
}

async function run(
  command: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${command[0]} exited ${code}: ${(err || out).trim().slice(0, 800)}`,
    );
  }
  return out.trim();
}

async function acquireDeployLock(state: string): Promise<() => Promise<void>> {
  mkdirSync(state, { recursive: true });
  if (platform() === "darwin") {
    const release = await acquireMacDeployLock(state);
    return async () => release();
  }
  const proc = Bun.spawn(
    [
      "flock",
      "-n",
      `${state}/.lock`,
      "/bin/sh",
      "-c",
      "printf 'LOCKED\\n'; cat >/dev/null",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (first.done || !new TextDecoder().decode(first.value).includes("LOCKED")) {
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    throw new Error(
      `another deploy or rollback is already in flight${err.trim() ? `: ${err.trim()}` : ""}`,
    );
  }
  return async () => {
    proc.stdin.end();
    await proc.exited;
  };
}

async function promoteFrontendRelease(
  targetSha: string,
  baseSha: string,
  user?: string,
): Promise<{ releaseRoot: string; version: string }> {
  if (g.__opensessionFrontendPromotion) {
    throw new Error("another frontend promotion is already running");
  }
  g.__opensessionFrontendPromotion = true;
  const state = deployStateDir();
  const startedAt = new Date().toISOString();
  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireDeployLock(state);
    const releaseScript = `${REPO_ROOT}/deploy/release-checkout.sh`;
    const env = {
      OPENSESSION_DEPLOY_CHECKOUT: deployCheckout(),
      OPENSESSION_DEPLOY_STATE: state,
      OPENSESSION_BUN_BIN: process.execPath,
    };
    const releaseRoot = await run(
      ["bash", releaseScript, "prepare", targetSha],
      { env },
    );
    await run([process.execPath, "run", "scripts/build-frontend.ts"], {
      cwd: releaseRoot,
      env,
    });
    const pointer: FrontendReleasePointer = {
      sha: targetSha,
      baseSha,
      releaseRoot,
      promotedAt: new Date().toISOString(),
    };
    const version = activateFrontendRelease(pointer);
    const result: SelfDeployResult = {
      ok: true,
      action: "frontend-promote",
      sha: targetSha,
      previousSha: baseSha,
      target: targetSha,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationSecs: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
      message: `frontend promoted without restarting services${user ? ` by ${user}` : ""}`,
    };
    writeFileAtomic(
      `${state}/last-frontend-result.json`,
      `${JSON.stringify(result, null, 2)}\n`,
      0o600,
    );
    broadcastToAll({
      type: "frontend_updated",
      version,
      ...(user ? { by: user } : {}),
    });
    return { releaseRoot, version };
  } catch (error) {
    const result: SelfDeployResult = {
      ok: false,
      action: "frontend-promote",
      sha: targetSha,
      previousSha: baseSha,
      target: targetSha,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationSecs: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
      message: error instanceof Error ? error.message : String(error),
    };
    writeFileAtomic(
      `${state}/last-frontend-result.json`,
      `${JSON.stringify(result, null, 2)}\n`,
      0o600,
    );
    throw error;
  } finally {
    await releaseLock?.();
    g.__opensessionFrontendPromotion = false;
  }
}

export function selfDeployHealthUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.OPENSESSION_HEALTH_URL) return env.OPENSESSION_HEALTH_URL;
  let host = env.HOST || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${env.PORT || "3850"}/ready`;
}

export interface MacDeployLaunchOptions {
  unit: string;
  targetSha: string;
  checkout: string;
  stateDir: string;
  bun: string;
  home: string;
  healthUrl: string;
  controller?: string;
}

/** A transient launchd job survives replacement of the two Open Session
 * LaunchAgents while remaining entirely inside the logged-in user's domain. */
export function macDeployLaunchArgs(options: MacDeployLaunchOptions): string[] {
  const controller =
    options.controller || `${REPO_ROOT}/scripts/self-deploy-macos.ts`;
  const log = `${options.stateDir}/self-deploy.log`;
  return [
    "launchctl",
    "submit",
    "-l",
    options.unit,
    "-o",
    log,
    "-e",
    log,
    "--",
    options.bun,
    controller,
    "--unit",
    options.unit,
    "--sha",
    options.targetSha,
    "--checkout",
    options.checkout,
    "--state",
    options.stateDir,
    "--bun",
    options.bun,
    "--home",
    options.home,
    "--health-url",
    options.healthUrl,
  ];
}

/** Launch the platform controller outside the gateway service so it survives
 * the restart it triggers. Linux uses a system unit; macOS uses a transient
 * user launchd job and never asks for sudo. */
async function launchDeployUnit(
  unit: string,
  targetSha: string,
): Promise<void> {
  const checkout = deployCheckout();
  const stateDir = deployStateDir();
  mkdirSync(stateDir, { recursive: true });
  let args: string[];
  if (platform() === "darwin") {
    const controller = `${REPO_ROOT}/scripts/self-deploy-macos.ts`;
    if (!existsSync(controller))
      throw new Error(`macOS deploy controller not found at ${controller}`);
    args = macDeployLaunchArgs({
      unit,
      targetSha,
      checkout,
      stateDir,
      bun: process.execPath,
      home: homeDir(),
      healthUrl: selfDeployHealthUrl(),
      controller,
    });
  } else {
    const controller = `${REPO_ROOT}/deploy/self-deploy.sh`;
    if (!existsSync(RUN_HOST_HELPER) && userInfo().uid === 0) {
      throw new Error(
        "legacy self-deploy refuses to launch from a root service",
      );
    }
    args = existsSync(RUN_HOST_HELPER)
      ? ["sudo", "-n", RUN_HOST_HELPER, "self-deploy", unit, targetSha]
      : [
          // Migration path for instances upgrading through the old in-product
          // deploy flow. Those boxes already grant this exact capability; a
          // subsequent `opensession service install` replaces it with the helper.
          "sudo",
          "-n",
          "systemd-run",
          "--collect",
          "--quiet",
          `--unit=${unit}`,
          `--description=Open Session self-deploy to ${targetSha.slice(0, 10)}`,
          `--uid=${userInfo().username}`,
          `--gid=${userInfo().username}`,
          "-p",
          `WorkingDirectory=${checkout}`,
          "-p",
          `Environment=HOME=${homeDir()}`,
          "-p",
          `Environment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
          "-p",
          `Environment=OPENSESSION_BUN_BIN=${process.execPath}`,
          "-p",
          `Environment=OPENSESSION_DEPLOY_CHECKOUT=${checkout}`,
          "-p",
          `Environment=OPENSESSION_DEPLOY_STATE=${stateDir}`,
          ...(process.env.OPENSESSION_STATE_DIR
            ? [
                "-p",
                `Environment=OPENSESSION_STATE_DIR=${process.env.OPENSESSION_STATE_DIR}`,
              ]
            : []),
          ...(process.env.OPENSESSION_SESSIONS_DIR
            ? [
                "-p",
                `Environment=OPENSESSION_SESSIONS_DIR=${process.env.OPENSESSION_SESSIONS_DIR}`,
              ]
            : []),
          ...(process.env.OPENSESSION_HEALTH_URL
            ? [
                "-p",
                `Environment=OPENSESSION_HEALTH_URL=${process.env.OPENSESSION_HEALTH_URL}`,
              ]
            : []),
          "-p",
          "StandardOutput=journal",
          "-p",
          "StandardError=journal",
          "/bin/bash",
          controller,
          "--sha",
          targetSha,
        ];
  }
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `self-deploy launcher exited ${code}: ${err.trim().slice(0, 400)}`,
    );
  }
}

function nextDeployUnitName(now: number = Date.now()): string {
  const previous = Number(g.__opensessionLastDeployUnitId || 0);
  const id = Math.max(now, previous + 1);
  g.__opensessionLastDeployUnitId = id;
  return `opensession-self-deploy-${id}`;
}

export interface SelfDeployToolContext {
  /** Who asked — recorded in the launch acknowledgement only. */
  user?: string;
}

export function createSelfDeployMcpServer(ctx: SelfDeployToolContext) {
  const tools = [
    tool(
      "deploy_self",
      "Deploy THIS Open Session instance to an immutable git release. Deployment may be autonomous and is shared across sessions. Concurrent standard deploy requests queue and coalesce to the newest fast-forward target; requests already covered by that release become successful no-ops. A strictly frontend-only diff is bundled in the prepared target release, atomically promoted, and announced to clients without restarting any service. A strictly gateway-only source diff uses the single-active preload handoff; protocol peers, dependencies, and other runtime changes use the coordinated health-gated gateway/kernel/executor restart path. /api/rebuild-frontend only rebuilds the already pinned source and is not a promotion path. This tool DOES NOT install changed root-owned artifacts. If the target changes the live deploy controllers, opensession*.service, credential installers, the fixed run-host helper/installer, or root-deploy-managed systemd units/drop-ins, use the documented full root deploy instead. Diverged targets are refused; the shared WIP checkout is only a git object source and is never changed.",
      {
        sha: z
          .string()
          .optional()
          .describe(
            "Target commit-ish to deploy (sha, branch, origin/main…). Default: origin/main after a fetch. Must be a fast-forward of the current HEAD.",
          ),
        confirm: z
          .boolean()
          .describe(
            "Must be exactly true. This deliberately acknowledges a shared live rollout; frontend-only promotion is restart-free, while other ordinary changes restart the services. No separate human approval is required.",
          ),
      },
      async (args: { sha?: string; confirm: boolean }) => {
        if (isDevInstance()) {
          // Belt-and-braces behind the interactive-mcp.ts wiring gate: the
          // script targets the production service + deploy state, so a dev
          // instance must never execute it even if the server got wired in.
          return text(
            "Refusing: this is a dev instance (OPENSESSION_DEV=1); deploy_self targets the production service and is disabled here.",
          );
        }
        if (args.confirm !== true) {
          return text(
            "Refusing: deploy_self changes the shared live Open Session release. Call again with confirm: true once you actually mean to deploy.",
          );
        }
        const checkout = deployCheckout();
        const stateDir = deployStateDir();
        const script = `${REPO_ROOT}/deploy/self-deploy.sh`;
        if (!existsSync(script)) {
          return text(
            `Refusing: pinned deploy controller not found at ${script}.`,
          );
        }
        try {
          const fetch = await git(checkout, ["fetch", "--prune", "origin"]);
          if (fetch.code !== 0) {
            return text(
              `Refusing: git fetch failed in ${checkout}: ${fetch.err.slice(0, 300)}`,
            );
          }
          const targetRef = args.sha?.trim() || "origin/main";
          const rev = await git(checkout, [
            "rev-parse",
            `${targetRef}^{commit}`,
          ]);
          if (rev.code !== 0) {
            return text(
              `Refusing: cannot resolve '${targetRef}': ${rev.err.slice(0, 300)}`,
            );
          }
          const targetSha = rev.out;
          const runtime = `${stateDir}/current`;
          let currentSha: string | null = null;
          if (existsSync(runtime)) {
            const current = await git(runtime, ["rev-parse", "HEAD"]);
            if (current.code === 0) currentSha = current.out;
            if (currentSha === targetSha) {
              return text(
                `Already deployed: backend is at ${targetSha.slice(0, 10)}. No service restart was needed.`,
              );
            }
            if (currentSha && currentSha !== targetSha) {
              const advance = await git(checkout, [
                "merge-base",
                "--is-ancestor",
                currentSha,
                targetSha,
              ]);
              if (advance.code !== 0) {
                const alreadyCovered = await git(checkout, [
                  "merge-base",
                  "--is-ancestor",
                  targetSha,
                  currentSha,
                ]);
                if (alreadyCovered.code === 0) {
                  return text(
                    `Deploy request ${targetSha.slice(0, 10)} was already covered by newer backend ${currentSha.slice(0, 10)}. No service restart was needed.`,
                  );
                }
                return text(
                  `Refusing diverged release ${targetSha.slice(0, 10)}: it neither advances nor is covered by current ${currentSha.slice(0, 10)}. Use the explicit rollback path for rollback, or the root deploy for an operator-selected history line.`,
                );
              }
            }
          }
          if (currentSha && currentSha !== targetSha) {
            const changed = await git(checkout, [
              "diff",
              "--no-renames",
              "--name-only",
              "-z",
              currentSha,
              targetSha,
              "--",
            ]);
            if (changed.code !== 0) {
              return text(
                `Refusing: cannot classify target diff: ${changed.err.slice(0, 300)}`,
              );
            }
            const paths = changed.out.split("\0").filter(Boolean);
            if (requiresRootDeploy(paths)) {
              return text(
                `Refusing unprivileged self-deploy for ${targetSha.slice(0, 10)}: the target changes root-owned deploy or service artifacts. Run the documented full root deploy for this release.`,
              );
            }
            if (isFrontendOnlyRelease(paths)) {
              const promoted = await promoteFrontendRelease(
                targetSha,
                currentSha,
                ctx.user,
              );
              return text(
                `Frontend promoted${ctx.user ? ` by ${ctx.user}` : ""}: ${targetSha.slice(0, 10)} (bundle ${promoted.version}).\n` +
                  `No service restarted; clients were notified. Backend remains pinned to ${currentSha.slice(0, 10)} until the next standard deploy.`,
              );
            }
          }
          const unit = nextDeployUnitName();
          await launchDeployUnit(unit, targetSha);
          const lifecycle =
            platform() === "darwin"
              ? "The detached launchd job will reload the macOS LaunchAgents, health-gate the release, and switch back automatically if the prior release remains schema-compatible."
              : "This instance will promote through either the single-active gateway handoff or the coordinated restart selected by the release classifier. An unhealthy release switches back automatically, and the watchdog covers wedges for 15 min.";
          return text(
            `Deploy launched${ctx.user ? ` by ${ctx.user}` : ""}: unit ${unit} → immutable release ${targetSha.slice(0, 10)}.\n` +
              `Result will land in ${stateDir}/last-result.json (log: ${stateDir}/self-deploy.log).\n` +
              `${lifecycle} Your session survives via the detached engine + reattach. Check deploy_status shortly.`,
          );
        } catch (e: any) {
          return text(
            `deploy_self failed to launch: ${e?.message || String(e)}`,
          );
        }
      },
    ),
    tool(
      "deploy_status",
      "Read the backend and frontend release pins, the most recent standard deploy/frontend-promotion results, and whether the 15-minute watchdog auto-rollback window is still active. The window does not delay or block later deploys. Read-only.",
      {},
      async () => {
        try {
          const stateDir = deployStateDir();
          return text(formatDeployStatus(readDeployState(stateDir), stateDir));
        } catch (e: any) {
          return text(`deploy_status failed: ${e?.message || String(e)}`);
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-self-deploy",
    version: "1.0.0",
    tools,
  });
}
