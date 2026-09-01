import { mergeStylexProps } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { cn } from "../ui/cn";
import {
  REGION_HANDLES,
  type MediaLightboxViewerProps,
} from "../lib/media-lightbox-viewer";
import { useMediaZoomGesture } from "../hooks/useMediaZoomGesture";
import { IconPencil, IconTrash } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  boxBorder: {
    boxSizing: "border-box",
  },
  shrink0: {
    flexShrink: "0",
  },
  rounded2xl: {
    borderRadius: "calc(22px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderWhite20: {
    borderColor: "color-mix(in oklab, var(--color-white) 20%, transparent)",
  },
  bgVarDiagramCanvas: {
    backgroundColor: "var(--diagram-canvas)",
  },
  p4: {
    padding: "calc(4px * 4)",
  },
  TransformOrigin00: {
    transformOrigin: "0 0",
  },
  minH0: {
    minHeight: "0",
  },
  minW0: {
    minWidth: "0",
  },
  maxHFull: {
    maxHeight: "100%",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  objectContain: {
    objectFit: "contain",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  z3: {
    zIndex: "3",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  grid: {
    display: "grid",
  },
  size10: {
    width: "calc(4px * 10)",
    height: "calc(4px * 10)",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  p0: {
    padding: "0",
  },
  phoneSize11: {
    "@media (max-width: 720px)": {
      width: "calc(4px * 11)",
      height: "calc(4px * 11)",
    },
  },
  size25: {
    width: "calc(4px * 2.5)",
    height: "calc(4px * 2.5)",
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  transitionTransform: {
    transitionProperty: "transform, translate, scale, rotate",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  durationVarDurMicro: {
    transitionDuration: "var(--dur-micro)",
  },
  easeVarEase: {
    transitionTimingFunction: "var(--ease)",
  },
  motionReduceTransitionNone: {
    "@media (prefers-reduced-motion: reduce)": {
      "@media (prefers-reduced-motion:reduce)": {
        transitionProperty: "none",
      },
    },
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textWhite70: {
    color: "color-mix(in oklab, var(--color-white) 70%, transparent)",
  },
  hoverBgWhite10: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor:
          "color-mix(in oklab, var(--color-white) 10%, transparent)",
      },
    },
  },
  hoverTextWhite: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--color-white)",
      },
    },
  },
  activeScale096: {
    ":active": {
      scale: "0.96",
    },
  },
  cursorMove: {
    cursor: "move",
  },
  touchNone: {
    touchAction: "none",
  },
  rounded3px: {
    borderRadius: "3px",
    cornerShape: "var(--cs)",
  },
  borderWhite: {
    borderColor: "var(--color-white)",
  },
});

/**
 * Pinch, pan, and zoom surface for one image or diagram. The wrapper owns the
 * gesture so pinches starting beside letterboxed media still work. At fit
 * scale, horizontal drags page through the gallery and downward drags dismiss.
 */
