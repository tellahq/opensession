const LARGE_REVIEW_PATCH_LENGTH = 1_000_000;
const LARGE_REVIEW_FILE_COUNT = 100;
const MAX_AUTO_EXPANDED_LINES = 2_000;
const LOCK_FILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|go\.sum|flake\.lock|Podfile\.lock|Package\.resolved)$/;

/** Keep large reviews interactive instead of eagerly mounting every diff row. */
export function reviewDiffLoadPolicy(patchLength: number, fileCount: number) {
  const large =
    patchLength >= LARGE_REVIEW_PATCH_LENGTH ||
    fileCount >= LARGE_REVIEW_FILE_COUNT;
  return {
    defaultExpandedFiles: large ? 2 : Infinity,
    groupFiles: !large,
    allowExpandAll: !large,
  };
}

/** Machine-written and unusually large files stay collapsed until requested. */
export function canAutoExpandDiffFile(
  path: string,
  changedLines: number,
): boolean {
  return !LOCK_FILE.test(path) && changedLines <= MAX_AUTO_EXPANDED_LINES;
}
