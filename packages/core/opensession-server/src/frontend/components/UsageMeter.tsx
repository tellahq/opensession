import * as React from "react";
import type { SessionUsage } from "../lib/types";
import type {
  ContextBreakdown,
  ContextSectionKind,
} from "@tellahq/opensession-protocol/events";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";

/**
 * Compact live cost + context readout for the mobile session bar. Shows the
 * running API-equivalent USD spend for the conversation and a ring gauge of
 * how close the context is to being compacted; tap for what fills it (system
 * prompt, tools, instructions, the conversation) and the token totals. Cost
 * comes directly from the engine's completed provider messages. Hidden until
 * the first run reports usage.
 */

function fmtUsd(n: number): string {
  if (n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return compact.format(n);
}

/** Fill-level color: neutral under 85%, red once the window is nearly full. */
function fillTone(frac: number) {
  if (frac >= 0.85) return { stroke: "stroke-red", text: "text-red" };
  return { stroke: "stroke-accent", text: "text-dim" };
}

/**
 * How full the context is, measured two ways. The gauge runs to the point the
 * engine compacts, because that is the next thing that will happen to the
 * conversation; on a 1M model that is well under half the window, so a gauge
 * against the window would sit near empty for a conversation about to be
 * summarized. The warning tone still reads the window itself: only a prompt
 * near the real ceiling is a problem.
 */
export function contextFill(usage: SessionUsage | undefined) {
  const window = usage?.contextWindow || 0;
  const tokens = usage?.contextTokens || 0;
  const compactAt = usage?.context?.compactAtTokens || 0;
  const limit = compactAt > 0 && compactAt < window ? compactAt : window;
  return {
    tokens,
    window,
    limit,
    compacts: limit > 0 && limit < window,
    frac: limit > 0 ? Math.min(tokens / limit, 1) : 0,
    tone: fillTone(window > 0 ? Math.min(tokens / window, 1) : 0),
  };
}

// The conversation first, then what is sent before it. One chart color each:
// the bar and its legend are read against each other, not against meaning.
const SECTIONS: Array<{
  kind: ContextSectionKind;
  label: string;
  swatch: string;
}> = [
  { kind: "messages", label: "Messages", swatch: "bg-chart-1" },
  { kind: "summary", label: "Earlier summary", swatch: "bg-chart-2" },
  { kind: "system-prompt", label: "System prompt", swatch: "bg-chart-3" },
  { kind: "instructions", label: "Project instructions", swatch: "bg-chart-4" },
  { kind: "tools", label: "Tools", swatch: "bg-chart-5" },
  { kind: "mcp-tools", label: "MCP tools", swatch: "bg-chart-6" },
  { kind: "skills", label: "Skills", swatch: "bg-chart-7" },
];

/** The sections in display order, with a section this client does not know
 * (a newer server) folded into one "Other" row instead of dropped: the rows
 * must keep adding up to the total above them. */
export function contextRows(breakdown: ContextBreakdown | undefined) {
  if (!breakdown?.sections.length) return [];
  const known = new Set<string>(SECTIONS.map((section) => section.kind));
  const rows = SECTIONS.flatMap((section) => {
    const tokens = breakdown.sections
      .filter((s) => s.kind === section.kind)
      .reduce((sum, s) => sum + s.tokens, 0);
    return tokens > 0 ? [{ ...section, tokens }] : [];
  });
  const other = breakdown.sections
    .filter((s) => !known.has(s.kind))
    .reduce((sum, s) => sum + s.tokens, 0);
  if (other > 0)
    rows.push({
      kind: "messages",
      label: "Other",
      swatch: "bg-chart-8",
      tokens: other,
    });
  return rows;
}

/** What fills the context window: one bar, one row per part. */
function ContextSections({ breakdown }: { breakdown: ContextBreakdown }) {
  const rows = contextRows(breakdown);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  if (total <= 0) return null;
  return (
    <div className="mt-2" data-context-breakdown>
      <div
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-line"
        aria-hidden
      >
        {rows.map((row) => (
          <span
            key={row.label}
            className={cn("h-full min-w-px", row.swatch)}
            style={{ flexGrow: row.tokens, flexBasis: 0 }}
          />
        ))}
      </div>
      <ul className="m-0 mt-2 list-none space-y-1 p-0">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-baseline justify-between gap-4"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-dim">
              <span
                className={cn("size-2 flex-none rounded-full", row.swatch)}
                aria-hidden
              />
              <span className="truncate">{row.label}</span>
            </span>
            <span className="flex-none tabular-nums">
              {fmtTokens(row.tokens)}
              <span className="ml-1.5 inline-block w-8 text-right text-faint">
                {Math.round((row.tokens / total) * 100)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** When the conversation is next summarized, and how often it has been. */
function compactionNote(
  breakdown: ContextBreakdown | undefined,
  fill: ReturnType<typeof contextFill>,
): string {
  const times = breakdown?.compactions ?? 0;
  return [
    fill.compacts
      ? `Compacts at ${fmtTokens(fill.limit)} of a ${fmtTokens(fill.window)} window`
      : "",
    times > 0 ? `Compacted ${times === 1 ? "once" : `${times} times`}` : "",
  ]
    .filter(Boolean)
    .join(". ");
}

/** SVG progress ring for how full the context window is. */
function ContextRing({
  frac,
  tone,
  size = 14,
}: {
  frac: number;
  tone: string;
  size?: number;
}) {
  const sw = 2;
  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(Math.max(frac, 0), 1));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="-rotate-90"
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={sw}
        className="stroke-line"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        className={cn("transition-[stroke-dashoffset] duration-300", tone)}
      />
    </svg>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <span className="text-dim">{label}</span>
      <span className={cn("tabular-nums", strong && "text-fg")}>{value}</span>
    </div>
  );
}

export function UsageCost({
  usage,
  className,
}: {
  usage: SessionUsage | undefined;
  className?: string;
}) {
  return (
    <span className={cn("tabular-nums", className)}>
      {fmtUsd(usage?.costUsd ?? 0)}
    </span>
  );
}

export function UsageDetails({
  usage,
  className,
}: {
  usage: SessionUsage | undefined;
  className?: string;
}) {
  const fill = contextFill(usage);
  const note = compactionNote(usage?.context, fill);
  const totalIn =
    (usage?.inputTokens ?? 0) +
    (usage?.cacheReadTokens ?? 0) +
    (usage?.cacheCreationTokens ?? 0);
  const cacheHit =
    totalIn > 0
      ? Math.round(((usage?.cacheReadTokens ?? 0) / totalIn) * 100)
      : 0;
  const turns = usage?.turns ?? 0;

  return (
    <div className={cn("text-xs", className)}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-medium text-fg">This conversation</span>
        <span className="text-dim">
          {turns} turn{turns === 1 ? "" : "s"}
        </span>
      </div>
      <div className="space-y-1.5">
        <Row label="Cost" value={<UsageCost usage={usage} />} strong />
        {fill.limit > 0 && (
          <Row
            label="Context"
            value={
              <span className={fill.tone.text}>
                {fmtTokens(fill.tokens)} / {fmtTokens(fill.limit)} (
                {Math.round(fill.frac * 100)}%)
              </span>
            }
          />
        )}
      </div>
      {usage?.context && <ContextSections breakdown={usage.context} />}
      {note && <p className="m-0 mt-2 text-faint">{note}.</p>}
      <div className="my-2 h-px bg-line" />
      <div className="space-y-1.5">
        <Row label="Input" value={fmtTokens(usage?.inputTokens ?? 0)} />
        <Row label="Output" value={fmtTokens(usage?.outputTokens ?? 0)} />
        <Row
          label="Cache read"
          value={`${fmtTokens(usage?.cacheReadTokens ?? 0)} (${cacheHit}%)`}
        />
        <Row
          label="Cache write"
          value={fmtTokens(usage?.cacheCreationTokens ?? 0)}
        />
      </div>
    </div>
  );
}

export function UsageMeter({
  usage,
  className,
  showCacheRate = false,
}: {
  usage: SessionUsage | undefined;
  className?: string;
  showCacheRate?: boolean;
}) {
  if (!usage || usage.turns === 0) return null;

  const fill = contextFill(usage);
  const totalIn =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const cacheHit =
    totalIn > 0 ? Math.round((usage.cacheReadTokens / totalIn) * 100) : 0;

  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={200}
        closeDelay={100}
        className={cn(
          // A quiet pill in the session subtitle: this is a readout you can
          // open, not a plate you press.
          "group flex min-h-8 items-center gap-1.5 rounded-full px-1.5 py-1 text-xs font-medium",
          "text-dim hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg",
          "cursor-pointer select-none outline-none transition-colors",
          className,
        )}
        aria-label="Conversation cost & context"
      >
        <UsageCost usage={usage} className="text-fg" />
        {fill.limit > 0 && (
          <ContextRing frac={fill.frac} tone={fill.tone.stroke} />
        )}
        {showCacheRate && (
          // Off by default, and the phone header's meter leaves it off: there
          // the meter rides in the title pill's subtitle next to the model
          // name, and the cache rate is the one thing on that line nobody
          // navigates by — it was pushing "Opus 5 + Fable oracle" down to
          // "Opus 5 + …".
          <span className="tabular-nums text-dim">{cacheHit}% cached</span>
        )}
      </Popover.Trigger>
      <Popover.Popup side="top" align="end" className="w-64 p-3 text-xs">
        <UsageDetails usage={usage} />
      </Popover.Popup>
    </Popover.Root>
  );
}
