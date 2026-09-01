/**
 * One pull request, as a row: the shape both the Pull requests list and the
 * People page's shipped feed read.
 *
 * A row is a PR first and a session second. GitHub is authoritative about
 * state, so a merge that landed outside Open Session still shows up, and a
 * session whose enrichment lags behind the merge does not overwrite it.
 */

import type { RecentPr } from "./api";
import type { UnifiedSession } from "./types";
import type { PrStatusInput } from "./pr-status";
import { sessionPrRefs } from "./session-prs";
import { cleanSessionTitle } from "./session-title";

export interface WorktreeRow extends PrStatusInput {
  key: string;
  session?: UnifiedSession;
  /** Preserved even when the session is archived and absent from the live list. */
  sessionId?: string;
  title: string;
  repo: string;
  branch: string;
  url?: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  number?: number;
  additions?: number;
  deletions?: number;
  updatedAt: string;
  workspaceId?: string | null;
  archived: boolean;
  person: string | null;
  author?: string;
}

function worktreesForSession(session: UnifiedSession): WorktreeRow[] {
  if (session.desk) return [];

  return sessionPrRefs(session)
    .filter((pr): pr is typeof pr & { url: string } => !!pr.url)
    .map((pr) => ({
      key: pr.url,
      session,
      sessionId: session.id,
      title: cleanSessionTitle(pr.title || session.title),
      repo: pr.repo,
      branch: pr.branch,
      url: pr.url,
      state: pr.state || "OPEN",
      number: pr.number,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      mergeable: pr.mergeable,
      checks: pr.checks,
      additions: pr.additions,
      deletions: pr.deletions,
      updatedAt: pr.updatedAt || session.lastActivity,
      workspaceId: session.workspaceId,
      archived: !!session.archived,
      person: session.startedBy?.toLowerCase() || null,
      author: pr.author,
    }));
}

export function dateGroup(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const then = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const days = Math.max(0, Math.floor((start - then) / 86_400_000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 35) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  const months = Math.max(
    1,
    (now.getFullYear() - date.getFullYear()) * 12 +
      now.getMonth() -
      date.getMonth(),
  );
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

export function compactAge(value: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds < 31_536_000) return `${Math.floor(seconds / 2_592_000)}mo`;
  return `${Math.floor(seconds / 31_536_000)}y`;
}

export function compactDiff(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(abs);
  if (abs < 10_000) return `${(abs / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(abs / 1000)}k`;
}

export function personLabel(person: string): string {
  return person
    .split(/[._-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildWorktreeRows(
  recentPrs: RecentPr[],
  sessions: UnifiedSession[],
): WorktreeRow[] {
  const byPr = new Map<string, WorktreeRow>();
  for (const pr of recentPrs) {
    byPr.set(pr.url, {
      key: pr.url,
      sessionId: pr.sessionId,
      title: pr.title,
      repo: pr.repo,
      branch: pr.branch,
      url: pr.url,
      state: pr.state,
      number: pr.number,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      checks: pr.checks,
      additions: pr.additions,
      deletions: pr.deletions,
      updatedAt: pr.updatedAt,
      workspaceId: null,
      archived: false,
      person: pr.person,
      author: pr.author,
    });
  }
  for (const session of sessions) {
    for (const row of worktreesForSession(session)) {
      const existing = byPr.get(row.key);
      byPr.set(row.key, {
        ...existing,
        ...row,
        // GitHub is authoritative; session enrichment can lag behind a merge.
        state: existing?.state ?? row.state,
        isDraft: existing?.isDraft ?? row.isDraft,
        reviewDecision: existing?.reviewDecision ?? row.reviewDecision,
        checks: existing?.checks ?? row.checks,
        mergeable: row.mergeable ?? existing?.mergeable,
        // Archiving a workspace should not remove its shipped PR from history.
        archived: existing ? false : row.archived,
        person: row.person || existing?.person || null,
        author: existing?.author || row.author,
        additions: row.additions ?? existing?.additions,
        deletions: row.deletions ?? existing?.deletions,
        updatedAt:
          existing && new Date(existing.updatedAt) > new Date(row.updatedAt)
            ? existing.updatedAt
            : row.updatedAt,
      });
    }
  }

  return [...byPr.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}
