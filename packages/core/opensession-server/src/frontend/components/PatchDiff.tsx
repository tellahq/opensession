import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { ComponentProps, ReactNode } from "react";

type DiffOptions = ComponentProps<typeof FileDiff>["options"];

/*
 * The workspace summary opens one file preview at a time out of the same
 * patch, so the last parse is kept: parsing walks the whole patch, and a
 * hover over the next row would otherwise repeat it.
 */
let lastParse: { patch: string; files: FileDiffMetadata[] } | null = null;

function patchFiles(patch: string): FileDiffMetadata[] {
  if (lastParse?.patch === patch) return lastParse.files;
  let files: FileDiffMetadata[] = [];
  try {
    files = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
  } catch {
    // A truncated or malformed patch shows nothing rather than an error.
  }
  lastParse = { patch, files };
  return files;
}

/** One file's diff out of a unified patch; nothing when the patch lacks it. */
export function PatchFileDiff({
  patch,
  path,
  options,
}: {
  patch: string;
  path: string;
  options: DiffOptions;
}) {
  const file = patchFiles(patch).find((candidate) => candidate.name === path);
  if (!file) return null;
  return <FileDiff fileDiff={file} options={options} disableWorkerPool />;
}

/** Every file in a unified patch under a header; nothing when it has none. */
export function PatchDiffs({
  patch,
  options,
  className,
  header,
}: {
  patch: string;
  options: DiffOptions;
  className: string;
  header: ReactNode;
}) {
  const files = patchFiles(patch);
  if (files.length === 0) return null;
  return (
    <div className={className}>
      {header}
      {files.map((file) => (
        <FileDiff
          key={`${file.prevName ?? ""}:${file.name}`}
          fileDiff={file}
          options={options}
          disableWorkerPool
        />
      ))}
    </div>
  );
}
