import { FileTree, useFileTree } from "@pierre/trees/react";
import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { WS_SUMMARY_SURFACE } from "../../lib/workspace-summary-classes";
import type { PrFile } from "../../lib/types";
import {
  filterReviewFiles,
  reviewFileDecoration,
  syncReviewTreeSelection,
} from "../../lib/pr-file-navigator";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { REVIEW_TREE_CSS } from "../../lib/pr-file-tree-styles";
import { cn } from "../../ui/cn";

const WIDTH_KEY = "opensession-pr-file-tree-width";
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const MIN_DIFF_WIDTH = 180;

function allDirectories(paths: string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [...directories];
}

function initialWidth(): number {
  if (typeof localStorage === "undefined") return DEFAULT_WIDTH;
  try {
    const stored = localStorage.getItem(WIDTH_KEY);
    const width = stored === null ? DEFAULT_WIDTH : Number(stored);
    return Number.isFinite(width)
      ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))
      : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function PrFileTree({
  files,
  mode,
  showFileStats,
  onOpenFile,
  activeFile,
  reviewedFiles,
  layout = "sidebar",
}: {
  files: PrFile[];
  mode: "flat" | "tree";
  showFileStats: boolean;
  onOpenFile: (path: string) => void;
  activeFile?: string | null;
  reviewedFiles?: ReadonlySet<string>;
  /** Mount inside the parent's responsive sheet; onOpenFile can also close it. */
  layout?: "sidebar" | "sheet";
}) {
  const [query, setQuery] = useState("");
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const visibleFiles = filterReviewFiles(
    files,
    query,
    unreviewedOnly,
    reviewedFiles,
  );
  const paths = visibleFiles.map((file) => file.path);
  const pathSet = new Set(paths);
  const [width, setWidth] = useState(initialWidth);
  const [availableWidth, setAvailableWidth] = useState(
    MAX_WIDTH + MIN_DIFF_WIDTH,
  );
  const navigationRef = useRef({
    onOpenFile,
    pathSet,
    reviewedFiles,
  });
  const syncingSelection = useRef(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    navigationRef.current = {
      onOpenFile,
      pathSet,
      reviewedFiles,
    };
  });
  const { model } = useFileTree({
    paths,
    initialExpandedPaths: allDirectories(paths),
    flattenEmptyDirectories: true,
    unsafeCSS: REVIEW_TREE_CSS,
    itemHeight: layout === "sheet" ? 44 : undefined,
    renderRowDecoration: ({ item }) =>
      item.kind === "file"
        ? reviewFileDecoration(item.path, navigationRef.current.reviewedFiles)
        : null,
    onSelectionChange: (selection) => {
      const path = selection[0] ? String(selection[0]) : null;
      const current = navigationRef.current;
      if (!syncingSelection.current && path && current.pathSet.has(path)) {
        current.onOpenFile(path);
      }
    },
  });

  const pathsKey = paths.join("\0");
  const syncPaths = useEffectEvent(() => {
    syncingSelection.current = true;
    try {
      model.resetPaths(paths, { initialExpandedPaths: allDirectories(paths) });
    } catch (error) {
      syncingSelection.current = false;
      throw error;
    }
    syncingSelection.current = false;
  });
  useEffect(() => {
    syncPaths();
  }, [model, pathsKey]);

  useEffect(() => {
    // Programmatic selection must not jump the diff or close a phone sheet.
    syncingSelection.current = true;
    try {
      syncReviewTreeSelection(model, activeFile);
    } catch (error) {
      syncingSelection.current = false;
      throw error;
    }
    syncingSelection.current = false;
  }, [model, activeFile, pathsKey]);

  useEffect(() => {
    // Pierre owns a separate render root; refresh decorations without rebuilding
    // its model, discarding expanded directories, or changing keyboard focus.
    if (model.getFileTreeContainer()) model.render({});
  }, [model, reviewedFiles, mode]);

  useEffect(
    () => () => {
      stopResizeRef.current?.();
      document.body.classList.remove("resizing-pr-file-tree");
    },
    [],
  );

  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const update = () =>
      setAvailableWidth(parent.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const maxWidth = Math.max(
    MIN_WIDTH,
    Math.min(MAX_WIDTH, availableWidth - MIN_DIFF_WIDTH),
  );
  const renderedWidth = Math.min(width, maxWidth);
  const clampWidth = (next: number) =>
    Math.min(maxWidth, Math.max(MIN_WIDTH, next));
  const commitWidth = (next: number) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {}
  };

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    stopResizeRef.current?.();
    const startX = event.clientX;
    const startWidth = root.getBoundingClientRect().width;
    document.body.classList.add("resizing-pr-file-tree");
    const move = (moveEvent: PointerEvent) => {
      root.style.width = `${clampWidth(startWidth + moveEvent.clientX - startX)}px`;
    };
    const cleanup = () => {
      document.body.classList.remove("resizing-pr-file-tree");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", cancel);
      stopResizeRef.current = null;
    };
    const stop = () => {
      commitWidth(root.getBoundingClientRect().width);
      cleanup();
    };
    const cancel = () => {
      root.style.width = `${renderedWidth}px`;
      cleanup();
    };
    stopResizeRef.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", cancel);
  }

  return (
    <aside
      ref={rootRef}
      aria-label="Changed files"
      className={cn(
        "flex min-h-0 shrink-0 flex-col",
        layout === "sheet"
          ? "relative h-full w-full"
          : `${WS_SUMMARY_SURFACE} sticky top-[var(--review-file-tree-top,0px)] mb-2 ml-2 mt-[var(--review-file-tree-gap,8px)] max-h-[calc(100dvh-var(--review-file-tree-top,0px)-16px)] desktop:max-h-[calc(100dvh-var(--desktop-header-h)-var(--review-file-tree-top,0px)-16px)]`,
      )}
      style={
        layout === "sheet"
          ? undefined
          : {
              width: renderedWidth,
              maxWidth: `calc(100% - ${MIN_DIFF_WIDTH}px)`,
            }
      }
    >
      {layout === "sidebar" && (
        <div className="flex h-11 shrink-0 items-center gap-2 px-3 text-label font-medium text-fg">
          <span className="min-w-0 flex-1 truncate">Changed files</span>
          <span className="text-meta font-normal tabular-nums text-faint">
            {visibleFiles.length === files.length
              ? files.length
              : `${visibleFiles.length} / ${files.length}`}
          </span>
        </div>
      )}
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
        <Input
          type="search"
          aria-label="Search filenames or paths"
          placeholder="Search files…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="phone:min-h-11 phone:text-[length:var(--text-input-phone)]"
        />
        <Button
          variant={unreviewedOnly ? "soft" : "ghost"}
          size="sm"
          disabled={reviewedFiles === undefined}
          aria-pressed={unreviewedOnly}
          onClick={() => setUnreviewedOnly((value) => !value)}
          className="self-start phone:min-h-11"
        >
          Unreviewed
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 py-1.5">
        {files.length === 0 ? (
          <p className="m-0 px-2 py-3 text-label text-faint">
            No files to review
          </p>
        ) : visibleFiles.length === 0 ? (
          <p role="status" className="m-0 px-2 py-3 text-label text-faint">
            {unreviewedOnly && !query.trim()
              ? "All files reviewed"
              : "No matching files"}
          </p>
        ) : mode === "tree" ? (
          <FileTree
            model={model}
            className="block h-full [color-scheme:dark] [--trees-accent-override:var(--accent)] [--trees-bg-override:transparent] [--trees-border-color-override:var(--divider)] [--trees-fg-muted-override:var(--text-faint)] [--trees-fg-override:var(--text-dim)] [--trees-focus-ring-color-override:var(--accent)] [--trees-selected-bg-override:var(--selected)] [--trees-selected-fg-override:var(--text)]"
          />
        ) : (
          <div className="flex min-w-full w-max flex-col gap-0.5">
            {visibleFiles.map((file) => {
              const slash = file.path.lastIndexOf("/");
              const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
              const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
              const decoration = reviewFileDecoration(file.path, reviewedFiles);
              return (
                <Button
                  key={file.path}
                  type="button"
                  variant="ghost"
                  aria-current={
                    activeFile === file.path ? "location" : undefined
                  }
                  className={cn(
                    "group flex min-h-8 min-w-0 items-center justify-start gap-2 rounded-row px-2 text-left text-label text-dim phone:min-h-11",
                    activeFile === file.path && "bg-pressed text-fg",
                  )}
                  title={file.path}
                  onClick={() => onOpenFile(file.path)}
                >
                  <span className="flex flex-1 whitespace-nowrap">
                    <span className="font-medium text-fg">{base}</span>
                    {dir && <span className="ml-1 text-faint">{dir}</span>}
                  </span>
                  {decoration && (
                    <span
                      className="shrink-0 text-meta text-dim"
                      aria-label={decoration.title}
                      title={decoration.title}
                    >
                      {decoration.text}
                    </span>
                  )}
                  {showFileStats && (
                    <span className="flex shrink-0 gap-1 text-meta tabular-nums">
                      {file.additions > 0 && (
                        <span className="text-green">+{file.additions}</span>
                      )}
                      {file.deletions > 0 && (
                        <span className="text-red">−{file.deletions}</span>
                      )}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        )}
      </div>
      {layout === "sidebar" && (
        <div
          role="separator"
          aria-label="Resize changed files"
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={Math.round(renderedWidth)}
          tabIndex={0}
          className="absolute inset-y-0 -right-1 z-10 w-[9px] cursor-col-resize touch-none after:absolute after:inset-y-1 after:left-1 after:w-px after:bg-transparent after:transition-[background-color] after:content-[''] hover:after:bg-accent focus-visible:outline-none focus-visible:after:bg-accent [body.resizing-pr-file-tree_&]:after:bg-accent"
          onPointerDown={startResize}
          onDoubleClick={() => commitWidth(DEFAULT_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            commitWidth(
              renderedWidth + (event.key === "ArrowRight" ? 16 : -16),
            );
          }}
        />
      )}
    </aside>
  );
}
