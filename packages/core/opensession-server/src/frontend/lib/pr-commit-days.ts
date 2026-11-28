import type { PrCheck, PrCommit } from "./types";

export interface PrCommitDay {
  /** "Nov 27, 2026", or "" for commits with no date. */
  label: string;
  commits: PrCommit[];
}

/** A PR's commits in the order they landed, grouped by the day they were
 *  authored, the way GitHub's Commits tab lists them. */
export function prCommitDays(
  commits: PrCommit[],
  locale?: string,
): PrCommitDay[] {
  const days: PrCommitDay[] = [];
  for (const commit of commits) {
    const label = commit.authoredDate
      ? new Date(commit.authoredDate).toLocaleDateString(locale, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "";
    const last = days.at(-1);
    if (last && last.label === label) last.commits.push(commit);
    else days.push({ label, commits: [commit] });
  }
  return days;
}

/** Checks grouped under their workflow ("CI"), status contexts last under
 *  the name they share with nothing else. Order within a group is kept. */
export function prCheckGroups(
  checks: PrCheck[],
): Array<{ name: string; checks: PrCheck[] }> {
  const groups = new Map<string, PrCheck[]>();
  for (const check of checks) {
    const name = check.workflowName || "";
    const list = groups.get(name);
    if (list) list.push(check);
    else groups.set(name, [check]);
  }
  return [...groups]
    .sort(([a], [b]) => (a === "" ? 1 : 0) - (b === "" ? 1 : 0))
    .map(([name, list]) => ({ name, checks: list }));
}
