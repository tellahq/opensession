/**
 * One shipped thing, as a feed row.
 *
 * The feed is what the team shipped, and not every repo ships the same way:
 * most land work as a merged pull request, while a `sharedCheckout` repo
 * (Open Session's own) commits straight to the default branch and has no PR
 * to show. Both become the same row here, sorted together, so the page
 * answers "what shipped" rather than "what merged".
 */

import type { RecentCommit } from "./api";
import { personLabel, type WorktreeRow } from "./pr-rows";

/**
 * Who shipped it. Everything has an owner: a teammate, or the automation or
 * agent that ran unattended. A row with no owner at all is a gap in the
 * record rather than a kind of work, so the feed does not render one.
 */
export interface FeedOwner {
  /** User-picker key, for a teammate. Null for an automation or agent. */
  person: string | null;
  /** What to call them: a teammate's name, or the automation's own. */
  label: string;
}

export interface FeedRow {
  key: string;
  kind: "pr" | "commit";
  title: string;
  repo: string;
  person: string | null;
  /** Null only for work shipped before commits carried a name. */
  owner: FeedOwner | null;
  url?: string;
  /** What to call it in the list: "#128" for a PR, a short sha for a commit. */
  ref?: string;
  additions?: number;
  deletions?: number;
  shippedAt: string;
  /**
   * The session behind it, when there is one to open.
   *
   * An id rather than the session itself, because opening one only ever needs
   * its id, and holding the object made the row depend on the session still
   * being in the live list. Almost none of them are: a session is archived
   * when its work is done, which for a shipped commit is the normal case and
   * usually happened the same day. Every such row quietly left for the web
   * host instead, which is the one place the session is not.
   */
  sessionId?: string;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Resolve a row's owner.
 *
 * A row's `person` is whoever owns the session behind it, and that is not
 * always a teammate: an automation owns its own sessions, so the field holds
 * the automation's name. Checking it against the roster is what keeps an
 * automation from wearing a face and reading as a colleague you could ask.
 * Its name is still the best label it has, so it keeps it.
 *
 * Failing that, the recorded author stands: an unattended run signs its own
 * name. Null only when nothing was recorded at all, which is how work from
 * before commits carried a name still reads.
 */
export function feedOwner(
  person: string | null,
  author?: string | null,
  isTeammate?: (key: string) => boolean,
): FeedOwner | null {
  if (person) {
    const label = personLabel(person);
    if (!isTeammate || isTeammate(person)) return { person, label };
    return { person: null, label };
  }
  const label = (author || "").trim();
  return label ? { person: null, label } : null;
}

/**
 * Merged PRs and commits in one list, newest first.
 *
 * A merge and commit both arrive carrying a session id when the server can
 * attribute them. Neither is looked up in the live session list here: that
 * lookup can only lose archived sessions.
 */
export function buildFeedRows(
  prRows: WorktreeRow[],
  commits: RecentCommit[],
  isTeammate?: (key: string) => boolean,
): FeedRow[] {
  const rows: FeedRow[] = [
    ...prRows.map((row): FeedRow => {
      const feedRow = {
        key: row.key,
        kind: "pr",
        title: row.title,
        repo: row.repo,
        person: row.person,
        owner: feedOwner(row.person, row.author, isTeammate),
        url: row.url,
        additions: row.additions,
        deletions: row.deletions,
        shippedAt: row.updatedAt,
        sessionId: row.sessionId,
      } satisfies FeedRow;
      return row.number ? { ...feedRow, ref: `#${row.number}` } : feedRow;
    }),
    ...commits.map((commit) => ({
      key: `${commit.repo}:${commit.sha}`,
      kind: "commit" as const,
      title: commit.title,
      repo: commit.repo,
      person: commit.person,
      owner: feedOwner(commit.person, commit.author, isTeammate),
      url: commit.url,
      ref: shortSha(commit.sha),
      additions: commit.additions,
      deletions: commit.deletions,
      shippedAt: commit.committedAt,
      sessionId: commit.sessionId,
    })),
  ];
  return rows.sort(
    (a, b) => new Date(b.shippedAt).getTime() - new Date(a.shippedAt).getTime(),
  );
}
