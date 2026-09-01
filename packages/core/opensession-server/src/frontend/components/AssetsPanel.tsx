import { mergeStylexOverrideClassName } from "../ui/cn";
/**
 * Assets tab — the session's scratch folder of agent-produced artifacts
 * (HTML/JS visualizations, reports, diagrams, sample data; see
 * src/server/session-assets.ts). Split view: file tree on top, preview below.
 *
 * This is the place you go to sit with the folder. One file on its own arrives
 * over the conversation instead, in `AssetOverlay` — and both render the same
 * `AssetPreview` with the same action menu, while placing metadata where it
 * best fits each surface.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { SessionAssetFile } from "../lib/api";
import { useSessionAssetsResource } from "../hooks/useApiResources";
import type { WSServerMessage } from "../lib/types";
import type { NewSessionPrefill } from "../lib/new-session-link";
import { Button } from "../ui/button";
import { AssetActions, AssetPreview } from "./AssetView";
import { resolvedAssetPath } from "../lib/asset-preview";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  block: {
    display: "block",
  },
  hFull: {
    height: "100%",
  },
  ColorSchemeDark: {
    colorScheme: "dark",
  },
  flex: {
    display: "flex",
  },
  minH240px: {
    minHeight: "240px",
  },
  flexCol: {
    flexDirection: "column",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  gap1: {
    gap: "4px",
  },
  px6: {
    paddingInline: "calc(4px * 6)",
  },
  textCenter: {
    textAlign: "center",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  maxW360px: {
    maxWidth: "360px",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  minH0: {
    minHeight: "0",
  },
  maxH38: {
    maxHeight: "38%",
  },
  minH88px: {
    minHeight: "88px",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  pt2: {
    paddingTop: "calc(4px * 2)",
  },
  pb1: {
    paddingBottom: "4px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  flex1: {
    flex: "1",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  px1: {
    paddingInline: "4px",
  },
  pb15: {
    paddingBottom: "calc(4px * 1.5)",
  },
});

/** Lives in SessionViewer (not the panel) so the tab button can show/hide on
 * the file count without the panel being mounted. */
export function useSessionAssets(
  sessionId: string,
  addHandler: (h: (msg: WSServerMessage) => void) => () => void,
) {
  const { data: files = [], mutate } = useSessionAssetsResource(sessionId);
  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);
  useEffect(
    () =>
      addHandler((msg) => {
        if (msg.type === "assets_changed" && msg.sessionId === sessionId)
          refresh();
      }),
    [addHandler, sessionId, refresh],
  );
  return { files, refresh };
}

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

function AssetsTree({
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
    <FileTree
      model={model}
      className={mergeStylexOverrideClassName(
        "",
        sx.block,
        sx.hFull,
        sx.ColorSchemeDark,
      )}
    />
  );
}

export function AssetsPanel({
  sessionId,
  files,
  refresh,
  selectedPath = null,
  onSelectPath,
  onOpenNewSession,
}: {
  sessionId: string;
  files: SessionAssetFile[];
  refresh: () => void;
  /** Controlled selection — the file the overlay was promoted from. */
  selectedPath?: string | null;
  onSelectPath: (path: string | null) => void;
  onOpenNewSession: (prefill: NewSessionPrefill) => void;
}) {
  const paths = files.map((f) => f.path);
  const selected = resolvedAssetPath(paths, selectedPath);
  // Keep SessionViewer aligned with tree navigation. Without this, promoting
  // the same overlay twice can be a React no-op after the tree selected
  // another file in between.
  useEffect(() => {
    if (selected !== selectedPath) onSelectPath(selected);
  }, [selected, selectedPath, onSelectPath]);

  const file = files.find((f) => f.path === selected) || null;

  if (!files.length) {
    return (
      <div
        {...stylex.props(
          sx.flex,
          sx.hFull,
          sx.minH240px,
          sx.flexCol,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.gap1,
          sx.px6,
          sx.textCenter,
        )}
      >
        <div {...stylex.props(sx.textDim, typography.label)}>No assets yet</div>
        <div {...stylex.props(sx.maxW360px, sx.textFaint, typography.label)}>
          Ask the agent to save a visualization, report, or demo page here. It
          writes files with opensession-assets' write_asset and they preview
          live in this tab.
        </div>
      </div>
    );
  }

  return (
    <div {...stylex.props(sx.flex, sx.hFull, sx.minH0, sx.flexCol)}>
      <div
        {...stylex.props(
          sx.flex,
          sx.maxH38,
          sx.minH88px,
          sx.flexCol,
          sx.overflowHidden,
          sx.borderB,
          sx.borderLine,
        )}
      >
        <div
          {...stylex.props(
            sx.flex,
            sx.itemsCenter,
            sx.justifyBetween,
            sx.px3,
            sx.pt2,
            sx.pb1,
          )}
        >
          <span
            {...stylex.props(sx.fontSemibold, sx.textFaint, typography.label)}
          >
            Files · {files.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className={mergeStylexOverrideClassName("", sx.textFaint)}
            onClick={refresh}
            title="Refresh the file list"
          >
            Refresh
          </Button>
        </div>
        <div
          {...stylex.props(
            sx.minH0,
            sx.flex1,
            sx.overflowYAuto,
            sx.px1,
            sx.pb15,
          )}
        >
          <AssetsTree
            key={paths.join("\n")}
            paths={paths}
            selected={selected}
            onSelect={onSelectPath}
          />
        </div>
      </div>
      {file ? (
        <>
          <AssetActions
            sessionId={sessionId}
            file={file}
            refresh={refresh}
            showSize
          />
          <AssetPreview
            sessionId={sessionId}
            file={file}
            onOpenNewSession={onOpenNewSession}
          />
        </>
      ) : null}
    </div>
  );
}
