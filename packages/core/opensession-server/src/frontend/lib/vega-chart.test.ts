// The pure half of the chart renderer: what counts as a chart fence, how a
// spec is sized before compiling, and which URLs the loader may fetch. The
// live vega view needs a laid-out DOM and is exercised in the browser.

import { describe, expect, test } from "bun:test";
import {
  CHART_FENCE_SELECTOR,
  finalizeChartViews,
  isChartLang,
  registerChartView,
  type ChartNode,
} from "./chart-fence";
import {
  DEFAULT_HEIGHT,
  MAX_DIMENSION,
  MAX_INLINE_ROWS,
  MAX_SOURCE_CHARS,
  chartConfigFrom,
  chartUrlAllowed,
  parseChartSpec,
  prepareChartSpec,
} from "./vega-chart";

const bars = {
  mark: "bar",
  data: { values: [{ a: "x", b: 1 }] },
  encoding: {
    x: { field: "a", type: "nominal" },
    y: { field: "b", type: "quantitative" },
  },
};

describe("isChartLang", () => {
  test("vega-lite, vegalite and chart fences are charts; others are not", () => {
    expect(isChartLang("vega-lite")).toBe(true);
    expect(isChartLang("VegaLite")).toBe(true);
    expect(isChartLang("chart")).toBe(true);
    expect(isChartLang("mermaid")).toBe(false);
    expect(isChartLang("json")).toBe(false);
    expect(isChartLang(undefined)).toBe(false);
  });

  test("the selector names the same fences marked emits", () => {
    expect(CHART_FENCE_SELECTOR).toContain('code[class~="language-vega-lite"]');
    expect(CHART_FENCE_SELECTOR).toContain('code[class~="language-chart"]');
  });
});

describe("parseChartSpec", () => {
  test("a spec object parses", () => {
    expect(parseChartSpec(JSON.stringify(bars))).toEqual(bars);
  });

  test("streaming, prose, arrays and non-view objects keep the fence", () => {
    expect(parseChartSpec('{"mark": "bar", "data": {')).toBeNull();
    expect(parseChartSpec("not json")).toBeNull();
    expect(parseChartSpec("[1, 2]")).toBeNull();
    expect(parseChartSpec('{"title": "no view here"}')).toBeNull();
    expect(parseChartSpec("")).toBeNull();
  });

  test("compositions count as views", () => {
    expect(parseChartSpec('{"hconcat": []}')).not.toBeNull();
    expect(
      parseChartSpec('{"facet": {}, "spec": {"mark": "bar"}}'),
    ).not.toBeNull();
    expect(
      parseChartSpec('{"repeat": {}, "spec": {"mark": "bar"}}'),
    ).not.toBeNull();
  });

  test("over-budget source and row counts keep the fence", () => {
    expect(
      parseChartSpec(`{"mark":"bar","x":"${"a".repeat(MAX_SOURCE_CHARS)}"}`),
    ).toBeNull();
    const rows = Array.from({ length: MAX_INLINE_ROWS + 1 }, () => ({ a: 1 }));
    expect(
      parseChartSpec(JSON.stringify({ mark: "bar", data: { values: rows } })),
    ).toBeNull();
    const half = rows.slice(0, MAX_INLINE_ROWS / 2 + 1);
    const layered = {
      layer: [
        { mark: "bar", data: { values: half } },
        { mark: "line", data: { values: half } },
      ],
    };
    expect(parseChartSpec(JSON.stringify(layered))).toBeNull();
    const datasets = {
      mark: "bar",
      datasets: { a: half, b: half },
    };
    expect(parseChartSpec(JSON.stringify(datasets))).toBeNull();
  });
});

describe("prepareChartSpec", () => {
  test("a unit view without a size fills the column at the default height", () => {
    const out = prepareChartSpec(bars, { phone: false });
    expect(out.width).toBe("container");
    expect(out.autosize).toEqual({ type: "fit", contains: "padding" });
    expect(out.height).toBe(DEFAULT_HEIGHT.desktop);
    expect(prepareChartSpec(bars, { phone: true }).height).toBe(
      DEFAULT_HEIGHT.phone,
    );
    // The input is not mutated.
    expect("width" in bars).toBe(false);
  });

  test("explicit sizes are kept and clamped", () => {
    const out = prepareChartSpec(
      { ...bars, width: 400, height: 50_000 },
      { phone: false },
    );
    expect(out.width).toBe(400);
    expect(out.height).toBe(MAX_DIMENSION);
    expect(out.autosize).toBeUndefined();
  });

  test("a composition keeps vega-lite's own cell sizing", () => {
    const out = prepareChartSpec({ hconcat: [bars, bars] }, { phone: false });
    expect(out.width).toBeUndefined();
    expect(out.height).toBeUndefined();
  });
});

describe("chartUrlAllowed", () => {
  const origin = "https://os.example.test";
  test("only this instance's session-asset raw route qualifies", () => {
    expect(
      chartUrlAllowed("/api/sessions/os-1/assets/raw/charts/a.json", origin),
    ).toBe(true);
    expect(
      chartUrlAllowed(`${origin}/api/sessions/os-1/assets/raw/a.csv`, origin),
    ).toBe(true);
    expect(chartUrlAllowed("/api/sessions/os-1/assets", origin)).toBe(false);
    expect(chartUrlAllowed("/api/sessions", origin)).toBe(false);
    expect(chartUrlAllowed("/media?path=/etc/passwd", origin)).toBe(false);
    expect(
      chartUrlAllowed(
        "https://elsewhere.test/api/sessions/os-1/assets/raw/a",
        origin,
      ),
    ).toBe(false);
    expect(
      chartUrlAllowed(
        "//elsewhere.test/api/sessions/os-1/assets/raw/a",
        origin,
      ),
    ).toBe(false);
    expect(chartUrlAllowed("data.json", origin)).toBe(false);
    expect(chartUrlAllowed("data:text/csv,a", origin)).toBe(false);
    expect(chartUrlAllowed("", origin)).toBe(false);
  });
});

describe("chartConfigFrom", () => {
  test("the page's tokens become the chart's ink, lines and palette", () => {
    const palette = ["#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8"];
    const config = chartConfigFrom({
      fg: "#fg",
      dim: "#dim",
      line: "#line",
      font: "Inter",
      palette,
    });
    expect(config.background).toBe("transparent");
    expect(config.font).toBe("Inter");
    expect(config.axis?.labelColor).toBe("#dim");
    expect(config.axis?.gridColor).toBe("#line");
    expect(config.title?.color).toBe("#fg");
    expect(config.range?.category).toEqual(palette);
    expect(config.mark?.color).toBe("#1");
    expect(config.mark?.tooltip).toBe(true);
  });
});

describe("chart view registry", () => {
  test("finalize runs once per registered canvas under the root", () => {
    const calls: string[] = [];
    const canvas = (): ChartNode => ({
      matches: () => true,
      querySelectorAll: () => [],
    });
    const a = canvas();
    registerChartView(a, { finalize: () => calls.push("a") });
    const root: ChartNode = {
      matches: () => false,
      querySelectorAll: () => [a, canvas()],
    };
    finalizeChartViews(root);
    finalizeChartViews(root);
    expect(calls).toEqual(["a"]);
  });
});
