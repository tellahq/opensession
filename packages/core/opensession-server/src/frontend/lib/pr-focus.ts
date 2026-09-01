/**
 * Which PR the review canvas shows, when a workspace carries several.
 *
 * A workspace is not one PR: a session opens one on its own branch, more
 * through attached repos, and can link or have discovered others. PrPanel
 * turns those into selectable targets and defaults to the primary one — so
 * anything that means "open THAT PR" (a sidebar PR row, a `repo#123` chip in
 * a transcript) has to name it, or the review opens on the wrong diff.
 *
 * The naming is deliberately loose because the callers know different things.
 * A sidebar row has repo + branch; a prose chip has only repo + number, and
 * the server can only fill in the branch for PRs its caches cover. Matching
 * therefore tries the identifiers in order of how specific they are, and ends
 * on the repo alone, which is what the primary/attached targets are keyed by.
 */

/**
 * One selectable PR in the panel: the primary repo's, an attached repo's, or a
 * manually linked one. Primary/attached target by repo id (the server resolves
 * the branch); linked PRs carry an explicit branch since they can live on any
 * branch — including another branch of the primary repo.
 */
export interface PrTarget {
  key: string;
  repo: string;
  branch?: string;
  /** Known for linked/discovered PRs; primary and attached ones resolve
   *  their branch server-side and never carry it. */
  number?: number;
  primary?: boolean;
  linked?: boolean;
  /** Found via the session link in the PR body, not stored on the session. */
  discovered?: boolean;
  label: string;
}

/**
 * The PR a caller asked the review to open on. `seq` is bumped per request so
 * clicking the same chip again re-focuses it after the reader has switched
 * targets by hand.
 */
export interface PrFocus {
  repo?: string;
  branch?: string;
  number?: number;
  view?: "checks";
  seq: number;
}

/** First target per key wins — a PR reached two ways (linked and discovered,
 *  or an attached repo whose branch also carries a discovered PR) is one tab. */
export function dedupeTargets(targets: PrTarget[]): PrTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    // An attached/primary repo tab has no branch of its own (the server
    // resolves it), so it can't collide with a branch-keyed target.
    const key = t.branch ? `${t.repo}\u0000${t.branch}` : `repo:${t.repo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The target a focus request names, or undefined when this panel doesn't
 * offer it (yet — the caller should ask again once the list has grown).
 *
 * Number beats branch: a chip in prose only ever carries a number, and the
 * branch the server hands back for it can be stale. The repo-only fallback is
 * what lands a focus on the primary PR, which is right both when the named PR
 * IS the primary one (whose target holds no number to match) and when the
 * panel simply has one PR for that repo.
 */
export function matchFocusTarget(
  targets: PrTarget[],
  focus: Pick<PrFocus, "repo" | "branch" | "number">,
): PrTarget | undefined {
  if (!focus.repo) return undefined;
  const inRepo = targets.filter((t) => t.repo === focus.repo);
  return (
    (focus.number !== undefined
      ? inRepo.find((t) => t.number === focus.number)
      : undefined) ??
    inRepo.find((t) =>
      focus.branch ? t.branch === focus.branch : !t.branch,
    ) ??
    inRepo[0]
  );
}
