import { repoLabel } from "../lib/repo-label";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PRODUCT_NAME, docTitle } from "../lib/brand";
import { fetchAnalytics } from "../lib/api";
import type {
  AnalyticsPerson,
  AnalyticsPersonRepo,
  AnalyticsSummary,
} from "../lib/types";
import { UserAvatar } from "./UserAvatar";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { DateRangeField } from "../ui/date-picker";
import { TopBar, TopBarActions, TopBarTitle } from "../ui/top-bar";
import { cn } from "../ui/cn";
import {
  DETAIL_TOPBAR_TITLE_TEXT,
  SCROLL_EDGE_DIVIDER,
} from "../lib/app-shell-classes";
import { useScrollEdge } from "../hooks/useScrollEdge";

/**
 * Analytics: what happened on/because of Open Session over a date range —
 * sessions, tokens, models, PRs, people, automations. Data comes aggregated
 * from GET /api/analytics (src/server/analytics.ts); this file is pure
 * presentation: stat tiles + hand-rolled SVG bar charts (stacked/grouped)
 * with hover tooltips, and the breakdown tables.
 */

// Validated categorical palette (8 slots, CVD-safe adjacent order) — dark
// values are the default theme, light overrides under html[data-theme].
// Order matters: it's the CVD-safety mechanism, so series always take slots
// in ascending order and a 9th series folds into "Other" (neutral gray).
const VIZ_STYLE = `
.analytics-viz{--viz-1:#3987e5;--viz-2:#008300;--viz-3:#d55181;--viz-4:#c98500;--viz-5:#199e70;--viz-6:#d95926;--viz-7:#9085e9;--viz-8:#e66767;--viz-other:#757575;}
html[data-theme="light"] .analytics-viz{--viz-1:#2a78d6;--viz-2:#008300;--viz-3:#e87ba4;--viz-4:#eda100;--viz-5:#1baf7a;--viz-6:#eb6834;--viz-7:#4a3aa7;--viz-8:#e34948;}
`;
const slot = (i: number) => `var(--viz-${i})`;
const OTHER_COLOR = "var(--viz-other)";

const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fmt = (n: number) => compactFmt.format(n);
const fmtInt = (n: number) => n.toLocaleString("en-US");
/** Cents up to $1K, compact above it — a table of four-figure sums is easier
 *  to compare as $1.2K than as $1,238.47. */
const fmtUsd = (n: number) =>
  n >= 1000 ? `$${compactFmt.format(n)}` : `$${n.toFixed(2)}`;
/** Whole dollars, compact — for the axis gutter, where cents don't fit. */
const fmtUsdTick = (n: number) => `$${compactFmt.format(n)}`;
/** A zero here means "nothing billed by token", not "free" — the dash says so
 *  without claiming a price. */
