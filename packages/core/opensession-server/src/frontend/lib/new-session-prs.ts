import type { OpenPr } from "./api";

type SearchablePullRequest = Pick<
  OpenPr,
  "repo" | "number" | "title" | "branch" | "author" | "updatedAt"
>;

/** Pull requests eligible for the selected new-session project, newest first. */
export function matchingPullRequests<T extends SearchablePullRequest>(
  pullRequests: readonly T[],
  repo: string,
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return pullRequests
    .filter((pullRequest) => pullRequest.repo === repo)
    .filter((pullRequest) => {
      if (!needle) return true;
      return [
        `#${pullRequest.number}`,
        String(pullRequest.number),
        pullRequest.title,
        pullRequest.branch,
        pullRequest.author,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
