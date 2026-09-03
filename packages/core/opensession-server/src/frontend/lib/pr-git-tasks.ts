import { useState } from "react";
import { getCurrentUser } from "../components/UserPicker";
import { gitPushApi } from "./api";
import { commitPrompt } from "./commit-prompt";
import { deriveStatus } from "./pr-status-derive";
import type { GitStatusInfo, PrDetails, WSClientMessage } from "./types";
import { errorMessage } from "./error-message";

/**
 * The local/remote work a branch still owes: conflicts to resolve, base
 * commits to pull, local commits to push, a dirty tree to commit. Shared by
 * the workspace panel's Git status rows and the review canvas's divergence
 * strip so both name the task — and ask the agent for it — identically.
 *
 * Push is a direct server-side `git push`; the judgment calls (resolve
 * conflicts, update from base, commit stray changes) prompt the session —
 * the agent does the work, not a bare button.
 */
/** Status-dot colours for a Git status row — the state, not a step marker. */
export type GitDotTone =
  | "green"
  | "yellow"
  | "red"
  | "blue"
  | "purple"
  | "muted";

export type GitTask = {
  key: "conflicts" | "behind" | "ahead" | "dirty";
  label: string;
  action: string;
  tone: Extract<GitDotTone, "red" | "yellow" | "blue">;
  run: "push" | { label: string; prompt: string };
};

export function gitTasks(
  git: GitStatusInfo | null,
  pr: PrDetails | null,
  base: string,
): GitTask[] {
  const tasks: GitTask[] = [];
  if (pr && deriveStatus(pr).key === "conflicts")
    tasks.push({
      key: "conflicts",
      label: `Conflicts with ${base}`,
      action: "Resolve",
      tone: "red",
      run: {
        label: "resolve the conflicts",
        prompt: `The PR has merge conflicts with ${base}. Rebase this branch on the latest origin/${base}, resolve the conflicts, and push.`,
      },
    });
  // Only a real feature branch can be behind its base, and a merged PR has
  // stopped caring.
  if (
    git &&
    git.branch &&
    git.branch !== base &&
    pr?.state !== "MERGED" &&
    git.behindBase > 0
  )
    tasks.push({
      key: "behind",
      label: `${git.behindBase} commit${git.behindBase === 1 ? "" : "s"} behind ${base}`,
      action: "Pull",
      tone: "yellow",
      run: {
        label: `update from ${base}`,
        prompt: `Update this branch with the latest origin/${base} (rebase preferred), resolve any conflicts, and push.`,
      },
    });
  if (git && git.ahead > 0)
    tasks.push({
      key: "ahead",
      label: `${git.ahead} commit${git.ahead === 1 ? "" : "s"} ahead of remote`,
      action: "Push",
      tone: "blue",
      run: "push",
    });
  if (git && git.uncommittedFiles > 0)
    tasks.push({
      key: "dirty",
      label: `${git.uncommittedFiles} uncommitted file${git.uncommittedFiles === 1 ? "" : "s"}`,
      action: "Commit",
      tone: "yellow",
      run: {
        label: "commit the changes",
        prompt: commitPrompt(
          git.uncommittedFiles,
          git.sharedCheckout,
          git.uncommittedPaths,
        ),
      },
    });
  return tasks;
}

/** Runs a {@link GitTask} and holds the transient push/prompt/error feedback. */
export function useGitTaskRunner({
  sessionId,
  repo,
  send,
  onRefresh,
}: {
  sessionId: string;
  repo?: string;
  send?: (msg: WSClientMessage) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const [pushing, setPushing] = useState(false);
  const [prompted, setPrompted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function promptSession(label: string, content: string) {
    if (!send) return;
    send({ type: "prompt", sessionId, user: getCurrentUser(), content });
    setPrompted(label);
    setTimeout(() => setPrompted(null), 6000);
  }

  async function push() {
    if (pushing) return;
    setPushing(true);
    setError(null);
    try {
      await gitPushApi(sessionId, repo);
      await onRefresh();
    } catch (error) {
      setError(errorMessage(error, "Push failed"));
    }
    setPushing(false);
  }

  function run(task: GitTask) {
    if (task.run === "push") void push();
    else promptSession(task.run.label, task.run.prompt);
  }

  /** A prompt-driven task needs a live session socket; Push never does. */
  function runnable(task: GitTask) {
    return task.run === "push" || !!send;
  }

  return { run, runnable, promptSession, pushing, prompted, error };
}
