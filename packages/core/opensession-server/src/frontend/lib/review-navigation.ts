/** Navigation wraps only when looking for unfinished work, not between adjacent files. */
export function adjacentReviewFile(
  paths: readonly string[],
  active: string | null,
  direction: -1 | 1,
): string | null {
  const index = active === null ? -1 : paths.indexOf(active);
  if (index < 0) return direction === 1 ? (paths[0] ?? null) : null;
  return paths[index + direction] ?? null;
}

export function nextUnreviewedFile(
  paths: readonly string[],
  active: string | null,
  reviewed: ReadonlySet<string>,
): string | null {
  const index = active === null ? -1 : paths.indexOf(active);
  for (let step = 1; step <= paths.length; step++) {
    const path = paths[(index + step) % paths.length];
    if (!reviewed.has(path)) return path;
  }
  return null;
}

/** Drafts accept feedback; only merging depends on readiness. */
export function canCommentOnReview(
  state: string | undefined,
  supportsComments: boolean,
): boolean {
  return state === "OPEN" && supportsComments;
}
