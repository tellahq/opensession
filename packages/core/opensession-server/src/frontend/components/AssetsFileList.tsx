/**
 * The Assets tab's file list: top-level files, then a caption per folder,
 * each file a two-line row in the app's own row grammar (lib/assets-classes).
 * Up and Down move the selection the way they did in the tree this replaces.
 */

import { useEffect, useRef } from "react";
import type { SessionAssetFile } from "../lib/api";
import {
  assetPreviewKind,
  formatAssetSize,
  groupAssetsByFolder,
  type AssetPreviewKind,
} from "../lib/asset-preview";
import {
  ASSETS_FOLDER,
  ASSETS_FOLDER_NAME,
  ASSETS_ROW,
  ASSETS_ROW_BODY,
  ASSETS_ROW_DETAIL,
  ASSETS_ROW_ICON,
  ASSETS_ROW_META,
  ASSETS_ROW_NAME,
  ASSETS_ROW_TIME,
} from "../lib/assets-classes";
import { fullTime, shortTime } from "../lib/time";
import { cn } from "../ui/cn";
import {
  IconBrowserTab,
  IconFile,
  IconFileText2,
  IconFolder,
  IconHeadphones,
  IconImage,
  IconPlayRectangle,
} from "./icons";

const KIND_ICON: Record<AssetPreviewKind, typeof IconFile> = {
  html: IconBrowserTab,
  pdf: IconFileText2,
  image: IconImage,
  video: IconPlayRectangle,
  audio: IconHeadphones,
  markdown: IconFileText2,
  text: IconFile,
  binary: IconFile,
};

export function AssetsFileList({
  files,
  selected,
  onSelect,
  className,
}: {
  files: SessionAssetFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const groups = groupAssetsByFolder(files);

  // Keep the open file in view when it changes from outside the list (an
  // overlay promoted to the tab, or a file opened from the transcript).
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[data-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-path]",
      ) ?? []),
    ];
    const current = rows.findIndex((row) => row === document.activeElement);
    const next =
      rows[
        current === -1
          ? 0
          : Math.min(
              rows.length - 1,
              Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)),
            )
      ];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (next.dataset.path) onSelect(next.dataset.path);
  }

  return (
    <div ref={listRef} className={className} onKeyDown={onKeyDown}>
      {groups.map((group) => (
        <div key={group.folder ?? ""}>
          {group.folder && (
            <div className={ASSETS_FOLDER} title={group.folder}>
              <IconFolder size={16} className="shrink-0" />
              <span className={ASSETS_FOLDER_NAME}>{group.folder}</span>
            </div>
          )}
          {group.files.map((file) => {
            const Icon = KIND_ICON[assetPreviewKind(file.path)];
            const name = file.path.split("/").pop() || file.path;
            const active = file.path === selected;
            return (
              <button
                key={file.path}
                type="button"
                data-path={file.path}
                data-active={active || undefined}
                aria-current={active || undefined}
                className={ASSETS_ROW}
                title={file.path}
                onClick={() => onSelect(file.path)}
              >
                <Icon size={18} className={ASSETS_ROW_ICON} />
                <span className={ASSETS_ROW_BODY}>
                  <span className={ASSETS_ROW_NAME}>{name}</span>
                  <span className={ASSETS_ROW_META}>
                    <span
                      className={cn(
                        ASSETS_ROW_DETAIL,
                        !file.description && "tabular-nums",
                      )}
                    >
                      {file.description || formatAssetSize(file.size)}
                    </span>
                    {file.mtime && (
                      <span
                        className={ASSETS_ROW_TIME}
                        title={fullTime(file.mtime)}
                      >
                        {shortTime(file.mtime)}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
