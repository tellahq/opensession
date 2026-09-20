import { useLayoutEffect, useRef } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";

/** Every ancestor dir across the file set — small trees, keep them all open. */
function allDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs];
}

/**
 * The Assets tab's file tree. Rendered through DeferredDiff: @pierre/trees
 * ships with the diff renderer's chunk, off the boot path.
 */
export function AssetsTree({
  paths,
  selected,
  onSelect,
}: {
  paths: string[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const onSelectRef = useRef(onSelect);
  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
  });
  const { model } = useFileTree({
    paths,
    initialExpandedPaths: allDirs(paths),
    initialSelectedPaths: selected ? [selected] : undefined,
    onSelectionChange: (sel) => {
      const p = sel[0] ? String(sel[0]) : null;
      // Directory rows also select — only react to real files.
      if (p && paths.includes(p)) onSelectRef.current(p);
    },
  });
  // Same forced dark color-scheme as the docs tree (Notes.tsx) — the tree's
  // own shadow styles use light-dark() and would otherwise follow the OS.
  return (
    <FileTree model={model} className="block h-full [color-scheme:dark]" />
  );
}
