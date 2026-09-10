import { describe, expect, it } from "bun:test";
import { MAX_METRICS, MAX_SOURCE_CHARS, parseMetrics } from "./metrics-block";

describe("parseMetrics line form", () => {
  it("reads one metric per line with an optional delta", () => {
    expect(
      parseMetrics("Requests: 1,204 (+12%)\nErrors: 3 (-2)\nUptime: 99.98%"),
    ).toEqual([
      { label: "Requests", value: "1,204", delta: "+12%", trend: "up" },
      { label: "Errors", value: "3", delta: "-2", trend: "down" },
      { label: "Uptime", value: "99.98%", delta: undefined, trend: "flat" },
    ]);
  });

  it("reads arrows and the unicode minus as a direction", () => {
    const metrics = parseMetrics(
      "A: 1 (▲ 4)\nB: 2 (▼ 1)\nC: 3 (↑ 2)\nD: 4 (↓ 5)\nE: 5 (−3)\nF: 6 (n/a)",
    );
    expect(metrics?.map((m) => m.trend)).toEqual([
      "up",
      "down",
      "up",
      "down",
      "down",
      "flat",
    ]);
  });

  it("splits on the first colon so a clock value keeps its own", () => {
    expect(parseMetrics("Uptime: 12:30:05")).toEqual([
      { label: "Uptime", value: "12:30:05", delta: undefined, trend: "flat" },
    ]);
  });

  it("skips blank lines and trims", () => {
    expect(parseMetrics("\n  Users :  42  \n\n")).toEqual([
      { label: "Users", value: "42", delta: undefined, trend: "flat" },
    ]);
  });

  it("declines a fence with a line that is not a metric", () => {
    expect(parseMetrics("Requests: 1,204\njust a note")).toBeNull();
    expect(parseMetrics("Requests:")).toBeNull();
    expect(parseMetrics(": 12")).toBeNull();
    expect(parseMetrics("")).toBeNull();
    expect(parseMetrics("   \n\n")).toBeNull();
  });

  it("declines a fence with more metrics than a row can show", () => {
    const line = (i: number) => `M${i}: ${i}`;
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => line(i)).join("\n");
    expect(parseMetrics(lines(MAX_METRICS))).toHaveLength(MAX_METRICS);
    expect(parseMetrics(lines(MAX_METRICS + 1))).toBeNull();
  });

  it("declines a fence larger than a metrics list has reason to be", () => {
    const padded = `A: 1 ${" ".repeat(MAX_SOURCE_CHARS)}`;
    expect(parseMetrics(padded)).toBeNull();
  });
});

describe("parseMetrics JSON form", () => {
  it("reads an array of objects and formats numbers", () => {
    expect(
      parseMetrics(
        '[{"label":"p95","value":340,"unit":"ms","delta":-3},' +
          '{"label":"Revenue","value":"$4.2k","delta":"+8%"},' +
          '{"label":"Users","value":12345.678}]',
      ),
    ).toEqual([
      { label: "p95", value: "340", unit: "ms", delta: "-3", trend: "down" },
      {
        label: "Revenue",
        value: "$4.2k",
        unit: undefined,
        delta: "+8%",
        trend: "up",
      },
      {
        label: "Users",
        value: "12,345.68",
        unit: undefined,
        delta: undefined,
        trend: "flat",
      },
    ]);
  });

  it("signs a numeric delta", () => {
    const metrics = parseMetrics(
      '[{"label":"a","value":1,"delta":2},{"label":"b","value":1,"delta":0}]',
    );
    expect(metrics?.map((m) => [m.delta, m.trend])).toEqual([
      ["+2", "up"],
      ["0", "flat"],
    ]);
  });

  it("declines JSON that is not an array of labelled values", () => {
    expect(parseMetrics("[]")).toBeNull();
    expect(parseMetrics('[{"label":"a"}]')).toBeNull();
    expect(parseMetrics('[{"value":1}]')).toBeNull();
    expect(parseMetrics('[{"label":"a","value":"  "}]')).toBeNull();
    expect(parseMetrics("[1, 2]")).toBeNull();
    expect(parseMetrics("[{")).toBeNull();
    expect(parseMetrics('{"label":"a","value":1}')).toBeNull();
  });

  it("declines an array with more metrics than a row can show", () => {
    const entries = (n: number) =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({ label: `M${i}`, value: i })),
      );
    expect(parseMetrics(entries(MAX_METRICS))).toHaveLength(MAX_METRICS);
    expect(parseMetrics(entries(MAX_METRICS + 1))).toBeNull();
  });
});
