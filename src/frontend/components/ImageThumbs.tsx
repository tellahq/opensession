import React from "react";
import { openLightbox } from "./MediaLightbox";
import { cn } from "../ui/cn";

interface Props {
  /** Attached images as `data:` URLs. */
  images: string[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}

/** Removable thumbnail row for pasted/dropped image attachments. */
export function ImageThumbs({ images, onRemove, disabled }: Props) {
  if (images.length === 0) return null;
  return (
    <div className="composer-images mb-2 flex flex-wrap gap-2">
      {images.map((src, i) => (
        <div key={i} className="composer-image-thumb relative leading-none">
          <button
            type="button"
            className="composer-image-preview block cursor-zoom-in border-0 bg-transparent p-0 leading-none outline-none focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            onClick={(event) =>
              openLightbox(
                images.map((image) => ({ kind: "image", src: image })),
                i,
                event.currentTarget,
              )
            }
            aria-label="Open image preview"
          >
            <img src={src} alt="" className="h-14 w-auto max-w-30 rounded-md border border-line-strong object-cover" />
          </button>
          <button
            type="button"
            className={cn("composer-image-remove absolute -top-1.5 -right-1.5 flex size-[18px] items-center justify-center rounded-full border-0 bg-fg p-0 text-control-label leading-none text-panel", "disabled:cursor-default disabled:opacity-50")}
            onClick={() => onRemove(i)}
            disabled={disabled}
            title="Remove image"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
