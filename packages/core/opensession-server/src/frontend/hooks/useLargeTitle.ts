import { useEffect, useState } from "react";

/**
 * The attribute a page's own big heading carries so a chrome row above it can
 * tell whether that heading is still on screen. `ui/page-header.tsx` puts it on
 * every `PageTitle`; this hook is its only reader.
 */
export const LARGE_TITLE_SELECTOR = "[data-large-title]";

/**
 * Has the bar taken the page's name over?
 *
 * The iOS large-title move. A page opens with its name set large in the body,
 * where a page's name belongs, and the bar above it stays quiet. Printing the
 * same word twice, an inch apart, is what made the bar read as a mistake. Once
 * that heading has travelled up under the bar the name has to go somewhere, so
 * the bar picks it up and holds it for as long as the page is scrolled. It is
 * the same answer the chat header gives: a bar says which thing is open, and
 * only needs to once nothing else on screen does.
 *
 * `false` while the page's own heading is visible, `true` once it has passed
 * under the bar. `true` as well when nothing under the bar is heading itself
 * with that name, since then the bar is the only place the name can appear.
 *
 * It defers to a heading that reads the SAME WORD, not merely to a heading. The
 * rule being kept is "do not print the same name twice, an inch apart", so a
 * bar naming something the page below is not naming has nothing to defer to.
 * That is not a detail: `/new` is a dialog over whichever page was already
 * open, so the bar says "New session" while a perfectly valid `PageTitle`
 * behind it says "Pull requests". Matched by name, the bar keeps its label,
 * which is the behaviour that route has always had.
 *
 * An IntersectionObserver rather than a scroll listener: the question is only
 * ever "is this element still below that edge", which is the one thing the
 * observer answers without running code on every frame. Its root is the
 * viewport narrowed by the bar's own measured height, so the crossover is the
 * bar's bottom edge exactly, with no constant to keep in step with
 * `--desktop-header-h`. The first state is read from rects instead of waiting
 * for the observer's first callback, which arrives a frame late and would flash
 * the bar's copy of the title on every route change.
 *
 * The heading is looked up inside the bar's own parent rather than handed in as
 * a ref, for the reason `useScrollEdge` does the same: the bar and
 * the page under it are never rendered by the same component. Re-resolved on
 * every mutation batch, which is what carries the handoff across a route
 * change and a page whose body lands a moment after its frame.
 *
 * @param bar the chrome row that would show the title, or null before it mounts
 * @param name the title the bar would show, matched against the headings found
 *   inside `bar.parentElement`
 */
export function useLargeTitleHandoff(
  bar: HTMLElement | null,
  name: string,
): boolean {
  // A bar with no page heading under it owns the title, so this is also the
  // right answer for every route that never had one.
  const [handedOver, setHandedOver] = useState(true);

  useEffect(() => {
    const root = bar?.parentElement;
    if (!bar || !root) {
      setHandedOver(true);
      return;
    }

    let frame = 0;
    let observer: IntersectionObserver | null = null;
    let watched: Element | null = null;

    const wanted = name.trim();
    const attach = (remeasure = false) => {
      frame = 0;
      const next = wanted
        ? ([...root.querySelectorAll(LARGE_TITLE_SELECTOR)].find(
            (heading) => heading.textContent?.trim() === wanted,
          ) ?? null)
        : null;
      // A streaming transcript mutates this subtree many times a second, so
      // the common case has to cost one lookup and stop. Two things rebuild
      // the observer: a heading that has actually changed, and a resize,
      // which moves the edge the margin below is measured from.
      if (next === watched && !remeasure) return;
      observer?.disconnect();
      watched = next;
      if (!next) {
        observer = null;
        setHandedOver(true);
        return;
      }
      const edge = bar.getBoundingClientRect().bottom;
      setHandedOver(next.getBoundingClientRect().bottom <= edge);
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            if (entry.target === watched) setHandedOver(!entry.isIntersecting);
        },
        { rootMargin: `${-Math.max(0, Math.round(edge))}px 0px 0px 0px` },
      );
      observer.observe(next);
    };
    // Sticky, so a mutation arriving in the same frame as a resize cannot
    // swallow the remeasure the resize asked for.
    let pending = false;
    const schedule = (remeasure = false) => {
      pending = pending || remeasure;
      if (!frame)
        frame = requestAnimationFrame(() => {
          const remeasureNow = pending;
          pending = false;
          attach(remeasureNow);
        });
    };
    const onResize = () => schedule(true);

    attach(true);
    window.addEventListener("resize", onResize);
    // Route changes and late-loading page bodies both arrive as mutations;
    // the rAF collapses a burst of them into one lookup.
    const mutations = new MutationObserver(() => schedule());
    mutations.observe(root, { childList: true, subtree: true });

    return () => {
      mutations.disconnect();
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [bar, name]);

  return handedOver;
}
