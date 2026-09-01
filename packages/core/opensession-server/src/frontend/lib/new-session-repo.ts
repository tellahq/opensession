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
