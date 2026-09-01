/** A worktree root paths can render relative to (label = attached-repo id). */
export type PathRoot = { dir: string; label?: string };

/**
 * Shorten a path for display: inside one of the session's worktrees it renders
 * repo-relative (an attached repo keeps a "<project>:" prefix so it stays
 * unambiguous); anything outside them just collapses $HOME to "~".
 */
export function tidyPath(p: string, roots: readonly PathRoot[] = []): string {
  if (!p) return "";
  for (const root of roots) {
    if (!root.dir) continue;
    if (p === root.dir) return root.label ? `${root.label}:.` : ".";
    if (p.startsWith(`${root.dir}/`)) {
      const rel = p.slice(root.dir.length + 1);
      return root.label ? `${root.label}:${rel}` : rel;
    }
  }
  return p.replace(/^\/home\/[^/]+\//, "~/");
}
