import { useLayoutEffect } from "react";

export function useSidebarStickyHeadings(
  sidebarScrollRef: React.RefObject<HTMLDivElement | null>,
) {
  // CSS has no interoperable :stuck selector. Track the shared sidebar
  // scrollport instead so section/lane labels can stay transparent in-flow and
  // gain an opaque surface only while position:sticky is actively pinning them.
  useLayoutEffect(() => {
    const root = sidebarScrollRef.current;
    if (!root) return;
    let frame = 0;
    // Every heading that can pin marks itself with `data-sticky-head`, so
    // this listener never has to know which family it belongs to (band,
    // lane, repo, status) — or survive the class names being restyled.
    const selector = "[data-sticky-head]";
    // What a header's own styles say: whether it pins at all, and the offset
    // it pins at. A scroll frame cannot change either, and reading them is a
    // style recalc per header, so they are cached here and re-read only when
    // the list, the rail or the density actually changes. `stuck` is the
    // attribute as last applied, so an unchanged header costs no write.
    type StickyHead = {
      el: HTMLElement;
      parent: HTMLElement;
      sticky: boolean;
      top: number;
      stuck: boolean;
    };
    let heads: StickyHead[] = [];
    let stale = true;
    const rescan = () => {
      stale = false;
      const applied = new Map(heads.map((h) => [h.el, h.stuck]));
      heads = [];
      for (const el of root.querySelectorAll<HTMLElement>(selector)) {
        const style = getComputedStyle(el);
        const parent = el.parentElement;
        heads.push({
          el,
          parent: parent ?? el,
          sticky: style.position === "sticky" && !!parent,
          top: Number.parseFloat(style.top) || 0,
          // React owns className and rewrites it on rerender. The dedicated
          // data attribute is not part of that managed value, so it preserves
          // the backing while the scroll position remains unchanged.
          stuck: applied.get(el) ?? el.hasAttribute("data-stuck"),
        });
      }
    };

    const update = () => {
      frame = 0;
      if (stale) rescan();
      // One read pass, then one write pass. A toggle between two rect
      // reads dirties layout for every header still to be measured, which
      // is what made a scroll frame over ~80 headers cost as much as it
      // did.
      const rootTop = root.getBoundingClientRect().top;
      const next: boolean[] = [];
      for (const head of heads) {
        if (!head.sticky) {
          next.push(false);
          continue;
        }
        const rect = head.el.getBoundingClientRect();
        const pinned = rect.top <= rootTop + head.top + 0.5;
        // Pin-line position alone also matches a header that naturally
        // RESTS at its sticky offset (the first section at scrollTop 0 —
        // the solid-pill-while-unscrolled bug), so additionally require
        // real displacement from the parent. All of these headers sit
        // flush with their parent's top in static layout, so a positive
        // delta means sticky is actively holding the header back. (Don't
        // try offsetTop for this: Chromium reports the displaced sticky
        // position there, not static layout.)
        const displaced =
          rect.top - head.parent.getBoundingClientRect().top > 1.5;
        next.push(pinned && displaced);
      }
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i]!;
        const stuck = next[i]!;
        if (head.stuck === stuck) continue;
        head.stuck = stuck;
        head.el.toggleAttribute("data-stuck", stuck);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // Mark rather than re-read: a burst of row updates in one frame then
    // costs one scan at rAF time instead of one per mutation record.
    const invalidate = () => {
      stale = true;
      schedule();
    };

    update();
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", invalidate);
    const resizeObserver = new ResizeObserver(invalidate);
    resizeObserver.observe(root);
    const mutationObserver = new MutationObserver(invalidate);
    mutationObserver.observe(root, { childList: true, subtree: true });
    // Density retunes the offsets these headers pin at (--sidebar-band-slot)
    // without touching the list, so the cache has to be re-read for it too.
    const densityObserver = new MutationObserver(invalidate);
    densityObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-density"],
    });

    return () => {
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", invalidate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      densityObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sidebarScrollRef]);
}
