import type { TranscriptIndexedRange } from "../../lib/transcript-index";

export interface TranscriptHydrationOutlineItem {
  key: string;
  ranges: readonly TranscriptIndexedRange[];
}

/** A rendered decoration does not make its surrounding indexed history loaded. */
export function transcriptRangesContainPayload(
  ranges: readonly TranscriptIndexedRange[],
  hasPayload: (entryId: string) => boolean,
): boolean {
  return ranges.some((range) => range.entryIds.some(hasPayload));
}

/**
 * Missing payload can move the opening viewport only when it belongs to a row
 * the virtualizer actually reports as visible. Unloaded ranges occupy no
 * placeholder space, so two adjacent visible rows may be thousands of outline
 * entries apart. Treating that compacted gap as visible used to hydrate the
 * transcript from seq 1 forward on a cold open, growing the scrollbar and
 * briefly painting old rows in the current viewport after every response.
 *
 * A visible row whose loaded payload is a suffix is also already stable: the
 * bounded opening request cut into that row, so every missing entry belongs
 * above what the reader can see. The explicit top-approach path hydrates that
 * prefix when the reader asks for earlier history. This holds across a row's
 * ranges, not just within one: a check-back group is a single row that runs
 * from the request that started a task through every check-back since, so on
 * a session that has waited on CI for hours its older ranges hold thousands
 * of entries. Demanding them kept the opening curtain down until all of them
 * arrived. Only payload missing after the row's first loaded entry is a gap
 * the reader would see.
 *
 * `null` means the virtualizer has not reported a usable window yet. An empty
 * array means the real visible rows are safe to reveal.
 */
export function visibleTranscriptHydrationDemand(
  outline: readonly TranscriptHydrationOutlineItem[],
  visibleKeys: ReadonlySet<string>,
  hasPayload: (entryId: string) => boolean,
): TranscriptIndexedRange[] | null {
  if (!outline.some((item) => visibleKeys.has(item.key))) return null;

  const wanted: TranscriptIndexedRange[] = [];
  const seen = new Set<string>();
  for (const item of outline) {
    if (!visibleKeys.has(item.key)) continue;
    // A row with no payload at all has nothing to anchor a suffix to.
    let reachedLoaded = !item.ranges.some((range) =>
      range.entryIds.some(hasPayload),
    );
    for (const range of item.ranges) {
      let missingBelowLoaded = false;
      for (const id of range.entryIds) {
        if (hasPayload(id)) reachedLoaded = true;
        else if (reachedLoaded) {
          missingBelowLoaded = true;
          break;
        }
      }
      if (!missingBelowLoaded) continue;
      const key = `${range.firstSeq}:${range.lastSeq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push(range);
    }
  }
  return wanted;
}
