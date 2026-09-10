/**
 * Lazy Vega-Lite renderer for ```vega-lite (and ```chart) fences in session
 * markdown. vega + vega-lite are about a megabyte minified, so like mermaid
 * this module is only dynamically imported once a landed message actually
 * carries a chart fence (MarkdownBody.tsx).
 *
 * A fence that does not parse, does not compile, or is over budget keeps its
 * plain code block: mid-stream JSON is the normal case for the first, and an
 * agent that wants to know WHY uses opensession-charts.make_chart, which
 * compiles the same spec on the server and reports the errors.
 *
 * Trust: a spec is model output rendered in the reader's browser, so the
 * expression language runs through vega-interpreter (no `new Function`), and
 * the loader only fetches same-origin session-asset URLs, so a spec can point
 * neither the reader nor the reader's cookies at another host. Tooltip text
 * is escaped by vega-tooltip.
 */

import {
  Error as VegaErrorLevel,
  View,
  loader as vegaLoader,
  parse as parseVega,
  type Loader,
  type LoggerInterface,
} from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile, type Config, type TopLevelSpec } from "vega-lite";
import { Handler as TooltipHandler } from "vega-tooltip";
import { z } from "zod";
import { PHONE_QUERY } from "./breakpoints";
import { registerChartView, type ChartHandle } from "./chart-fence";

/** Same ceiling as mermaid and shiki: past this, layout freezes rather than
 *  draws. Charts carry inline data, so it is ten times a diagram's. */
export const MAX_SOURCE_CHARS = 200_000;
/** Inline rows past this belong in a session asset (make_chart offloads them). */
export const MAX_INLINE_ROWS = 50_000;
/** A numeric width or height past this is a runaway, not a chart. */
export const MAX_DIMENSION = 2_000;
export const DEFAULT_HEIGHT = { desktop: 280, phone: 220 } as const;

/** The session-asset raw route, the one place chart data may be loaded from. */
const ASSET_URL_RE = /^\/api\/sessions\/[^/?#]+\/assets\/raw\/[^?#]+/;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/** The keys of a spec this module reads. Everything else passes through to
 *  vega-lite untouched, which is the point: the grammar is theirs. */
const viewFields = {
  width: jsonValue.optional(),
  height: jsonValue.optional(),
  autosize: jsonValue.optional(),
  data: z.looseObject({ values: z.array(jsonValue).optional() }).optional(),
  datasets: z.record(z.string(), z.array(jsonValue)).optional(),
};
const unitOrLayerSchema = z.union([
  z.looseObject({ ...viewFields, mark: jsonValue }),
  z.looseObject({ ...viewFields, layer: z.array(jsonValue) }),
]);
const compositionSchema = z.union([
  z.looseObject({ ...viewFields, hconcat: z.array(jsonValue) }),
  z.looseObject({ ...viewFields, vconcat: z.array(jsonValue) }),
  z.looseObject({ ...viewFields, concat: z.array(jsonValue) }),
  z.looseObject({ ...viewFields, facet: jsonValue, spec: jsonValue }),
  z.looseObject({ ...viewFields, repeat: jsonValue, spec: jsonValue }),
]);
/** Something vega-lite can compile: a unit, layer, or composition. */
const chartSpecSchema = z.union([unitOrLayerSchema, compositionSchema]);

export type ChartSpec = z.infer<typeof chartSpecSchema>;

/**
 * JSON in, a Vega-Lite spec out, or null when the text is not one: not JSON
 * (still streaming, or just prose), not a view, or too big to lay out.
 */
export function parseChartSpec(code: string): ChartSpec | null {
  const src = code.trim();
  if (!src || src.length > MAX_SOURCE_CHARS) return null;
  let parsed: JsonValue;
  try {
    parsed = jsonValue.parse(JSON.parse(src));
  } catch {
    return null;
  }
  const spec = chartSpecSchema.safeParse(parsed);
  if (!spec.success) return null;
  if (inlineRowCount(spec.data, 0) > MAX_INLINE_ROWS) return null;
  return spec.data;
}

/** Rows carried inline anywhere in the spec, sub-views included. */
function inlineRowCount(spec: ChartSpec, depth: number): number {
  let rows = spec.data?.values?.length ?? 0;
  for (const values of Object.values(spec.datasets ?? {}))
    rows += values.length;
  if (depth > 8) return rows;
  const children: JsonValue[] = [];
  for (const key of ["layer", "hconcat", "vconcat", "concat"] as const) {
    const list = z.array(jsonValue).safeParse(spec[key]);
    if (list.success) children.push(...list.data);
  }
  const inner = jsonValue.safeParse(spec.spec);
  if (inner.success) children.push(inner.data);
  for (const child of children) {
    const sub = chartSpecSchema.safeParse(child);
    if (sub.success) rows += inlineRowCount(sub.data, depth + 1);
  }
  return rows;
}

/**
 * Whether the loader may fetch `url` from `origin`. Only this instance's
 * session-asset raw route qualifies, as a root-relative path or an absolute
 * URL on the same origin; the route itself enforces who may read the asset.
 */
export function chartUrlAllowed(url: string, origin: string): boolean {
  if (!url) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.origin !== origin) return false;
    return ASSET_URL_RE.test(parsed.pathname);
  }
  return ASSET_URL_RE.test(url);
}

