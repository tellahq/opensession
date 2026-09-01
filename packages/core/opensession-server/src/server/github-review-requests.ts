import { githubLoginToPersonKey } from "./shared/user-mappings";
import {
  botGhToken,
  ghRateLimited,
  isGhRateLimitMsg,
  noteGhRateLimited,
} from "./github-limit";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";

export interface ReviewRequestRef {
  login?: string;
  slug?: string;
}

interface ReviewTeamCacheEntry {
  logins: string[];
  expiresAt: number;
}

const REVIEW_TEAM_CACHE_TTL = 30 * 60_000;
const reviewTeamCache: Map<string, ReviewTeamCacheEntry> = ((
  globalThis as any
).__osReviewTeamCache ||= new Map());

export function normalizeReviewTeamSlug(slug: string): string {
  return slug.split("/").filter(Boolean).at(-1) || slug;
}

/** Expand GitHub's mixed user/team review requests into individual logins. */
export function expandReviewRequestLogins(
  requests: ReviewRequestRef[],
  teamLoginsBySlug: ReadonlyMap<string, readonly string[]>,
  authorLogin?: string,
): string[] {
  const author = authorLogin?.toLowerCase();
  const logins = new Map<string, string>();
  for (const request of requests) {
    const requested = request.login
      ? [request.login]
      : request.slug
        ? teamLoginsBySlug.get(request.slug.toLowerCase()) || []
        : [];
    for (const login of requested) {
      const lower = login.toLowerCase();
      if (lower && lower !== author) logins.set(lower, login);
    }
  }
  return [...logins.values()];
}

/**
 * The same requests as `gh pr edit --remove-reviewer` specs: a user login, or
 * `owner/team-slug` for a team. Withdrawing a team's request needs the team
 * itself — removing the members it expands to leaves the request standing.
 */
export function reviewRequestRemovalSpecs(
  requests: ReviewRequestRef[],
  owner: string,
): string[] {
  const specs = requests.map(
    (request) =>
      request.login ||
      (request.slug
        ? `${owner}/${normalizeReviewTeamSlug(request.slug)}`
        : null),
  );
  return [...new Set(specs.filter((spec): spec is string => !!spec))];
}

export function cachedReviewTeamLogins(
  owner: string,
  slug: string,
): string[] | null {
  const teamSlug = normalizeReviewTeamSlug(slug);
  const entry = reviewTeamCache.get(
    `${owner.toLowerCase()}/${teamSlug.toLowerCase()}`,
  );
  return entry?.expiresAt && entry.expiresAt > Date.now() ? entry.logins : null;
}

export async function fetchReviewTeamLogins(
  owner: string,
  slug: string,
): Promise<string[] | null> {
  const teamSlug = normalizeReviewTeamSlug(slug);
  const key = `${owner.toLowerCase()}/${teamSlug.toLowerCase()}`;
  const cached = reviewTeamCache.get(key);
  if (cached?.expiresAt && cached.expiresAt > Date.now()) return cached.logins;
  if (ghRateLimited("rest")) return cached?.logins || null;
  const token = await botGhToken();
  if (!token) return cached?.logins || null;

  const logins: string[] = [];
  let url: string | null =
    `https://api.github.com/orgs/${encodeURIComponent(owner)}/teams/${encodeURIComponent(teamSlug)}/members?per_page=100`;
  try {
    while (url) {
      const response = await fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (
          (response.status === 403 || response.status === 429) &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            isGhRateLimitMsg(body))
        ) {
          const reset =
            Number(response.headers.get("x-ratelimit-reset")) * 1000;
          noteGhRateLimited(
            "pr-review-team",
            Number.isFinite(reset) ? reset : undefined,
            "rest",
          );
        }
        return cached?.logins || null;
      }
      const members = await response.json();
      if (!Array.isArray(members)) return cached?.logins || null;
      for (const member of members) {
        if (typeof member?.login === "string") logins.push(member.login);
      }
      const next = response.headers
        .get("link")
        ?.match(/<([^>]+)>;\s*rel="next"/i);
      url = next?.[1] || null;
    }
  } catch {
    return cached?.logins || null;
  }

  reviewTeamCache.set(key, {
    logins,
    expiresAt: Date.now() + REVIEW_TEAM_CACHE_TTL,
  });
  return logins;
}

export function reviewRequestPersonKeys(
  requests: ReviewRequestRef[],
  teamLoginsBySlug: ReadonlyMap<string, readonly string[]>,
  authorLogin?: string,
): string[] {
  return expandReviewRequestLogins(requests, teamLoginsBySlug, authorLogin)
    .map((login) => githubLoginToPersonKey(login))
    .filter((person): person is string => !!person);
}
