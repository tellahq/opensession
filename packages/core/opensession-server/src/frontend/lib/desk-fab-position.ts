const DESK_FAB_SIZE = 44;
const DESK_FAB_EDGE_INSET = 18;
const DESK_FAB_COMPOSER_GAP = 12;
const DESK_FAB_ABOVE_GAP = 10;

export interface DeskFabAnchorRect {
  right: number;
  top: number;
}

export interface DeskFabViewport {
  width: number;
  height: number;
}

export interface DeskFabPosition {
  left: number;
  bottom: number;
}

/**
 * Keep the Desk trigger in the window corner while there is room beside the
 * composer. When that position would cross the viewport edge, put it directly
 * above the composer instead.
 */
export function calculateDeskFabPosition(
  anchor: DeskFabAnchorRect,
  viewport: DeskFabViewport,
): DeskFabPosition {
  const cornerLeft = viewport.width - DESK_FAB_SIZE - DESK_FAB_EDGE_INSET;
  const besideComposerLeft = anchor.right + DESK_FAB_COMPOSER_GAP;
  const preferredLeft = Math.max(cornerLeft, besideComposerLeft);

  if (preferredLeft + DESK_FAB_SIZE <= viewport.width) {
    return { left: preferredLeft, bottom: DESK_FAB_EDGE_INSET };
  }

  return {
    left: anchor.right - DESK_FAB_SIZE,
    bottom: viewport.height - anchor.top + DESK_FAB_ABOVE_GAP,
  };
}