/**
 * The spec as it will be compiled. A unit or layered view with no explicit
 * width fills the column and re-fits on resize; a composition (facet, concat,
 * repeat) cannot use container sizing in vega-lite and keeps its own cell
 * sizes. Explicit sizes are clamped so a typo cannot lay out a 100k-pixel SVG.
 */
export function prepareChartSpec(
  spec: ChartSpec,
  opts: { phone: boolean },
): ChartSpec {
  const out = { ...spec };
  const fillsColumn = "mark" in out || "layer" in out;
  if (fillsColumn) {
    if (out.width === undefined) {
      out.width = "container";
      out.autosize ??= { type: "fit", contains: "padding" };
    }
    if (out.height === undefined)
      out.height = opts.phone ? DEFAULT_HEIGHT.phone : DEFAULT_HEIGHT.desktop;
  }
  const width = z.number().safeParse(out.width);
  if (width.success) out.width = clampDimension(width.data);
  const height = z.number().safeParse(out.height);
  if (height.success) out.height = clampDimension(height.data);
  return out;
}

function clampDimension(value: number): number {
  return Math.min(Math.max(1, value), MAX_DIMENSION);
}

/** The page's own ink, lines and categorical palette, as vega-lite config. */
export function chartConfigFrom(tokens: {
  fg: string;
  dim: string;
  line: string;
  font: string;
  palette: string[];
}): Config {
  const { fg, dim, line, font, palette } = tokens;
  return {
    background: "transparent",
    font,
    padding: 4,
    view: { stroke: null },
    axis: {
      domainColor: line,
      gridColor: line,
      gridDash: [2, 3],
      tickColor: line,
      labelColor: dim,
      labelFontSize: 11,
      titleColor: dim,
      titleFontSize: 11,
      titleFontWeight: 500,
      titlePadding: 8,
      labelPadding: 4,
    },
    // vega-lite stands nominal x labels on end by default; short category
    // labels read better flat, and overlap thins them out when they are not.
    axisX: { grid: false, labelAngle: 0, labelOverlap: true },
    legend: {
      labelColor: dim,
      labelFontSize: 11,
      titleColor: dim,
      titleFontSize: 11,
      titleFontWeight: 500,
      symbolSize: 80,
    },
    header: {
      labelColor: dim,
      labelFontSize: 11,
      titleColor: fg,
      titleFontSize: 12,
      titleFontWeight: 600,
    },
    title: {
      color: fg,
      subtitleColor: dim,
      fontSize: 13,
      fontWeight: 600,
      anchor: "start",
      offset: 12,
    },
    text: { color: fg, fontSize: 11 },
    mark: { color: palette[0], tooltip: true },
    line: { strokeWidth: 2 },
    point: { size: 48, filled: true },
    bar: { cornerRadiusEnd: 2 },
    arc: { stroke: "transparent" },
    range: {
      category: palette,
      ordinal: { scheme: "blues" },
      ramp: { scheme: "blues" },
      heatmap: { scheme: "blues" },
    },
  };
}

