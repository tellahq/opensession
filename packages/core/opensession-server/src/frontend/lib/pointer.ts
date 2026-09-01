/** Pointer capability, asked at the moment of the interaction rather than at
 *  module load: a hybrid laptop gains and loses a mouse while the page runs. */

/** Touch devices can't hover, and a tap that raises a card covers the view
 *  that same tap just opened — so no hover card is ever raised there. (iOS
 *  synthesizes a mouseenter on first tap, so this can't be left to hover.) */
export function pointerCanHover() {
  return (
    typeof window === "undefined" || window.matchMedia("(hover: hover)").matches
  );
}
