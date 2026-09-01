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
