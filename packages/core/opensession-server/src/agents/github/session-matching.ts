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

/** True when the session has `repo:branch` checked out (its primary branch or
 * an attached repo), as opposed to only following it as a linked PR. */
export function checksOutBranch(
  session: UnifiedSession,
  repo: string,
  branch: string,
  defaultRepoId: string,
): boolean {
  if (
    session.branch === branch &&
    !session.repoLess &&
    (session.repo || defaultRepoId) === repo
  )
    return true;
  return (session.attachedRepos ?? []).some(
    (attached) => attached.repo === repo && attached.branch === branch,
  );
}

export type OwnerOrder = "activity" | "created";

/**
 * Live sessions that own `repo:branch`: the ones with it checked out plus the
 * ones that linked its PR. With `order`, sessions holding a checkout come
 * first (they can act on the branch), then newest by activity or creation, so
 * a linked-only follower never takes a fix away from the real owner.
 */
export async function matchSessions(
  repo: string,
  branch: string,
  opts: { order?: OwnerOrder } = {},
): Promise<UnifiedSession[]> {
  if (!branch) return [];
  const repos = configuredRepos(await getConfigAsync());
  const defaultRepoId = defaultRepo(repos).id;
  const sessions = await indexedLiveSessionsByRepoBranch(
    repo,
    branch,
    defaultRepoId,
  );
  // The query returns at most limit + 1 rows. Refuse ambiguous ownership rather
  // than silently truncating it or starting a fleet of agent turns.
  if (sessions.length > SESSION_BRANCH_MATCH_LIMIT)
    throw new SessionOwnershipOverflowError(repo, branch);
  if (!opts.order) return sessions;
  const field = opts.order === "created" ? "createdAt" : "lastActivity";
  const time = (s: UnifiedSession) => Date.parse(s[field] || "") || 0;
  const rank = (s: UnifiedSession) =>
    checksOutBranch(s, repo, branch, defaultRepoId) ? 0 : 1;
  return [...sessions].sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
}
