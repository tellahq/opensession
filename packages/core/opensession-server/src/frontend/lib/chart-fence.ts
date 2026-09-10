/**
 * The cheap half of chart rendering: which fences are charts, and the
 * registry of live Vega views so a markdown body can tear them down without
 * loading the renderer. Everything that touches vega itself is in
 * vega-chart.ts and is imported lazily, the way mermaid.ts is.
 *
 * A rendered mermaid diagram is a string, so replacing the DOM is enough to
 * forget it. A Vega view is a live dataflow with timers, event listeners and
 * a tooltip handler, and a markdown body resets its innerHTML on every theme
 * flip and re-render, so the view has to be finalized first or it keeps
 * running against nodes nobody can see.
 */

/** Fence info strings that render as a chart. `chart` is the short alias. */
const CHART_LANGS = new Set(["vega-lite", "vegalite", "chart"]);

export function isChartLang(lang: string | undefined): boolean {
  return !!lang && CHART_LANGS.has(lang.toLowerCase());
}

/** CSS selector for a fence that is on its way to becoming a chart. */
export const CHART_FENCE_SELECTOR = [...CHART_LANGS]
  .map((lang) => `code[class~="language-${lang}"]`)
  .join(", ");

/** The classes of a rendered chart (see base-markdown.css): the positioned
 *  wrapper that also holds the expand control, the padded well that scrolls
 *  sideways, and the unpadded canvas vega measures for container sizing. */
export const CHART_WRAP_CLASS = "md-chart-wrap";
export const CHART_WELL_CLASS = "md-chart";
export const CHART_CANVAS_CLASS = "md-chart-canvas";

export interface ChartHandle {
  /** Stop the dataflow and drop every listener the view attached. */
  finalize(): void;
}

/** The part of Element the registry reads. Named so a test can hand in a
 *  plain object: there is no DOM preload in this repo. */
export interface ChartNode {
  matches(selector: string): boolean;
  querySelectorAll(selector: string): ArrayLike<ChartNode>;
}

const views = new WeakMap<ChartNode, ChartHandle>();

export function registerChartView(
  canvas: ChartNode,
  handle: ChartHandle,
): void {
  views.set(canvas, handle);
}

/** Finalize every chart mounted under `root`, including `root` itself. */
export function finalizeChartViews(root: ChartNode): void {
  const canvases = root.matches(`.${CHART_CANVAS_CLASS}`)
    ? [root]
    : Array.from(root.querySelectorAll(`.${CHART_CANVAS_CLASS}`));
  for (const canvas of canvases) {
    const handle = views.get(canvas);
    if (!handle) continue;
    views.delete(canvas);
    try {
      handle.finalize();
    } catch {
      // A view that already failed has nothing left to release.
    }
  }
}
