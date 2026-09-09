/**
 * Pull request labels, applied as the bot.
 *
 * Labels carry no authorship, so they are a bot action by design
 * (docs/github-authority.md). The gateway mints a token scoped to the target
 * repository and makes the request itself: a session whose shell holds the
 * token for one repository can still label a pull request in another
 * registered repository, and the token never enters the run.
 */

import { audited } from "./audit";
import type { Repo } from "./config";
import { githubAppRepositoryToken } from "./github-app";
import { REPOS } from "./worktree";

export interface PrLabelChange {
  add?: string[];
  remove?: string[];
}

export interface PrLabelResult {
  repo: string;
  ghRepo: string;
  number: number;
  labels: string[];
}

const PR_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;

/**
 * The registered repository and PR number a URL or `repo` + `number` pair
 * names. Throws with a human message: an unregistered repository, a
 * repository that is not on GitHub, or a missing number.
 */
export function resolveRegisteredPr(input: {
  url?: string;
  repo?: string;
  number?: number;
}): { repo: Repo; number: number } {
  let repo: Repo | undefined;
  let number = input.number;
  if (input.url) {
    const m = input.url.match(PR_URL);
    if (!m)
      throw new Error("Not a GitHub PR URL (…github.com/owner/repo/pull/N)");
    const ghRepo = `${m[1]}/${m[2]}`.toLowerCase();
    repo = Object.values(REPOS).find((r) => r.ghRepo?.toLowerCase() === ghRepo);
    if (!repo)
      throw new Error(
        `${m[1]}/${m[2]} isn't a registered repo (known: ${Object.values(REPOS)
          .filter((r) => r.ghRepo)
          .map((r) => r.id)
          .join(", ")})`,
      );
    number = parseInt(m[3], 10);
  } else if (input.repo) {
    repo = REPOS[input.repo.trim()];
    if (!repo) throw new Error(`Unknown repo "${input.repo}"`);
  }
  if (!repo) throw new Error("Pass a PR URL or a repo id");
  if (repo.host === "codestorage" || !repo.ghRepo)
    throw new Error(`${repo.id} is not on GitHub; labels only exist there.`);
  if (!number) throw new Error("Pass a PR URL or a PR number");
  return { repo, number };
}

function normalizeLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((l) => l.trim()).filter(Boolean))];
}

export interface GithubLabelApi {
  /** POST /issues/:n/labels; resolves the resulting label set. */
  add: (ghRepo: string, number: number, labels: string[]) => Promise<string[]>;
  /** DELETE /issues/:n/labels/:name; resolves the resulting label set. */
  remove: (ghRepo: string, number: number, label: string) => Promise<string[]>;
  /** GET /issues/:n/labels. */
  list: (ghRepo: string, number: number) => Promise<string[]>;
}

async function githubRequest(
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Array<{ name: string }>> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opensession",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      json && typeof json === "object" && "message" in json
        ? String(json.message)
        : `GitHub REST ${response.status}`;
    throw new Error(`${message} (${response.status})`);
  }
  // SAFETY: the labels endpoints return an array of label objects; anything
  // else is treated as an empty set rather than trusted.
  return Array.isArray(json) ? (json as Array<{ name: string }>) : [];
}

export function githubLabelApi(token: string): GithubLabelApi {
  const names = (labels: Array<{ name: string }>) => labels.map((l) => l.name);
  return {
    add: async (ghRepo, number, labels) =>
      names(
        await githubRequest(
          token,
          "POST",
          `/repos/${ghRepo}/issues/${number}/labels`,
          { labels },
        ),
      ),
    remove: async (ghRepo, number, label) =>
      names(
        await githubRequest(
          token,
          "DELETE",
          `/repos/${ghRepo}/issues/${number}/labels/${encodeURIComponent(label)}`,
        ),
      ),
    list: async (ghRepo, number) =>
      names(
        await githubRequest(
          token,
          "GET",
          `/repos/${ghRepo}/issues/${number}/labels?per_page=100`,
        ),
      ),
  };
}

/**
 * Add and remove labels on one pull request as the bot. Removing a label the
 * PR does not carry is not an error. Resolves the label set afterwards.
 */
export async function applyPrLabels(
  target: { repo: Repo; number: number },
  change: PrLabelChange,
  api: GithubLabelApi,
): Promise<PrLabelResult> {
  const add = normalizeLabels(change.add);
  const remove = normalizeLabels(change.remove).filter((l) => !add.includes(l));
  const ghRepo = target.repo.ghRepo;
  let labels: string[] | undefined;
  if (add.length) labels = await api.add(ghRepo, target.number, add);
  for (const label of remove) {
    try {
      labels = await api.remove(ghRepo, target.number, label);
    } catch (error) {
      // GitHub answers 404 when the label is not on the issue.
      if (!/\(404\)$/.test(error instanceof Error ? error.message : ""))
        throw error;
    }
  }
  labels ??= await api.list(ghRepo, target.number);
  return { repo: target.repo.id, ghRepo, number: target.number, labels };
}

/** The interactive entrypoint: resolve the PR, mint the bot token for its
 * repository, apply the change, and audit it against the session. */
export async function labelPr(
  sessionId: string,
  input: { url?: string; repo?: string; number?: number } & PrLabelChange,
): Promise<PrLabelResult> {
  const target = resolveRegisteredPr(input);
  if (
    !normalizeLabels(input.add).length &&
    !normalizeLabels(input.remove).length
  )
    throw new Error("Nothing to change: give labels to add or remove.");
  const token = await githubAppRepositoryToken(target.repo.ghRepo);
  if (!token)
    throw new Error(
      `The GitHub App has no installation token for ${target.repo.ghRepo}.`,
    );
  return audited(
    {
      context: "repos",
      action: "label-pr",
      args: {
        session: sessionId,
        repo: target.repo.ghRepo,
        number: target.number,
        add: normalizeLabels(input.add),
        remove: normalizeLabels(input.remove),
      },
    },
    () => applyPrLabels(target, input, githubLabelApi(token)),
  );
}
