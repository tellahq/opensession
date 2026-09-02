import React from "react";
import type { ImageAttachmentComment } from "../lib/image-attachment-comment";
import type { ImageRegion } from "../lib/image-region-comment";
import {
  openLightbox,
  type ImageRegionAnnotation,
  type LightboxItem,
} from "../lib/media-lightbox";
import { IconX } from "./icons";

interface Props {
  /** Attached images as `data:` URLs. */
  images: string[];
  onRemove: (index: number) => void;
  comments?: ImageAttachmentComment[];
  /** Add or edit a region comment in the draft that owns these attachments. */
  onComment?: (
    index: number,
    region: ImageRegion,
    text: string,
    keepOpen: boolean,
    existing?: ImageRegionAnnotation,
  ) => void | Promise<void>;
  onDeleteComment?: (
    index: number,
    annotation: ImageRegionAnnotation,
  ) => void | Promise<void>;
  disabled?: boolean;
  /**
   * Images still on their way to disk. A paste is not attached until its
   * upload lands, which during a slow load is seconds of a composer that looks
   * like it ignored you — so each one stands here as a ghost tile until its
   * picture replaces it.
   */
  pending?: number;
  onRemovePending?: (index: number) => void;
}

/** Removable thumbnail row for pasted/dropped image attachments. */
export function ImageThumbs({
  images,
  onRemove,
  comments = [],
  onComment,
  onDeleteComment,
  disabled,
  pending = 0,
  onRemovePending,
}: Props) {
  if (images.length === 0 && pending < 1) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {images.map((src, i) => (
        <div key={i} className="relative leading-[0]">
          <button
            type="button"
            // The radius is only visible through the focus ring, which has to
            // follow the thumbnail's corner rather than cut across it.
            className="focus-ring block cursor-zoom-in rounded-control leading-[0]"
            onClick={(event) =>
              openLightbox(
                images.map((image, imageIndex) => {
                  const item: LightboxItem = {
                    kind: "image",
                    src: image,
                    regionAnnotations: comments
                      .filter((comment) => comment.imageIndex === imageIndex)
                      .map(({ id, region, text }) => ({ id, region, text })),
                  };
                  if (onComment) {
                    item.onRegionComment = ({
                      region,
                      text,
                      keepOpen,
                      existing,
                    }) =>
                      onComment(imageIndex, region, text, keepOpen, existing);
                  }
                  if (onDeleteComment) {
                    item.onDeleteRegionComment = (annotation) =>
                      onDeleteComment(imageIndex, annotation);
                  }
                  return item;
                }),
                i,
                event.currentTarget,
              )
            }
            aria-label="Open image preview"
          >
            <img
              src={src}
              alt=""
              className="h-14 w-auto max-w-[120px] rounded-control border border-line/60 object-cover"
            />
          </button>
          <button
            type="button"
            className="absolute -top-1.5 -right-1.5 flex size-[18px] items-center justify-center rounded-full bg-fg p-0 text-panel"
            onClick={() => onRemove(i)}
            disabled={disabled}
            title="Remove image"
          >
            <IconX className="block" size={12} dense />
          </button>
        </div>
      ))}
      {/* The shape the picture will take, in the place it will take it: the
          app's skeleton language (a bordered block that breathes) rather than
          a spinner, which in this product means an agent is working. 100px is
          a 16:9 screenshot at this height, so the common paste barely moves
          when the real thumbnail lands. */}
      {Array.from({ length: pending }, (_, i) => (
        <div key={`staging-${i}`} className="relative">
          <div className="h-14 w-[100px] animate-pulse rounded-control border border-line-strong bg-hover" />
          {onRemovePending && (
            <button
              type="button"
              className="absolute -top-1.5 -right-1.5 flex size-[18px] items-center justify-center rounded-full bg-fg p-0 text-panel"
              onClick={() => onRemovePending(i)}
              disabled={disabled}
              aria-label="Cancel image upload"
              title="Cancel image upload"
            >
              <IconX className="block" size={12} dense />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
