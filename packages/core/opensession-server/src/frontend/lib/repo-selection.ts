/**
 * The New-session repo picker's selection when a session works in more than
 * one repo.
 *
 * The selection is an ORDERED list, not a set: the first repo is the session's
 * own — its worktree, its branch, where the agent starts — and the rest are
 * attached beside it as isolated worktrees on the same branch (the server's
 * `attachedRepos`). So "remove the first one" means the next in line takes over
 * as the session's repo rather than the session losing its footing.
 *
 * The rules live here rather than in the palette because they are the part
 * worth testing on its own; the palette only decides which rows may join.
 */

export interface RepoSelection {
  /** The session's own repo. */
  repo: string;
  /** Repos attached beside it, in the order they were added. */
  extras: string[];
}

/**
 * Add or remove a repo from the selection (the picker's modifier-click).
 *
 * Removing the session's own repo promotes the first attached one in its
 * place; removing the last remaining repo is refused, because a picker with
 * nothing picked has no meaning here — "No repo" is its own row.
 */
export function toggleRepoSelection(
  selection: RepoSelection,
  id: string,
): RepoSelection {
  const { repo, extras } = selection;
  if (id === repo)
    return extras.length
      ? { repo: extras[0], extras: extras.slice(1) }
      : selection;
  if (extras.includes(id))
    return { repo, extras: extras.filter((item) => item !== id) };
  return { repo, extras: [...extras, id] };
}

/**
 * The picker's footer line. It names the repos once there is more than one —
 * the trigger only has room for the session's own repo and a count — and
 * otherwise teaches the gesture, which nothing else on screen can show.
 */
export function repoSelectionHint(
  extras: string[],
  labelFor: (id: string) => string,
  modifier: string,
): string {
  if (!extras.length) return `${modifier}-click to work in more than one repo.`;
  return `Also working in ${joinWithAnd(extras.map(labelFor))}.`;
}

/** "a", "a and b", "a, b and c" — the list voice used in prose, not a table. */
function joinWithAnd(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
