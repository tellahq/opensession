/**
 * In-memory measured heights for transcript blocks — the "pretext" that lets a
 * reopened chat start at its true size instead of an outline guess.
 *
 * On open, the virtualizer seeds every block from `lib/transcript-index.ts`
 * heuristics and corrects them as rows mount and measure. Each correction
 * moves content, so a transcript whose estimates are wrong visibly shifts
 * while it settles. Blocks of settled history never change height between
 * visits, so remembering what they actually measured last time and feeding
 * those numbers back as the next visit's first estimate removes nearly all of
 * that correction on reopen.
 *
 * The cache lives in memory only: heights are plain ints, a few hundred KB at
 * the cap, so they survive session switches for as long as the page is open
 * and vanish with it. Two things invalidate a session's numbers — the page
 * closing, and the session layer changing width, because every height measured
 * at one width is wrong at another. `recordTranscriptSizes` watches the width
 * each row reports and clears the cache the moment it drifts, so no separate
 * breakpoint bookkeeping is needed.
 */

// Row widths jitter by a pixel with scrollbar and rounding noise; anything
// past this is a real reflow of the session layer.
const WIDTH_EPSILON_PX = 2;
// Sessions kept at once, least-recently-used dropped first.
const MAX_SESSIONS = 16;

export interface TranscriptSizes {
  /** Layer width the heights were measured at; 0 until the first record. */
  width: number;
  blockHeights: Map<string, number>;
}

const caches = new Map<string, TranscriptSizes>();

/**
 * The cache for one session, created empty on first touch. Insertion order
 * doubles as recency: loads move the session to the newest slot, and the
 * oldest falls out beyond {@link MAX_SESSIONS}.
 */
export function loadTranscriptSizes(sessionId: string): TranscriptSizes {
  const existing = caches.get(sessionId);
  if (existing) {
    caches.delete(sessionId);
    caches.set(sessionId, existing);
    return existing;
  }
  const fresh: TranscriptSizes = { width: 0, blockHeights: new Map() };
  caches.set(sessionId, fresh);
  while (caches.size > MAX_SESSIONS) {
    const oldest = caches.keys().next().value;
    if (oldest === undefined) break;
    caches.delete(oldest);
  }
  return fresh;
}

/**
 * Merge freshly measured heights into a session's cache. `width` is the layer
 * width the rows were measured at; when it drifts from what the cache holds,
 * every stored height is stale, so the cache empties and adopts the new width.
 */
export function recordTranscriptSizes(
  cache: TranscriptSizes,
  width: number,
  measured: ReadonlyArray<readonly [string, number]>,
): void {
  if (!Number.isFinite(width) || width <= 0 || measured.length === 0) return;
  if (cache.width && Math.abs(cache.width - width) > WIDTH_EPSILON_PX) {
    cache.blockHeights.clear();
  }
  cache.width = width;
  for (const [key, size] of measured) {
    if (Number.isFinite(size) && size > 0) {
      cache.blockHeights.set(key, Math.round(size));
    }
  }
}

/** Empty the whole store; exists so tests start from a known slate. */
export function resetTranscriptSizes(): void {
  caches.clear();
}

/**
 * The virtualizer's first-guess height for a block: the height it really
 * measured on the last visit when we have one, otherwise the outline
 * heuristic. A seed only stands in until measurement replaces it, so a stale
 * seed behaves exactly like a stale heuristic.
 */
export function seededBlockEstimate(
  heuristic: number,
  seeded: TranscriptSizes | undefined,
  blockKey: string,
): number {
  const cached = seeded?.blockHeights.get(blockKey);
  return cached !== undefined && cached > 0 ? cached : heuristic;
}
