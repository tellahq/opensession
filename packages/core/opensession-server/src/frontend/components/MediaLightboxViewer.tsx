import { cn } from "../ui/cn";
import {
  REGION_HANDLES,
  type MediaLightboxViewerProps,
} from "../lib/media-lightbox-viewer";
import { useMediaZoomGesture } from "../hooks/useMediaZoomGesture";
import { IconPencil, IconTrash } from "./icons";

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
      className={`relative flex min-h-0 min-w-0 flex-1 touch-none select-none items-center justify-center self-stretch ${
        commentMode
          ? "cursor-crosshair"
          : zoomed
            ? "cursor-grab"
            : "cursor-zoom-in"
      }`}
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
          // Its right-click menu (DiagramContextMenu.tsx) finds it by this.
          data-lightbox-diagram=""
          // The same hairline and corner the photo takes, over the well
          // the diagram is drawn on in the transcript: a light-theme
          // chart is near-black ink, which would be unreadable straight
          // on the scrim.
          className="box-border shrink-0 rounded-2xl border border-line bg-[var(--diagram-canvas)] p-4 [transform-origin:0_0] [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
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
            // The scrim is the page's own colour, frosted, so a screenshot in
            // the same theme has no edge of its own and bleeds into it. The
            // theme's hairline gives it one in both, as the video has.
            // The top of the radius scale, because this is the largest
            // floating surface in the app and a card-sized corner on a
            // screen-sized photo reads as a crop rather than a shape.
            // Anything rounder would leave the scale, and it starts
            // clipping content that sits in a screenshot's own corner.
            className="min-h-0 min-w-0 max-h-full max-w-full rounded-2xl border border-line object-contain [transform-origin:0_0]"
            style={{ viewTransitionName }}
          />
          {commentMode && shownRegionBox && imageBox && (
            /* What you chose stays at full brightness and everything else
						   steps back, rather than the selection wearing a coloured wash.
						   One spread shadow paints the whole surround; the wrapper clips
						   it to the picture's own rounded box so it cannot leak over the
						   scrim and the chrome. */
            <div
              className="pointer-events-none absolute overflow-hidden rounded-2xl"
              style={{
                left: imageBox.left,
                top: imageBox.top,
                width: imageBox.width,
                height: imageBox.height,
              }}
              aria-hidden="true"
            >
              <div
                className="absolute shadow-[0_0_0_9999px_rgb(0_0_0/0.5)]"
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
                  className="group/annotation absolute z-3 flex items-center"
                  style={{
                    left: imageBox.left + centerX * imageBox.width,
                    top: imageBox.top + centerY * imageBox.height,
                    transform: "translate(-50%, -50%)",
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="focus-ring grid size-10 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 phone:size-11"
                    onClick={() =>
                      setOpenAnnotation(open ? null : annotation.id)
                    }
                    aria-label={`Show annotation: ${annotation.text}`}
                    aria-expanded={open}
                  >
                    <span className="size-2.5 rounded-full bg-accent shadow-[0_1px_4px_rgb(0_0_0/0.28),0_0_0_1px_rgb(255_255_255/0.18)] transition-transform duration-micro ease-standard group-hover/annotation:scale-grow group-focus-within/annotation:scale-grow motion-reduce:transition-none" />
                  </button>
                  <div
                    className={cn(
                      "absolute top-1/2 flex w-[min(260px,56vw)] -translate-y-1/2 items-center gap-1 rounded-popup bg-black/70 p-1.5 pl-3 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_10px_30px_rgb(0_0_0/0.38)] backdrop-blur-xl transition-[opacity,scale] duration-micro ease-standard motion-reduce:transition-none",
                      opensLeft
                        ? "right-full mr-1 origin-right"
                        : "left-full ml-1 origin-left",
                      open
                        ? "pointer-events-auto scale-100 opacity-100"
                        : "pointer-events-none scale-press opacity-0 group-hover/annotation:pointer-events-auto group-hover/annotation:scale-100 group-hover/annotation:opacity-100 group-focus-within/annotation:pointer-events-auto group-focus-within/annotation:scale-100 group-focus-within/annotation:opacity-100",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-label font-medium">
                      {annotation.text}
                    </span>
                    {onEditAnnotation && (
                      <button
                        type="button"
                        className="grid size-10 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-white/70 hover:bg-white/10 hover:text-white active:scale-press phone:size-11"
                        onClick={() => onEditAnnotation(annotation)}
                        aria-label="Edit annotation"
                      >
                        <IconPencil size={20} />
                      </button>
                    )}
                    {onDeleteAnnotation && (
                      <button
                        type="button"
                        className="grid size-10 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-white/70 hover:bg-white/10 hover:text-white active:scale-press phone:size-11"
                        onClick={() => onDeleteAnnotation(annotation)}
                        aria-label="Delete annotation"
                      >
                        <IconTrash size={20} />
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
              className="absolute cursor-move touch-none rounded-xs border border-white shadow-[0_0_0_1px_rgb(0_0_0/0.22)]"
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
                      "absolute grid touch-none place-items-center",
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
                        "block border-white drop-shadow-[0_0_2px_rgb(0_0_0/0.5)]",
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
