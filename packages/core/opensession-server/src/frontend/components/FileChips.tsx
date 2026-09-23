import React from "react";
import { extBadge, formatBytes, type FileAttachment } from "../lib/images";
import type { PendingFileProgress } from "../lib/attachments";
import {
  fileChipCard,
  fileChipCardPaddingRemovable,
  fileChipMeta,
  fileChipName,
  fileChipRow,
  fileChipSub,
  fileChipThumb,
} from "../lib/composer-classes";
import { cn } from "../ui/cn";

interface Props {
  files: FileAttachment[];
  onRemove: (index: number) => void;
  disabled?: boolean;
  /** Files still on their way to disk: a ghost card each, in the row where
   *  they will land. See ImageThumbs for why they are shown at all. */
  pending?: number;
  /** Name and progress for each pending card, when the caller tracks them. */
  progress?: PendingFileProgress[];
  onRemovePending?: (index: number) => void;
}

/** Removable preview cards for non-image file attachments (staged to disk server-side). */
export function FileChips({
  files,
  onRemove,
  disabled,
  pending = 0,
  progress,
  onRemovePending,
}: Props) {
  if (files.length === 0 && pending < 1) return null;
  const cancelButton = (i: number) => {
    return (
      onRemovePending && (
        <button
          type="button"
          className="absolute top-1 right-[5px] shrink-0 text-[15px] leading-none text-faint enabled:hover:text-fg disabled:cursor-default disabled:opacity-50"
          onClick={() => onRemovePending(i)}
          disabled={disabled}
          aria-label="Cancel file upload"
          title="Cancel file upload"
        >
          ×
        </button>
      )
    );
  };
  return (
    <div className={fileChipRow}>
      {files.map((f, i) => (
        <div
          key={i}
          className={cn(fileChipCard, fileChipCardPaddingRemovable)}
          title={f.name}
        >
          <span className={fileChipThumb}>{extBadge(f.name)}</span>
          <span className={fileChipMeta}>
            <span className={fileChipName}>{f.name}</span>
            <span className={fileChipSub}>Attachment</span>
          </span>
          <button
            type="button"
            className="absolute top-1 right-[5px] shrink-0 text-[15px] leading-none text-faint enabled:hover:text-fg disabled:cursor-default disabled:opacity-50"
            onClick={() => onRemove(i)}
            disabled={disabled}
            title="Remove file"
          >
            ×
          </button>
        </div>
      ))}
      {/* The card it will become, named from the start: the badge and name
          are known the moment you pick the file, and a multi-gigabyte upload
          is minutes of waiting that should say how far along it is. The bar
          runs along the card's foot so the chip keeps its resting height. */}
      {Array.from({ length: pending }, (_, i) => {
        const upload = progress?.[i];
        if (!upload)
          return (
            <div
              key={`staging-${i}`}
              className={cn(
                fileChipCard,
                fileChipCardPaddingRemovable,
                "animate-pulse",
              )}
            >
              <span className={cn(fileChipThumb, "bg-hover")} />
              <span className={fileChipMeta}>
                <span className="h-3 w-[92px] rounded-sm bg-hover" />
                <span className="h-2.5 w-[46px] rounded-sm bg-hover" />
              </span>
              {cancelButton(i)}
            </div>
          );
        const percent = Math.round(upload.fraction * 100);
        return (
          <div
            key={`staging-${i}`}
            className={cn(
              fileChipCard,
              fileChipCardPaddingRemovable,
              "overflow-hidden",
            )}
            title={upload.name}
          >
            <span className={cn(fileChipThumb, "opacity-60")}>
              {extBadge(upload.name)}
            </span>
            <span className={fileChipMeta}>
              <span className={fileChipName}>{upload.name}</span>
              <span className={cn(fileChipSub, "tabular-nums")}>
                {percent > 0
                  ? `${percent}% of ${formatBytes(upload.size)}`
                  : `Uploading ${formatBytes(upload.size)}…`}
              </span>
            </span>
            <span
              role="progressbar"
              aria-label={`Uploading ${upload.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="absolute inset-x-0 bottom-0 h-[3px] bg-fg/8"
            >
              <span
                className={cn(
                  "block h-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none",
                  percent === 0 && "w-1/5 animate-pulse",
                )}
                style={percent > 0 ? { width: `${percent}%` } : undefined}
              />
            </span>
            {cancelButton(i)}
          </div>
        );
      })}
    </div>
  );
}
