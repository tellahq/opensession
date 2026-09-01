import { useEffect } from "react";

/**
 * Tell a chrome row whether content is passing underneath it.
 *
 * The app's top row (the sidebar's chrome strip, the pane's title bar) draws
 * no line at rest: a bar and the content below it share one fill, so at the
 * top of a list there is no seam to mark. Once the content has scrolled under
 * the row there IS one, and the row grows a hairline. This hook is the half of
 * that CSS can't express — `:stuck`/`:scrolled` don't exist — so it toggles a
 * `data-scrolled` attribute the class strings key off (`SCROLL_EDGE_DIVIDER`
 * in lib/app-shell-classes.ts).
 *
 * A class toggle rather than a CSS scroll timeline, which the transcript's own
 * top edge used to use and which reads like the tidier answer. Three reasons it
 * isn't here: base.css's reduced-motion block clamps every `animation-duration`
 * to 0.01ms, which for a scroll-driven animation loses the STATE rather than
 * the motion, so the line would never appear for those readers; `capture-ui.ts`
 * freezes animations outright, so the scrolled state could never be
 * screenshotted; and a split pane puts two identically-named scroll timelines
 * under one `timeline-scope`, where the deferred timeline silently fails to
 * attach. None of those touch an attribute.
 *
 * The scroller is looked up by selector inside the bar's own parent rather than
 * handed in as a ref, because the two are never rendered by the same component
 * — the sidebar's chrome row is App's and its list is Sidebar's; the pane's bar
 * is App's and the transcript is SessionViewer's. Re-resolved on every mutation
 * batch (coalesced into the same frame as the scroll read), which is what
 * carries the attribute across a route change, a tab switch, and a transcript
 * that mounts a second later.
 *
 * @param bar   the chrome row to mark, or null before it mounts
 * @param selector matched against `bar.parentElement` to find the scroll
 *   container beneath it
 */
export function useScrollEdge(bar: HTMLElement | null, selector: string): void {
  useEffect(() => {
    const root = bar?.parentElement;
    if (!bar || !root) return;

    let frame = 0;
    let scroller: HTMLElement | null = null;

    const update = () => {
      frame = 0;
      const next = root.querySelector<HTMLElement>(selector);
      if (next !== scroller) {
        scroller?.removeEventListener("scroll", schedule);
        scroller = next;
        scroller?.addEventListener("scroll", schedule, { passive: true });
      }
      // Not `> 0`: scrollTop is fractional at fractional zoom, and a Mac
      // rubber-band overscroll drives it negative at the top. A pane with
      // nothing to scroll reports 0 and keeps the line off.
      bar.toggleAttribute("data-scrolled", (scroller?.scrollTop ?? 0) > 1);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("resize", schedule);
    // Route changes, tab switches and streaming appends all arrive as
    // mutations; the rAF above collapses a burst of them into one lookup.
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, { childList: true, subtree: true });

    return () => {
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      scroller?.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
      bar.removeAttribute("data-scrolled");
    };
  }, [bar, selector]);
}
