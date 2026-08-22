/**
 * Simple-mode maintenance: keep a long-running single-user install from
 * silently filling its disk.
 *
 * The service logs are the one piece of state that grows with no bound of its
 * own. launchd and the systemd unit redirect the server's stdout/stderr into
 * `server.log` / `server.err.log` and rotate nothing, so a laptop or small VPS
 * left running for weeks grows those files until the disk is full, and the
 * failures that follow (writes erroring, sessions wedging) read as a baffling
 * outage rather than "your log ate the disk". Everything else that grows is
 * already bounded: the worktree reaper and disk-gc reclaim worktrees and their
 * caches, and audit files prune past a retention window. This fills the log
 * gap and warns before free space runs out.
 *
 * Conservative by construction: it only truncates its own service logs, never
 * user data, and keeps one rotation for a post-mortem. Nothing runs at module
 * scope; the sweep is armed from the boot block via startMaintenance().
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { audit } from "./audit";
import { diskUsagePct } from "./disk-gc";
import { homeDir } from "./paths";

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Cap each service log here; above it, rotate to `.1` and truncate in place. */
const LOG_CAP_BYTES = num(process.env.OPENSESSION_LOG_CAP_MB, 25) * MB;
const SWEEP_INTERVAL_MS = num(process.env.OPENSESSION_MAINTENANCE_INTERVAL_MS, 6 * HOUR);
const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;
/** Warn the operator once free space is this tight — before writes start failing. */
const DISK_WARN_PCT = num(process.env.OPENSESSION_DISK_WARN_PCT, 90);

/** The install's home, honoring the override used by scripts/lib/paths.ts. */
function opensessionHome(): string {
  return process.env.OPENSESSION_HOME || join(homeDir(), ".opensession");
}

