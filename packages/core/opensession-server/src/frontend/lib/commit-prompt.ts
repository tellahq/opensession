/**
 * What the "Commit" action in the Git status rows asks the session to do.
 *
 * On a per-session worktree the working tree is the session's own, so "commit
 * the uncommitted files" is unambiguous. On a shared checkout it is not: the
 * tree carries every concurrent session's in-flight edits, and staging it would
 * ship their half-finished work under this session's message. The count is
 * already scoped to the files this session wrote, so the prompt names them and
 * says plainly that nothing else may be staged.
 */
export function commitPrompt(
  dirty: number,
  sharedCheckout?: boolean,
  paths?: string[],
): string {
  const files = `${dirty} uncommitted file${dirty === 1 ? "" : "s"}`;
  if (!sharedCheckout || !paths?.length) {
    return `Commit the ${files} in this worktree with a clear, descriptive message, then push.`;
  }
  const list = paths.map((p) => `- ${p}`).join("\n");
  return [
    `Commit your ${files} with a clear, descriptive message, then push.`,
    "",
    "This is a shared checkout. Other sessions have their own uncommitted",
    "work in the same tree. Commit ONLY these paths, and do not run",
    "`git add -A`, `git reset`, or anything else that touches the rest of the",
    "tree or another session's staged entries:",
    list,
  ].join("\n");
}
