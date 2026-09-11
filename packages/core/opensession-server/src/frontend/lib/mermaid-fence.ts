/**
 * The cheap half of diagram rendering: the fence upgrader that turns a
 * ```mermaid fence into an inline diagram. Mermaid itself (multi-MB) lives in
 * mermaid.ts and is imported lazily, only when a body carries such a fence.
 */

import { expandIconMarkup } from "../components/icons";
import type { FenceUpgrader } from "./fence-upgraders";

let mermaidPromise: Promise<typeof import("./mermaid")> | null = null;
function loadMermaid() {
  mermaidPromise ??= import("./mermaid");
  return mermaidPromise;
}

/** Source that doesn't parse (still streaming, or just wrong) keeps the
 *  plain code fence. */
export const mermaidUpgrader: FenceUpgrader = {
  langs: ["mermaid"],
  async upgrade({ pre, source, root, alive }) {
    const m = await loadMermaid().catch(() => null);
    if (!m || !alive()) return false;
    const svg = await m.renderMermaidSvg(source).catch(() => null);
    if (!alive() || !svg || !root.contains(pre)) return false;
    // The diagram itself sits in a scroller, with the expand control as its
    // SIBLING rather than a child: a wide diagram scrolls sideways, and a
    // button inside that box would ride off the edge with it.
    const wrap = document.createElement("div");
    wrap.className = "md-mermaid-wrap";
    const well = document.createElement("div");
    well.className = "md-mermaid";
    well.innerHTML = svg;
    // A real button, activated by the same delegated listener that opens
    // session images (MediaLightbox.tsx). Clicking the diagram opens it too;
    // this is what puts it in the tab order, and what makes it discoverable
    // on a touch screen with no hover.
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "md-diagram-expand";
    expand.title = "Expand diagram";
    expand.setAttribute("aria-label", "Expand diagram");
    expand.innerHTML = expandIconMarkup();
    wrap.append(well, expand);
    pre.replaceWith(wrap);
    return true;
  },
};
