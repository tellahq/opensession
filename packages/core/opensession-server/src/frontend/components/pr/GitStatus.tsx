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
import type {
  GitStatusInfo,
  PrDetails,
  WSClientMessage,
} from "../../lib/types";
import { Button } from "../../ui/button";
import { MergeUndoControl } from "./MergeUndoControl";
import { deferredMergeKey } from "../../lib/deferred-merge";
import { useDeferredMergeDeadline } from "../../hooks/useDeferredMerge";
import {
  MERGE_CHOICE_LABEL,
  MERGE_CHOICE_SHORT,
  MERGE_CHOICE_TITLE,
  type MergeChoice,
} from "../../lib/merge-choices";
import { Menu, MENU_ICON } from "../../ui/menu";
import {
  IconChevronDown,
  IconClock,
  IconGitMerge,
  IconWarningTriangle,
  IconX,
} from "../icons";

export type GitStatusRowsProps = {
  git: GitStatusInfo | null;
  pr: PrDetails | null;
  sessionId: string;
  repo?: string;
  send?: (msg: WSClientMessage) => void;
  onRefresh: () => Promise<void> | void;
  onMerge?: () => void;
  merging?: boolean;
  mergeScheduled?: boolean;
  onMarkReady?: () => void;
  markingReady?: boolean;
  /** Squash, auto-merge and force merge, from mergeChoices(). When set, it
   *  replaces the plain `onMerge` button with the button plus a menu. */
  merge?: {
    primary: MergeChoice | null;
    all: MergeChoice[];
    onChoose: (choice: MergeChoice) => void;
    /** An auto-merge toggle is in flight. */
    busy?: boolean;
  };
  /** Draw the merge action as the page's primary button rather than the
   *  row's quiet plate: the overview's merge box leads with it. */
  emphasis?: boolean;
};

export interface GitStatusRow {
  key: string;
  label: string;
  tone: GitDotTone;
  action?: React.ReactNode;
}

/**
 * The rows GitStatusRows draws, for a surface that lays them out itself. The
 * first row is the pull request's own state ("Ready to merge", "Merge
 * conflicts") with its one action; the rest are the branch's local/remote
 * discrepancies. `notes` is the prompted/error line under them.
 */
