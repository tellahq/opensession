import type { TranscriptEntry } from "./types";
/** The latest audit marker carries the actor's complete active range set, so
 * a paged client can dim earlier rows even when older markers are unloaded. */
export function revertedEntryIds(
  entries: readonly TranscriptEntry[],
): Set<string> {
  const latest = entries
    .filter((entry) => entry.turnRevert?.activeRanges !== undefined)
    .at(-1)?.turnRevert;
  const ranges = latest?.activeRanges;
  return new Set(
    entries
      .filter(
        (entry) =>
          !entry.turnRevert &&
          (ranges
            ? entry.seq !== undefined &&
              ranges.some(
                (range) =>
                  entry.seq! >= range.fromSeq && entry.seq! <= range.toSeq,
              )
            : entry.reverted),
      )
      .map((entry) => entry.id),
  );
}
