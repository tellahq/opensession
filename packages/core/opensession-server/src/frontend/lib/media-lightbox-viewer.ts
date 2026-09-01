import type { DiagramMedia } from "./diagram-media";
import type {
  ImageRegion,
  RegionHandle,
  ScreenRect,
} from "./image-region-comment";
import type { ImageRegionAnnotation } from "./media-lightbox";

export interface MediaLightboxViewerProps {
  src: string;
  diagram?: DiagramMedia;
  onTapBackdrop: () => void;
  onTapMedia?: () => void;
  onZoomChange: (zoomed: boolean) => void;
  onSwipe?: (direction: -1 | 1) => void;
  onDismiss?: () => void;
  onDragProgress?: (progress: number) => void;
  enterFrom?: -1 | 0 | 1;
  viewTransitionName?: string;
  commentMode?: boolean;
  selection?: ImageRegion | null;
  onSelection?: (region: ImageRegion) => void;
  onSelectionRect?: (rect: ScreenRect | null) => void;
  annotations?: ImageRegionAnnotation[];
  onEditAnnotation?: (annotation: ImageRegionAnnotation) => void;
  onDeleteAnnotation?: (annotation: ImageRegionAnnotation) => void;
}

export const MAX_SCALE = 8;
export const DOUBLE_TAP_SCALE = 2.5;

/** Air between a diagram and its own edge, so the drawing is not flush against
 * the corner of the surface it sits on. */
export const DIAGRAM_PADDING = 16;

/** How far a slow downward drag has to travel before letting go closes. A
 * flick gets there sooner. */
export const DISMISS_DISTANCE = 120;

/** Corners first, then edges: the corner is what the hand reaches for, and on
 *  a short side it is the only handle that fits. `sx`/`sy` are the directions
 *  the handle lies in from the region's middle, which is both where it sits and
 *  which way it steps when the region is too small to hold it.
 *
 *  `mark` is what the handle draws, which is not the same thing as what it
 *  catches. A corner is a bracket whose two bars run along the edges they
 *  resize, meeting exactly on the corner; an edge is a short bar lying along
 *  the line it moves. Both are white with a soft dark halo, because the picture
 *  underneath is as likely to be a white settings pane as a dark one. */
export const REGION_HANDLES: {
  id: RegionHandle;
  /** The side whose length has to be long enough to hold this handle. */
  axis?: "x" | "y";
  position: string;
  cursor: string;
  mark: string;
  sx: -1 | 0 | 1;
  sy: -1 | 0 | 1;
}[] = [
  {
    id: "nw",
    position: "left-0 top-0",
    sx: -1,
    sy: -1,
    cursor: "cursor-nwse-resize",
    mark: "absolute left-1/2 top-1/2 size-3.5 rounded-tl-[4px] border-l-[3px] border-t-[3px] phone:size-4",
  },
  {
    id: "ne",
    position: "left-full top-0",
    sx: 1,
    sy: -1,
    cursor: "cursor-nesw-resize",
    mark: "absolute right-1/2 top-1/2 size-3.5 rounded-tr-[4px] border-r-[3px] border-t-[3px] phone:size-4",
  },
  {
    id: "se",
    position: "left-full top-full",
    sx: 1,
    sy: 1,
    cursor: "cursor-nwse-resize",
    mark: "absolute right-1/2 bottom-1/2 size-3.5 rounded-br-[4px] border-r-[3px] border-b-[3px] phone:size-4",
  },
  {
    id: "sw",
    position: "left-0 top-full",
    sx: -1,
    sy: 1,
    cursor: "cursor-nesw-resize",
    mark: "absolute left-1/2 bottom-1/2 size-3.5 rounded-bl-[4px] border-l-[3px] border-b-[3px] phone:size-4",
  },
  {
    id: "n",
    axis: "x",
    position: "left-1/2 top-0",
    sx: 0,
    sy: -1,
    cursor: "cursor-ns-resize",
    mark: "h-[3px] w-5 rounded-full bg-white",
  },
  {
    id: "s",
    axis: "x",
    position: "left-1/2 top-full",
    sx: 0,
    sy: 1,
    cursor: "cursor-ns-resize",
    mark: "h-[3px] w-5 rounded-full bg-white",
  },
  {
    id: "w",
    axis: "y",
    position: "left-0 top-1/2",
    sx: -1,
    sy: 0,
    cursor: "cursor-ew-resize",
    mark: "h-5 w-[3px] rounded-full bg-white",
  },
  {
    id: "e",
    axis: "y",
    position: "left-full top-1/2",
    sx: 1,
    sy: 0,
    cursor: "cursor-ew-resize",
    mark: "h-5 w-[3px] rounded-full bg-white",
  },
];

/** Touch-sized on a phone, pointer-sized otherwise. */
export const REGION_HANDLE_HIT = { phone: 36, desktop: 24 };
