import * as React from "react";
import type { SessionUsage } from "../lib/types";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";

/**
 * Compact live cost + context readout for the mobile session bar. Shows the
 * running API-equivalent USD spend for the conversation and a ring gauge of
 * how full the model's context window is; tap for a per-token breakdown. Cost
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
  const window = usage?.contextWindow || 0;
  const ctx = usage?.contextTokens || 0;
  const frac = window > 0 ? Math.min(ctx / window, 1) : 0;
  const tone = fillTone(frac);
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
        {window > 0 && (
          <Row
            label="Context"
            value={
              <span className={tone.text}>
                {fmtTokens(ctx)} / {fmtTokens(window)} ({Math.round(frac * 100)}
                %)
              </span>
            }
          />
        )}
      </div>
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

  const window = usage.contextWindow || 0;
  const ctx = usage.contextTokens || 0;
  const frac = window > 0 ? Math.min(ctx / window, 1) : 0;
  const tone = fillTone(frac);
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
        {window > 0 && <ContextRing frac={frac} tone={tone.stroke} />}
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
