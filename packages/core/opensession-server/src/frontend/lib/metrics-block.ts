/**
 * The ```metrics fence: a row of cards, each a big number with a small label
 * and an optional delta (docs/blocks.md, "Metrics"). Two grammars, both
 * parsed here without a DOM so the parser is unit-testable:
 *
 *   Requests: 1,204 (+12%)        one metric per line, delta in parentheses
 *   [{"label":"p95","value":340,"unit":"ms","delta":-3}]
 *
 * A fence that does not parse keeps its code block, so a half-streamed or
 * mis-shaped one is still readable.
 */

import { z } from "zod";
import type { FenceUpgrader } from "./fence-upgraders";

export type MetricTrend = "up" | "down" | "flat";

export interface Metric {
  label: string;
  value: string;
  unit?: string;
  delta?: string;
  trend: MetricTrend;
}

/** `Label: value (delta)`; the parenthesised tail is optional. */
const METRIC_LINE = /^([^:]+?)\s*:\s*(.+?)(?:\s*\(([^()]*)\))?\s*$/;

/** The direction a delta reads as, from its sign or arrow. */
function trendOf(delta: string | undefined): MetricTrend {
  if (!delta) return "flat";
  const lead = delta.trim().charAt(0);
  if (lead === "+" || lead === "▲" || lead === "↑") return "up";
  if (lead === "-" || lead === "−" || lead === "▼" || lead === "↓")
    return "down";
  return "flat";
}

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** A non-blank string, trimmed; blank is rejected, not emptied. */
const text = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0);

/** A value written as a number is formatted for reading; a string is kept. */
const value = z.union([z.number().finite().transform(number.format), text]);

/** A numeric delta carries its sign, so `2` reads as `+2` beside its value. */
const signedDelta = z
  .number()
  .finite()
  .transform((n) => {
    const magnitude = number.format(Math.abs(n));
    return n > 0 ? `+${magnitude}` : n < 0 ? `-${magnitude}` : magnitude;
  });

const metricEntry = z.object({
  label: text,
  value,
  delta: z.union([signedDelta, text]).optional(),
  unit: text.optional(),
});

const metricsJson = z.array(metricEntry).nonempty();

function metricFromLine(line: string): Metric | null {
  const m = METRIC_LINE.exec(line);
  if (!m) return null;
  const label = m[1]!.trim();
  const value = m[2]!.trim();
  if (!label || !value) return null;
  const delta = m[3]?.trim() || undefined;
  return { label, value, delta, trend: trendOf(delta) };
}

/**
 * The metrics a fence lists, or null when it is not a metrics fence after
 * all: an empty body, a JSON body that is not an array of `{label, value}`
 * objects, or a line that is not `Label: value (delta)`.
 */
export function parseMetrics(source: string): Metric[] | null {
  const body = source.trim();
  if (!body) return null;
  // Anything JSON-shaped is read as JSON: a bare object is not the array the
  // grammar asks for, and must not fall through to the line reader.
  if (body.startsWith("[") || body.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return null;
    }
    const parsed = metricsJson.safeParse(json);
    if (!parsed.success) return null;
    return parsed.data.map(({ label, value, delta, unit }) => ({
      label,
      value,
      unit,
      delta,
      trend: trendOf(delta),
    }));
  }
  const metrics: Metric[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const metric = metricFromLine(line);
    if (!metric) return null;
    metrics.push(metric);
  }
  return metrics.length ? metrics : null;
}

/** The card row (styles/blocks/metrics.css). Text goes in as textContent. */
function metricsElement(metrics: readonly Metric[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "md-metrics";
  row.setAttribute("role", "list");
  for (const metric of metrics) {
    const card = document.createElement("div");
    card.className = "md-metric";
    card.setAttribute("role", "listitem");
    const value = document.createElement("div");
    value.className = "md-metric-value";
    const figure = document.createElement("span");
    figure.className = "md-metric-figure";
    figure.textContent = metric.value;
    value.append(figure);
    if (metric.unit) {
      const unit = document.createElement("span");
      unit.className = "md-metric-unit";
      unit.textContent = metric.unit;
      value.append(unit);
    }
    if (metric.delta) {
      const delta = document.createElement("span");
      delta.className = `md-metric-delta md-metric-delta-${metric.trend}`;
      delta.textContent = metric.delta;
      value.append(delta);
    }
    const label = document.createElement("div");
    label.className = "md-metric-label";
    label.textContent = metric.label;
    label.title = metric.label;
    card.append(value, label);
    row.append(card);
  }
  return row;
}

export const metricsUpgrader: FenceUpgrader = {
  langs: ["metrics"],
  async upgrade({ pre, source, root, alive }) {
    const metrics = parseMetrics(source);
    if (!metrics || !alive() || !root.contains(pre)) return false;
    pre.replaceWith(metricsElement(metrics));
    return true;
  },
};
