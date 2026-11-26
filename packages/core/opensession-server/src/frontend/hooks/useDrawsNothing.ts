import { useLayoutEffect, useState } from "react";

/** Whether no element under `root` draws a box. A hidden element and a
 *  `display: contents` wrapper both have no client rects, so a tree of
 *  section wrappers whose rows all stood down counts as nothing. */
export function drawsNothing(root: Element): boolean {
  for (const element of root.querySelectorAll("*"))
    if (element.getClientRects().length > 0) return false;
  return true;
}

/**
 * Follows `drawsNothing` for a subtree whose sections decide for themselves
 * whether to render, so a surface can stand down instead of drawing an empty
 * frame around them. Measured before paint, so the frame never flashes.
 *
 * Hide the surface with `visibility: hidden`, not `display: none`: the
 * measurement needs its descendants laid out to see them come back.
 */
export function useDrawsNothing(root: Element | null): boolean {
  const [empty, setEmpty] = useState(false);
  useLayoutEffect(() => {
    if (!root) {
      setEmpty(false);
      return;
    }
    const update = () => setEmpty(drawsNothing(root));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden"],
    });
    return () => observer.disconnect();
  }, [root]);
  return empty;
}
