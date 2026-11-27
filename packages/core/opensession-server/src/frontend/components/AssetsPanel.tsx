/**
 * Assets tab — the session's scratch folder of agent-produced artifacts
 * (HTML/JS visualizations, reports, diagrams, sample data; see
 * src/server/session-assets.ts). One file at full size, with the folder's
 * other files behind the name in its header.
 *
 * This is the place you go to sit with the folder. One file on its own arrives
 * over the conversation instead, in `AssetOverlay` — and both render the same
 * `AssetPreview` with the same action menu, while placing metadata where it
 * best fits each surface.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { SessionAssetFile } from "../lib/api";
import { useSessionAssetsResource } from "../hooks/useApiResources";
import type { WSServerMessage } from "../lib/types";
import type { NewSessionPrefill } from "../lib/new-session-link";
import { AssetActions, AssetPreview } from "./AssetView";
import { assetPreviewKind, resolvedAssetPath } from "../lib/asset-preview";
import { canAnnotateAsset } from "../lib/asset-annotation";
import { AssetAnnotationLayer } from "./AssetAnnotationLayer";

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
  // Keep SessionViewer aligned with list navigation. Without this, promoting
  // the same overlay twice can be a React no-op after the list selected
  // another file in between.
  useEffect(() => {
    if (selected !== selectedPath) onSelectPath(selected);
  }, [selected, selectedPath, onSelectPath]);

  const file = files.find((f) => f.path === selected) || null;
  // The file being annotated: picking another file leaves the mode.
  const [annotatingPath, setAnnotatingPath] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  if (!files.length) {
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center">
        <div className="text-item-title font-medium text-dim">
          No assets yet
        </div>
        <div className="max-w-[360px] text-label text-faint">
          Ask the agent to save a visualization, report, or demo page here. It
          writes files with opensession-assets' write_asset and they preview
          live in this tab.
        </div>
      </div>
    );
  }

  // The tab is the file, full size. Other files are one click away in the
  // header's name, so no column of them takes width from the file.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {file ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AssetActions
            sessionId={sessionId}
            file={file}
            files={files}
            onSelectPath={onSelectPath}
            refresh={refresh}
            annotating={
              canAnnotateAsset(assetPreviewKind(file.path))
                ? annotatingPath === file.path
                : undefined
            }
            onAnnotate={(on) => setAnnotatingPath(on ? file.path : null)}
            showSize
          />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <AssetPreview
              ref={previewRef}
              sessionId={sessionId}
              file={file}
              onOpenNewSession={onOpenNewSession}
            />
            {annotatingPath === file.path && (
              <AssetAnnotationLayer
                sessionId={sessionId}
                path={file.path}
                preview={previewRef}
                onExit={() => setAnnotatingPath(null)}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
