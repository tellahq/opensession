import type { Workspace } from "./types";

type WorkspaceComposerTarget = {
  mode: "ask" | "code" | "scratch";
  branch: string;
  repo?: string;
  fromPr?: true;
};

type WorkspaceDraftPatch = {
  draft: Workspace["draft"] | null;
};

/** Fallback branch name when a parked draft did not save a branch choice. */
export function fallbackBranchName(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
  return slug || "new-session";
}

/** Resolve the first session started from a sessionless workspace composer. */
export function workspaceComposerTarget(
  workspace: Pick<Workspace, "branch" | "draft" | "externalRefs" | "repo">,
  prompt: string,
): WorkspaceComposerTarget {
  if (workspace.branch) {
    const target: WorkspaceComposerTarget = {
      mode: "code",
      branch: workspace.branch,
      fromPr: true,
    };
    if (workspace.repo) target.repo = workspace.repo;
    return target;
  }
  if (workspace.draft && workspace.repo) {
    return {
      mode: "code",
      branch: fallbackBranchName(prompt),
      repo: workspace.repo,
    };
  }
  if (workspace.externalRefs?.length && !workspace.repo)
    return { mode: "scratch", branch: "" };
  const target: WorkspaceComposerTarget = { mode: "ask", branch: "" };
  if (workspace.repo) target.repo = workspace.repo;
  return target;
}

/**
 * Turn the workspace composer's current text into the server patch it owns.
 * A blank composer is the absence of a draft, not a draft-shaped empty value.
 */
export function workspaceDraftPatch(
  text: string,
  updatedAt: string,
  by?: string,
  autoName?: boolean,
): WorkspaceDraftPatch {
  if (!text.trim()) return { draft: null };
  const draft: NonNullable<Workspace["draft"]> = { text, updatedAt };
  if (by !== undefined) draft.by = by;
  if (autoName !== undefined) draft.autoName = autoName;
  return { draft };
}
