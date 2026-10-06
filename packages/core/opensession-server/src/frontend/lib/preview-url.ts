/**
 * Append a session's agent-recorded `previewPath` to a base URL (the local
 * Preview origin or the PR's preview environment) so a click lands directly on the
 * feature under test. `path` is stored root-relative (leading slash) but we
 * normalize defensively. Falsy path → the base URL unchanged.
 */
export function withPreviewPath(base: string, path?: string | null): string {
  if (!path) return base;
  const rel = "/" + String(path).replace(/^\/+/, "");
  if (rel === "/") return base;
  return base.replace(/\/+$/, "") + rel;
}

/**
 * Whether a PR preview environment's link opens a working deploy. A first
 * build has nothing behind the branch alias yet (it 404s); a rebuild keeps
 * serving the previous deploy, which the server reports as `live`.
 */
export function previewOpenable(staging: {
  status: string;
  live?: boolean;
}): boolean {
  return staging.status === "Ready" || staging.live === true;
}

/**
 * The PR preview environment link: the session's recorded route when it has
 * one, else the deployment's configured landing route, else the root.
 */
export function stagingHref(
  staging: { url: string; defaultPath?: string },
  previewPath?: string | null,
): string {
  return withPreviewPath(staging.url, previewPath || staging.defaultPath);
}
