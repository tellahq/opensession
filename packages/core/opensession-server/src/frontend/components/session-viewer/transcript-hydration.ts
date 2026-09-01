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

/** The bounded opening payload may cut into a range and leave a loaded suffix.
 * Only that shape inserts later hydration at the start of an existing row.
 * Normal range pagination starts at firstSeq and appends at the row's end. */
export function transcriptRangeHasLoadedSuffix(
  entryIds: readonly string[],
  hasPayload: (entryId: string) => boolean,
): boolean {
  const firstLoaded = entryIds.findIndex(hasPayload);
  return (
    firstLoaded > 0 && entryIds.slice(firstLoaded).every((id) => hasPayload(id))
  );
}

/**
 * Missing payload can move the opening viewport only when it belongs to a row
 * the virtualizer actually reports as visible. Unloaded ranges occupy no
 * placeholder space, so two adjacent visible rows may be thousands of outline
 * entries apart. Treating that compacted gap as visible used to hydrate the
 * transcript from seq 1 forward on a cold open, growing the scrollbar and
 * briefly painting old rows in the current viewport after every response.
 *
 * A visible range whose loaded payload is a suffix is also already stable: the
 * bounded opening request cut into that range, so every missing entry belongs
 * above what the reader can see. The explicit top-approach path hydrates that
 * prefix when the reader asks for earlier history.
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
    for (const range of item.ranges) {
      if (range.entryIds.every(hasPayload)) continue;
      const firstLoaded = range.entryIds.findIndex(hasPayload);
      if (
        firstLoaded > 0 &&
        range.entryIds.slice(firstLoaded).every(hasPayload)
      )
        continue;
      const key = `${range.firstSeq}:${range.lastSeq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push(range);
    }
  }
  return wanted;
}