const fmtUsdCell = (n: number) => (n > 0 ? fmtUsd(n) : "–");
const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((100 * part) / whole)}%` : "–";

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// Session kinds get fixed palette slots (color follows the entity, and the
// slot order is the stack render order).
const KINDS: Array<{ key: string; label: string }> = [
  { key: "automation", label: "Automations" },
  { key: "review", label: "PR reviews" },
  { key: "prompt", label: "Interactive" },
  { key: "create", label: "Spawned" },
  { key: "slack", label: "Slack" },
  { key: "linear", label: "Linear" },
  { key: "goal", label: "Goals" },
];

function useWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let t = step; t <= max + step * 0.001; t += step) ticks.push(t);
  return ticks;
}

/** A bar with independently rounded ends. In a stack the top segment carries
 *  the cap, the bottom one the foot, and a lone segment carries both, so the
 *  silhouette is round at each end however many colors it is made of. Radii
 *  clamp to the bar's own half-width and half-height, so a narrow bar or a
 *  nearly-empty day goes fully domed rather than notched. */
function roundedBar(
  x: number,
  y: number,
  w: number,
  h: number,
  rTop: number,
  rBottom: number,
): string {
  const t = Math.min(rTop, w / 2, h / 2);
  const b = Math.min(rBottom, w / 2, h / 2);
  return `M${x},${y + h - b} L${x},${y + t} Q${x},${y} ${x + t},${y} L${x + w - t},${y} Q${x + w},${y} ${x + w},${y + t} L${x + w},${y + h - b} Q${x + w},${y + h} ${x + w - b},${y + h} L${x + b},${y + h} Q${x},${y + h} ${x},${y + h - b} Z`;
}

interface Series {
  label: string;
  color: string;
  /** Identity behind the label, for a legend that also filters the chart.
   *  Defaults to the label. */
  value?: string;
}

interface BarChartProps {
  labels: string[];
  series: Series[];
  /** values[dayIndex][seriesIndex] */
  values: number[][];
  mode: "stacked" | "grouped";
  height?: number;
  formatValue?: (n: number) => string;
  /** Axis ticks live in a 34px gutter, so a format that reads fine in the
   *  tooltip ($612.15) can overflow it. Defaults to `formatValue`. */
  formatTick?: (n: number) => string;
}

/** The numbers a chart raises under the pointer. Opaque, unlike the app's
 *  other popups: it floats directly over the densest, most colourful thing on
 *  the page, and a translucent surface there tints every row with the bars
 *  behind it. Placement belongs to the chart, which knows its own box. */
function ChartTooltip({
  className,
  style,
  ref,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={ref}
      className={cn(
        "pointer-events-none absolute z-10 rounded-popup [corner-shape:squircle] bg-popup",
        "px-3 py-2.5 [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

/** Stacked/grouped bar chart: hairline gridlines, clean ticks, 2px surface
 *  gaps between stacked segments, rounded caps, and a per-day hover tooltip. */
function BarChart({
  labels,
  series,
  values,
  mode,
  height = 190,
  formatValue = fmt,
  formatTick,
}: BarChartProps) {
  const tickLabel = formatTick ?? formatValue;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const gutter = 34;
  const bottom = 18;
  const plotH = height - bottom - 6;
  const plotW = Math.max(0, width - gutter - 4);
  const n = labels.length;
  const band = n > 0 ? plotW / n : 0;

  const max = Math.max(
    1,
    ...values.map((day) =>
      mode === "stacked" ? day.reduce((a, b) => a + b, 0) : Math.max(0, ...day),
    ),
  );
  const ticks = niceTicks(max);
  const scaleMax = ticks.length ? Math.max(max, ticks[ticks.length - 1]) : max;
  const yOf = (v: number) => 6 + plotH - (v / scaleMax) * plotH;
  const hOf = (v: number) => (v / scaleMax) * plotH;

  const labelEvery = Math.max(
    1,
    Math.ceil(n / Math.max(2, Math.floor(plotW / 56))),
  );

  if (width === 0) return <div ref={ref} style={{ height }} />;

  const tooltipRows =
    hover === null
      ? []
      : series
          .map((s, j) => ({ ...s, value: values[hover][j] }))
          .filter((r) => r.value > 0);
  // Clamp the tooltip inside the container; flip to the left half past midway.
  const tooltipLeft =
    hover === null
      ? 0
      : Math.min(Math.max(gutter + hover * band + band / 2, 70), width - 90);

  return (
    <div
      ref={ref}
      className="relative"
      style={{ height }}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={width} height={height} role="img">
        {ticks.map((t) => (
          <g key={t}>
            {/* Dashed gridlines, solid baseline: the value lines are a
						    reading aid and stay out of the way, the zero line is the
						    floor the bars actually stand on. */}
            <line
              x1={gutter}
              x2={width}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke="var(--border)"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <text
              x={gutter - 8}
              y={yOf(t) + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--text-faint)"
            >
              {tickLabel(t)}
            </text>
          </g>
        ))}
        <line
          x1={gutter}
          x2={width}
          y1={yOf(0)}
          y2={yOf(0)}
          stroke="var(--border)"
          strokeWidth={1}
        />
        {hover !== null && band > 0 && (
          <rect
            x={gutter + hover * band}
            y={6}
            width={band}
            height={plotH}
            rx={6}
            fill="var(--hover)"
          />
        )}
        {labels.map((label, i) => {
          const x0 = gutter + i * band;
          const marks: React.ReactNode[] = [];
          if (mode === "stacked") {
            const barW = Math.max(2, Math.min(24, band * 0.72));
            const x = x0 + (band - barW) / 2;
            // Round both ends of the stack, not just its cap: a bar standing
            // on square feet reads as a rectangle whatever its top does.
            const r = Math.min(barW / 2, 8);
            let yCursor = yOf(0);
            let topIdx = -1;
            let botIdx = -1;
            for (let j = values[i].length - 1; j >= 0; j--)
              if (values[i][j] > 0) {
                topIdx = j;
                break;
              }
            for (let j = 0; j < values[i].length; j++)
              if (values[i][j] > 0) {
                botIdx = j;
                break;
              }
            values[i].forEach((v, j) => {
              if (v <= 0) return;
              const h = hOf(v);
              const y = yCursor - h;
              // 2px surface gap between touching segments (shaved off
              // every segment that has another stacked above it).
              const gap = j === topIdx ? 0 : Math.min(2, h);
              marks.push(
                <path
                  key={j}
                  d={roundedBar(
                    x,
                    y + gap,
                    barW,
                    Math.max(0, h - gap),
                    j === topIdx ? r : 0,
                    j === botIdx ? r : 0,
                  )}
                  fill={series[j].color}
                />,
              );
              yCursor = y;
            });
          } else {
            const cluster = series.length;
            const barW = Math.max(2, Math.min(10, (band - 4) / cluster));
            const x = x0 + (band - barW * cluster - 2 * (cluster - 1)) / 2;
            values[i].forEach((v, j) => {
              if (v <= 0) return;
              const h = hOf(v);
              // These are never wider than 10px, so both ends go fully
              // capsuled: at this width anything less reads as a rectangle.
              marks.push(
                <path
                  key={j}
                  d={roundedBar(
                    x + j * (barW + 2),
                    yOf(0) - h,
                    barW,
                    h,
                    barW / 2,
                    barW / 2,
                  )}
                  fill={series[j].color}
                />,
              );
            });
          }
          return (
            <g key={label}>
              {/* Hovering a day pushes every other day back instead of just
							    marking the one. The read is "this day against the month",
							    and dimming carries that better than a highlight does. */}
              <g opacity={hover === null || hover === i ? 1 : 0.28}>{marks}</g>
              {i % labelEvery === 0 && (
                <text
                  x={x0 + band / 2}
                  y={height - 4}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--text-faint)"
                >
                  {shortDate(label)}
                </text>
              )}
              <rect
                x={x0}
                y={0}
                width={band}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onClick={() => setHover(i)}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && tooltipRows.length > 0 && (
        <ChartTooltip
          className="top-1 -translate-x-1/2"
          style={{ left: tooltipLeft }}
        >
          <div className="mb-1 text-meta font-semibold text-fg">
            {shortDate(labels[hover])}
          </div>
          {tooltipRows.map((r) => (
            <div
              key={r.label}
              className="flex items-center gap-1.5 whitespace-nowrap text-meta leading-4.5"
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: r.color }}
              />
              <span className="text-dim">{r.label}</span>
              <span className="ml-auto pl-3 font-medium tabular-nums text-fg">
                {formatValue(r.value)}
              </span>
            </div>
          ))}
        </ChartTooltip>
      )}
    </div>
  );
}

/** The chart's key, and its filter when the card hands it an `onSelect`.
 *  A legend already names every series and colors it, so isolating one is a
 *  press on the entry rather than a second control listing the same things.
 *  The pressed entry is the way back out, which is what its title says. */
function Legend({
  series,
  selected = null,
  onSelect,
  filterLabel = "Filter",
  clearLabel = "Show all",
}: {
  series: Series[];
  selected?: string | null;
  onSelect?: (value: string) => void;
  /** Names the group of toggles, and each one's "show only X" title. */
  filterLabel?: string;
  clearLabel?: string;
}) {
  if (series.length < 2) return null;
  return (
    <div
      className={cn(
        "mb-3 flex flex-wrap gap-y-1",
        onSelect ? "-mx-1.5 gap-x-0.5" : "gap-x-3.5",
      )}
      role={onSelect ? "group" : undefined}
      aria-label={onSelect ? filterLabel : undefined}
    >
      {series.map((s) => {
        const value = s.value ?? s.label;
        const active = selected !== null && selected === value;
        // One series isolated leaves the rest as context, not as noise:
        // they stay readable, a step back in ink and dot.
        const muted = selected !== null && !active;
        const swatch = (
          <span
            className="size-2 rounded-full"
            style={{ background: s.color, opacity: muted ? 0.4 : 1 }}
          />
        );
        if (!onSelect) {
          return (
            <span
              key={value}
              className="flex items-center gap-1.5 text-meta text-dim"
            >
              {swatch}
              {s.label}
            </span>
          );
        }
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(value)}
            title={active ? clearLabel : `Show only ${s.label}`}
            className={cn(
              "flex items-center gap-1.5 rounded-[999px] px-1.5 py-1 text-meta hover:bg-hover",
              active ? "bg-active text-fg" : muted ? "text-faint" : "text-dim",
            )}
          >
            {swatch}
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  series,
  selected,
  onSelect,
  filterLabel,
  clearLabel,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  series?: Series[];
  /** Pass both to make the legend filter the chart it labels. */
  selected?: string | null;
  onSelect?: (value: string) => void;
  filterLabel?: string;
  clearLabel?: string;
  /** A control that belongs to this chart, on the title's line. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const heading = (
    <h3 className="m-0 text-item-title font-semibold tracking-[-0.01em] text-fg">
      {title}
    </h3>
  );
  return (
    <Card as="section" className="min-w-0 bg-raised p-5">
      {actions ? (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          {heading}
          {actions}
        </div>
      ) : (
        heading
      )}
      {subtitle && (
        <p className="m-0 mb-3 mt-1 text-supporting text-dim">{subtitle}</p>
      )}
      {series && (
        <Legend
          series={series}
          selected={selected}
          onSelect={onSelect}
          filterLabel={filterLabel}
          clearLabel={clearLabel}
        />
      )}
      {children}
    </Card>
  );
}

function StatTile({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  /** Rendered a step down from the figure, so "1.3K" reads and "h" annotates. */
  unit?: string;
  sub?: string;
}) {
  return (
    <Card className="min-w-0 bg-raised px-5 py-4">
      <div className="text-label font-medium text-dim">{label}</div>
      <div className="mt-1 text-stat font-semibold text-fg">
        {value}
        {unit && (
          <span className="ml-0.5 text-item-title font-medium text-dim">
            {unit}
          </span>
        )}
      </div>
      {sub && <div className="mt-1 truncate text-meta text-faint">{sub}</div>}
    </Card>
  );
}

/** What the per-person bars measure. Output tokens are the loudest of the
 *  three and the least fair: how much a model writes per turn is mostly a
 *  property of the model, so a person working on a terse one reads as a
 *  fraction of a colleague doing the same work on a wordy one. Turns and
 *  sessions count the work instead of its prose. */
const REPO_METRICS = [
  { key: "outputTokens", label: "Output", noun: "Output tokens", format: fmt },
  { key: "turns", label: "Turns", noun: "Turns", format: fmtInt },
  { key: "sessions", label: "Sessions", noun: "Sessions", format: fmtInt },
] as const;
type RepoMetric = (typeof REPO_METRICS)[number]["key"];
type RepoMetricMeta = (typeof REPO_METRICS)[number];

function isRepoMetric(value: string): value is RepoMetric {
  return REPO_METRICS.some((metric) => metric.key === value);
}

interface PersonRepoRow {
  name: string;
  total: number;
  segments: AnalyticsPersonRepo[];
}

/** One row per person, one segment per repo, measured in `metric`. `repo`
 *  isolates a single series: people who never touched it drop out, and the
 *  rest rank by the length they are about to draw, because isolated the
 *  question is who works on this repo and the unfiltered order (each person's
 *  activity across everything) puts a one-session worker above the people who
 *  actually built it. Unfiltered, rows keep the people order the table above
 *  uses, and reach further down the list than any single repo's dozen. */
function personRepoRows(
  people: AnalyticsPerson[],
  order: string[],
  metric: RepoMetric,
  repo: string | null,
): PersonRepoRow[] {
  const segOrder = (r: string) => (r ? order.indexOf(r) : order.length);
  const rows: PersonRepoRow[] = [];
  for (const p of people) {
    const segments = (p.repos || []).filter(
      (r) => (repo === null || r.repo === repo) && r[metric] > 0,
    );
    if (!segments.length) continue;
    rows.push({
      name: p.name,
      total: segments.reduce((sum, s) => sum + s[metric], 0),
      segments:
        repo === null
          ? [...segments].sort((a, b) => segOrder(a.repo) - segOrder(b.repo))
          : segments,
    });
  }
  if (repo !== null) rows.sort((a, b) => b.total - a.total);
  return rows.slice(0, 12);
}

/** One row per person: their picture and name, a bar split by repo, and the
 *  total in the metric being measured. A segment can be two pixels wide, so
 *  the hover target is the whole row: pointing anywhere on it raises the
 *  breakdown, and a segment under the pointer is the line that readout marks.
 *  Tapping a row does the same, which is the only way in on touch. */
function PersonRepoBars({
  rows,
  metric,
  maxTotal,
  colorOf,
}: {
  rows: PersonRepoRow[];
  metric: RepoMetricMeta;
  maxTotal: number;
  colorOf: (repo: string) => string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // The row under the pointer, with the geometry the readout is placed
  // against. Measured off the row itself, so it survives any row height.
  const [hover, setHover] = useState<{
    index: number;
    x: number;
    width: number;
    top: number;
    bottom: number;
  } | null>(null);
  // The segment under the pointer, when there is one. Separate state: the
  // row's own mousemove keeps firing over a segment, so folding the two
  // together would clear the segment on the next pixel of travel.
  const [segment, setSegment] = useState<string | null>(null);
  // The readout is placed against its own size, which changes with the
  // number of repos in the row. Measure while it is mounted; the observer also
  // catches content changes as the pointer moves between rows.
  const [tip, setTip] = useState({ w: 0, h: 0 });
  const open = hover !== null;
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!open || !el) return;
    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setTip((cur) => (cur.w === w && cur.h === h ? cur : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  const show = (index: number, e: React.MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const box = wrap.getBoundingClientRect();
    const row = e.currentTarget;
    setHover({
      index,
      x: e.clientX - box.left,
      width: box.width,
      top: row.offsetTop,
      bottom: row.offsetTop + row.offsetHeight,
    });
  };
  const clear = () => {
    setHover(null);
    setSegment(null);
  };
  // A tap has no way out of its own accord: there is no pointer to leave the
  // row with, so the next touch anywhere else is what closes the readout.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !wrapRef.current?.contains(e.target))
        clear();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const row = hover ? rows[hover.index] : null;
  // Above the row when it fits, below otherwise, so the readout never covers
  // the row it describes. Horizontally centred on the pointer, clamped to the
  // chart's own width.
  const above = hover ? hover.top - tip.h - 8 >= 0 : true;
  const half = tip.w / 2;
  const left = hover
    ? Math.min(Math.max(hover.x, half), Math.max(half, hover.width - half))
    : 0;

  return (
    // Rows are contiguous rather than spaced: their padding is the rhythm, so
    // travelling down the list never crosses a gap that would drop the
    // readout and raise it again.
    <div ref={wrapRef} className="relative flex flex-col">
      {rows.map((p, i) => (
        <div
          key={p.name}
          className={cn(
            "-mx-2 flex items-center gap-3 rounded-row px-2 py-1.5 text-label",
            hover?.index === i && "bg-hover",
          )}
          onMouseMove={(e) => show(i, e)}
          onClick={(e) => show(i, e)}
          onMouseLeave={clear}
        >
          <span className="flex w-[20%] min-w-28 items-center gap-2">
            <UserAvatar name={p.name} size={18} />
            <span className="min-w-0 truncate text-fg">{p.name}</span>
          </span>
          <span className="h-3 min-w-0 flex-1">
            <span
              className="flex h-3 min-w-3 overflow-hidden rounded-[999px]"
              style={{ width: `${Math.max(1.5, (100 * p.total) / maxTotal)}%` }}
              onMouseLeave={() => setSegment(null)}
            >
              {p.segments.map((s) => (
                <span
                  key={s.repo || "(none)"}
                  className="block h-3"
                  style={{
                    width: `${(100 * s[metric.key]) / p.total}%`,
                    background: colorOf(s.repo),
                  }}
                  onMouseEnter={() => setSegment(s.repo)}
                />
              ))}
            </span>
          </span>
          <span className="w-14 shrink-0 text-right tabular-nums text-dim">
            {metric.format(p.total)}
          </span>
        </div>
      ))}
      {hover && row && (
        <ChartTooltip
          ref={tipRef}
          className="-translate-x-1/2"
          style={{
            left,
            top: above ? hover.top - tip.h - 8 : hover.bottom + 8,
          }}
        >
          {/* Same size as the row's own picture, so the readout draws the
					    image the row already fetched instead of asking GitHub for a
					    second size and opening on a blank tile. */}
          <div className="mb-1.5 flex items-center gap-1.5">
            <UserAvatar name={row.name} size={18} />
            <span className="text-meta font-semibold text-fg">{row.name}</span>
          </div>
          <table className="border-collapse text-meta">
            <thead>
              <tr className="text-faint">
                <th />
                {REPO_METRICS.map((m) => (
                  // The column the bars are drawn in reads a step up from
                  // the two that are along for the ride.
                  <th
                    key={m.key}
                    className={cn(
                      "pb-0.5 pl-3 text-right font-medium",
                      m.key === metric.key && "text-dim",
                    )}
                  >
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {row.segments.map((s) => (
                <tr
                  key={s.repo || "(none)"}
                  className={
                    segment !== null && segment !== s.repo
                      ? "opacity-40"
                      : undefined
                  }
                >
                  <td>
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-dim">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: colorOf(s.repo) }}
                      />
                      {s.repo ? repoLabel(s.repo) : "No repo"}
                    </span>
                  </td>
                  {REPO_METRICS.map((m) => (
                    <td
                      key={m.key}
                      className={cn(
                        "pl-3 text-right tabular-nums leading-4.5",
                        m.key === metric.key
                          ? "font-medium text-fg"
                          : "text-dim",
                      )}
                    >
                      {m.format(s[m.key])}
                    </td>
                  ))}
                </tr>
              ))}
              {row.segments.length > 1 && (
                <tr className="border-t border-line">
                  <td className="pt-1 pr-2 text-faint">All repos</td>
                  {REPO_METRICS.map((m) => (
                    <td
                      key={m.key}
                      className={cn(
                        "pt-1 pl-3 text-right tabular-nums",
                        m.key === metric.key
                          ? "font-medium text-fg"
                          : "text-dim",
                      )}
                    >
                      {m.format(
                        row.segments.reduce((sum, s) => sum + s[m.key], 0),
                      )}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </ChartTooltip>
      )}
    </div>
  );
}

const PRESETS = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

const OPEN_PR_STATE = { label: "Open", color: "var(--viz-2)" };
const PR_STATE = new Map([
  ["OPEN", OPEN_PR_STATE],
  ["MERGED", { label: "Merged", color: "var(--viz-7)" }],
  ["CLOSED", { label: "Closed", color: "var(--viz-8)" }],
]);

export function Analytics() {
  const [from, setFrom] = useState(() => daysAgo(29));
  const [to, setTo] = useState(utcToday);
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showAllPrs, setShowAllPrs] = useState(false);
  // Which repo the per-person bars are isolated to, or null for the whole
  // mix. `""` is a repo here (the "No repo" bucket), so this is never a
  // falsy check.
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [repoMetric, setRepoMetric] = useState<RepoMetric>("outputTokens");
  // The bar is a sibling above the scroller, so it can't know on its own when
  // the charts have started travelling under it. The app's own chrome rows ask
  // the same question the same way.
  const [barEl, setBarEl] = useState<HTMLElement | null>(null);
  useScrollEdge(barEl, ".analytics-scroll");

  useEffect(() => {
    document.title = docTitle("Analytics");
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchAnalytics(from, to)
      .then((next) => {
        if (!alive) return;
        setData(next);
        setError("");
      })
      .catch((e) => alive && setError(e?.message || "Failed to load analytics"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [from, to]);

  const derived = (() => {
    if (!data) return null;
    const labels = data.days.map((d) => d.date);

    // The engine store prunes, so the oldest days of a long range have no
    // token or cost data left. Plotting them as 0 would read as "usage
    // started here"; the engine-derived charts start where the data does.
    const firstMeasured = data.days.findIndex((d) => !d.unmeasured);
    const engineFrom = firstMeasured < 0 ? data.days.length : firstMeasured;
    const engineDays = data.days.slice(engineFrom);
    const engineLabels = labels.slice(engineFrom);
    const unmeasuredDays = data.totals.unmeasuredDays ?? engineFrom;

    // Sessions by kind: fixed slots for the known kinds, everything else
    // folds into a neutral "Other".
    const presentKinds = KINDS.filter((k) =>
      data.days.some((d) => (d.sessionsByKind[k.key] || 0) > 0),
    );
    const knownKeys = new Set(KINDS.map((k) => k.key));
    const hasOtherKind = data.days.some((d) =>
      Object.entries(d.sessionsByKind).some(
        ([k, v]) => v > 0 && !knownKeys.has(k),
      ),
    );
    const kindSeries: Series[] = presentKinds.map((k) => ({
      label: k.label,
      color: slot(KINDS.indexOf(k) + 1),
    }));
    if (hasOtherKind) kindSeries.push({ label: "Other", color: OTHER_COLOR });
    const kindValues = data.days.map((d) => {
      const row = presentKinds.map((k) => d.sessionsByKind[k.key] || 0);
      if (hasOtherKind) {
        row.push(
          Object.entries(d.sessionsByKind).reduce(
            (sum, [k, v]) => (knownKeys.has(k) ? sum : sum + v),
            0,
          ),
        );
      }
      return row;
    });

    // Output tokens by model: top 5 in the range take slots 1-5, the tail
    // folds into "Other".
    const topModels = data.models.slice(0, 5).map((m) => m.model);
    const hasOtherModel = data.models.length > 5;
    const modelSeries: Series[] = topModels.map((m, i) => ({
      label: m,
      color: slot(i + 1),
    }));
    if (hasOtherModel) modelSeries.push({ label: "Other", color: OTHER_COLOR });
    const modelValues = engineDays.map((d) => {
      const row = topModels.map((m) => d.outputByModel[m] || 0);
      if (hasOtherModel) {
        row.push(
          Object.entries(d.outputByModel).reduce(
            (sum, [m, v]) => (topModels.includes(m) ? sum : sum + v),
            0,
          ),
        );
      }
      return row;
    });

    // Tokens per day, split by kind. Cache reads dwarf the rest by two
    // orders of magnitude, so the stack is really "how much context got
    // re-read" with a sliver of new work on top — which is the honest shape.
    const totalTokens =
      data.totals.totalTokens ??
      data.totals.inputTokens +
        data.totals.outputTokens +
        data.totals.cacheReadTokens +
        data.totals.cacheWriteTokens;
    const tokenSeries: Series[] = [
      { label: "Cache read", color: slot(1) },
      { label: "Input", color: slot(4) },
      { label: "Output", color: slot(2) },
    ];
    // Cache writes are zero on every current engine path; only carry the
    // series when a day actually has some, so the legend stays honest.
    const hasCacheWrite = data.days.some((d) => d.cacheWriteTokens > 0);
    if (hasCacheWrite)
      tokenSeries.push({ label: "Cache write", color: slot(7) });
    const tokenValues = engineDays.map((d) => {
      const row = [d.cacheReadTokens, d.inputTokens, d.outputTokens];
      if (hasCacheWrite) row.push(d.cacheWriteTokens);
      return row;
    });

    // Cost per day by model, priced from the engine stores' per-request
    // token counts against the model catalog.
    const costUsd = data.totals.costUsd ?? 0;
    const requests = data.totals.requests ?? 0;
    const hasCost = costUsd > 0;
    const costModels = [...data.models]
      .filter((m) => (m.costUsd ?? 0) > 0)
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
      .slice(0, 5)
      .map((m) => m.model);
    const costSeries: Series[] = costModels.map((m, i) => ({
      label: m,
      color: slot(i + 1),
    }));
    const costValues = engineDays.map((d) =>
      costModels.map((m) => d.costByModel?.[m] || 0),
    );

    const prSeries: Series[] = [
      { label: "Opened", color: slot(1) },
      { label: "Merged", color: slot(2) },
    ];
    const prValues = data.days.map((d) => [d.prsOpened, d.prsMerged]);

    const turnSeries: Series[] = [
      { label: "Turns", color: slot(1) },
      { label: "Errors", color: slot(8) },
    ];
    const turnValues = data.days.map((d) => [d.turns, d.errors]);

    const factorySeries: Series[] = [
      { label: "Human-reviewed", color: slot(2) },
      { label: "No human review", color: slot(8) },
    ];
    const factoryByDate = new Map(data.factory.days.map((d) => [d.date, d]));
    const factoryValues = labels.map((date) => {
      const d = factoryByDate.get(date);
      return [d?.reviewed || 0, d?.unreviewed || 0];
    });

    // Per-person repo mix: colors follow the repos table's order (slots 1-8,
    // tail and the "no repo" bucket fold into neutral gray).
    const coloredRepos = data.repos.map((r) => r.repo).filter(Boolean);
    const repoColor = (repo: string) => {
      const i = coloredRepos.indexOf(repo);
      return repo && i >= 0 && i < 8 ? slot(i + 1) : OTHER_COLOR;
    };

    // Review finding outcomes, cohorted by the day the finding was posted.
    // Guard: the live-rebuilt frontend can briefly run against a not-yet-
    // restarted server whose payload has no reviewQuality.
    const rq = data.reviewQuality;
    const reviewSeries: Series[] = [
      { label: "Addressed", color: slot(2) },
      { label: "Pushback", color: slot(4) },
      { label: "Ignored", color: slot(8) },
      { label: "Pending", color: OTHER_COLOR },
    ];
    const reviewByDate = new Map((rq?.days || []).map((d) => [d.date, d]));
    const reviewValues = labels.map((date) => {
      const d = reviewByDate.get(date);
      return [
        d?.addressed || 0,
        d?.dismissed || 0,
        d?.ignored || 0,
        d?.pending || 0,
      ];
    });
    const splitDate = labels[Math.floor(labels.length / 2)] || "";

    return {
      labels,
      engineLabels,
      unmeasuredDays,
      kindSeries,
      kindValues,
      modelSeries,
      modelValues,
      tokenSeries,
      tokenValues,
      totalTokens,
      costSeries,
      costValues,
      costUsd,
      requests,
      hasCost,
      prSeries,
      prValues,
      turnSeries,
      turnValues,
      factorySeries,
      factoryValues,
      rq,
      reviewSeries,
      reviewValues,
      splitDate,
      repoColor,
      coloredRepos,
    };
  })();

  // The per-person bars: rebuilt per metric and per filter rather than held
  // in `derived`, so switching either does not rebuild every other chart.
  const allRepoRows =
    data && derived
      ? personRepoRows(data.people, derived.coloredRepos, repoMetric, null)
      : [];
  // Colors and legend order follow the repos table; a repo only appears once
  // somebody's bar carries it in the metric being shown.
  const personRepoSeries: Series[] = !derived
    ? []
    : [...derived.coloredRepos, ""]
        .filter((repo) =>
          allRepoRows.some((p) => p.segments.some((s) => s.repo === repo)),
        )
        .map((repo) => ({
          label: repo ? repoLabel(repo) : "No repo",
          color: derived.repoColor(repo),
          value: repo,
        }));
  // A held filter outlives the range and the metric it was picked in, so it
  // only counts while that repo is still one of the chart's own series.
  const activeRepo =
    repoFilter !== null && personRepoSeries.some((s) => s.value === repoFilter)
      ? repoFilter
      : null;
  const repoRows =
    !data || !derived || activeRepo === null
      ? allRepoRows
      : personRepoRows(
          data.people,
          derived.coloredRepos,
          repoMetric,
          activeRepo,
        );
  // Scale to the longest bar on screen: filtered to a small repo, every bar
  // measured against the unfiltered leader would be a stub.
  const maxRepoRow = Math.max(1, ...repoRows.map((r) => r.total));
  const metricMeta = REPO_METRICS.find((m) => m.key === repoMetric)!;

  return (
    <div className="analytics-viz flex min-h-0 flex-1 flex-col bg-bg">
      <style>{VIZ_STYLE}</style>
      {/* The page's own title bar, built the way REPORTS_COLUMN_HEADER is: a
			    sibling ABOVE the scroller rather than a sticky box inside it, so it
			    is fixed by construction, spans the pane edge to edge, and the charts
			    travel out of sight under it. `--desktop-header-h` is the height the
			    chat header, the sidebar's brand row and the plain pane title all
			    take, so this lines up with them across the top of the window, and
			    `wco-chrome` makes that stretch a window drag region in the desktop
			    shell (base.css exempts the controls in it).
			    The fill is the page's own, so there is no seam to draw at rest;
			    SCROLL_EDGE_DIVIDER grows the hairline once something is actually
			    passing underneath. */}
      <TopBar
        as="header"
        ref={setBarEl}
        className={cn(
          "wco-chrome flex h-[var(--desktop-header-h)] shrink-0 items-center",
          "phone:h-auto phone:py-2.5",
          SCROLL_EDGE_DIVIDER,
        )}
      >
        {/* The bar's fill and hairline run the full pane; its contents keep to
				    the exact column the cards below are centred in, padding included.
				    The name therefore sits on the cards' left edge and the range
				    control on their right. Analytics is a compact dashboard rather
				    than a reading page, so its name lives here from the first frame
				    instead of taking a second large-title row in the content. */}
        <div className="mx-auto flex w-full max-w-[1080px] flex-wrap items-center justify-between gap-3 px-4 md:px-6">
          <TopBarTitle
            className={cn(
              "text-item-title font-semibold text-fg",
              DETAIL_TOPBAR_TITLE_TEXT,
            )}
            data-shown=""
          >
            Analytics
          </TopBarTitle>
          {/* The presets and the span are one control: they set one value
					    between them, and it carries the chrome tier the rest of the bar
					    is on rather than a plate per end. */}
          <TopBarActions>
            <DateRangeField
              label="Date range"
              from={from}
              to={to}
              max={utcToday()}
              presets={PRESETS}
              onRangeChange={(start, end) => {
                setFrom(start);
                setTo(end);
              }}
            />
          </TopBarActions>
        </div>
      </TopBar>

      <div className="analytics-scroll min-h-0 flex-1 overflow-y-auto">
        {/* No top padding: every block in here opens with its own `mt-4`,
				    which is the gap under the bar. */}
        <div className="mx-auto w-full max-w-[1080px] px-4 pb-10 md:px-6">
          {error && <p className="mt-4 text-body text-red">{error}</p>}
          {!data && !error && (
            <div className="flex h-60 items-center justify-center text-body text-dim">
              Loading analytics…
            </div>
          )}

          {data && derived && (
            <div
              className={
                loading ? "opacity-60 transition-opacity" : "transition-opacity"
              }
            >
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatTile
                  label="Active sessions"
                  value={fmtInt(data.totals.sessions)}
                  sub={`${fmtInt(data.totals.sessionsCreated)} created in range`}
                />
                <StatTile
                  label="Turns"
                  value={fmtInt(data.totals.turns)}
                  sub={`${fmtInt(data.totals.errors)} errors · ${fmtInt(data.totals.cancelled)} cancelled`}
                />
                <StatTile
                  label="Tokens"
                  value={fmt(derived.totalTokens)}
                  sub={`${fmt(data.totals.inputTokens)} in · ${fmt(data.totals.outputTokens)} out${
                    data.totals.cacheWriteTokens
                      ? ` · ${fmt(data.totals.cacheWriteTokens)} cache write`
                      : ""
                  }`}
                />
                <StatTile
                  label="Cost at list price"
                  value={derived.hasCost ? fmtUsd(derived.costUsd) : "–"}
                  sub={
                    derived.hasCost
                      ? `at list price · ${fmt(derived.requests)} model requests`
                      : "no priced requests in range"
                  }
                />
                <StatTile
                  label="Cache reads"
                  value={fmt(data.totals.cacheReadTokens)}
                  sub={`${pct(data.totals.cacheReadTokens, derived.totalTokens)} of all tokens`}
                />
                <StatTile
                  label="Agent time"
                  value={fmt(Math.round(data.totals.durationMs / 3_600_000))}
                  unit="h"
                  sub="wall-clock across turns"
                />
                <StatTile
                  label="PRs opened"
                  value={fmtInt(data.totals.prsOpened)}
                  sub={`of ${fmtInt(data.totals.allPrsOpened)} across repos`}
                />
                <StatTile
                  label="PRs merged"
                  value={fmtInt(data.totals.prsMerged)}
                  sub={
                    data.totals.allPrsMerged
                      ? `${Math.round((100 * data.totals.prsMerged) / data.totals.allPrsMerged)}% of all merges`
                      : "no merges in range"
                  }
                />
                <StatTile
                  label="People active"
                  value={fmtInt(data.totals.activePeople)}
                  sub="humans with sessions"
                />
                <StatTile
                  label="Automation runs"
                  value={fmtInt(
                    data.automations.reduce((sum, a) => sum + a.runs, 0),
                  )}
                  sub={`across ${fmtInt(data.automations.filter((a) => a.runs > 0).length)} automations`}
                />
              </div>

              {derived.unmeasuredDays > 0 && (
                <p className="m-0 mt-2 text-supporting text-faint">
                  Tokens and cost cover {shortDate(derived.engineLabels[0])}{" "}
                  onwards. The engine keeps about a month of message history, so
                  the earlier{" "}
                  {derived.unmeasuredDays === 1
                    ? "day"
                    : `${derived.unmeasuredDays} days`}{" "}
                  of this range have no data left to read. Everything else on
                  this page covers the full range.
                </p>
              )}

              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <ChartCard
                  title="Sessions per day"
                  subtitle="Distinct sessions with agent activity"
                  series={derived.kindSeries}
                >
                  <BarChart
                    labels={derived.labels}
                    series={derived.kindSeries}
                    values={derived.kindValues}
                    mode="stacked"
                  />
                </ChartCard>
                <ChartCard
                  title="Output tokens per day"
                  subtitle="By model, top 5 in range"
                  series={derived.modelSeries}
                >
                  <BarChart
                    labels={derived.engineLabels}
                    series={derived.modelSeries}
                    values={derived.modelValues}
                    mode="stacked"
                  />
                </ChartCard>
                <ChartCard
                  title="Tokens per day"
                  subtitle="Every token the engines read and wrote, by kind"
                  series={derived.tokenSeries}
                >
                  <BarChart
                    labels={derived.engineLabels}
                    series={derived.tokenSeries}
                    values={derived.tokenValues}
                    mode="stacked"
                  />
                </ChartCard>
                {derived.hasCost && (
                  <ChartCard
                    title="Cost per day at list price"
                    subtitle="By model, top 5 in range"
                    series={derived.costSeries}
                  >
                    <BarChart
                      labels={derived.engineLabels}
                      series={derived.costSeries}
                      values={derived.costValues}
                      mode="stacked"
                      formatValue={fmtUsd}
                      formatTick={fmtUsdTick}
                    />
                    <p className="m-0 mt-2 text-supporting text-faint">
                      What this traffic would have cost on the API, not what was
                      paid: every model runs on a subscription pool. Counted per
                      model request, so tool calls and sub-agents are included.
                    </p>
                  </ChartCard>
                )}
                <ChartCard
                  title="Pull requests per day"
                  subtitle={`Opened & merged from ${PRODUCT_NAME} sessions`}
                  series={derived.prSeries}
                >
                  <BarChart
                    labels={derived.labels}
                    series={derived.prSeries}
                    values={derived.prValues}
                    mode="grouped"
                    formatValue={fmtInt}
                  />
                </ChartCard>
                <ChartCard
                  title="Turns per day"
                  subtitle="Completed turns and errored events"
                  series={derived.turnSeries}
                >
                  <BarChart
                    labels={derived.labels}
                    series={derived.turnSeries}
                    values={derived.turnValues}
                    mode="grouped"
                  />
                </ChartCard>
                <ChartCard
                  title="Review coverage on merges"
                  subtitle="Merged PRs per day, split by whether a human reviewed or commented"
                  series={derived.factorySeries}
                >
                  <BarChart
                    labels={derived.labels}
                    series={derived.factorySeries}
                    values={derived.factoryValues}
                    mode="stacked"
                    formatValue={fmtInt}
                  />
                </ChartCard>
                <ChartCard
                  title="Factory health"
                  subtitle={`Merged PRs in range: agent (${PRODUCT_NAME} sessions) vs everything else`}
                >
                  <table className="w-full border-collapse text-label">
                    <thead>
                      <tr className="text-left text-meta text-faint">
                        <th className="pb-1.5 font-medium">Metric</th>
                        <th className="pb-1.5 text-right font-medium">
                          Agent PRs
                        </th>
                        <th className="pb-1.5 text-right font-medium">
                          Other PRs
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const { agent, other } = data.factory;
                        const pct = (c: typeof agent) =>
                          c.merged
                            ? `${Math.round((100 * c.humanReviewed) / c.merged)}%`
                            : "–";
                        const rows: Array<[string, string, string]> = [
                          [
                            "Merged",
                            fmtInt(agent.merged),
                            fmtInt(other.merged),
                          ],
                          ["Human-reviewed", pct(agent), pct(other)],
                          [
                            "Rework commits after review (avg)",
                            String(agent.avgReworkCommits),
                            String(other.avgReworkCommits),
                          ],
                          [
                            "Reverts",
                            fmtInt(agent.reverts),
                            fmtInt(other.reverts),
                          ],
                          [
                            "Median hours to merge",
                            String(agent.medianHoursToMerge),
                            String(other.medianHoursToMerge),
                          ],
                          [
                            "Avg lines changed",
                            fmtInt(agent.avgLinesChanged),
                            fmtInt(other.avgLinesChanged),
                          ],
                        ];
                        return rows.map(([label, a, b]) => (
                          <tr key={label} className="border-t border-line">
                            <td className="py-1.5 text-fg">{label}</td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {a}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {b}
                            </td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </table>
                </ChartCard>
                {derived.rq && (
                  <>
                    <ChartCard
                      title="Review finding outcomes"
                      subtitle="Bot findings by day posted; outcomes settle as PRs progress, so recent days show pending"
                      series={derived.reviewSeries}
                    >
                      <BarChart
                        labels={derived.labels}
                        series={derived.reviewSeries}
                        values={derived.reviewValues}
                        mode="stacked"
                        formatValue={fmtInt}
                      />
                    </ChartCard>
                    <ChartCard
                      title="Review quality trend"
                      subtitle={`Earlier vs recent half of the range (split at ${shortDate(derived.splitDate)}). Is the reviewer getting better?`}
                    >
                      <table className="w-full border-collapse text-label">
                        <thead>
                          <tr className="text-left text-meta text-faint">
                            <th className="pb-1.5 font-medium">Metric</th>
                            <th className="pb-1.5 text-right font-medium">
                              Earlier
                            </th>
                            <th className="pb-1.5 text-right font-medium">
                              Recent
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const { earlier, recent } = derived.rq;
                            const pct = (v: number | null) =>
                              v === null ? "–" : `${v}%`;
                            const num = (v: number | null) =>
                              v === null ? "–" : String(v);
                            const rows: Array<[string, string, string]> = [
                              [
                                "Findings posted",
                                fmtInt(earlier.posted),
                                fmtInt(recent.posted),
                              ],
                              [
                                "Addressed rate (of settled)",
                                pct(earlier.addressedRate),
                                pct(recent.addressedRate),
                              ],
                              [
                                "Author pushback",
                                fmtInt(earlier.dismissed),
                                fmtInt(recent.dismissed),
                              ],
                              [
                                "Ignored at close",
                                fmtInt(earlier.ignored),
                                fmtInt(recent.ignored),
                              ],
                              [
                                "Missed bugs detected",
                                fmtInt(earlier.missedBugs),
                                fmtInt(recent.missedBugs),
                              ],
                              [
                                "Reviews run",
                                fmtInt(earlier.reviews),
                                fmtInt(recent.reviews),
                              ],
                              [
                                "Findings per review",
                                num(earlier.avgFindingsPerReview),
                                num(recent.avgFindingsPerReview),
                              ],
                              [
                                "Avg merge-confidence",
                                num(earlier.avgConfidence),
                                num(recent.avgConfidence),
                              ],
                              [
                                "Withheld by noise filter",
                                fmtInt(earlier.withheld),
                                fmtInt(recent.withheld),
                              ],
                            ];
                            return rows.map(([label, a, b]) => (
                              <tr key={label} className="border-t border-line">
                                <td className="py-1.5 text-fg">{label}</td>
                                <td className="py-1.5 text-right tabular-nums text-dim">
                                  {a}
                                </td>
                                <td className="py-1.5 text-right tabular-nums text-dim">
                                  {b}
                                </td>
                              </tr>
                            ));
                          })()}
                        </tbody>
                      </table>
                      <p className="m-0 mt-2 text-supporting text-faint">
                        Addressed = author acted on the finding · pushback =
                        author explicitly rejected it · reviews-run metrics
                        collect from Jul 28 on. High addressed rate + low
                        pushback/missed bugs = healthier reviews.
                      </p>
                    </ChartCard>
                  </>
                )}
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <ChartCard title="Models" subtitle="Tokens and cost per model">
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-label">
                      <thead>
                        <tr className="text-left text-meta text-faint">
                          {/* Headline numbers first, breakdown after: at phone width the
													    table scrolls, and Tokens/Cost are what must survive the cut. */}
                          <th className="pb-1.5 font-medium">Model</th>
                          <th className="pb-1.5 text-right font-medium">
                            Requests
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Tokens
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Cost
                          </th>
                          <th className="pb-1.5 text-right font-medium">In</th>
                          <th className="pb-1.5 text-right font-medium">Out</th>
                          <th className="pb-1.5 text-right font-medium">
                            Cache read
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.models.slice(0, 10).map((m) => (
                          <tr key={m.model} className="border-t border-line">
                            <td
                              className="max-w-32 truncate py-1.5 text-fg"
                              title={m.model}
                            >
                              {m.model}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(m.requests ?? m.turns)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-fg">
                              {fmt(
                                m.totalTokens ??
                                  m.inputTokens +
                                    m.outputTokens +
                                    m.cacheReadTokens +
                                    m.cacheWriteTokens,
                              )}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtUsdCell(m.costUsd ?? 0)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmt(m.inputTokens)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmt(m.outputTokens)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmt(m.cacheReadTokens)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(data.totals.unpricedRequests ?? 0) > 0 && (
                    <p className="m-0 mt-2 text-supporting text-faint">
                      A dash means the model carries no catalog price, so its
                      requests are left out of the total.
                    </p>
                  )}
                </ChartCard>
                <ChartCard
                  title="Repos"
                  subtitle="Sessions, turns and PRs per repo"
                >
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-label">
                      <thead>
                        <tr className="text-left text-meta text-faint">
                          <th className="pb-1.5 font-medium">Repo</th>
                          <th className="pb-1.5 text-right font-medium">
                            Sessions
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Turns
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Opened
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Merged
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Share
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.repos.map((r) => (
                          <tr
                            key={r.repo || "(none)"}
                            className="border-t border-line"
                          >
                            <td
                              className={`max-w-32 truncate py-1.5 ${r.repo ? "text-fg" : "text-faint"}`}
                            >
                              {r.repo ? repoLabel(r.repo) : "No repo"}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(r.sessions || 0)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(r.turns || 0)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(r.prsOpened)}{" "}
                              <span className="text-faint">
                                / {fmtInt(r.allOpened)}
                              </span>
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(r.prsMerged)}{" "}
                              <span className="text-faint">
                                / {fmtInt(r.allMerged)}
                              </span>
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-fg">
                              {r.allMerged
                                ? `${Math.round((100 * r.prsMerged) / r.allMerged)}%`
                                : "–"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="m-0 mt-2 text-supporting text-faint">
                    Opened/Merged = {PRODUCT_NAME} PRs / all PRs in range ·
                    share = {PRODUCT_NAME}'s cut of merges.
                  </p>
                </ChartCard>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <ChartCard
                  title="People"
                  subtitle="Sessions and turns per person"
                >
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-label">
                      <thead>
                        <tr className="text-left text-meta text-faint">
                          <th className="pb-1.5 font-medium">Person</th>
                          <th className="pb-1.5 text-right font-medium">
                            Created
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Active
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Turns
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.people.slice(0, 12).map((p) => (
                          <tr key={p.name} className="border-t border-line">
                            {/* A surface row carries real work but names nobody, so it is
														    left out of the People active count. Dim it, or the table
														    and that number look like they disagree. */}
                            <td
                              className={`max-w-40 py-1.5 ${p.unattributed ? "text-faint" : "text-fg"}`}
                              title={
                                p.unattributed
                                  ? `Sessions from ${p.name} with no person recorded`
                                  : undefined
                              }
                            >
                              <span className="flex items-center gap-2">
                                {p.unattributed ? null : (
                                  <UserAvatar name={p.name} size={18} />
                                )}
                                <span className="min-w-0 truncate">
                                  {p.name}
                                </span>
                              </span>
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(p.sessionsCreated)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(p.sessionsActive)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(p.turns)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </ChartCard>
                <ChartCard
                  title="Automations"
                  subtitle="Runs, turns and errors per automation"
                >
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-label">
                      <thead>
                        <tr className="text-left text-meta text-faint">
                          <th className="pb-1.5 font-medium">Automation</th>
                          <th className="pb-1.5 text-right font-medium">
                            Runs
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Turns
                          </th>
                          <th className="pb-1.5 text-right font-medium">
                            Errors
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.automations.slice(0, 12).map((a) => (
                          <tr key={a.name} className="border-t border-line">
                            <td
                              className="max-w-44 truncate py-1.5 text-fg"
                              title={a.name}
                            >
                              {a.name}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(a.runs)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-dim">
                              {fmtInt(a.turns)}
                            </td>
                            <td
                              className={`py-1.5 text-right tabular-nums ${a.errors ? "text-red" : "text-faint"}`}
                            >
                              {fmtInt(a.errors)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </ChartCard>
              </div>

              {allRepoRows.length > 0 && (
                <div className="mt-4">
                  <ChartCard
                    title="Repo activity per person"
                    subtitle={
                      activeRepo === null
                        ? `${metricMeta.noun} by repo. Hover a row for sessions, turns and output.`
                        : `${metricMeta.noun} in ${
                            activeRepo
                              ? repoLabel(activeRepo)
                              : "sessions with no repo"
                          }. Hover a row for sessions, turns and output.`
                    }
                    actions={
                      <Segmented
                        label="Measure"
                        size="sm"
                        value={repoMetric}
                        onValueChange={(value) => {
                          if (isRepoMetric(value)) setRepoMetric(value);
                        }}
                      >
                        {REPO_METRICS.map((m) => (
                          <SegmentedOption key={m.key} value={m.key}>
                            {m.label}
                          </SegmentedOption>
                        ))}
                      </Segmented>
                    }
                    series={personRepoSeries}
                    selected={activeRepo}
                    onSelect={(repo) =>
                      setRepoFilter((cur) => (cur === repo ? null : repo))
                    }
                    filterLabel="Filter by repo"
                    clearLabel="Show all repos"
                  >
                    <PersonRepoBars
                      rows={repoRows}
                      metric={metricMeta}
                      maxTotal={maxRepoRow}
                      colorOf={derived.repoColor}
                    />
                  </ChartCard>
                </div>
              )}

              {data.prs.length > 0 && (
                <div className="mt-4">
                  <ChartCard
                    title={`Pull requests from ${PRODUCT_NAME}`}
                    subtitle={`${fmtInt(data.prs.length)} PRs opened or merged in range`}
                  >
                    <div className="flex flex-col">
                      {(showAllPrs ? data.prs : data.prs.slice(0, 12)).map(
                        (pr) => {
                          const state = PR_STATE.get(pr.state) ?? OPEN_PR_STATE;
                          return (
                            <a
                              key={`${pr.repo}#${pr.number}`}
                              href={pr.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="-mx-2 flex items-center gap-2.5 rounded-row px-2 py-1.5 text-label no-underline hover:bg-hover"
                            >
                              <span
                                className="size-2 shrink-0 rounded-full"
                                style={{ background: state.color }}
                              />
                              <span className="shrink-0 tabular-nums text-faint">
                                {repoLabel(pr.repo)}#{pr.number}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-fg">
                                {pr.title}
                              </span>
                              <span className="hidden shrink-0 text-faint sm:inline">
                                {state.label}
                              </span>
                              <span className="shrink-0 tabular-nums text-faint">
                                {shortDate(pr.mergedAt || pr.createdAt)}
                              </span>
                            </a>
                          );
                        },
                      )}
                    </div>
                    {data.prs.length > 12 && (
                      <Button
                        size="sm"
                        className="mt-2 text-control-label"
                        onClick={() => setShowAllPrs((v) => !v)}
                      >
                        {showAllPrs
                          ? "Show fewer"
                          : `Show all ${fmtInt(data.prs.length)}`}
                      </Button>
                    )}
                  </ChartCard>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
