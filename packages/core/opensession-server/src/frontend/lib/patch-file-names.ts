/**
 * The paths a unified patch carries, read off its `diff --git` headers. The
 * workspace summary decides which file rows open a preview before the diff
 * renderer, which parses the patch for real, has loaded.
 */
export function patchFileNames(patch: string): Set<string> {
  const names = new Set<string>();
  for (const match of patch.matchAll(
    /^diff --git "?a\/.*?"? "?b\/(.+?)"?$/gm,
  )) {
    names.add(match[1]);
  }
  return names;
}
