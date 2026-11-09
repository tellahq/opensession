import { useEffect, useState } from "react";
import { subscribeSidePanel } from "../../lib/side-panel-store";

/** Where the floating huddle card sits, in px from the window's edges. */
export interface DockPlacement {
  right: number;
  bottom: number;
}

const GAP = 16;
const FALLBACK: DockPlacement = { right: GAP, bottom: 84 };

/** The last visible match: the focused viewer's, in a split. */
function lastVisible(selector: string): Element | null {
  const all = [...document.querySelectorAll(selector)].filter(
    (el) => el.getClientRects().length > 0,
  );
  return all.at(-1) ?? null;
}

/**
 * Keep the huddle card off what people type into: left of an open thread
 * split or session side panel (whose bottom right holds a reply box) and above the
 * conversation's composer. Falls back to the corner when neither is on
 * screen.
 */
export function useDockPlacement(enabled: boolean): DockPlacement {
  const [placement, setPlacement] = useState(FALLBACK);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const observed = new Set<Element>();
    const resize = new ResizeObserver(() => later());
    function measure() {
      // An open thread split sits left of the panel, so it is the edge.
      const panel =
        lastVisible(".thread-split") ?? lastVisible(".viewer-panel");
      const composer = lastVisible(
        ".detail-pane .composer:not(.thread-split .composer)",
      );
      for (const el of [panel, composer])
        if (el && !observed.has(el)) {
          observed.add(el);
          resize.observe(el);
        }
      const panelLeft = panel?.getBoundingClientRect().left;
      const composerTop = composer?.getBoundingClientRect().top;
      const next = {
        right:
          panelLeft === undefined
            ? GAP
            : Math.max(0, window.innerWidth - panelLeft) + GAP,
        bottom:
          composerTop === undefined
            ? FALLBACK.bottom
            : Math.max(GAP, window.innerHeight - composerTop + 12),
      };
      setPlacement((current) =>
        current.right === next.right && current.bottom === next.bottom
          ? current
          : next,
      );
    }
    // A store change renders the panel first; measure once it lands.
    function later() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    measure();
    const off = subscribeSidePanel(later);
    window.addEventListener("resize", later);
    // Moving between sessions swaps the panel and composer without either
    // resizing.
    const poll = window.setInterval(measure, 1_000);
    return () => {
      off();
      window.removeEventListener("resize", later);
      window.clearInterval(poll);
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [enabled]);
  return placement;
}
