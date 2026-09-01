import React from "react";
import type { ImageAttachmentComment } from "../lib/image-attachment-comment";
import type { ImageRegion } from "../lib/image-region-comment";
import {
  openLightbox,
  type ImageRegionAnnotation,
} from "../lib/media-lightbox";
import { IconX } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { motionStyles } from "../styles/animations.stylex";
import { mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mb2: {
    marginBottom: "8px",
  },
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gap2: {
    gap: "8px",
  },
  relative: {
    position: "relative",
  },
  leading0: {
    lineHeight: "0",
  },
  focusRing: {
    ":focus-visible": {
      outline: "2px solid var(--accent-ink)",
      outlineOffset: "2px",
    },
  },
  block: {
    display: "block",
  },
  cursorZoomIn: {
    cursor: "zoom-in",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  h14: {
    height: "56px",
  },
  wAuto: {
    width: "auto",
  },
  maxW120px: {
    maxWidth: "120px",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine60: {
    borderColor: "var(--border)",
  },
  objectCover: {
    objectFit: "cover",
  },
  absolute: {
    position: "absolute",
  },
  Top15: {
    top: "-6px",
  },
  Right15: {
    right: "-6px",
  },
  size18px: {
    width: "18px",
    height: "18px",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgFg: {
    backgroundColor: "var(--text)",
  },
  p0: {
    padding: "0",
  },
  textPanel: {
    color: "var(--bg-panel)",
  },
  w100px: {
    width: "100px",
  },
  animatePulse: {
    animation: "var(--animate-pulse)",
  },
  borderLineStrong: {
    borderColor: "var(--border-strong)",
  },
  bgHover: {
    backgroundColor: "var(--hover)",
  },
});

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
    <div {...stylex.props(sx.mb2, sx.flex, sx.flexWrap, sx.gap2)}>
      {images.map((src, i) => (
        <div key={i} {...stylex.props(sx.relative, sx.leading0)}>
          <button
            type="button"
            // The radius is only visible through the focus ring, which has to
            // follow the thumbnail's corner rather than cut across it.
            {...stylex.props(
              sx.focusRing,
              sx.block,
              sx.cursorZoomIn,
              sx.roundedControl,
              sx.leading0,
            )}
            onClick={(event) =>
              openLightbox(
                images.map((image, imageIndex) => ({
                  kind: "image" as const,
                  src: image,
                  regionAnnotations: comments
                    .filter((comment) => comment.imageIndex === imageIndex)
                    .map(({ id, region, text }) => ({ id, region, text })),
                  ...(onComment
                    ? {
                        onRegionComment: ({
                          region,
                          text,
                          keepOpen,
                          existing,
                        }: {
                          region: ImageRegion;
                          text: string;
                          keepOpen: boolean;
                          existing?: ImageRegionAnnotation;
                        }) =>
                          onComment(
                            imageIndex,
                            region,
                            text,
                            keepOpen,
                            existing,
                          ),
                      }
                    : {}),
                  ...(onDeleteComment
                    ? {
                        onDeleteRegionComment: (
                          annotation: ImageRegionAnnotation,
                        ) => onDeleteComment(imageIndex, annotation),
                      }
                    : {}),
                })),
                i,
                event.currentTarget,
              )
            }
            aria-label="Open image preview"
          >
            <img
              src={src}
              alt=""
              {...stylex.props(
                sx.h14,
                sx.wAuto,
                sx.maxW120px,
                sx.roundedControl,
                sx.border,
                sx.borderLine60,
                sx.objectCover,
              )}
            />
          </button>
          <button
            type="button"
            {...stylex.props(
              sx.absolute,
              sx.Top15,
              sx.Right15,
              sx.flex,
              sx.size18px,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.roundedFull,
              sx.bgFg,
              sx.p0,
              sx.textPanel,
            )}
            onClick={() => onRemove(i)}
            disabled={disabled}
            title="Remove image"
          >
            <IconX
              className={mergeStylexOverrideClassName("", sx.block)}
              size={12}
              dense
            />
          </button>
        </div>
      ))}
      {/* The shape the picture will take, in the place it will take it: the
          app's skeleton language (a bordered block that breathes) rather than
          a spinner, which in this product means an agent is working. 100px is
          a 16:9 screenshot at this height, so the common paste barely moves
          when the real thumbnail lands. */}
      {Array.from({ length: pending }, (_, i) => (
        <div key={`staging-${i}`} {...stylex.props(sx.relative)}>
          <div
            {...stylex.props(
              sx.h14,
              sx.w100px,
              motionStyles.pulse,
              sx.roundedControl,
              sx.border,
              sx.borderLineStrong,
              sx.bgHover,
            )}
          />
          {onRemovePending && (
            <button
              type="button"
              {...stylex.props(
                sx.absolute,
                sx.Top15,
                sx.Right15,
                sx.flex,
                sx.size18px,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.roundedFull,
                sx.bgFg,
                sx.p0,
                sx.textPanel,
              )}
              onClick={() => onRemovePending(i)}
              disabled={disabled}
              aria-label="Cancel image upload"
              title="Cancel image upload"
            >
              <IconX
                className={mergeStylexOverrideClassName("", sx.block)}
                size={12}
                dense
              />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
