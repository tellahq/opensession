/**
 * Whether the session header's workspace summary card is up.
 *
 * Stored rather than held in the component, because the card is a standing
 * view of the workspace and not a menu you reopen: it survives a reload and
 * follows you from one session to the next.
 *
 * It lives in its own module because two components need the same answer. The
 * card owns it, and the session viewer reads it on its FIRST render to decide
 * whether the header still draws the PR strip and the preview link. Waiting
 * for the card to report in an effect would paint the very things the card
 * replaces, for a frame, on every load.
 */
export const WS_SUMMARY_OPEN_KEY = "opensession-workspace-summary-open";

/** Same-tab notification that the preference changed. `storage` only fires in
 *  the OTHER tabs, and a second viewer in this one has to follow along. */
export const WS_SUMMARY_OPEN_EVENT =
  "opensession-workspace-summary-open-changed";

export function workspaceSummaryOpen(): boolean {
  return localStorage.getItem(WS_SUMMARY_OPEN_KEY) !== "false";
}

/** Bring the compact workspace summary back when another surface yields room. */
export function openWorkspaceSummary(): void {
  localStorage.setItem(WS_SUMMARY_OPEN_KEY, "true");
  window.dispatchEvent(new Event(WS_SUMMARY_OPEN_EVENT));
}

/**
 * The header width at which the card stops covering anything.
 *
 * The card floats over the session column's right gutter, and the transcript
 * steps aside for it only while the pane is wide enough to have a gutter to
 * give. Below this there is nowhere to step, so a pinned card sits on top of
 * the words it is summarising. That is the width where it hides itself and
 * waits to be asked for instead.
 *
 * Measured on the session header rather than the window: the sidebar and the
 * side panel both eat into it, so the window's own width says little about
 * how much pane is left.
 */
export const WS_SUMMARY_ROOM_W = 1120;

/**
 * How far the reading column moves left while the card is open.
 *
 * The transcript and composer move as one, leaving the card its own side of
 * the pane and making the open state visible even when the pane is wide. This
 * is a deliberate composition rather than the minimum distance needed to
 * prevent overlap, so the step stays fixed at every width that can show the
 * card.
 */
export const WS_SUMMARY_MAX_SHIFT = 160;

/**
 * How far left the transcript and composer step while the card is up.
 *
 * Below WS_SUMMARY_ROOM_W the card is hidden, so an unmeasured or narrow pane
 * does not move. Every pane that can show the card gets the full step.
 */
export function workspaceSummaryShift(headerW: number): number {
  return headerW >= WS_SUMMARY_ROOM_W ? WS_SUMMARY_MAX_SHIFT : 0;
}

/**
 * Whether this pane can hold the card as a standing view.
 *
 * Room is the only question. Review used to be excluded here, which is what
 * made opening it feel like the card had been dismissed: every surface wide
 * enough shows the card, and Review gives it a column of its own.
 */
export function workspaceSummaryCanStand(hasRoom: boolean): boolean {
  return hasRoom;
}

/**
 * Whether navigation from a summary row should dismiss the card.
 *
 * A narrow overlay must leave after routing because it covers the destination.
 * A standing card stays pinned, including when its Review row opens Review.
 */
export function workspaceSummaryShouldDismissAfterRouting(
  canStand: boolean,
): boolean {
  return !canStand;
}

/** Place the card directly below the workspace tab strip. Review gives the
 *  card its own column, so its inner PR bars need no extra clearance. */
export function workspaceSummarySideOffset(tabStripVisible: boolean): number {
  return tabStripVisible ? 49 : 20;
}
