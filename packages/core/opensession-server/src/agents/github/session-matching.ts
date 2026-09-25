/** PR ownership is catalog state, not something a webhook rediscovers by
 * opening every session's checkout. Keep this module free of worktree probes,
 * session-list enumeration, and synchronous I/O, including failure paths. */
import {
  configuredRepos,
  defaultRepo,
  getConfigAsync,
} from "../../server/config";
import { indexedLiveSessionsByRepoBranch } from "../../server/session-list-store";
import { SESSION_BRANCH_MATCH_LIMIT } from "../../server/session-list-protocol";
import type { UnifiedSession } from "../../server/types";

export class SessionOwnershipOverflowError extends Error {
  readonly minimumMatches = SESSION_BRANCH_MATCH_LIMIT + 1;
  constructor(
    readonly repo: string,
    readonly branch: string,
  ) {
    super(
      `Refusing PR ownership lookup with more than ${SESSION_BRANCH_MATCH_LIMIT} sessions on ${repo}:${branch}`,
    );
    this.name = "SessionOwnershipOverflowError";
  }
}

export async function workspaceIdForRepo(
  fullName: string,
): Promise<string | null> {
  const repos = configuredRepos(await getConfigAsync());
  return (
    Object.values(repos).find((repo) => repo.ghRepo === fullName)?.id ?? null
  );
}

async function lookup(
  repo: string,
  branch: string,
  relation: "owned" | "linked",
): Promise<UnifiedSession[]> {
  if (!branch) return [];
  const repos = configuredRepos(await getConfigAsync());
  const sessions = await indexedLiveSessionsByRepoBranch(
    repo,
    branch,
    defaultRepo(repos).id,
    relation,
  );
  // The query returns at most limit + 1 rows. Refuse ambiguous ownership rather
  // than silently truncating it or starting a fleet of agent turns.
  if (sessions.length > SESSION_BRANCH_MATCH_LIMIT)
    throw new SessionOwnershipOverflowError(repo, branch);
  return sessions;
}

/** Sessions that have the branch checked out (primary or attached repo).
 * Merge and conflict notices use this: they are about the checkout. */
export function matchSessions(
  repo: string,
  branch: string,
): Promise<UnifiedSession[]> {
  return lookup(repo, branch, "owned");
}

function reviewCandidates(sessions: UnifiedSession[]): UnifiedSession[] {
  // The PR's own review/fix runs also sit on this branch: never hand off to
  // those. The most recently active real session comes first.
  return sessions
    .filter((s) => !s.id.startsWith("bks-ghpr-"))
    .sort(
      (a, b) =>
        Date.parse(b.lastActivity || "0") - Date.parse(a.lastActivity || "0"),
    );
}

/** Who receives a PR review's findings, best first. A session with the
 * branch checked out wins; otherwise a session that linked the PR (link_pr),
 * e.g. one that opened it from a temporary checkout. Model inversion uses the
 * same order so the reviewer is inverted against the model that gets the
 * findings. */
export async function matchReviewOwners(
  repo: string,
  branch: string,
): Promise<UnifiedSession[]> {
  const owners = reviewCandidates(await lookup(repo, branch, "owned"));
  if (owners.length) return owners;
  return reviewCandidates(await lookup(repo, branch, "linked"));
}
