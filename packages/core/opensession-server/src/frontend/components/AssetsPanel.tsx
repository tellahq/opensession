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

import React, { useCallback, useEffect, useState } from "react";
import type { SessionAssetFile } from "../lib/api";
import { useSessionAssetsResource } from "../hooks/useApiResources";
import type { WSServerMessage } from "../lib/types";
import type { NewSessionPrefill } from "../lib/new-session-link";
import { Button } from "../ui/button";
import { AssetActions, AssetPreview } from "./AssetView";
import { AssetsTree } from "./DeferredDiff";
import { resolvedAssetPath } from "../lib/asset-preview";

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
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center">
        <div className="text-label text-dim">No assets yet</div>
        <div className="max-w-[360px] text-label text-faint">
          Ask the agent to save a visualization, report, or demo page here. It
          writes files with opensession-assets' write_asset and they preview
          live in this tab.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex max-h-[38%] min-h-[88px] flex-col overflow-hidden border-b border-line">
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <span className="text-label font-semibold text-faint">
            Files · {files.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-faint"
            onClick={refresh}
            title="Refresh the file list"
          >
            Refresh
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1.5">
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
