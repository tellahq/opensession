import type React from "react";
import { AGENT_NAME } from "../../lib/brand";
import {
  type GitDotTone,
  type GitTask,
  gitTasks,
  useGitTaskRunner,
} from "../../lib/pr-git-tasks";
import { deriveStatus } from "../../lib/pr-status-derive";
import {
  GIT_ACTION,
  GIT_DOT,
  GIT_DOT_BG,
  GIT_LABEL,
  GIT_NOTE,
  GIT_ROW,
} from "../../lib/pr-tone-classes";
import type { GitStatusInfo, PrDetails } from "../../lib/types";
import { Button } from "../../ui/button";
import { MergeUndoControl } from "./MergeUndoControl";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../../ui/cn";

const sx = stylex.create({
  textFaint: {
    color: "var(--text-faint)",
  },
  textRed: {
    color: "var(--red)",
  },
});

/**
 * Local/remote discrepancy rows for the Status card: each gets a line with one
 * action on the right. Push is a direct server-side `git push`; the judgment
 * calls (create the PR, resolve conflicts, update from base, commit stray
 * changes) prompt the session — the agent does the work, not a bare button.
 */
export function GitStatusRows({
  git,
  pr,
  sessionId,
  repo,
  send,
  onRefresh,
  onMerge,
  merging,
  mergeScheduled,
}: {
  git: GitStatusInfo | null;
  pr: PrDetails | null;
  sessionId: string;
  repo?: string;
  send?: (msg: any) => void;
  onRefresh: () => Promise<void> | void;
  onMerge?: () => void;
  merging?: boolean;
  mergeScheduled?: boolean;
}) {
  const runner = useGitTaskRunner({ sessionId, repo, send, onRefresh });
  const { prompted, error } = runner;

  const base = pr?.baseRefName || git?.baseBranch || "main";
  const tasks = gitTasks(git, pr, base);
  const task = (key: GitTask["key"]) => tasks.find((t) => t.key === key);

  const rows: Array<{
    key: string;
    label: string;
    tone: GitDotTone;
    action?: React.ReactNode;
  }> = [];

  if (pr) {
    const status = deriveStatus(pr);
    const conflicts = task("conflicts");
    const resolveAction =
      conflicts && runner.runnable(conflicts) ? (
        <button className={GIT_ACTION} onClick={() => runner.run(conflicts)}>
          {conflicts.action}
        </button>
      ) : undefined;
    rows.push({
      key: "pr-status",
      label: status.qualifier || status.label,
      tone: status.tone,
      action:
        resolveAction ||
        (pr.state === "OPEN" && !pr.isDraft && onMerge ? (
          mergeScheduled ? (
            <MergeUndoControl compact onUndo={onMerge} />
          ) : (
            <button
              className={GIT_ACTION}
              onClick={onMerge}
              disabled={merging}
              title="Squash and merge this pull request"
            >
              {merging ? "Merging…" : "Merge"}
            </button>
          )
        ) : undefined),
    });
  }

  // Base-sync (rebase) status — lead with it so the panel answers "am I behind
  // main?" at a glance. Shown for any real feature branch (not the base branch
  // itself, not a merged PR): a reassuring green "up to date" when in sync, and
  // a prominent yellow "N behind" with a one-click Update (rebase) when not.
  if (git && git.branch && git.branch !== base && pr?.state !== "MERGED") {
    const behind = task("behind");
    rows.push({
      key: "base-sync",
      label: behind ? behind.label : `Up to date with ${base}`,
      tone: behind ? behind.tone : "green",
      action:
        behind && runner.runnable(behind) ? (
          <button className={GIT_ACTION} onClick={() => runner.run(behind)}>
            {behind.action}
          </button>
        ) : undefined,
    });
  }

  if (!pr) {
    rows.push({
      key: "no-pr",
      label: "No pull request",
      tone: "muted",
      action: send && (
        <button
          className={GIT_ACTION}
          onClick={() =>
            runner.promptSession(
              "create a PR",
              "Commit any remaining work, push the branch, and open a PR for it.",
            )
          }
        >
          Create PR
        </button>
      ),
    });
  }
  for (const key of ["ahead", "dirty"] as const) {
    const t = task(key);
    if (!t || !runner.runnable(t)) continue;
    rows.push({
      key,
      label: t.label,
      tone: t.tone,
      action: (
        <button
          className={GIT_ACTION}
          onClick={() => runner.run(t)}
          disabled={t.run === "push" && runner.pushing}
        >
          {t.run === "push" && runner.pushing ? "Pushing…" : t.action}
        </button>
      ),
    });
  }
  if (rows.length === 0) return null;

  return (
    <>
      {rows.map((row) => (
        <div key={row.key} className={GIT_ROW}>
          <span className={`${GIT_DOT} ${GIT_DOT_BG[row.tone]}`} aria-hidden />
          <span className={GIT_LABEL}>{row.label}</span>
          {row.action}
        </div>
      ))}
      {prompted && (
        <div
          className={[GIT_NOTE, mergeStylexClassName("", sx.textFaint)]
            .filter(Boolean)
            .join(" ")}
        >
          Asked {AGENT_NAME} to {prompted} ✓
        </div>
      )}
      {error && (
        <div
          className={[GIT_NOTE, mergeStylexClassName("", sx.textRed)]
            .filter(Boolean)
            .join(" ")}
        >
          {error}
        </div>
      )}
    </>
  );
}