export function useGitStatusRows({
  git,
  pr,
  sessionId,
  repo,
  send,
  onRefresh,
  onMerge,
  merging,
  mergeScheduled,
  onMarkReady,
  markingReady,
  merge,
  emphasis,
}: GitStatusRowsProps) {
  const runner = useGitTaskRunner({ sessionId, repo, send, onRefresh });
  const { prompted, error } = runner;
  const mergeDeadline = useDeferredMergeDeadline(deferredMergeKey(pr?.url));

  const base = pr?.baseRefName || git?.baseBranch || "main";
  const tasks = gitTasks(git, pr, base);
  const task = (key: GitTask["key"]) => tasks.find((t) => t.key === key);

  const rows: GitStatusRow[] = [];

  if (pr) {
    const status = deriveStatus(pr);
    const conflicts = task("conflicts");
    const resolveAction =
      conflicts && runner.runnable(conflicts) ? (
        <button className={GIT_ACTION} onClick={() => runner.run(conflicts)}>
          {conflicts.action}
        </button>
      ) : undefined;
    const readyAction =
      pr.state === "OPEN" && pr.isDraft && onMarkReady ? (
        <button
          className={GIT_ACTION}
          onClick={onMarkReady}
          disabled={markingReady}
          title="Mark this pull request ready for review"
        >
          {markingReady ? "Marking ready…" : "Ready for review"}
        </button>
      ) : undefined;
    rows.push({
      key: "pr-status",
      label: status.qualifier || status.label,
      tone: status.tone,
      action:
        resolveAction ||
        readyAction ||
        (pr.state === "OPEN" && !pr.isDraft && merge ? (
          <MergeControl
            merge={merge}
            emphasis={emphasis}
            merging={merging}
            mergeScheduled={mergeScheduled}
            undo={
              mergeScheduled && onMerge ? (
                <MergeUndoControl
                  compact
                  deadline={mergeDeadline}
                  onUndo={onMerge}
                />
              ) : null
            }
          />
        ) : pr.state === "OPEN" && !pr.isDraft && onMerge ? (
          <span className="inline-flex shrink-0 items-center gap-1">
            {mergeScheduled && (
              <MergeUndoControl
                compact
                deadline={mergeDeadline}
                onUndo={onMerge}
              />
            )}
            <button
              className={GIT_ACTION}
              onClick={onMerge}
              disabled={merging || mergeScheduled}
              title="Squash and merge this pull request"
            >
              {merging || mergeScheduled ? "Merging…" : "Merge"}
            </button>
          </span>
        ) : undefined),
    });
  }

  if (pr?.state === "OPEN" && pr.autoMerge) {
    rows.push({
      key: "auto-merge",
      label: `Auto-merge on${pr.autoMerge.enabledBy ? ` by ${pr.autoMerge.enabledBy}` : ""}`,
      tone: "blue",
      action: merge?.all.includes("cancel-auto") ? (
        <Button
          variant="soft"
          className={GIT_ACTION}
          onClick={() => merge.onChoose("cancel-auto")}
          disabled={merge.busy}
          title={MERGE_CHOICE_TITLE["cancel-auto"]}
        >
          {merge.busy ? "Cancelling…" : MERGE_CHOICE_SHORT["cancel-auto"]}
        </Button>
      ) : undefined,
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
  const notes =
    prompted || error ? (
      <>
        {prompted && (
          <div className={`${GIT_NOTE} text-faint`}>
            Asked {AGENT_NAME} to {prompted} ✓
          </div>
        )}
        {error && <div className={`${GIT_NOTE} text-red`}>{error}</div>}
      </>
    ) : null;
  return { rows, notes };
}

/**
 * Local/remote discrepancy rows for the Status card: each gets a line with one
 * action on the right. Push is a direct server-side `git push`; the judgment
 * calls (create the PR, resolve conflicts, update from base, commit stray
 * changes) prompt the session — the agent does the work, not a bare button.
 */
export function GitStatusRows(props: GitStatusRowsProps) {
  const { rows, notes } = useGitStatusRows(props);
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
      {notes}
    </>
  );
}

const MERGE_CHOICE_ICON: Record<MergeChoice, React.ReactNode> = {
  merge: <IconGitMerge size={18} className={MENU_ICON} />,
  auto: <IconClock size={18} className={MENU_ICON} />,
  "cancel-auto": <IconX size={18} className={MENU_ICON} />,
  force: <IconWarningTriangle size={18} className="text-red" />,
};

/**
 * The status row's merge action: the primary choice as a button, and the
 * rest (auto-merge, force merge) behind a chevron beside it. Cancelling
 * auto-merge has its own row, so the menu leaves it out.
 */
function MergeControl({
  merge,
  emphasis,
  merging,
  mergeScheduled,
  undo,
}: {
  merge: NonNullable<GitStatusRowsProps["merge"]>;
  emphasis?: boolean;
  merging?: boolean;
  mergeScheduled?: boolean;
  undo: React.ReactNode;
}) {
  const menu = merge.all.filter((c) => c !== "cancel-auto");
  const busy = merging || mergeScheduled;
  if (!merge.primary && !menu.length) return null;
  const primary = merge.primary;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {undo}
      {primary && (
        <Button
          variant={emphasis ? "success-strong" : "soft"}
          size={emphasis ? "sm" : undefined}
          className={emphasis ? "shrink-0" : GIT_ACTION}
          onClick={() => merge.onChoose(primary)}
          disabled={busy || (primary === "auto" && merge.busy)}
          title={MERGE_CHOICE_TITLE[primary]}
        >
          {busy
            ? "Merging…"
            : primary === "auto" && merge.busy
              ? "Turning on…"
              : MERGE_CHOICE_SHORT[primary]}
        </Button>
      )}
      {menu.length > (primary ? 1 : 0) && (
        <Menu.Root>
          <Menu.Trigger
            className={
              primary
                ? "-ml-0.5 grid size-6 shrink-0 place-items-center rounded-md text-faint transition-[color,background-color] hover:bg-hover hover:text-fg disabled:opacity-60 phone:size-9"
                : GIT_ACTION
            }
            aria-label="Merge options"
            title="Merge options"
            disabled={busy}
          >
            {primary ? (
              <IconChevronDown size={14} />
            ) : (
              <>
                Merge
                <IconChevronDown
                  size={14}
                  className="ml-1 shrink-0 opacity-55"
                />
              </>
            )}
          </Menu.Trigger>
          <Menu.Popup align="end" sideOffset={6} className="min-w-[200px]">
            {menu.map((choice) => (
              <Menu.Item
                key={choice}
                onClick={() => merge.onChoose(choice)}
                className={
                  choice === "force"
                    ? "text-red data-[highlighted]:bg-red-soft"
                    : undefined
                }
              >
                {MERGE_CHOICE_ICON[choice]}
                <span className="min-w-0 flex-1 truncate">
                  {MERGE_CHOICE_LABEL[choice]}
                </span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Root>
      )}
    </span>
  );
}
