import { DEFAULT_REPO_ID } from "./brand";
import { sessionCarriesPr } from "./session-prs";
import type { UnifiedSession, Workspace } from "./types";

type PrIdentity = { repo: string; number?: number; branch?: string };

/** Whether the workspace record itself identifies this PR. */
export function workspaceCarriesPr(
  workspace: Workspace,
  pr: PrIdentity,
): boolean {
  const repo = workspace.repo || DEFAULT_REPO_ID;
  if (repo !== pr.repo) return false;
  return (
    (pr.number !== undefined && workspace.prNumber === pr.number) ||
    (!!pr.branch && workspace.branch === pr.branch)
  );
}

/**
 * Which workspace a PR belongs to, answered from what the app already holds.
 *
 * The server owns resolution (workspace-resolve.ts) because only it can mint a
 * workspace for a PR nobody has opened yet. But most PRs a link names are ones
 * this browser already knows about: the workspace list carries `prNumber` and
 * `branch`, and the session list says which sessions carry which PRs. Matching
 * those first is what lets a `repo#123` link open as a Review tab in place,
 * instead of spending a network round-trip on a full-view spinner.
 *
 * Mirrors the first two lookup steps the server does (dedupe key, then the
 * newest PR-matching session's workspace) and stops there: minting is the
 * server's job, so an unknown PR returns null and the caller asks it.
 */
export function findPrWorkspaceId(
  workspaces: Workspace[],
  sessions: UnifiedSession[],
  pr: PrIdentity,
): string | null {
  if (pr.number !== undefined) {
    const byNumber = workspaces.find((workspace) =>
      workspaceCarriesPr(workspace, { repo: pr.repo, number: pr.number }),
    );
    if (byNumber) return byNumber.id;
  }
  if (pr.branch) {
    const byBranch = workspaces.find((workspace) =>
      workspaceCarriesPr(workspace, { repo: pr.repo, branch: pr.branch }),
    );
    if (byBranch) return byBranch.id;
  }
  // Newest first: the same preference the server's session lookup uses, so a
  // PR reopened in a later session lands where the server would put it.
  const carrier = [...sessions]
    .filter((s) => !s.archived && !!s.workspaceId && sessionCarriesPr(s, pr))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
  const id = carrier?.workspaceId;
  // Only answer with a workspace this client can actually render. Navigating
  // to an id the list has not caught up with would trade the spinner for a
  // "Workspace not found", which is worse.
  return id && workspaces.some((w) => w.id === id) ? id : null;
}
