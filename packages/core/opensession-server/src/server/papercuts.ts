/**
 * Papercuts — a cross-session friction log. Any run (interactive session,
 * Slack, automation) can log a one-or-two-sentence papercut in the moment via
 * the opensession-papercuts in-process MCP server: a tool call that missed and
 * had to be retried, a flaky command, a stale cache, a misleading error, an
 * undocumented gotcha. None are blocking on their own — logged together they
 * show where a repo and its tooling need sanding down.
 *
 * Storage: one JSON line per papercut into a daily file under
 * ~/.opensession-papercuts/, tagged with repo/session/model/run kind. Every
 * entry is ALSO emitted as a `papercut` audit event, so the nightly audit
 * digest (/api/audit/digest → the Dreaming automation) sees the day's
 * papercuts with no extra plumbing.
 *
 * Config (Settings → Papercuts): `~/.opensession-papercuts/config.json`
 *   { "repos": { "<repoId>": { "enabled": false } } }
 * Per-repo, default ON — a repo that opts out neither carries the tool nor
 * gets the "log papercuts" nudge in its runs. Read fresh per call.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { audit } from "./audit";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { REPOS } from "./worktree";

const PAPERCUTS_DIR = stateDir("papercuts");

export interface PapercutEntry {
  ts: string;
  message: string;
  /** Registered repo id the friction belongs to (undefined = opensession/general). */
  repo?: string;
  sessionId?: string;
  model?: string;
  /** Journal-style run kind: prompt, slack, automation, … */
  runKind?: string;
  /** Who was driving: a user, or "<name> (automation)". */
  by?: string;
}

const MAX_MESSAGE_CHARS = 1000;

function dayFile(date: string): string {
  return `${PAPERCUTS_DIR}/papercuts-${date}.jsonl`;
}

export function logPapercut(entry: Omit<PapercutEntry, "ts">): PapercutEntry {
  const message = (entry.message || "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) throw new Error("papercut message is empty");
  const full: PapercutEntry = {
    ...entry,
    message,
    ts: new Date().toISOString(),
  };
  mkdirSync(PAPERCUTS_DIR, { recursive: true });
  appendFileSync(dayFile(full.ts.slice(0, 10)), JSON.stringify(full) + "\n");
  // Mirror into the audit log so buildAuditDigest (and through it the nightly
  // Dreaming automation) picks papercuts up alongside errors and tool stats.
  audit({
    kind: "papercut",
    session_id: entry.sessionId,
    run_kind: entry.runKind,
    repo: entry.repo,
    model: entry.model,
    by: entry.by,
    message,
  });
  return full;
}

/** Recent papercuts, newest first. Scans at most `days` daily files back. */
export function listPapercuts(opts?: {
  repo?: string;
  days?: number;
  limit?: number;
}): PapercutEntry[] {
  const days = Math.min(120, Math.max(1, opts?.days || 14));
  const limit = Math.min(1000, Math.max(1, opts?.limit || 200));
  const out: PapercutEntry[] = [];
  for (let i = 0; i < days && out.length < limit; i++) {
    const date = new Date(Date.now() - i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const path = dayFile(date);
    if (!existsSync(path)) continue;
    const dayEntries: PapercutEntry[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as PapercutEntry;
        if (opts?.repo && e.repo !== opts.repo) continue;
        dayEntries.push(e);
      } catch {}
    }
    dayEntries.reverse(); // newest first within the day
    out.push(...dayEntries);
  }
  return out.slice(0, limit);
}

// ── Per-repo config ──────────────────────────────────────────────────────────

interface PapercutsConfigFile {
  repos?: Record<string, { enabled?: boolean }>;
}

function readConfig(): PapercutsConfigFile {
  try {
    return JSON.parse(readFileSync(`${PAPERCUTS_DIR}/config.json`, "utf-8"));
  } catch {
    return {};
  }
}

/** Default ON: only an explicit `enabled: false` turns a repo off, and an
 *  unknown/undefined repo (session-only sessions) always logs. */
export function papercutsEnabledForRepo(repoId: string | undefined): boolean {
  if (!repoId) return true;
  return readConfig().repos?.[repoId]?.enabled !== false;
}

/** Every registered repo with its effective toggle (for the Settings panel). */
export function papercutsRepoConfigs(): Array<{
  repoId: string;
  enabled: boolean;
}> {
  return Object.values(REPOS).map((p) => ({
    repoId: p.id,
    enabled: papercutsEnabledForRepo(p.id),
  }));
}

export function setPapercutsEnabled(repoId: string, enabled: boolean): void {
  if (!REPOS[repoId]) throw new Error(`unknown repo "${repoId}"`);
  const cfg = readConfig();
  cfg.repos = { ...cfg.repos, [repoId]: { ...cfg.repos?.[repoId], enabled } };
  mkdirSync(PAPERCUTS_DIR, { recursive: true });
  writeJsonAtomic(`${PAPERCUTS_DIR}/config.json`, cfg);
}
