import { DEFAULT_REPO_ID } from "./brand";
import { isAutomationSession } from "./landing-session";
import {
  prBranchKey,
  prLookupKeys,
  prNumberKey,
  sessionCarriesPr,
} from "./session-prs";
import type { UnifiedSession, Workspace } from "./types";

type PrIdentity = { repo: string; number?: number; branch?: string };

/** Whether the workspace record itself identifies this PR. */
export function workspaceCarriesPr(
  workspace: Workspace,
  pr: PrIdentity,
): boolean {
  const carried = workspaceCarriedPrKeys(workspace);
  return prLookupKeys(pr).some((key) => carried.includes(key));
}

/** The `prLookupKeys` a workspace record answers to; see `workspaceCarriesPr`. */
export function workspaceCarriedPrKeys(workspace: Workspace): string[] {
  const repo = workspace.repo || DEFAULT_REPO_ID;
  const keys: string[] = [];
  if (workspace.prNumber != null)
    keys.push(prNumberKey(repo, workspace.prNumber));
  if (workspace.branch) keys.push(prBranchKey(repo, workspace.branch));
  return keys;
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
  // Newest first: the same preference the server's session lookup uses, so a
  // PR reopened in a later session lands where the server would put it.
  // Only workspaces this client can actually render count. Navigating to an
  // id the list has not caught up with would trade the spinner for a
  // "Workspace not found", which is worse.
  const carriers = [...sessions]
    .filter(
      (s) =>
        !s.archived &&
        !!s.workspaceId &&
        workspaces.some((w) => w.id === s.workspaceId) &&
        sessionCarriesPr(s, pr),
    )
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  // The conversation a person had about this PR. A session that opened it in
  // a repo it never attached carries it only through the PR's footer, while a
  // review run may already have filed the PR under a workspace of its own.
  const person = carriers.find((s) => !isAutomationSession(s));
  const hasPerson = (workspaceId: string) =>
    sessions.some(
      (s) =>
        !s.archived && s.workspaceId === workspaceId && !isAutomationSession(s),
    );
  const record =
    (pr.number !== undefined
      ? // A number-only record (minted before its branch was known) has no
        // Review to open. Let the server resolve it, which fills the branch in.
        workspaces.find(
          (workspace) =>
            !!workspace.branch &&
            workspaceCarriesPr(workspace, { repo: pr.repo, number: pr.number }),
        )
      : undefined) ??
    (pr.branch
      ? workspaces.find((workspace) =>
          workspaceCarriesPr(workspace, { repo: pr.repo, branch: pr.branch }),
        )
      : undefined);
  if (record) {
    // An empty PR workspace gives way to the session that opened the PR.
    return person?.workspaceId && !hasPerson(record.id)
      ? person.workspaceId
      : record.id;
  }
  return (person ?? carriers[0])?.workspaceId ?? null;
}
