/**
 * The DOM half of a slides block: one slide at a time in a 16:9 well, with
 * arrows, dots, a counter, the keyboard and a swipe. Each slide is the
 * app's own markdown (renderMarkdown) in the context the surrounding body
 * was rendered with, so a PR number or a session asset links the same way
 * inside the deck as outside it; rendered once up front. A nested fence
 * inside a slide stays a plain code block, since the body's upgrade pass
 * has already run by the time the deck exists.
 *
 * Built as DOM rather than JSX for the reason every block is: the body it
 * sits in is an innerHTML string. Listeners live on the deck's own nodes
 * and go with them.
 */

import {
  chevronLeftIconMarkup,
  chevronRightIconMarkup,
  expandIconMarkup,
} from "../components/icons";
import { openBlockExpand } from "./block-expand";
import { type MarkdownContext, renderMarkdown } from "./markdown";

/** How far a finger travels before it turns a page. */
const SWIPE_DISTANCE = 40;
/** Past this many slides the dots stop helping and only the counter shows. */
const MAX_DOTS = 16;

export interface SlidesDeck {
  el: HTMLElement;
  /** Show slide `index`, clamped. */
  go(index: number): void;
}

function button(className: string, label: string, html: string) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.title = label;
  el.setAttribute("aria-label", label);
  el.innerHTML = html;
  return el;
}

export function buildSlidesDeck(
  slides: readonly string[],
  options: {
    index?: number;
    expandable: boolean;
    /** The context the deck's body was rendered with. */
    markdown?: MarkdownContext;
  },
): SlidesDeck {
  const count = slides.length;
  let index = Math.min(Math.max(options.index ?? 0, 0), count - 1);

  const wrap = document.createElement("div");
  wrap.className = "md-slides-wrap";
  const deck = document.createElement("div");
  deck.className = "md-slides";
  deck.tabIndex = 0;
  deck.setAttribute("role", "group");
  deck.setAttribute("aria-roledescription", "slide deck");
  deck.setAttribute("aria-label", `Slides, ${count} in total`);

  const stage = document.createElement("div");
  stage.className = "md-slides-stage";
  const panes = slides.map((slide, i) => {
    const pane = document.createElement("div");
    pane.className = "md-slide markdown";
    pane.setAttribute("role", "group");
    pane.setAttribute("aria-roledescription", "slide");
    pane.setAttribute("aria-label", `Slide ${i + 1} of ${count}`);
    pane.innerHTML = renderMarkdown(slide, options.markdown);
    stage.append(pane);
    return pane;
  });

  const nav = document.createElement("div");
  nav.className = "md-slides-nav";
  const prev = button(
    "md-slides-arrow",
    "Previous slide",
    chevronLeftIconMarkup(18),
  );
  const next = button(
    "md-slides-arrow",
    "Next slide",
    chevronRightIconMarkup(18),
  );
  const dots = document.createElement("div");
  dots.className = "md-slides-dots";
  const dotButtons =
    count <= MAX_DOTS
      ? slides.map((_, i) => {
          const dot = button("md-slides-dot", `Go to slide ${i + 1}`, "");
          dot.addEventListener("click", () => go(i));
          dots.append(dot);
          return dot;
        })
      : [];
  const counter = document.createElement("span");
  counter.className = "md-slides-count";
  counter.setAttribute("aria-live", "polite");
  nav.append(prev, dots, counter, next);
  deck.append(stage, nav);
  wrap.append(deck);

  function go(to: number) {
    index = Math.min(Math.max(to, 0), count - 1);
    panes.forEach((pane, i) => {
      if (i === index) pane.setAttribute("data-current", "");
      else pane.removeAttribute("data-current");
    });
    dotButtons.forEach((dot, i) =>
      dot.setAttribute("aria-current", i === index ? "true" : "false"),
    );
    counter.textContent = `${index + 1} / ${count}`;
    prev.disabled = index === 0;
    next.disabled = index === count - 1;
    stage.scrollTop = 0;
  }
  prev.addEventListener("click", () => go(index - 1));
  next.addEventListener("click", () => go(index + 1));

  deck.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea"))
      return;
    if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === "ArrowRight") go(index + 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(count - 1);
    else return;
    e.preventDefault();
  });

  // A horizontal swipe on the stage turns the page; a mostly vertical one is
  // the reader scrolling a tall slide and is left alone.
  let touchStart: { x: number; y: number } | null = null;
  stage.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      touchStart = t ? { x: t.clientX, y: t.clientY } : null;
    },
    { passive: true },
  );
  stage.addEventListener(
    "touchend",
    (e) => {
      const t = e.changedTouches[0];
      if (!touchStart || !t) return;
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy)) return;
      go(dx < 0 ? index + 1 : index - 1);
    },
    { passive: true },
  );

  if (options.expandable) {
    const expand = button(
      "md-diagram-expand",
      "Expand slides",
      expandIconMarkup(),
    );
    expand.addEventListener("click", () => {
      openBlockExpand({
        title: "Slides",
        mount(host) {
          const large = buildSlidesDeck(slides, {
            index,
            expandable: false,
            markdown: options.markdown,
          });
          large.el.dataset.expanded = "";
          host.append(large.el);
          large.el.querySelector<HTMLElement>(".md-slides")?.focus();
          return () => large.el.remove();
        },
      });
    });
    wrap.append(expand);
  }

  go(index);
  return { el: wrap, go };
}
