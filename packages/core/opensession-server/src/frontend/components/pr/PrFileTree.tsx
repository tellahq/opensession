import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  h11: {
    height: "calc(4px * 11)",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontNormal: {
    fontWeight: "var(--font-weight-normal)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  minH0: {
    minHeight: "0",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  px1: {
    paddingInline: "4px",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  m0: {
    margin: "0",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  block: {
    display: "block",
  },
  hFull: {
    height: "100%",
  },
  ColorSchemeDark: {
    colorScheme: "dark",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  minH8: {
    minHeight: "calc(4px * 8)",
  },
  roundedRow: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  textLeft: {
    textAlign: "left",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  focusVisibleOutlineAccent: {
    ":focus-visible": {
      outlineColor: "var(--accent)",
    },
  },
  overflowHidden: {
    overflow: "hidden",
  },
  ml1: {
    marginLeft: "4px",
  },
  gap1: {
    gap: "4px",
  },
  textGreen: {
    color: "var(--green)",
  },
  textRed: {
    color: "var(--red)",
  },
  absolute: {
    position: "absolute",
  },
  insetY0: {
    insetBlock: "0",
  },
  Right1: {
    right: "calc(4px * -1)",
  },
  z10: {
    zIndex: "10",
  },
  w9px: {
    width: "9px",
  },
  cursorColResize: {
    cursor: "col-resize",
  },
  touchNone: {
    touchAction: "none",
  },
  afterAbsolute: {
    "::after": {
      content: '""',
      position: "absolute",
    },
  },
  afterInsetY1: {
    "::after": {
      content: '""',
      insetBlock: "4px",
    },
  },
  afterLeft1: {
    "::after": {
      content: '""',
      left: "4px",
    },
  },
  afterWPx: {
    "::after": {
      content: '""',
      width: "1px",
    },
  },
  afterBgTransparent: {
    "::after": {
      content: '""',
      backgroundColor: "transparent",
    },
  },
  afterTransitionBackgroundColor: {
    "::after": {
      content: '""',
      transitionProperty: "background-color",
      transitionTimingFunction: "var(--tw-ease, var(--ease))",
      transitionDuration: "var(--tw-duration, var(--dur-micro))",
    },
  },
  afterContent: {
    "::after": {
      content: "''",
    },
  },
  hoverAfterBgAccent: {
    "@media (hover: hover)": {
      "::after": {
        content: '""',
        backgroundColor: "var(--accent)",
      },
    },
  },
  focusVisibleOutlineNone: {
    ":focus-visible": {
      outlineStyle: "none",
    },
  },
  focusVisibleAfterBgAccent: {
    "::after": {
      content: '""',
      backgroundColor: "var(--accent)",
    },
  },
});

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
      className={utilityClassName(
        `${WS_SUMMARY_SURFACE} sticky top-[var(--review-file-tree-top,0px)] mb-2 ml-2 mt-[var(--review-file-tree-gap,8px)] flex max-h-[calc(100dvh-var(--review-file-tree-top,0px)-16px)] min-h-0 shrink-0 flex-col desktop:max-h-[calc(100dvh-var(--desktop-header-h)-var(--review-file-tree-top,0px)-16px)]`,
      )}
      style={{
        width: renderedWidth,
        maxWidth: `calc(100% - ${MIN_DIFF_WIDTH}px)`,
      }}
    >
      <div
        {...stylex.props(
          sx.flex,
          sx.h11,
          sx.shrink0,
          sx.itemsCenter,
          sx.gap2,
          sx.px3,
          sx.fontMedium,
          sx.textFg,
          typography.label,
        )}
      >
        <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
          Changed files
        </span>
        <span
          {...mergeStylexProps(
            "tabular-nums",
            sx.fontNormal,
            sx.textFaint,
            typography.meta,
          )}
        >
          {files.length}
        </span>
      </div>
      <div
        {...stylex.props(sx.minH0, sx.flex1, sx.overflowYAuto, sx.px1, sx.py15)}
      >
        {files.length === 0 ? (
          <p
            {...stylex.props(
              sx.m0,
              sx.px2,
              sx.py3,
              sx.textFaint,
              typography.label,
            )}
          >
            No files to review
          </p>
        ) : mode === "tree" ? (
          <FileTree
            model={model}
            className={mergeStylexOverrideClassName(
              "[--trees-accent-override:var(--accent)] [--trees-bg-override:transparent] [--trees-border-color-override:var(--divider)] [--trees-fg-muted-override:var(--text-faint)] [--trees-fg-override:var(--text-dim)] [--trees-focus-ring-color-override:var(--accent)] [--trees-selected-bg-override:var(--selected)] [--trees-selected-fg-override:var(--text)]",
              sx.block,
              sx.hFull,
              sx.ColorSchemeDark,
            )}
          />
        ) : (
          <div {...stylex.props(sx.flex, sx.flexCol, sx.gap05)}>
            {files.map((file) => {
              const slash = file.path.lastIndexOf("/");
              const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
              const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  {...mergeStylexProps(
                    "group focus-visible:outline-2",
                    sx.flex,
                    sx.minH8,
                    sx.minW0,
                    sx.itemsCenter,
                    sx.gap2,
                    sx.roundedRow,
                    sx.border0,
                    sx.bgTransparent,
                    sx.px2,
                    sx.textLeft,
                    sx.textDim,
                    sx.hoverBgHover,
                    sx.hoverTextFg,
                    sx.focusVisibleOutlineAccent,
                    typography.label,
                  )}
                  title={file.path}
                  onClick={() => onOpenFile(file.path)}
                >
                  <span
                    {...stylex.props(
                      sx.flex,
                      sx.minW0,
                      sx.flex1,
                      sx.overflowHidden,
                    )}
                  >
                    <span
                      {...stylex.props(sx.shrink0, sx.fontMedium, sx.textFg)}
                    >
                      {base}
                    </span>
                    {dir && (
                      <span
                        {...stylex.props(
                          sx.ml1,
                          sx.minW0,
                          sx.truncate,
                          sx.textFaint,
                        )}
                      >
                        {dir}
                      </span>
                    )}
                  </span>
                  {showFileStats && (
                    <span
                      {...mergeStylexProps(
                        "tabular-nums",
                        sx.flex,
                        sx.shrink0,
                        sx.gap1,
                        typography.meta,
                      )}
                    >
                      {file.additions > 0 && (
                        <span {...stylex.props(sx.textGreen)}>
                          +{file.additions}
                        </span>
                      )}
                      {file.deletions > 0 && (
                        <span {...stylex.props(sx.textRed)}>
                          −{file.deletions}
                        </span>
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
        {...mergeStylexProps(
          "[body.resizing-pr-file-tree_&]:after:bg-accent",
          sx.absolute,
          sx.insetY0,
          sx.Right1,
          sx.z10,
          sx.w9px,
          sx.cursorColResize,
          sx.touchNone,
          sx.afterAbsolute,
          sx.afterInsetY1,
          sx.afterLeft1,
          sx.afterWPx,
          sx.afterBgTransparent,
          sx.afterTransitionBackgroundColor,
          sx.afterContent,
          sx.hoverAfterBgAccent,
          sx.focusVisibleOutlineNone,
          sx.focusVisibleAfterBgAccent,
        )}
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
