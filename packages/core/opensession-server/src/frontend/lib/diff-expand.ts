import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";

// Same split @pierre/diffs uses for patch and file lines: each line keeps its
// trailing newline, so joining them gives back the exact text.
function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

/**
 * Full old and new file text for a patch-parsed diff, built from the new
 * side's full text alone. Unmodified regions are the same on both sides, and
 * the patch hunks carry every line that differs, so the old file is the new
 * file with each hunk swapped back. This lets the review diff expand its
 * "unmodified lines" rows with one fetch per file and no base-ref lookup.
 *
 * Throws when the new text does not match the patch, for example when the
 * file changed after the patch was taken. Hydrating with mismatched text
 * would render the wrong lines.
 */
export function diffFilesFromNewText(
  fd: FileDiffMetadata,
  newText: string,
): FileDiffLoadedFiles {
  const newLines = splitLines(newText);
  const oldLines: string[] = [];
  let cursor = 0;
  for (const hunk of fd.hunks) {
    const start = hunk.additionStart - (hunk.additionCount === 0 ? 0 : 1);
    if (start < cursor || start + hunk.additionCount > newLines.length)
      throw new Error(`${fd.name} does not match its diff`);
    for (let i = 0; i < hunk.additionCount; i++) {
      if (newLines[start + i] !== fd.additionLines[hunk.additionLineIndex + i])
        throw new Error(`${fd.name} does not match its diff`);
    }
    for (let i = cursor; i < start; i++) oldLines.push(newLines[i]!);
    for (let i = 0; i < hunk.deletionCount; i++)
      oldLines.push(fd.deletionLines[hunk.deletionLineIndex + i]!);
    cursor = start + hunk.additionCount;
  }
  for (let i = cursor; i < newLines.length; i++) oldLines.push(newLines[i]!);
  const newFile = { name: fd.name, contents: newText };
  if (fd.type === "rename-pure") return { oldFile: null, newFile };
  return {
    oldFile: { name: fd.prevName || fd.name, contents: oldLines.join("") },
    newFile,
  };
}
