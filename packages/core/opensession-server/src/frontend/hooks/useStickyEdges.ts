import { useEffect } from "react";

/** Mark sticky rows only while they are pinned against their scroll edge. */
export function useStickyEdges(
  root: HTMLElement | null,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!root || !enabled) return;

    const scroller = scrollParent(root);
    if (!scroller) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const scrollEdgeTop = scroller.getBoundingClientRect().top;
      for (const edge of root.querySelectorAll<HTMLElement>(
        "[data-sticky-edge]",
      )) {
        const edgeRect = edge.getBoundingClientRect();
        const rowRect = edge.parentElement?.getBoundingClientRect();
        const inset = Number.parseFloat(getComputedStyle(edge).top) || 0;
        const pinnedTop = scrollEdgeTop + inset;
        edge.toggleAttribute(
          "data-stuck",
          rowRect != null &&
            rowRect.top < pinnedTop - 1 &&
            Math.abs(edgeRect.top - pinnedTop) <= 1,
        );
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, { childList: true, subtree: true });

    return () => {
      mutations.disconnect();
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      for (const edge of root.querySelectorAll<HTMLElement>(
        "[data-sticky-edge]",
      ))
        edge.removeAttribute("data-stuck");
    };
  }, [root, enabled]);
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY))
      return parent;
  }
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : null;
}
