import type { DeskCorner, DeskResizeHandle } from "./desk-panel";

/** The Desk header doubles as the panel's grab bar on desktop. `touch-none`
 *  keeps a finger drag on a tablet from scrolling the page underneath. */
export const DESK_PANEL_GRAB =
  "cursor-grab select-none touch-none active:cursor-grabbing";

/** Invisible strips along the shell's edges and squares on its corners. They
 *  sit inside the shell (it clips overflow), the corners listed last so they
 *  win over the edges where the two overlap. */
export const DESK_PANEL_HANDLE = "absolute z-[1] touch-none";

export const DESK_PANEL_HANDLES: {
  id: DeskResizeHandle;
  className: string;
  /** The CSS cursor the document shows for the whole drag, not just while the
   *  pointer is over the 6px handle. */
  cursor: string;
}[] = [
  {
    id: "n",
    className: "inset-x-3 top-0 h-1.5 cursor-ns-resize",
    cursor: "ns-resize",
  },
  {
    id: "s",
    className: "inset-x-3 bottom-0 h-1.5 cursor-ns-resize",
    cursor: "ns-resize",
  },
  {
    id: "w",
    className: "inset-y-3 left-0 w-1.5 cursor-ew-resize",
    cursor: "ew-resize",
  },
  {
    id: "e",
    className: "inset-y-3 right-0 w-1.5 cursor-ew-resize",
    cursor: "ew-resize",
  },
  {
    id: "nw",
    className: "left-0 top-0 size-3.5 cursor-nwse-resize",
    cursor: "nwse-resize",
  },
  {
    id: "ne",
    className: "right-0 top-0 size-3.5 cursor-nesw-resize",
    cursor: "nesw-resize",
  },
  {
    id: "sw",
    className: "bottom-0 left-0 size-3.5 cursor-nesw-resize",
    cursor: "nesw-resize",
  },
  {
    id: "se",
    className: "bottom-0 right-0 size-3.5 cursor-nwse-resize",
    cursor: "nwse-resize",
  },
];

/** The panel pops from the corner it is parked in, so the summon reads as
 *  growing out of the trigger rather than appearing from nowhere. */
export const DESK_PANEL_ORIGIN: Record<DeskCorner, string> = {
  "top-left": "origin-top-left",
  "top-right": "origin-top-right",
  "bottom-left": "origin-bottom-left",
  "bottom-right": "origin-bottom-right",
};