export function MediaLightboxViewer({
  src,
  diagram,
  onTapBackdrop,
  onTapMedia,
  onZoomChange,
  onSwipe,
  onDismiss,
  onDragProgress,
  enterFrom = 0,
  viewTransitionName,
  commentMode = false,
  selection,
  onSelection,
  onSelectionRect,
  annotations = [],
  onEditAnnotation,
  onDeleteAnnotation,
}: MediaLightboxViewerProps) {
  const {
    wrapRef,
    imgRef,
    boxRef,
    fit,
    zoomed,
    imageBox,
    openAnnotation,
    setOpenAnnotation,
    shownRegionBox,
    handlesOutside,
    handleHit,
    handleStep,
    onPointerDown,
    onPointerMove,
    onPointerEnd,
    onPointerCancel,
    onMediaLoad,
  } = useMediaZoomGesture({
    src,
    diagram,
    onTapBackdrop,
    onTapMedia,
    onZoomChange,
    onSwipe,
    onDismiss,
    onDragProgress,
    enterFrom,
    commentMode,
    selection,
    onSelection,
    onSelectionRect,
    annotations,
  });

  return (
    <div
      ref={wrapRef}
      className={utilityClassName(
        `relative flex min-h-0 min-w-0 flex-1 touch-none select-none items-center justify-center self-stretch ${
          commentMode
            ? "cursor-crosshair"
            : zoomed
              ? "cursor-grab"
              : "cursor-zoom-in"
        }`,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerCancel}
    >
      {diagram ? (
        <div
          ref={boxRef}
          role="img"
          aria-label="Diagram"
          // The same hairline and corner the photo takes, over the well
          // the diagram is drawn on in the transcript: a light-theme
          // chart is near-black ink, which would be unreadable straight
          // on the scrim.
          {...mergeStylexProps(
            "[&>svg]:block [&>svg]:h-full [&>svg]:w-full",
            sx.boxBorder,
            sx.shrink0,
            sx.rounded2xl,
            sx.border,
            sx.borderWhite20,
            sx.bgVarDiagramCanvas,
            sx.p4,
            sx.TransformOrigin00,
          )}
          style={{ width: fit?.w, height: fit?.h, viewTransitionName }}
          // The markup is mermaid's own output, already rendered into the
          // transcript by MarkdownBody; this is the same SVG, resized.
          dangerouslySetInnerHTML={{ __html: diagram.svg }}
        />
      ) : (
        <>
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            // object-contain sizes the box from the decoded picture, so the
            // box before load is not the box after it.
            onLoad={onMediaLoad}
            // The scrim is near-black in both themes, so a dark screenshot
            // opened full size has no edge of its own and bleeds into it.
            // A white hairline rather than border-line-strong: this surface
            // is always dark, like the rest of the lightbox chrome.
            // The top of the radius scale, because this is the largest
            // floating surface in the app and a card-sized corner on a
            // screen-sized photo reads as a crop rather than a shape.
            // Anything rounder would leave the scale, and it starts
            // clipping content that sits in a screenshot's own corner.
            {...stylex.props(
              sx.minH0,
              sx.minW0,
              sx.maxHFull,
              sx.maxWFull,
              sx.rounded2xl,
              sx.border,
              sx.borderWhite20,
              sx.objectContain,
              sx.TransformOrigin00,
            )}
            style={{ viewTransitionName }}
          />
          {commentMode && shownRegionBox && imageBox && (
            /* What you chose stays at full brightness and everything else
						   steps back, rather than the selection wearing a coloured wash.
						   One spread shadow paints the whole surround; the wrapper clips
						   it to the picture's own rounded box so it cannot leak over the
						   scrim and the chrome. */
            <div
              {...stylex.props(
                sx.pointerEventsNone,
                sx.absolute,
                sx.overflowHidden,
                sx.rounded2xl,
              )}
              style={{
                left: imageBox.left,
                top: imageBox.top,
                width: imageBox.width,
                height: imageBox.height,
              }}
              aria-hidden="true"
            >
              <div
                {...mergeStylexProps(
                  "shadow-[0_0_0_9999px_rgb(0_0_0/0.5)]",
                  sx.absolute,
                )}
                style={{
                  left: shownRegionBox.left - imageBox.left,
                  top: shownRegionBox.top - imageBox.top,
                  width: shownRegionBox.width,
                  height: shownRegionBox.height,
                }}
              />
            </div>
          )}
          {imageBox &&
            !zoomed &&
            annotations.map((annotation) => {
              const centerX = annotation.region.x + annotation.region.width / 2;
              const centerY =
                annotation.region.y + annotation.region.height / 2;
              const open = openAnnotation === annotation.id;
              const opensLeft = centerX > 0.62;
              return (
                <div
                  key={annotation.id}
                  {...mergeStylexProps(
                    "group/annotation",
                    sx.absolute,
                    sx.z3,
                    sx.flex,
                    sx.itemsCenter,
                  )}
                  style={{
                    left: imageBox.left + centerX * imageBox.width,
                    top: imageBox.top + centerY * imageBox.height,
                    transform: "translate(-50%, -50%)",
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    {...mergeStylexProps(
                      "focus-ring",
                      sx.grid,
                      sx.size10,
                      sx.shrink0,
                      sx.placeItemsCenter,
                      sx.roundedFull,
                      sx.border0,
                      sx.bgTransparent,
                      sx.p0,
                      sx.phoneSize11,
                    )}
                    onClick={() =>
                      setOpenAnnotation(open ? null : annotation.id)
                    }
                    aria-label={`Show annotation: ${annotation.text}`}
                    aria-expanded={open}
                  >
                    <span
                      {...mergeStylexProps(
                        "shadow-[0_1px_4px_rgb(0_0_0/0.28),0_0_0_1px_rgb(255_255_255/0.18)] group-hover/annotation:scale-[1.22] group-focus-within/annotation:scale-[1.22]",
                        sx.size25,
                        sx.roundedFull,
                        sx.bgAccent,
                        sx.transitionTransform,
                        sx.durationVarDurMicro,
                        sx.easeVarEase,
                        sx.motionReduceTransitionNone,
                      )}
                    />
                  </button>
                  <div
                    className={cn(
                      utilityClassName(
                        "absolute top-1/2 flex w-[min(260px,56vw)] -translate-y-1/2 items-center gap-1 rounded-popup bg-black/70 p-1.5 pl-3 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_10px_30px_rgb(0_0_0/0.38)] backdrop-blur-xl transition-[opacity,scale] duration-[var(--dur-micro)] ease-[var(--ease)] motion-reduce:transition-none",
                      ),
                      opensLeft
                        ? utilityClassName("right-full mr-1 origin-right")
                        : utilityClassName("left-full ml-1 origin-left"),
                      open
                        ? utilityClassName(
                            "pointer-events-auto scale-100 opacity-100",
                          )
                        : utilityClassName(
                            "pointer-events-none scale-[0.96] opacity-0 group-hover/annotation:pointer-events-auto group-hover/annotation:scale-100 group-hover/annotation:opacity-100 group-focus-within/annotation:pointer-events-auto group-focus-within/annotation:scale-100 group-focus-within/annotation:opacity-100",
                          ),
                    )}
                  >
                    <span
                      {...stylex.props(
                        sx.minW0,
                        sx.flex1,
                        sx.truncate,
                        sx.fontMedium,
                        typography.label,
                      )}
                    >
                      {annotation.text}
                    </span>
                    {onEditAnnotation && (
                      <button
                        type="button"
                        {...stylex.props(
                          sx.grid,
                          sx.size10,
                          sx.shrink0,
                          sx.placeItemsCenter,
                          sx.roundedFull,
                          sx.border0,
                          sx.bgTransparent,
                          sx.p0,
                          sx.textWhite70,
                          sx.hoverBgWhite10,
                          sx.hoverTextWhite,
                          sx.activeScale096,
                          sx.phoneSize11,
                        )}
                        onClick={() => onEditAnnotation(annotation)}
                        aria-label="Edit annotation"
                      >
                        <IconPencil size={17} />
                      </button>
                    )}
                    {onDeleteAnnotation && (
                      <button
                        type="button"
                        {...stylex.props(
                          sx.grid,
                          sx.size10,
                          sx.shrink0,
                          sx.placeItemsCenter,
                          sx.roundedFull,
                          sx.border0,
                          sx.bgTransparent,
                          sx.p0,
                          sx.textWhite70,
                          sx.hoverBgWhite10,
                          sx.hoverTextWhite,
                          sx.activeScale096,
                          sx.phoneSize11,
                        )}
                        onClick={() => onDeleteAnnotation(annotation)}
                        aria-label="Delete annotation"
                      >
                        <IconTrash size={17} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          {commentMode && shownRegionBox && (
            <div
              // The region is a thing you can take hold of, not a mark:
              // press it to move it, press a handle to resize it.
              // Dragging bare picture still starts a new one.
              data-region-handle="move"
              // A hairline, not a coloured frame: the dimmed surround is
              // what says where the selection is, so the line only has to
              // trace it. The dark hairline under it keeps the white edge
              // legible on a white screenshot.
              {...mergeStylexProps(
                "shadow-[0_0_0_1px_rgb(0_0_0/0.22)]",
                sx.absolute,
                sx.cursorMove,
                sx.touchNone,
                sx.rounded3px,
                sx.border,
                sx.borderWhite,
              )}
              style={shownRegionBox}
              aria-hidden="true"
            >
              {REGION_HANDLES.filter(
                (handle) =>
                  // An edge handle needs a side long enough to hold one
                  // without crowding the corners it sits between, and
                  // a framed region has no room for one at all.
                  !handlesOutside &&
                  (handle.axis !== "x" || shownRegionBox.width >= 56) &&
                  (handle.axis !== "y" || shownRegionBox.height >= 56),
              )
                .concat(
                  handlesOutside
                    ? REGION_HANDLES.filter((handle) => !handle.axis)
                    : [],
                )
                .map((handle) => (
                  <span
                    key={handle.id}
                    data-region-handle={handle.id}
                    // The mark stays small so it cannot hide a small
                    // region; the square around it is what the finger
                    // gets.
                    className={cn(
                      utilityClassName(
                        "absolute grid touch-none place-items-center",
                      ),
                      handle.position,
                      handle.cursor,
                    )}
                    style={{
                      width: handleHit,
                      height: handleHit,
                      transform: `translate(calc(-50% + ${handle.sx * handleStep}px), calc(-50% + ${handle.sy * handleStep}px))`,
                    }}
                  >
                    <span
                      className={cn(
                        utilityClassName(
                          "block border-white drop-shadow-[0_0_2px_rgb(0_0_0/0.5)]",
                        ),
                        handle.mark,
                      )}
                    />
                  </span>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
