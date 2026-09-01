import type { ReviewGuideData } from "./types";

/** Split a unified diff into per-file chunks keyed by the new-side path. */
function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue;
    const match = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (match) map.set(match[2], part);
  }
  return map;
}

/**
 * Pair each guide section with the slice of the unified diff covering its
 * files (so inline commenting keeps working inside the guide). Model paths are
 * matched exactly, then by suffix; files no section claimed come back as a
 * trailing "Everything else" section so guide mode never hides part of a PR.
 */
export function sectionsWithPatches(guide: ReviewGuideData, patch: string) {
  const byFile = splitPatchByFile(patch);
  const unclaimed = new Set(byFile.keys());
  // A suffix match can only ever pair two paths that end in the same segment,
  // so bucket the patch's paths by basename once rather than scanning every
  // one of them per section file.
  const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const byBasename = new Map<string, string[]>();
  for (const path of byFile.keys()) {
    const bucket = byBasename.get(basename(path));
    if (bucket) bucket.push(path);
    else byBasename.set(basename(path), [path]);
  }
  const resolve = (file: string): string | null => {
    if (byFile.has(file)) return file;
    for (const path of byBasename.get(basename(file)) ?? [])
      if (path.endsWith(`/${file}`) || file.endsWith(`/${path}`)) return path;
    return null;
  };
  const sections = guide.sections.map((section) => {
    const chunks: string[] = [];
    for (const file of section.files) {
      const path = resolve(file);
      if (!path || !unclaimed.has(path)) continue;
      unclaimed.delete(path);
      const filePatch = byFile.get(path);
      if (filePatch) chunks.push(filePatch);
    }
    return { ...section, patch: chunks.join("") };
  });
  if (unclaimed.size > 0)
    sections.push({
      title: "Everything else",
      explanation: "Changes the guide didn't group into a section.",
      files: [...unclaimed],
      patch: [...unclaimed]
        .map((file) => byFile.get(file))
        .filter((filePatch): filePatch is string => filePatch !== undefined)
        .join(""),
    });
  return sections;
}
