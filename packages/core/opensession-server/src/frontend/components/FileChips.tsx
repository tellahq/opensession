import React from "react";
import { extBadge, formatBytes, type FileAttachment } from "../lib/images";
import type { PendingFileProgress } from "../lib/attachments";
import * as stylex from "@stylexjs/stylex";
import { fileChip, FileChipRemove } from "../ui/file-chip";
import { cn } from "../ui/cn";
import { sx } from "../ui/sx";

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
        <FileChipRemove
          label="Cancel file upload"
          onClick={() => onRemovePending(i)}
          disabled={disabled}
        />
      )
    );
  };
  return (
    <div {...stylex.props(fileChip.row)}>
      {files.map((f, i) => (
        <div
          key={i}
          {...stylex.props(fileChip.card, fileChip.removable)}
          title={f.name}
        >
          <span {...stylex.props(fileChip.badge)}>{extBadge(f.name)}</span>
          <span {...stylex.props(fileChip.meta)}>
            <span {...stylex.props(fileChip.name)}>{f.name}</span>
            <span {...stylex.props(fileChip.sub)}>Attachment</span>
          </span>
          <FileChipRemove
            label="Remove file"
            onClick={() => onRemove(i)}
            disabled={disabled}
          />
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
              {...sx([fileChip.card, fileChip.removable], "animate-pulse")}
            >
              <span {...sx(fileChip.badge, "bg-hover")} />
              <span {...stylex.props(fileChip.meta)}>
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
            {...sx([fileChip.card, fileChip.removable], "overflow-hidden")}
            title={upload.name}
          >
            <span {...sx(fileChip.badge, "opacity-60")}>
              {extBadge(upload.name)}
            </span>
            <span {...stylex.props(fileChip.meta)}>
              <span {...stylex.props(fileChip.name)}>{upload.name}</span>
              <span {...sx(fileChip.sub, "tabular-nums")}>
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
                  "block h-full bg-accent transition-[width] duration-long ease-standard motion-reduce:transition-none",
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
