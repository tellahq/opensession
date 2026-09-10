/**
 * The cheap half of a slides block: which fences are decks, and how a deck's
 * markdown splits into slides. Building the deck (slides-deck.ts) pulls in
 * the markdown renderer, so it is imported when a body carries one.
 */

import type { FenceUpgrader } from "./fence-upgraders";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split on lines that are exactly `---` (trailing whitespace allowed). A
 * `---` inside a nested code fence belongs to that fence, not the deck.
 * Blank slides are dropped, so a deck that opens with `---` does not start
 * on an empty one.
 */
export function splitSlides(source: string): string[] {
  const slides: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const open = FENCE_OPEN.exec(line);
    if (fence) {
      const closes =
        open &&
        open[1][0] === fence[0] &&
        open[1].length >= fence.length &&
        line.trim() === open[1];
      if (closes) fence = null;
      current.push(line);
      continue;
    }
    if (open) {
      fence = open[1];
      current.push(line);
      continue;
    }
    if (line.trimEnd() === "---") {
      slides.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  slides.push(current.join("\n"));
  return slides.map((slide) => slide.trim()).filter(Boolean);
}

let deckPromise: Promise<typeof import("./slides-deck")> | null = null;
function loadDeck() {
  deckPromise ??= import("./slides-deck");
  return deckPromise;
}

/** A fence with nothing in it keeps the plain code block. */
export const slidesUpgrader: FenceUpgrader = {
  langs: ["slides"],
  async upgrade({ pre, source, root, alive, markdown }) {
    const slides = splitSlides(source);
    if (slides.length === 0) return false;
    const m = await loadDeck().catch(() => null);
    if (!m || !alive() || !root.contains(pre)) return false;
    pre.replaceWith(
      m.buildSlidesDeck(slides, { expandable: true, markdown }).el,
    );
    return true;
  },
};