function xmlText(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function logParent(path: string): string | null {
  const clean = path.trim();
  return /^(server|server\.err)\.log$/.test(basename(clean))
    ? dirname(clean)
    : null;
}

/**
 * Recover the log directory from a rendered systemd unit or launchd plist.
 * Older custom-home services do not carry OPENSESSION_HOME in their process
 * environment, but their installed definition still names the real log path or
 * stable executable. Reading it lets an upgraded server protect those logs on
 * its first restart, without requiring a separate service reinstall.
 */
export function serviceLogDirFromDefinition(text: string): string | null {
  for (const match of text.matchAll(
    /^Standard(?:Output|Error)=append:(.+)$/gm,
  )) {
    const dir = logParent(match[1] || "");
    if (dir) return dir;
  }

  for (const match of text.matchAll(
    /<key>Standard(?:Out|Error)Path<\/key>\s*<string>([^<]+)<\/string>/g,
  )) {
    const dir = logParent(xmlText(match[1] || ""));
    if (dir) return dir;
  }

  const systemdHome = text.match(
    /^Environment=["']?OPENSESSION_HOME=([^"'\n]+)["']?$/m,
  )?.[1];
  if (systemdHome) return join(systemdHome.trim(), "logs");

  const plistHome = text.match(
    /<key>OPENSESSION_HOME<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];
  if (plistHome) return join(xmlText(plistHome), "logs");

  const binaryHome = text.match(
    /^ExecStart=["']?(.+?)[\/]bin[\/]opensession(?:\s|["'])/m,
  )?.[1];
  return binaryHome ? join(binaryHome, "logs") : null;
}

function installedServiceLogDir(): string | null {
  const home = homeDir();
  const definitions = process.platform === "darwin"
    ? [join(home, "Library", "LaunchAgents", "dev.opensession.server.plist")]
    : [
        join(
          process.env.XDG_CONFIG_HOME || join(home, ".config"),
          "systemd",
          "user",
          "opensession.service",
        ),
        "/etc/systemd/system/opensession.service",
      ];
  for (const path of definitions) {
    try {
      const dir = serviceLogDirFromDefinition(readFileSync(path, "utf8"));
      if (dir) return dir;
    } catch {}
  }
  return null;
}

/** The directory the active service writes, including pre-upgrade definitions. */
export function serviceLogDir(): string {
  if (process.env.OPENSESSION_HOME)
    return join(process.env.OPENSESSION_HOME, "logs");
  return installedServiceLogDir() || join(opensessionHome(), "logs");
}

/** The nearest existing path on the log filesystem for the free-space check.
 * The log directory may not exist yet, so walk through its install home before
 * reaching the filesystem root. */
export function diskProbePath(): string {
  let candidate = serviceLogDir();
  while (true) {
    if (existsSync(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return homeDir();
    candidate = parent;
  }
}

const SERVICE_LOGS = ["server.log", "server.err.log"];

/**
 * Rotate an oversized service log in place. launchd and systemd open the log
 * for append, so the running server's next write lands at the new end of file
 * rather than at a stale offset: copy-then-truncate is safe and leaves no
 * sparse hole. One generation is kept as `<name>.1` for a post-mortem when
 * space permits. On ENOSPC the partial rotation is removed and the live log is
 * truncated as a last resort: recovering the filesystem is more important than
 * preserving the copy. Returns the freed size, or 0 if nothing to do.
 */
export interface LogRotationOps {
  copy: (source: string, destination: string) => void;
  truncate: (path: string) => void;
  remove: (path: string) => void;
}

const DEFAULT_LOG_ROTATION_OPS: LogRotationOps = {
  copy: (source, destination) => copyFileSync(source, destination),
  truncate: (path) => truncateSync(path, 0),
  remove: (path) => rmSync(path, { force: true }),
};

export function rotateLog(
  path: string,
  capBytes = LOG_CAP_BYTES,
  ops: LogRotationOps = DEFAULT_LOG_ROTATION_OPS,
): number {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return 0; // no such log yet
  }
  if (size <= capBytes) return 0;
  const rotatedPath = `${path}.1`;
  try {
    ops.copy(path, rotatedPath);
    ops.truncate(path);
    return size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
      try {
        ops.remove(rotatedPath);
        ops.truncate(path);
        console.warn(
          `[maintenance] disk full while rotating ${path}; truncated without keeping .1`,
        );
        return size;
      } catch (fallbackError) {
        console.error(
          `[maintenance] could not recover disk space from ${path}:`,
          fallbackError,
        );
        return 0;
      }
    }
    console.error(`[maintenance] could not rotate ${path}:`, error);
    return 0;
  }
}

export interface MaintenanceResult {
  rotated: { path: string; wasBytes: number }[];
  diskPct: number;
}

/** One maintenance pass. Safe to call repeatedly; never touches user data. */
export function runMaintenance(): MaintenanceResult {
  const dir = serviceLogDir();
  const rotated: { path: string; wasBytes: number }[] = [];
  if (existsSync(dir)) {
    for (const name of SERVICE_LOGS) {
      const wasBytes = rotateLog(join(dir, name));
      if (wasBytes) rotated.push({ path: join(dir, name), wasBytes });
    }
  }
  for (const r of rotated) {
    console.log(
      `[maintenance] rotated ${r.path} (${(r.wasBytes / MB).toFixed(0)}MB -> 0)`,
    );
  }
  if (rotated.length) audit({ event: "maintenance_log_rotate", rotated: rotated.length });

  const diskPct = diskUsagePct(diskProbePath());
  if (diskPct >= DISK_WARN_PCT) {
    console.warn(
      `[maintenance] free disk is low — filesystem at ${diskPct.toFixed(0)}%. ` +
        `Old sessions/worktrees are the usual culprit; \`opensession doctor\` reports state size.`,
    );
  }
  return { rotated, diskPct };
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Arm the periodic maintenance sweep. Idempotent, so a `bun --hot` reload never
 * stacks a second one. Call once from the __opensessionBooted block.
 */
export function startMaintenance(): void {
  if (timer) return;
  if (process.env.OPENSESSION_MAINTENANCE === "0") {
    console.log("[maintenance] disabled (OPENSESSION_MAINTENANCE=0)");
    return;
  }
  const run = () => {
    try {
      runMaintenance();
    } catch (e) {
      console.error("[maintenance] sweep failed:", e);
    }
  };
  setTimeout(run, FIRST_SWEEP_DELAY_MS);
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  console.log(
    `[maintenance] started (every ${Math.round(SWEEP_INTERVAL_MS / HOUR)}h; ` +
      `service-log cap ${(LOG_CAP_BYTES / MB).toFixed(0)}MB, disk warn at ${DISK_WARN_PCT}%)`,
  );
}
