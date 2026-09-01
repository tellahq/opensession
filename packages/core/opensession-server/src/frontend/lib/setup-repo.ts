/**
 * Resolve the default branch across the setup-status and repository payloads.
 *
 * During a backend upgrade the hot-rebuilt frontend can briefly receive the
 * older setup-status shape, which did not include `defaultBranch`. `/api/repos`
 * already carried it, so use that payload as the compatibility fallback. An
 * empty string keeps the settings page usable until either request catches up.
 */
export function setupRepoDefaultBranch(
  setup: { defaultBranch?: string },
  repository?: { defaultBranch?: string },
): string {
  return setup.defaultBranch || repository?.defaultBranch || "";
}
