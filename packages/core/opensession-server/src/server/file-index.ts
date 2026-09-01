// File index for "@"-mention autocomplete in the composer.
//
// Lists the tracked + untracked-non-ignored files of a checkout (the same set
// `git status` would show) plus the folders containing them, and fuzzy-filters
// both against a query. The full list per directory is cached briefly so a
// burst of keystrokes doesn't re-shell `git ls-files` on every character —
// only the in-memory filter runs.
//
// Sandbox-aware (docs/self-hosting-sandboxes.md): callers may pass a
// WorkspaceExec (workspaceExecFor) so `git ls-files` runs inside the
// session's sandbox — required for volume-mode workspaces, which have no
// host copy of the worktree. Omitted = the host path, unchanged.

import { $ } from "bun";
import type { WorkspaceExec } from "./sandbox/workspace-exec";

const CACHE_TTL_MS = 15_000;
const cache = new Map<
  string,
  { files: string[]; dirs: string[]; at: number }
>();
const loads = new Map<string, Promise<void>>();

// Monotonic-ish clock without Date.now() (which is fine in server code, but a
// single source keeps it easy to reason about). performance.now() is process
// uptime in ms — perfect for a TTL.
function now(): number {
  return performance.now();
}

// `git ls-files` lists files only, so folder mentions are derived from the
// file paths: every ancestor directory of a listed file is a candidate.
function deriveDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.indexOf("/");
    while (i >= 0) {
      dirs.add(f.slice(0, i));
      i = f.indexOf("/", i + 1);
    }
  }
  return [...dirs];
}

async function loadFiles(dir: string, exec?: WorkspaceExec): Promise<void> {
  const hit = cache.get(dir);
  if (hit && now() - hit.at < CACHE_TTL_MS) return;
  const inflight = loads.get(dir);
  if (inflight) return inflight;

  const load = (async () => {
    try {
      // --cached: tracked, --others --exclude-standard: untracked but not gitignored.
      // -z: NUL-separated so paths with spaces/newlines survive.
      const args = [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ];
      let out: string;
      if (exec) {
        const r = await exec(["git", ...args]);
        if (r.exitCode !== 0)
          throw new Error(r.stderr.trim() || `git ls-files failed in ${dir}`);
        out = r.stdout;
      } else {
        out = await $`git -C ${dir} ${args}`.quiet().text();
      }
      // Drop vendored dependency trees — they're tracked in some repos (opensession
      // commits node_modules) but are never useful "@"-mention targets and only
      // crowd out source files in the results.
      const files = out
        .split("\0")
        .filter(Boolean)
        .filter(
          (f) =>
            !f.startsWith("node_modules/") && !f.includes("/node_modules/"),
        );
      cache.set(dir, { files, dirs: deriveDirs(files), at: now() });
    } catch (error) {
      // A transient git/sandbox failure should not make the picker look empty.
      if (!hit) throw error;
      cache.set(dir, { ...hit, at: now() });
    } finally {
      loads.delete(dir);
    }
  })();
  loads.set(dir, load);
  return load;
}

/** Case-insensitive subsequence match returning a score (higher = better) or -1. */
function fuzzyScore(query: string, path: string): number {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  if (!q) {
    // No query: rank by shallowness then length so top-level files surface first.
    return 1000 - path.split("/").length * 10 - path.length * 0.1;
  }
  const base = p.slice(p.lastIndexOf("/") + 1);

  // Strong boosts for the common cases before falling back to subsequence.
  if (base === q) return 10_000 - path.length;
  if (base.startsWith(q)) return 8_000 - path.length;
  if (base.includes(q)) return 6_000 - path.length;
  if (p.includes(q)) return 4_000 - path.length;

  // Subsequence match anywhere in the full path.
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let pi = 0; pi < p.length && qi < q.length; pi++) {
    if (p[pi] === q[qi]) {
      qi++;
      streak++;
      score += streak; // reward consecutive matches
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return -1; // not all query chars matched
  return 1_000 + score - path.length * 0.1;
}

/** One "@"-mention candidate: a repo-relative file path, or a folder. */
export interface RepoEntry {
  path: string;
  /** True for a directory (derived from file paths — see deriveDirs). */
  dir?: boolean;
}

export function listRepoEntries(
  dir: string,
  query: string,
  limit = 20,
): RepoEntry[] {
  const hit = cache.get(dir);
  if (!hit) return [];
  const scored: Array<{ entry: RepoEntry; score: number }> = [];
  for (const f of hit.files) {
    const score = fuzzyScore(query, f);
    if (score >= 0) scored.push({ entry: { path: f }, score });
  }
  for (const d of hit.dirs) {
    const score = fuzzyScore(query, d);
    if (score >= 0) scored.push({ entry: { path: d, dir: true }, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length,
  );
  return scored.slice(0, limit).map((s) => s.entry);
}

/** Resolve, fuzzy-filter and cap the file+folder list for a directory
 *  (async-safe). `exec` routes the git listing through a sandbox (see
 *  header); omitted = host, exactly as before. */
export async function searchRepoEntries(
  dir: string,
  query: string,
  limit = 20,
  exec?: WorkspaceExec,
): Promise<RepoEntry[]> {
  await loadFiles(dir, exec);
  return listRepoEntries(dir, query, limit);
}
