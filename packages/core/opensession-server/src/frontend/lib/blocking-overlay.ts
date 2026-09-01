// Whether a surface is open that should keep a window-level chord from firing:
// a palette, the composer's schedule modal, the session delete overlay.
//
// This exists because the obvious spelling is wrong in a way nothing reports.
// Every window-level handler used to inline
//   document.querySelector(".palette-backdrop, …")
// which asks whether the ELEMENT EXISTS, not whether anything is open. The Desk
// renders its palette with Base UI's `keepMounted` (components/DeskOverlay.tsx)
// so that summoning it a second time is instant, and a kept-mounted portal is
// in the DOM from the first render onward, carrying `hidden` and `data-closed`.
// querySelector matches a hidden element perfectly happily, so the guard read
// true forever and every chord behind it was dead app-wide: archive, pin, team
// note, tab switching, open pull request. Nothing threw, no test failed, and
// each chord looked individually broken rather than one shared guard being
// stuck on.
//
// `:not([hidden])` is what separates the two questions, measured against the
// live app: with nothing open the bare selector matches the Desk's backdrop
// (hidden, display:none, 0x0, data-closed) and this one matches nothing.
//
// Keep the class names as names. They are runtime markers with no styling
// behind them, so a rename that "cleans up dead CSS" silently unblocks every
// chord over an open palette instead.

/** Blocking overlays, each required to be actually rendered. */
export const BLOCKING_OVERLAY_SELECTOR =
  ".palette-backdrop:not([hidden]), .composer-schedule-modal-backdrop:not([hidden]), .session-delete-overlay:not([hidden])";

/**
 * True when a blocking overlay is open, so a window-level shortcut should
 * decline the keystroke.
 */
export function blockingOverlayOpen(root: ParentNode = document): boolean {
  return !!root.querySelector(BLOCKING_OVERLAY_SELECTOR);
}
