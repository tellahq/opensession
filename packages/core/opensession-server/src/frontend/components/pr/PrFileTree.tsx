import { FileTree, useFileTree } from "@pierre/trees/react";
import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { WS_SUMMARY_SURFACE } from "../../lib/workspace-summary-classes";
import type { DiffFileGroup, PrFile } from "../../lib/types";
import {
  filesInFolder,
  filterReviewFiles,
  reviewFileDecoration,
  syncReviewTreeSelection,
} from "../../lib/pr-file-navigator";
import {
  bulkReviewChanges,
  groupReviewProgress,
} from "../../lib/review-groups";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Menu } from "../../ui/menu";
import { Tooltip } from "../../ui/tooltip";
import {
  popupItemClasses,
  popupScrollClasses,
  popupSurfaceClasses,
} from "../../ui/popup-classes";
import {
  IconCheck,
  IconChevronRight,
  IconDotsHorizontal,
  IconSidebarLeft,
  IconSidebarRight,
} from "../icons";
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
  changedFiles,
  onSetReviewed,
  groups,
  leftoverTitle,
  removedFiles,
  layout = "sidebar",
  side = "left",
  onCollapse,
}: {
  files: PrFile[];
  mode: "flat" | "tree";
  showFileStats: boolean;
  onOpenFile: (path: string) => void;
  activeFile?: string | null;
  reviewedFiles?: ReadonlySet<string>;
  /** Reviewed earlier, changed by later commits. */
  changedFiles?: ReadonlySet<string>;
  /** Mark or unmark many files at once (groups, folders, bulk actions). */
  onSetReviewed?: (paths: string[], reviewed: boolean) => void;
  /** Show files in these groups, each with its own review progress. */
  groups?: readonly DiffFileGroup[];
  /** Title for files no group claimed. */
  leftoverTitle?: string;
  /** Files an earlier head of this review had that the latest commits removed. */
  removedFiles?: readonly string[];
  /** Mount inside the parent's responsive sheet; onOpenFile can also close it. */
  layout?: "sidebar" | "sheet";
  /** Which edge of the diff the sidebar sits on; the resize handle faces the diff. */
  side?: "left" | "right";
  /** Offer a button that hides the sidebar entirely. */
  onCollapse?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const canBulk = !!onSetReviewed && reviewedFiles !== undefined;
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
    changedFiles,
  });
  const syncingSelection = useRef(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    navigationRef.current = {
      onOpenFile,
      pathSet,
      reviewedFiles,
      changedFiles,
    };
  });
  const { model } = useFileTree({
    paths,
    initialExpandedPaths: allDirectories(paths),
    flattenEmptyDirectories: true,
    unsafeCSS: REVIEW_TREE_CSS,
    itemHeight: layout === "sheet" ? 44 : undefined,
    composition: {
      contextMenu: { triggerMode: "right-click", buttonVisibility: "always" },
    },
    renderRowDecoration: ({ item }) =>
      item.kind === "file"
        ? reviewFileDecoration(
            item.path,
            navigationRef.current.reviewedFiles,
            navigationRef.current.changedFiles,
          )
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
  }, [model, reviewedFiles, changedFiles, mode]);

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
      const delta = moveEvent.clientX - startX;
      root.style.width = `${clampWidth(startWidth + (side === "right" ? -delta : delta))}px`;
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

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const groupProgress = groups?.length
    ? groupReviewProgress(
        groups,
        paths,
        reviewedFiles,
        changedFiles,
        leftoverTitle,
      )
    : null;
  const bulk = (
    targets: readonly string[],
    action: "mark" | "reset" | "invert",
  ) => {
    if (!onSetReviewed || !reviewedFiles) return;
    const { mark, unmark } = bulkReviewChanges(targets, reviewedFiles, action);
    if (mark.length) onSetReviewed(mark, true);
    if (unmark.length) onSetReviewed(unmark, false);
  };
  const renderRow = (file: PrFile) => {
    const slash = file.path.lastIndexOf("/");
    const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
    const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
    const decoration = reviewFileDecoration(
      file.path,
      reviewedFiles,
      changedFiles,
    );
    return (
      <Button
        key={file.path}
        type="button"
        variant="ghost"
        aria-current={activeFile === file.path ? "location" : undefined}
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
  };

  return (
    <aside
      ref={rootRef}
      aria-label="Changed files"
      className={cn(
        "flex min-h-0 shrink-0 flex-col",
        layout === "sheet"
          ? "relative h-full w-full"
          : `${WS_SUMMARY_SURFACE} sticky top-[var(--review-file-tree-top,0px)] mb-2 ${side === "right" ? "mr-2" : "ml-2"} mt-[var(--review-file-tree-gap,8px)] max-h-[calc(100dvh-var(--review-file-tree-top,0px)-16px)] desktop:max-h-[calc(100dvh-var(--desktop-header-h)-var(--review-file-tree-top,0px)-16px)]`,
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
          {onCollapse && (
            <Tooltip label="Hide changed files">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Hide changed files"
                icon={
                  side === "right" ? (
                    <IconSidebarRight size={18} />
                  ) : (
                    <IconSidebarLeft size={18} />
                  )
                }
                className="-mr-1.5"
                onClick={onCollapse}
              />
            </Tooltip>
          )}
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
        <div className="flex items-center gap-1">
          <Button
            variant={unreviewedOnly ? "soft" : "ghost"}
            size="sm"
            disabled={reviewedFiles === undefined}
            aria-pressed={unreviewedOnly}
            onClick={() => setUnreviewedOnly((value) => !value)}
            className="phone:min-h-11"
          >
            Unreviewed
          </Button>
          {canBulk && (
            <Menu.Root>
              <Tooltip label="Review progress">
                <Menu.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto phone:size-11"
                      aria-label="Review progress"
                      icon={<IconDotsHorizontal size={18} />}
                    />
                  }
                />
              </Tooltip>
              <Menu.Popup align="end">
                {(
                  [
                    ["mark", "Mark all as reviewed"],
                    ["reset", "Reset review state"],
                    ["invert", "Invert review state"],
                  ] as const
                ).map(([action, label]) => (
                  <Menu.Item
                    key={action}
                    onClick={() =>
                      bulk(
                        files.map((file) => file.path),
                        action,
                      )
                    }
                  >
                    {label}
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Root>
          )}
        </div>
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
        ) : groupProgress ? (
          <div className="flex min-w-full w-max flex-col gap-0.5">
            {groupProgress.map((group) => {
              const collapsed = collapsedGroups.has(group.title);
              const done = group.reviewed === group.files.length;
              return (
                <section key={group.title} className="flex flex-col gap-0.5">
                  <div className="flex min-h-8 items-center gap-1 pr-1 phone:min-h-11">
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-none bg-transparent px-1.5 py-1 text-left font-sans text-label font-semibold text-dim hover:text-fg"
                      onClick={() =>
                        setCollapsedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.title)) next.delete(group.title);
                          else next.add(group.title);
                          return next;
                        })
                      }
                    >
                      <IconChevronRight
                        size={14}
                        className={cn(
                          "shrink-0 text-faint transition-transform",
                          !collapsed && "rotate-90",
                        )}
                      />
                      <span className="min-w-0 truncate">{group.title}</span>
                    </button>
                    {reviewedFiles && (
                      <span
                        className={cn(
                          "shrink-0 text-meta tabular-nums",
                          done ? "text-green" : "text-faint",
                        )}
                        aria-label={`${group.reviewed} of ${group.files.length} files reviewed`}
                      >
                        {group.reviewed}/{group.files.length}
                      </span>
                    )}
                    {canBulk && (
                      <Tooltip
                        label={
                          done
                            ? "Mark group as not reviewed"
                            : "Mark group as reviewed"
                        }
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "size-7 shrink-0 phone:size-11",
                            done ? "text-green" : "text-faint",
                          )}
                          aria-label={
                            done
                              ? `Mark ${group.title} as not reviewed`
                              : `Mark ${group.title} as reviewed`
                          }
                          icon={<IconCheck size={16} />}
                          onClick={() => onSetReviewed!(group.files, !done)}
                        />
                      </Tooltip>
                    )}
                  </div>
                  {!collapsed &&
                    group.files.map((path) => renderRow(fileByPath.get(path)!))}
                </section>
              );
            })}
          </div>
        ) : mode === "tree" ? (
          <FileTree
            model={model}
            renderContextMenu={
              canBulk
                ? (item, context) => {
                    const targets =
                      item.kind === "directory"
                        ? filesInFolder(paths, String(item.path))
                        : [String(item.path)];
                    const allReviewed =
                      targets.length > 0 &&
                      targets.every((path) => reviewedFiles?.has(path));
                    const noun = item.kind === "directory" ? "folder" : "file";
                    return (
                      <div
                        className={popupSurfaceClasses}
                        role="menu"
                        aria-label={`Review ${item.name}`}
                      >
                        <div className={popupScrollClasses}>
                          <button
                            type="button"
                            role="menuitem"
                            className={cn(
                              popupItemClasses,
                              "border-none bg-transparent hover:bg-hover",
                            )}
                            disabled={!targets.length}
                            onClick={() => {
                              onSetReviewed!(targets, !allReviewed);
                              context.close();
                            }}
                          >
                            {allReviewed
                              ? `Mark ${noun} as not reviewed`
                              : `Mark ${noun} as reviewed`}
                          </button>
                        </div>
                      </div>
                    );
                  }
                : undefined
            }
            className="block h-full [color-scheme:dark] [--trees-accent-override:var(--accent)] [--trees-bg-override:transparent] [--trees-border-color-override:var(--divider)] [--trees-fg-muted-override:var(--text-faint)] [--trees-fg-override:var(--text-dim)] [--trees-focus-ring-color-override:var(--accent)] [--trees-selected-bg-override:var(--selected)] [--trees-selected-fg-override:var(--text)]"
          />
        ) : (
          <div className="flex min-w-full w-max flex-col gap-0.5">
            {visibleFiles.map(renderRow)}
          </div>
        )}
        {removedFiles && removedFiles.length > 0 && (
          <section
            className="mt-2 flex flex-col gap-0.5 border-t border-divider pt-2"
            aria-label="No longer in this diff"
          >
            <h3 className="m-0 px-2 py-1 text-meta font-semibold text-faint">
              No longer in this diff
            </h3>
            {removedFiles.map((path) => (
              <span
                key={path}
                className="truncate px-2 py-1 text-label text-faint line-through"
                title={`${path} was removed from this diff by later commits`}
              >
                {path}
              </span>
            ))}
          </section>
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
          className={cn(
            "absolute inset-y-0 z-10 w-[9px] cursor-col-resize",
            "touch-none after:absolute after:inset-y-1 after:left-1 after:w-px after:bg-transparent after:transition-[background-color] after:content-[''] hover:after:bg-accent focus-visible:outline-none focus-visible:after:bg-accent [body.resizing-pr-file-tree_&]:after:bg-accent",
            side === "right" ? "-left-1" : "-right-1",
          )}
          onPointerDown={startResize}
          onDoubleClick={() => commitWidth(DEFAULT_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            commitWidth(
              renderedWidth +
                ((event.key === "ArrowRight") === (side === "left") ? 16 : -16),
            );
          }}
        />
      )}
    </aside>
  );
}