function readChartConfig(): Config {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    root.getPropertyValue(name).trim() || fallback;
  const palette = Array.from({ length: 8 }, (_, i) =>
    token(`--chart-${i + 1}`, "#888888"),
  );
  return chartConfigFrom({
    fg: token("--text", "#e9e9e9"),
    dim: token("--text-dim", "#a2a2a2"),
    line: token("--border", "#333333"),
    font: getComputedStyle(document.body).fontFamily || "sans-serif",
    palette,
  });
}

/** vega's http loader, fenced to this instance's session assets. */
function restrictedLoader(): Loader {
  const base = vegaLoader({ mode: "http" });
  const origin = window.location.origin;
  const refuse = () =>
    new Error(
      "Chart data must be a session asset (/api/sessions/<id>/assets/raw/…).",
    );
  return {
    ...base,
    sanitize: async (uri) => {
      if (!chartUrlAllowed(uri, origin)) throw refuse();
      return { href: uri };
    },
    load: async (uri) => {
      if (!chartUrlAllowed(uri, origin)) throw refuse();
      return base.http(uri, { credentials: "same-origin" });
    },
  };
}

/** Swallows vega-lite's compile-time warnings: the transcript is not the
 *  place to report them, make_chart is. */
class QuietLogger implements LoggerInterface {
  level(): number;
  level(_: number): this;
  level(_?: number): number | this {
    return _ === undefined ? 0 : this;
  }
  error(): this {
    return this;
  }
  warn(): this {
    return this;
  }
  info(): this {
    return this;
  }
  debug(): this {
    return this;
  }
}

let tooltip: TooltipHandler | null = null;
function tooltipHandler(): TooltipHandler {
  // One shared element, styled by base-markdown.css (#vg-tooltip-element).
  tooltip ??= new TooltipHandler({ theme: "os", disableDefaultStyle: true });
  return tooltip;
}

/**
 * Mount `code` as a live chart inside `canvas`, or return null (and leave
 * the canvas untouched) when it cannot be one. The canvas must be laid out
 * already: container sizing reads its width at first render.
 */
export async function renderChart(
  canvas: HTMLElement,
  code: string,
): Promise<ChartHandle | null> {
  const parsed = parseChartSpec(code);
  if (!parsed) return null;
  const phone = window.matchMedia(PHONE_QUERY).matches;
  const spec = prepareChartSpec(parsed, { phone });
  let compiled;
  try {
    // SAFETY: chartSpecSchema admits exactly the top-level shapes vega-lite
    // compiles (a mark, a layer, or a composition); the grammar inside them
    // is vega-lite's to validate, and a spec it rejects throws here and keeps
    // its code fence.
    const topLevel = spec as TopLevelSpec;
    compiled = compile(topLevel, {
      config: readChartConfig(),
      logger: new QuietLogger(),
    }).spec;
  } catch (error) {
    // Kept as a warning, not silence: unlike a half-streamed diagram, a
    // fence that parsed as JSON and still failed is a spec bug worth a
    // console line for whoever is debugging it.
    console.warn("[chart] spec did not compile:", error);
    return null;
  }
  let view: View;
  try {
    const runtime = parseVega(compiled, undefined, { ast: true });
    view = new View(runtime, {
      container: canvas,
      renderer: "svg",
      hover: true,
      expr: expressionInterpreter,
      loader: restrictedLoader(),
      tooltip: tooltipHandler().call,
      logLevel: VegaErrorLevel,
    });
    await view.runAsync();
  } catch (error) {
    console.warn("[chart] spec did not render:", error);
    canvas.replaceChildren();
    return null;
  }
  // Container-sized charts re-fit when the column changes width. rAF
  // coalesces the burst a window drag produces into one relayout per frame.
  let frame = 0;
  let lastWidth = canvas.clientWidth;
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (canvas.clientWidth === lastWidth) return;
          lastWidth = canvas.clientWidth;
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            void view.resize().runAsync();
          });
        });
  observer?.observe(canvas);
  const handle: ChartHandle = {
    finalize() {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      view.finalize();
    },
  };
  registerChartView(canvas, handle);
  return handle;
}
