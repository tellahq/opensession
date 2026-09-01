import type { Workspace } from "./types";

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
): {
  mode: "ask" | "code" | "scratch";
  branch: string;
  repo?: string;
  fromPr?: true;
} {
  if (workspace.branch) {
    return {
      mode: "code",
      branch: workspace.branch,
      ...(workspace.repo ? { repo: workspace.repo } : {}),
      fromPr: true,
    };
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
  return {
    mode: "ask",
    branch: "",
    ...(workspace.repo ? { repo: workspace.repo } : {}),
  };
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
): { draft: Workspace["draft"] | null } {
  if (!text.trim()) return { draft: null };
  return {
    draft: {
      text,
      updatedAt,
      ...(by !== undefined ? { by } : {}),
      ...(autoName !== undefined ? { autoName } : {}),
    },
  };
}
