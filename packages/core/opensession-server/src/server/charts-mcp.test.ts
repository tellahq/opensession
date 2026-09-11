import { describe, expect, test } from "bun:test";
import {
  CHART_ASSET_DIR,
  INLINE_DATA_LIMIT,
  chartAssetUrl,
  formatChartFence,
  makeChart,
} from "./charts-mcp";

const SESSION = "os-00000000-0000-7000-0000-000000000000";

const bars = {
  mark: "bar",
  data: {
    values: [
      { day: "Mon", runs: 12 },
      { day: "Tue", runs: 9 },
    ],
  },
  encoding: {
    x: { field: "day", type: "nominal" },
    y: { field: "runs", type: "quantitative" },
  },
};

function deps() {
  const writes: Array<{ path: string; bytes: number }> = [];
  return {
    writes,
    deps: {
      writeAsset: async (_session: string, path: string, data: Buffer) => {
        writes.push({ path, bytes: data.byteLength });
        return {};
      },
      now: () => 1_000_000,
    },
  };
}

describe("make_chart", () => {
  test("a valid spec comes back as a vega-lite fence with rows on one line each", async () => {
    const result = await makeChart(
      { sessionId: SESSION, spec: bars },
      deps().deps,
    );
    if (!result.ok) throw new Error(result.errors.join());
    expect(result.fence.startsWith("```vega-lite\n{")).toBe(true);
    expect(result.fence.endsWith("\n```")).toBe(true);
    expect(result.fence).toContain('{"day":"Mon","runs":12}');
    expect(result.dataAsset).toBeUndefined();
    // The fence round-trips.
    const body = result.fence.slice("```vega-lite\n".length, -"\n```".length);
    expect(JSON.parse(body)).toEqual(bars);
  });

  test("a JSON string spec and separate rows are accepted; the title fills in", async () => {
    const { data: _d, ...spec } = bars;
    const result = await makeChart(
      {
        sessionId: SESSION,
        spec: JSON.stringify(spec),
        data: bars.data.values,
        title: "Runs per day",
      },
      deps().deps,
    );
    if (!result.ok) throw new Error(result.errors.join());
    expect(result.fence).toContain('"title": "Runs per day"');
    expect(result.fence).toContain('{"day":"Tue","runs":9}');
  });

  test("broken JSON, a non-object, and a spec vega-lite rejects report errors", async () => {
    const d = deps().deps;
    const bad = await makeChart({ sessionId: SESSION, spec: "{nope" }, d);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toMatch(/not valid JSON/);
    const list = await makeChart({ sessionId: SESSION, spec: [1] }, d);
    expect(list.ok).toBe(false);
    const noMark = await makeChart(
      { sessionId: SESSION, spec: { mark: "nope", encoding: {} } },
      d,
    );
    expect(noMark.ok).toBe(false);
    if (!noMark.ok) expect(noMark.errors.length).toBeGreaterThan(0);
  });

  test("an external data URL is refused before compiling", async () => {
    const result = await makeChart(
      {
        sessionId: SESSION,
        spec: { ...bars, data: { url: "https://example.com/data.csv" } },
      },
      deps().deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("$.data.url");
  });

  test("a session asset URL is allowed", async () => {
    const result = await makeChart(
      {
        sessionId: SESSION,
        spec: {
          ...bars,
          data: { url: chartAssetUrl(SESSION, "charts/x.json") },
        },
      },
      deps().deps,
    );
    expect(result.ok).toBe(true);
  });

  test("big inline data moves to a session asset and the fence points at it", async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => ({
      day: `d${i}`,
      runs: i,
    }));
    const { writes, deps: d } = deps();
    const result = await makeChart(
      { sessionId: SESSION, spec: bars, data: rows, title: "Big run count" },
      d,
    );
    if (!result.ok) throw new Error(result.errors.join());
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`${CHART_ASSET_DIR}/big-run-count-lfls.json`);
    expect(result.dataAsset).toBe(writes[0].path);
    expect(result.fence).toContain(
      `"url": "${chartAssetUrl(SESSION, writes[0].path)}"`,
    );
    expect(result.fence).not.toContain('"values"');
    expect(result.fence.length).toBeLessThan(INLINE_DATA_LIMIT);
  });

  test("the vega-lite $schema is dropped: the fence never needs it", async () => {
    const result = await makeChart(
      {
        sessionId: SESSION,
        spec: {
          $schema: "https://vega.github.io/schema/vega-lite/v6.json",
          ...bars,
        },
      },
      deps().deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fence).not.toContain("$schema");
  });
});

describe("formatChartFence", () => {
  test("nested values arrays stay compact and the rest is indented", () => {
    const fence = formatChartFence({
      layer: [{ data: { values: [{ a: 1 }] }, mark: "line" }],
    });
    expect(fence).toBe(
      [
        "```vega-lite",
        "{",
        '  "layer": [',
        "    {",
        '      "data": {',
        '        "values": [',
        '          {"a":1}',
        "        ]",
        "      },",
        '      "mark": "line"',
        "    }",
        "  ]",
        "}",
        "```",
      ].join("\n"),
    );
  });

  test("an empty values array is fine", () => {
    expect(formatChartFence({ data: { values: [] } })).toContain(
      '"values": []',
    );
  });
});

describe("chartAssetUrl", () => {
  test("encodes each path segment separately", () => {
    expect(chartAssetUrl("os-1", "charts/a b.json")).toBe(
      "/api/sessions/os-1/assets/raw/charts/a%20b.json",
    );
  });
});
