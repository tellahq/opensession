import type { UnifiedSession } from "./types";

export function sessionHasWorkspace(
  session: Pick<UnifiedSession, "branch" | "worktreeDir">,
): boolean {
  return Boolean(session.worktreeDir || session.branch);
}
