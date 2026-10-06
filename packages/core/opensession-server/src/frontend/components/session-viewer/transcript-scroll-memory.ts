/** Where a reader left a session's transcript when they were not at the live
 * edge. `anchorEid` is the entry at the top of the viewport and `anchorTop`
 * its offset from the scroller's top edge; `scrollTop` places the reader
 * close by while that row's virtual slot mounts. */
export type TranscriptScrollPosition = {
  anchorEid: string | null;
  anchorTop: number;
  scrollTop: number;
};

// Positions are tiny, so this outlives the transcript view LRU: a session
// whose transcript was evicted still reopens where the reader left it.
const positions = new Map<string, TranscriptScrollPosition>();
const TRANSCRIPT_SCROLL_MEMORY_MAX = 200;

export function rememberedTranscriptScroll(
  sessionId: string,
): TranscriptScrollPosition | null {
  return positions.get(sessionId) ?? null;
}

/** `null` means the reader is at the live edge, which is the default. */
export function rememberTranscriptScroll(
  sessionId: string,
  position: TranscriptScrollPosition | null,
) {
  positions.delete(sessionId);
  if (!position) return;
  positions.set(sessionId, position);
  while (positions.size > TRANSCRIPT_SCROLL_MEMORY_MAX) {
    const oldest = positions.keys().next().value;
    if (oldest === undefined) break;
    positions.delete(oldest);
  }
}

// A few hit-tests near the top of the viewport instead of reading a rect per
// transcript row. Several columns cover right-aligned bubbles and gaps
// between rows; elementsFromPoint sees through overlays such as the phone
// top bar, which sits above the scroller.
const SAMPLE_XS = [0.5, 0.25, 0.75];
const SAMPLE_YS = [8, 40, 96, 160];

export function pickViewportAnchor(container: HTMLElement): HTMLElement | null {
  const rect = container.getBoundingClientRect();
  for (const dy of SAMPLE_YS) {
    if (dy >= rect.height) break;
    for (const fx of SAMPLE_XS) {
      const hits = document.elementsFromPoint(
        rect.left + rect.width * fx,
        rect.top + dy,
      );
      for (const hit of hits) {
        if (!container.contains(hit)) continue;
        const entry = hit.closest<HTMLElement>("[data-eid]");
        if (entry && container.contains(entry)) return entry;
        break;
      }
    }
  }
  return null;
}

export function captureTranscriptScroll(
  container: HTMLElement,
): TranscriptScrollPosition {
  const anchor = pickViewportAnchor(container);
  return {
    anchorEid: anchor?.dataset.eid ?? null,
    anchorTop: anchor
      ? anchor.getBoundingClientRect().top -
        container.getBoundingClientRect().top
      : 0,
    scrollTop: container.scrollTop,
  };
}
