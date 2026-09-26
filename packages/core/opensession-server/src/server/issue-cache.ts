/**
 * Open GitHub issues across the registered repos, for the Issues page.
 *
 * One REST list per GitHub-backed repo, refreshed at most once a minute and
 * only when something asks for it (no timer at import). An `issues` or
 * `issue_comment` webhook marks the snapshot stale so the next request
 * refreshes early. Rows carry the deterministic id of the issue's session so
 * the page can tell which issues already have one without a second lookup.
 */
import { githubInstallationCredential } from "./github-app";
import { configuredRepos, type Repo } from "./config";
import {
  ghRateLimited,
  isGhRateLimitMsg,
  noteGhRateLimited,
} from "./github-limit";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";
import { githubLoginToPersonKey } from "./shared/user-mappings";
import { LABEL_ISSUE } from "../agents/github/constants";

export interface OpenIssueEntry {
  repo: string;
  ghRepo: string;
  number: number;
  title: string;
  url: string;
  body: string;
  author: string;
  /** Web user-picker key ("kent"), or null when nobody on it is a teammate. */
  person: string | null;
  labels: string[];
  assignees: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  /** The issue's session id, whether or not that session exists yet. */
  sessionId: string;
  /** The `os` label is on the issue: a session was asked for. */
  assigned: boolean;
}

const ISSUE_CACHE_TTL = 60_000;
const PER_REPO_LIMIT = 100;
// Issue bodies are shown in the page's preview; a novel-length one is cut.
const BODY_LIMIT = 20_000;

const cache: { data: Map<string, OpenIssueEntry[]>; ts: number } = {
  data: new Map(),
  ts: 0,
};
let refreshing: Promise<void> | null = null;

function issueRepos(): Repo[] {
  return Object.values(configuredRepos()).filter(
    (repo) =>
      !!repo.ghRepo && repo.host !== "codestorage" && repo.prCache !== false,
  );
}

/** Make the next read refresh, for example after an issue webhook. */
export function invalidateIssueCache(): void {
  cache.ts = 0;
}

/** Demo mode: rows for a repo GitHub will never be asked about. A refresh
 *  without App authority leaves seeded rows in place. */
export function seedIssueCache(repoId: string, rows: OpenIssueEntry[]): void {
  cache.data.set(repoId, rows);
}

/** Every open issue, newest activity first. A cold cache waits for the first
 *  fetch; a warm one serves the snapshot and refreshes in the background. */
export async function getOpenIssues(): Promise<OpenIssueEntry[]> {
  if (Date.now() - cache.ts >= ISSUE_CACHE_TTL) {
    const refresh = refreshIssueCache();
    if (cache.data.size === 0) await refresh;
  }
  return [...cache.data.values()]
    .flat()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function refreshIssueCache(): Promise<void> {
  if (!refreshing) {
    refreshing = refreshInner().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function refreshInner(): Promise<void> {
  const { bksIdFor } = await import("../agents/github/run");
  for (const repo of issueRepos()) {
    const rows = await listRepoIssues(repo, (number) =>
      bksIdFor(number, "issue", repo.ghRepo),
    );
    if (rows) cache.data.set(repo.id, rows);
  }
  cache.ts = Date.now();
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function entryFrom(
  repo: Repo,
  d: any,
  sessionIdFor: (number: number) => string,
): OpenIssueEntry | null {
  // The issues endpoint lists pull requests too; those have their own page.
  if (!d || typeof d.number !== "number" || d.pull_request) return null;
  const labels: string[] = Array.isArray(d.labels)
    ? d.labels
        .map((l: any) => (typeof l === "string" ? l : l?.name))
        .filter(isString)
    : [];
  const assignees: string[] = Array.isArray(d.assignees)
    ? d.assignees.map((a: any) => a?.login).filter(isString)
    : [];
  const author: string = isString(d.user?.login) ? d.user.login : "";
  return {
    repo: repo.id,
    ghRepo: repo.ghRepo,
    number: d.number,
    title: isString(d.title) ? d.title : `#${d.number}`,
    url: isString(d.html_url) ? d.html_url : "",
    body: isString(d.body) ? d.body.slice(0, BODY_LIMIT) : "",
    author,
    person:
      githubLoginToPersonKey(author) ??
      assignees
        .map((login) => githubLoginToPersonKey(login))
        .find((p): p is string => !!p) ??
      null,
    labels,
    assignees,
    comments: Number(d.comments) || 0,
    createdAt: isString(d.created_at) ? d.created_at : "",
    updatedAt: isString(d.updated_at) ? d.updated_at : "",
    sessionId: sessionIdFor(d.number),
    assigned: labels.includes(LABEL_ISSUE),
  };
}

async function listRepoIssues(
  repo: Repo,
  sessionIdFor: (number: number) => string,
): Promise<OpenIssueEntry[] | null> {
  const credential = await githubInstallationCredential({ repo: repo.ghRepo });
  if (!credential || (await ghRateLimited("rest", credential))) return null;
  try {
    const resp = await fetchWithTimeout(
      `https://api.github.com/repos/${repo.ghRepo}/issues?state=open&sort=updated&direction=desc&per_page=${PER_REPO_LIMIT}`,
      {
        headers: {
          Authorization: `Bearer ${credential.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (
        (resp.status === 403 || resp.status === 429) &&
        (resp.headers.get("x-ratelimit-remaining") === "0" ||
          isGhRateLimitMsg(body))
      ) {
        await noteGhRateLimited(
          "issue-cache",
          Number(resp.headers.get("x-ratelimit-reset")) * 1000,
          "rest",
          credential,
        );
      } else {
        console.warn(`[issues] ${repo.ghRepo}: HTTP ${resp.status}`);
      }
      return null;
    }
    const data: unknown = await resp.json();
    if (!Array.isArray(data)) return null;
    return data.flatMap((d) => {
      const entry = entryFrom(repo, d, sessionIdFor);
      return entry ? [entry] : [];
    });
  } catch (e) {
    console.warn(`[issues] ${repo.ghRepo}: list failed:`, e);
    return null;
  }
}
