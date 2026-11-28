import type { PreviewStatus } from "./api";

/**
 * The last preview status each session reported. The session viewer remounts
 * on every tab switch, so without this the header starts each visit with no
 * status and its Portal play button pops in a request later, shoving the
 * icons beside it over. Seeding from here draws the header as it was left;
 * the fetch on open then corrects anything that changed.
 */
const last = new Map<string, PreviewStatus>();
const LIMIT = 200;

export function lastPreviewStatus(sessionId: string): PreviewStatus | null {
  return last.get(sessionId) ?? null;
}

export function rememberPreviewStatus(
  sessionId: string,
  status: PreviewStatus | null,
): void {
  last.delete(sessionId);
  if (!status) return;
  last.set(sessionId, status);
  if (last.size > LIMIT) last.delete(last.keys().next().value!);
}
