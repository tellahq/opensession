import { useLayoutEffect, useRef } from "react";

/** Every heading that can pin marks itself with this, so the hook never has
 *  to know which family it belongs to (band, lane, repo, status), or survive
 *  the class names being restyled. */
const HEAD = "[data-sticky-head]";

/** Content taller than this is a list of rows, not a row: its children fade
 *  one by one, or a whole list would vanish once its top reached the line. */
const ROW_MAX_PX = 120;

/** The part of an element the row walk reads, so it runs without a DOM. */
export interface FadeNode<T> {
  readonly children: Iterable<T>;
  readonly nextElementSibling: T | null;
  matches(selector: string): boolean;
  querySelector(selector: string): object | null;
}

/**
 * The elements that fade out as they slide under a pinned heading: the
 * content after it, split into rows. Something holding headings of its own
 * (a repo band's lanes) is split too, so those headings are never faded;
 * each of them marks its own rows. `height` reads an element's layout height.
 */
export function pinnedFadeTargets<T extends FadeNode<T>>(
  head: T,
  height: (el: T) => number,
): T[] {
  const out: T[] = [];
  const visit = (el: T) => {
    if (el.matches(HEAD)) return;
    const children = [...el.children];
    const split =
      children.length > 0 &&
      (el.querySelector(HEAD) !== null || height(el) > ROW_MAX_PX);
    if (!split) {
      out.push(el);
      return;
    }
    for (const child of children) visit(child);
  };
  for (let sib = head.nextElementSibling; sib; sib = sib.nextElementSibling) {
    visit(sib);
  }
  return out;
}

/**
 * Track the pinned headings of one sidebar list and fade the rows under them.
 * Returns the teardown.
 */
function bindStickyHeadings(root: HTMLElement): () => void {
  // CSS has no interoperable :stuck selector. Track the shared sidebar
  // scrollport instead and mark the headings position:sticky is actively
  // pinning.
  //
  // A pinned heading has no fill of its own. Over the desktop shell's
  // translucent material no fill can match the chrome around it (the
  // material is the window behind, which CSS cannot sample), so an opaque
  // backing read as a shaded band. Instead the rows after a heading fade out
  // as they reach its bottom edge (`[data-pin-fade]`, base-platform.css).
  // The fade is a scroll-driven animation, so the browser runs it in step
  // with the scroll; this only says which rows fade and where the line is,
  // and only when the list changes. A scroll listener runs after the frame
  // it reacts to is drawn, so masks driven from it trail the scroll.
  let frame = 0;
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
  /** What carries the fade as last applied: the rows, and the parents
   *  holding each heading's line. */
  let faded = new Set<HTMLElement>();
  let lined = new Set<HTMLElement>();
  let stale = true;
  const rescan = () => {
    stale = false;
    const applied = new Map(heads.map((h) => [h.el, h.stuck]));
    heads = [];
    const nextFaded = new Set<HTMLElement>();
    const nextLined = new Set<HTMLElement>();
    for (const el of root.querySelectorAll<HTMLElement>(HEAD)) {
      const style = getComputedStyle(el);
      const parent = el.parentElement;
      const sticky = style.position === "sticky" && !!parent;
      const top = Number.parseFloat(style.top) || 0;
      heads.push({
        el,
        parent: parent ?? el,
        sticky,
        top,
        // React owns className and rewrites it on rerender. The dedicated
        // data attribute is not part of that managed value, so it survives
        // a rerender while the scroll position remains unchanged.
        stuck: applied.get(el) ?? el.hasAttribute("data-stuck"),
      });
      if (!sticky || !parent) continue;
      // The line rows fade out at: where the heading's bottom edge sits
      // once pinned. Set on the parent, so the rows after the heading
      // inherit it, and a nested heading's own parent overrides it for the
      // rows under that one.
      parent.style.setProperty(
        "--pin-line",
        `${Math.round(top + el.offsetHeight)}px`,
      );
      nextLined.add(parent);
      for (const row of pinnedFadeTargets<Element>(el, (n) =>
        n instanceof HTMLElement ? n.offsetHeight : 0,
      )) {
        if (row instanceof HTMLElement) nextFaded.add(row);
      }
    }
    for (const el of nextFaded) el.setAttribute("data-pin-fade", "");
    for (const el of faded) {
      if (!nextFaded.has(el)) el.removeAttribute("data-pin-fade");
    }
    for (const el of lined) {
      if (!nextLined.has(el)) el.style.removeProperty("--pin-line");
    }
    faded = nextFaded;
    lined = nextLined;
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
    for (const el of faded) el.removeAttribute("data-pin-fade");
    for (const el of lined) el.style.removeProperty("--pin-line");
  };
}

export function useSidebarStickyHeadings(
  sidebarScrollRef: React.RefObject<HTMLDivElement | null>,
) {
  const bound = useRef<{ root: HTMLElement; unbind: () => void } | null>(null);
  // The list is not always there: on Channels the sidebar shows the channel
  // list in its place, and going back to Sessions brings it back without
  // remounting this hook. Bound once at mount, a sidebar that opened on
  // Channels never tracked its headings at all. So check after every render,
  // which costs one comparison, and rebind when the list changed.
  useLayoutEffect(() => {
    const root = sidebarScrollRef.current;
    if (bound.current?.root === root) return;
    bound.current?.unbind();
    bound.current = root ? { root, unbind: bindStickyHeadings(root) } : null;
  });
  useLayoutEffect(
    () => () => {
      bound.current?.unbind();
      bound.current = null;
    },
    [],
  );
}
