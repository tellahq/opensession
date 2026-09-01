/**
 * Session-scoped scratch space — the controlled replacement for anonymous
 * /tmp writes (phase 1 of the /tmp ownership design, 2026-08-18).
 *
 * Every engine run gets `~/.opensession-session-scratch/<session-id>/`:
 * agent-runner.ts ensures it and stamps `opts.scratchDir`, engines export it
 * (pi's bash env sets TMPDIR + OPENSESSION_SCRATCH) and the run instructions
 * name it, so temporary files land in a directory whose lifecycle we own
 * instead of accumulating machine-wide in /tmp forever.
 *
 * Lifecycle: removed when the session is deleted (sessions.ts deleteSession),
 * and swept by the worktree reaper's hourly pass for sessions idle past the
 * horizon (7d, automation-owned 24h — the same shape as worktree parking).
 * Scratch is disposable by contract: the run instructions tell agents that
 * anything worth keeping goes in session assets, the worktree, or a PR.
 *
 * Fail-closed rules mirror the reaper's: a running session or one whose
 * lastActivity does not parse keeps its dir; a dir no session owns (its
 * session was deleted while the server was down) goes only once its own
 * mtime is past the idle horizon, so a dir created moments before its
 * session file lands can never be swept mid-run.
 *
 * State-dir resolution is per call, never a module const — `bun test` runs
 * every file in one process, and a module-load pin belongs to whichever test
 * file imported this first (the workspaces.ts leak of 2026-08-15).
 */

import { type Dirent, mkdirSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "./paths";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Root of the per-session scratch store. */
export function sessionScratchRoot(): string {
  return stateDir("session-scratch");
}

/** Dir name for a session id; null when the id sanitizes to nothing. */
function scratchName(sessionId: string): string | null {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return safe && safe !== "." && safe !== ".." ? safe : null;
}

/**
 * Ensure the session's scratch dir exists and return its path. Undefined on
 * an unusable id or an fs failure — callers treat scratch as best-effort and
 * a run without one simply gets no scratch section.
 */
export function ensureSessionScratch(sessionId: string): string | undefined {
  const name = scratchName(sessionId);
  if (!name) return undefined;
  const dir = join(sessionScratchRoot(), name);
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

/** Remove a session's scratch dir. Never throws — deletion paths must not
 *  block on a scratch hiccup. */
export async function removeSessionScratch(sessionId: string): Promise<void> {
  const name = scratchName(sessionId);
  if (!name) return;
  try {
    await rm(join(sessionScratchRoot(), name), {
      recursive: true,
      force: true,
    });
  } catch (e) {
    console.warn(
      `[session-scratch] failed to remove scratch for ${sessionId}:`,
      e,
    );
  }
}

export interface ScratchSweepSession {
  id: string;
  lastActivity: string;
  isRunning: boolean;
  /** Name of the automation that created the session, when any. */
  automation?: string;
}

export interface ScratchDirInfo {
  /** Directory name under sessionScratchRoot(). */
  name: string;
  mtimeMs: number;
}

/** Sessions idle this long lose their scratch dir. */
const IDLE_DAYS = () =>
  positiveNumber(process.env.OPENSESSION_SCRATCH_IDLE_DAYS, 7);
/** Automation runs are one-shot; their scratch ages out much sooner. */
const AUTOMATION_IDLE_HOURS = () =>
  positiveNumber(process.env.OPENSESSION_SCRATCH_AUTOMATION_IDLE_HOURS, 24);

/**
 * Pure sweep decision: which dir names to delete, given the store listing and
 * the current sessions. Exported for tests; sweepSessionScratch does the fs.
 */
export function scratchDirsToSweep(
  dirs: readonly ScratchDirInfo[],
  sessions: readonly ScratchSweepSession[],
  nowMs: number,
): string[] {
  const idleCutoff = nowMs - IDLE_DAYS() * DAY;
  const automationCutoff = nowMs - AUTOMATION_IDLE_HOURS() * HOUR;
  const owners = new Map<
    string,
    { latestMs: number; protected: boolean; automationOnly: boolean }
  >();
  for (const session of sessions) {
    const name = scratchName(session.id);
    if (!name) continue;
    const current = owners.get(name) ?? {
      latestMs: Number.NEGATIVE_INFINITY,
      protected: false,
      automationOnly: true,
    };
    if (!session.automation) current.automationOnly = false;
    const lastActivityMs = Date.parse(session.lastActivity);
    if (!Number.isFinite(lastActivityMs) || session.isRunning) {
      current.protected = true;
    } else {
      current.latestMs = Math.max(current.latestMs, lastActivityMs);
    }
    owners.set(name, current);
  }
  const doomed: string[] = [];
  for (const dir of dirs) {
    const owner = owners.get(dir.name);
    if (!owner) {
      // Session gone (normal deletes remove the dir directly, so this is a
      // crash leftover) — but only once the dir itself has sat past the idle
      // horizon, so a dir racing its session file's first write is safe.
      if (dir.mtimeMs < idleCutoff) doomed.push(dir.name);
      continue;
    }
    if (owner.protected) continue;
    const cutoff = owner.automationOnly ? automationCutoff : idleCutoff;
    if (owner.latestMs < cutoff) doomed.push(dir.name);
  }
  return doomed;
}

/**
 * Sweep the scratch store against the current sessions. Returns the dir
 * names removed. Callers pass the full session list (the worktree reaper
 * already holds one per sweep).
 */
export async function sweepSessionScratch(
  sessions: readonly ScratchSweepSession[],
): Promise<string[]> {
  const root = sessionScratchRoot();
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // store not created yet
  }
  const dirs: ScratchDirInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      dirs.push({
        name: entry.name,
        mtimeMs: statSync(join(root, entry.name)).mtimeMs,
      });
    } catch {}
  }
  const removed: string[] = [];
  for (const name of scratchDirsToSweep(dirs, sessions, Date.now())) {
    try {
      await rm(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      console.warn(`[session-scratch] sweep failed for ${name}:`, e);
    }
  }
  return removed;
}
