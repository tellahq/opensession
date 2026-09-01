import { BASE_PATH } from "./base";

/**
 * Transcript v2 (docs/transcripts.md §1): entries whose serialized
 * form exceeds 32KB are stored with each images[] data-URL replaced by an
 * "os-blob:<entryId>/<i>" marker. The real bytes stay readable through the
 * transcript-image route, which falls back to the store's full entry when the
 * mirror can't resolve the image.
 *
 * This rewrites marker srcs to that route; every non-marker src (http(s),
 * data:, media paths) passes through untouched — so legacy transcripts, old
 * bundles and old servers are all unaffected.
 */
const OS_BLOB_RE = /^os-blob:(.+)\/(\d+)$/;

export function resolveEntryImageSrc(src: string, sessionId?: string): string {
  const m = OS_BLOB_RE.exec(src);
  if (!m || !sessionId) return src;
  return `${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/transcript-image/${encodeURIComponent(m[1])}/${m[2]}`;
}
