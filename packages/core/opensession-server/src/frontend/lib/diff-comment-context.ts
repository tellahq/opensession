import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";

/** Patch arrays omit gaps between hunks, so map real line numbers per hunk. */
export function diffCommentContext(
  file: FileDiffMetadata,
  range: SelectedLineRange,
) {
  const removed = range.side === "deletions";
  const lines = removed ? file.deletionLines : file.additionLines;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const result: { number: number; text: string }[] = [];
  for (const hunk of file.hunks) {
    const first = removed ? hunk.deletionStart : hunk.additionStart;
    const count = removed ? hunk.deletionCount : hunk.additionCount;
    const index = removed ? hunk.deletionLineIndex : hunk.additionLineIndex;
    for (
      let number = Math.max(start, first);
      number <= Math.min(end, first + count - 1);
      number++
    ) {
      result.push({
        number,
        text: lines[index + number - first]?.replace(/\r?\n$/, "") ?? "",
      });
    }
  }
  return result;
}
