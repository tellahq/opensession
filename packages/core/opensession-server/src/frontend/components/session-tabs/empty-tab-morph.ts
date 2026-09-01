import { duration, ease } from "../../ui/motion";

export const EMPTY_TAB_COLLAPSED_WIDTH = 32;

export const emptyTabTransition = {
  type: "tween" as const,
  duration: duration.base,
  ease,
};

const MORPH_DURATION_MS = emptyTabTransition.duration * 1000;
const MORPH_EASING = `cubic-bezier(${ease.join(",")})`;

function morphTiming(
  options: KeyframeAnimationOptions = {},
): KeyframeAnimationOptions {
  return {
    duration: MORPH_DURATION_MS,
    easing: MORPH_EASING,
    fill: "both",
    ...options,
  };
}

function clipRadius(element: HTMLElement): string {
  return getComputedStyle(element).borderTopLeftRadius || "8px";
}

/**
 * Reveal the full-size tab from the + without changing layout on every frame.
 * The tab takes its final space immediately, then a FLIP translation keeps its
 * collapsed visual aligned with the old control while the clip opens.
 */
export function animateEmptyTabOpen(
  tab: HTMLElement,
  origin: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">,
): void {
  if (tab.dataset.emptyTabMorph === "opening") return;
  tab.dataset.emptyTabMorph = "opening";

  const rect = tab.getBoundingClientRect();
  const collapsedWidth = Math.min(EMPTY_TAB_COLLAPSED_WIDTH, rect.width);
  const clippedLeft = Math.max(0, rect.width - collapsedWidth);
  const originCenterX = origin.left + origin.width / 2;
  const originCenterY = origin.top + origin.height / 2;
  const collapsedCenterX = rect.right - collapsedWidth / 2;
  const collapsedCenterY = rect.top + rect.height / 2;
  const deltaX = originCenterX - collapsedCenterX;
  const deltaY = originCenterY - collapsedCenterY;
  const radius = clipRadius(tab);

  const animations: Animation[] = [
    tab.animate(
      [
        {
          transform: `translate(${deltaX}px, ${deltaY}px)`,
          clipPath: `inset(0 0 0 ${clippedLeft}px round ${radius})`,
        },
        {
          transform: "translate(0px, 0px)",
          clipPath: `inset(0 0 0 0 round ${radius})`,
        },
      ],
      morphTiming(),
    ),
  ];

  const title = tab.querySelector<HTMLElement>("[data-empty-tab-title]");
  if (title)
    animations.push(
      title.animate(
        [
          { opacity: 0, transform: "translateX(8px)" },
          { opacity: 0, transform: "translateX(8px)", offset: 0.12 },
          { opacity: 1, transform: "translateX(0px)" },
        ],
        morphTiming(),
      ),
    );

  const glyph = tab.querySelector<HTMLElement>("[data-empty-tab-glyph]");
  if (glyph)
    animations.push(
      glyph.animate(
        [
          { transform: "rotate(45deg) scale(1.25)" },
          { transform: "rotate(0deg) scale(1)" },
        ],
        morphTiming(),
      ),
    );

  void Promise.allSettled(
    animations.map((animation) => animation.finished),
  ).then(() => {
    delete tab.dataset.emptyTabMorph;
  });
}

/**
 * Finish the empty tab's reverse morph without keeping the live session around.
 * The visual copy can collapse after the real tab closes, so a pending create
 * response cannot race the animation and resurrect the deleted session.
 */
export function animateEmptyTabClose(button: HTMLButtonElement): void {
  const tab = button.closest<HTMLElement>('[role="tab"]');
  if (!tab) return;

  const strip = tab.closest<HTMLElement>('[role="tablist"]');
  const hideReturningPlus = () => {
    const plus = strip?.querySelector<HTMLElement>(".session-tab-new");
    if (!plus) return;
    plus.dataset.emptyTabMorphTarget = "";
    plus.style.setProperty("opacity", "0", "important");
  };
  const plusObserver = strip ? new MutationObserver(hideReturningPlus) : null;
  if (strip) plusObserver?.observe(strip, { childList: true, subtree: true });
  hideReturningPlus();

  const rect = tab.getBoundingClientRect();
  const collapsedWidth = Math.min(EMPTY_TAB_COLLAPSED_WIDTH, rect.width);
  const clippedLeft = Math.max(0, rect.width - collapsedWidth);
  const deltaX = -clippedLeft;
  const radius = clipRadius(tab);
  const surfaceColor = getComputedStyle(tab).backgroundColor;
  const ghost = tab.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("role");
  ghost.removeAttribute("aria-selected");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "100",
    transition: "none",
  });
  document.body.append(ghost);

  const animations: Animation[] = [
    ghost.animate(
      [
        {
          transform: "translateX(0px)",
          clipPath: `inset(0 0 0 0 round ${radius})`,
        },
        {
          transform: `translateX(${deltaX}px)`,
          clipPath: `inset(0 0 0 ${clippedLeft}px round ${radius})`,
        },
      ],
      morphTiming(),
    ),
    ghost.animate(
      [
        { backgroundColor: surfaceColor },
        { backgroundColor: surfaceColor, offset: 0.65 },
        { backgroundColor: "rgba(0, 0, 0, 0)" },
      ],
      morphTiming(),
    ),
  ];
  const title = ghost.querySelector<HTMLElement>("[data-empty-tab-title]");
  if (title)
    animations.push(
      title.animate(
        [
          { opacity: 1, transform: "translateX(0px)" },
          { opacity: 0, transform: "translateX(8px)" },
        ],
        morphTiming(),
      ),
    );
  const glyph = ghost.querySelector<HTMLElement>("[data-empty-tab-glyph]");
  if (glyph)
    animations.push(
      glyph.animate(
        [
          { transform: "rotate(0deg) scale(1)" },
          { transform: "rotate(45deg) scale(1.25)" },
        ],
        morphTiming(),
      ),
    );
  void Promise.allSettled(
    animations.map((animation) => animation.finished),
  ).then(() => {
    plusObserver?.disconnect();
    const plus = strip?.querySelector<HTMLElement>(
      "[data-empty-tab-morph-target]",
    );
    if (plus) {
      delete plus.dataset.emptyTabMorphTarget;
      plus.style.removeProperty("opacity");
    }
    ghost.remove();
  });
}
