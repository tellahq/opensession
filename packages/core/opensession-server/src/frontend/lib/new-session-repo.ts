import { canJoinCreateWorkspace } from "../../shared/session-create-workspace";
import { NO_REPO } from "./session-repo";

/** Pick the real repository shown by a fresh composer. */
export function newSessionDefaultRepo(
  options: ReadonlyArray<{ id: string; default?: boolean }>,
  workspaceChoice: string,
): string {
  if (options.length === 0) return NO_REPO;
  return (
    (options.some((option) => option.id === workspaceChoice)
      ? workspaceChoice
      : "") ||
    options.find((option) => option.default)?.id ||
    options[0].id
  );
}

/** A list refresh must not undo an explicit choice, including a newly registered repo. */
export function refreshedNewSessionRepo(
  current: string,
  options: ReadonlyArray<{ id: string }>,
  fallback: string,
  scopedRepo?: string,
): string {
  if (current === NO_REPO || options.some((option) => option.id === current))
    return current;
  if (scopedRepo && options.some((option) => option.id === scopedRepo))
    return scopedRepo;
  return fallback;
}

/** Workspace and branch defaults belong only to that workspace's project. */
export function newSessionWorkspaceScope(
  repo: string,
  scope: { repo?: string; workspaceId?: string; forceBranch?: string },
): { workspaceId?: string; forceBranch?: string } {
  return (scope.repo || NO_REPO) === repo
    ? { workspaceId: scope.workspaceId, forceBranch: scope.forceBranch }
    : {};
}

/** Reject known-incompatible destinations; the active list is not exhaustive. */
export function newSessionWorkspaceDestination(
  workspaces: ReadonlyArray<{
    id: string;
    repo?: string;
    worktreeDir?: string;
    branch?: string;
  }>,
  workspaceId: string | undefined,
  repo: string,
  mode: "code" | "ask" | "scratch",
  pullRequest?: { branch: string } | null,
): string | undefined {
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return workspaceId;
  return canJoinCreateWorkspace(workspace, {
    repo: repo === NO_REPO ? undefined : repo,
    mode,
    fromPr: !!pullRequest,
    branch: pullRequest?.branch,
  })
    ? workspace.id
    : undefined;
}
