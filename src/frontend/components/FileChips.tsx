import React from "react";
import type { FileAttachment } from "../lib/images";
import { cn } from "../ui/cn";

interface Props {
  files: FileAttachment[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}

/** Short uppercase extension badge for a filename (e.g. "PDF", "TS"), or "FILE". */
function extBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "FILE";
  return name.slice(dot + 1, dot + 5).toUpperCase();
}

/** Removable preview cards for non-image file attachments (staged to disk server-side). */
export function FileChips({ files, onRemove, disabled }: Props) {
  if (files.length === 0) return null;
  return (
    <div className="composer-files mb-2 flex flex-wrap gap-2">
      {files.map((f, i) => (
        <div key={i} className="composer-file-card relative inline-flex max-w-60 items-center gap-[9px] rounded-lg border border-line-strong bg-hover py-1.5 pr-[26px] pl-1.5" title={f.name}>
          <span className="composer-file-thumb inline-flex size-[34px] shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[9.5px] font-bold tracking-[0.02em] text-accent">{extBadge(f.name)}</span>
          <span className="composer-file-meta flex min-w-0 flex-col gap-px">
            <span className="composer-file-name truncate text-supporting text-fg">{f.name}</span>
            <span className="composer-file-sub text-meta text-faint">Attachment</span>
          </span>
          <button
            type="button"
            className={cn("composer-file-remove absolute top-1 right-1.5 shrink-0 border-0 bg-transparent p-0 text-[15px] leading-none text-faint hover:not-disabled:text-fg", "disabled:cursor-default disabled:opacity-50")}
            onClick={() => onRemove(i)}
            disabled={disabled}
            title="Remove file"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
