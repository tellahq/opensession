/** A create may only join a workspace whose repository and checkout it uses. */
export function canJoinCreateWorkspace(
  workspace: { repo?: string; worktreeDir?: string; branch?: string },
  destination: {
    repo?: string;
    mode: "code" | "ask" | "scratch";
    /** PR asks read the PR worktree instead of the pinned Ask checkout. */
    fromPr?: boolean;
    branch?: string;
  },
): boolean {
  if ((workspace.repo || undefined) !== (destination.repo || undefined))
    return false;
  // Repo-less workspaces own a scratch directory which their sessions share.
  if (!workspace.repo && !workspace.branch) return true;
  if (!workspace.worktreeDir || destination.mode === "code") return true;
  return (
    destination.mode === "ask" &&
    destination.fromPr === true &&
    !!destination.branch &&
    destination.branch === workspace.branch
  );
}
