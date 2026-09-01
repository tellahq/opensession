/**
 * The registered repositories as of the last `/api/repos` answer, remembered
 * across loads.
 *
 * The set of repos an instance serves changes about as often as someone adds
 * a project, but every repo picker used to open empty and wait for a request
 * before it could draw a single row. The cache makes those pickers
 * stale-while-revalidate: they paint the last known list instantly and the
 * fetch behind them corrects it, which is only ever a row appearing or
 * leaving rather than the whole menu arriving at once.
 *
 * The colour assignment rides along (see lib/repo-colors): a tile drawn from
 * the cache paints the colour the server actually assigned, so it doesn't
 * start on the fallback hash colour and change under you a moment later.
 */

import { rememberRepoColors } from "./repo-colors";
import type { RepoInfo } from "./api/repos";

const KEY = "opensession-repos";

interface CachedRepoList {
  repos: RepoInfo[];
  /** The workspace's default repo for new sessions. */
  newSessionRepo: string;
}

function concreteDefault(repos: RepoInfo[], value: string): string {
  return (
    (repos.some((repo) => repo.id === value) ? value : "") ||
    repos.find((repo) => repo.default)?.id ||
    repos[0]?.id ||
    ""
  );
}

let cached: CachedRepoList | null | undefined;
/** A real answer has landed this session, so the stored one is history. */
let live = false;

function read(): CachedRepoList | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as CachedRepoList) : null;
    if (
      parsed &&
      Array.isArray(parsed.repos) &&
      parsed.repos.every((repo) => typeof repo?.id === "string")
    ) {
      cached = {
        repos: parsed.repos,
        newSessionRepo: concreteDefault(
          parsed.repos,
          typeof parsed.newSessionRepo === "string"
            ? parsed.newSessionRepo
            : "",
        ),
      };
    }
  } catch {
    // No storage, or something else wrote nonsense under the key. Either way
    // the pickers just fall back to waiting for the request.
    cached = null;
  }
  // Never let a stored assignment overwrite one a live fetch already recorded.
  if (cached && !live) rememberRepoColors(cached.repos);
  return cached;
}

/** The repos seen on the last load, or [] the very first time. */
export function cachedRepos(): RepoInfo[] {
  return read()?.repos ?? [];
}

/** The workspace default seen on the last load, or "" the very first time. */
export function cachedNewSessionRepo(): string {
  return read()?.newSessionRepo ?? "";
}

/** Record a fresh `/repos` answer (called as the list lands). */
export function rememberRepos(repos: RepoInfo[], newSessionRepo: string): void {
  live = true;
  cached = { repos, newSessionRepo: concreteDefault(repos, newSessionRepo) };
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    // A browser with storage blocked still gets the in-memory list.
  }
}
