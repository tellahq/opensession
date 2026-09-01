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
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(stored)
    ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, stored))
    : DEFAULT_WIDTH;
}

export function PrFileTree({
  files,
  mode,
  showFileStats,
  onOpenFile,
}: {
  files: PrFile[];
  mode: "flat" | "tree";
  showFileStats: boolean;
  onOpenFile: (path: string) => void;
}) {
  const paths = files.map((file) => file.path);
  const [width, setWidth] = useState(initialWidth);
  const [availableWidth, setAvailableWidth] = useState(
    MAX_WIDTH + MIN_DIFF_WIDTH,
  );
  const onOpenFileRef = useRef(onOpenFile);
  const rootRef = useRef<HTMLElement | null>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    onOpenFileRef.current = onOpenFile;
  });
  const { model } = useFileTree({
    paths,
    initialExpandedPaths: allDirectories(paths),
    onSelectionChange: (selection) => {
      const path = selection[0] ? String(selection[0]) : null;
      if (path && paths.includes(path)) onOpenFileRef.current(path);
    },
  });

  const pathsKey = paths.join("\0");
  const syncPaths = useEffectEvent(() => {
    model.resetPaths(paths, { initialExpandedPaths: allDirectories(paths) });
  });
  useEffect(() => {
    syncPaths();
  }, [model, pathsKey]);

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
      id="pr-file-tree"
      aria-label="Changed files"
      className={`${WS_SUMMARY_SURFACE} sticky top-[var(--review-file-tree-top,0px)] mb-2 ml-2 mt-[var(--review-file-tree-gap,8px)] flex max-h-[calc(100dvh-var(--review-file-tree-top,0px)-16px)] min-h-0 shrink-0 flex-col desktop:max-h-[calc(100dvh-var(--desktop-header-h)-var(--review-file-tree-top,0px)-16px)]`}
      style={{
        width: renderedWidth,
        maxWidth: `calc(100% - ${MIN_DIFF_WIDTH}px)`,
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 px-3 text-label font-medium text-fg">
        <span className="min-w-0 flex-1 truncate">Changed files</span>
        <span className="text-meta font-normal tabular-nums text-faint">
          {files.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5">
        {files.length === 0 ? (
          <p className="m-0 px-2 py-3 text-label text-faint">
            No files to review
          </p>
        ) : mode === "tree" ? (
          <FileTree
            model={model}
            className="block h-full [color-scheme:dark] [--trees-accent-override:var(--accent)] [--trees-bg-override:transparent] [--trees-border-color-override:var(--divider)] [--trees-fg-muted-override:var(--text-faint)] [--trees-fg-override:var(--text-dim)] [--trees-focus-ring-color-override:var(--accent)] [--trees-selected-bg-override:var(--selected)] [--trees-selected-fg-override:var(--text)]"
          />
        ) : (
          <div className="flex flex-col gap-0.5">
            {files.map((file) => {
              const slash = file.path.lastIndexOf("/");
              const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
              const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  className="group flex min-h-8 min-w-0 items-center gap-2 rounded-row border-0 bg-transparent px-2 text-left text-label text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                  title={file.path}
                  onClick={() => onOpenFile(file.path)}
                >
                  <span className="flex min-w-0 flex-1 overflow-hidden">
                    <span className="shrink-0 font-medium text-fg">{base}</span>
                    {dir && (
                      <span className="ml-1 min-w-0 truncate text-faint">
                        {dir}
                      </span>
                    )}
                  </span>
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
                </button>
              );
            })}
          </div>
        )}
      </div>
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
          commitWidth(renderedWidth + (event.key === "ArrowRight" ? 16 : -16));
        }}
      />
    </aside>
  );
}
