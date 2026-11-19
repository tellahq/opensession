import type { ReactNode } from "react";
import type { ModelOption, ProviderAccountOption } from "../../lib/api";
import {
  resetsIn,
  sessionLimits,
  type SessionLimit,
} from "../../lib/account-limits";
import { baseModelId } from "../../lib/model-engine";
import { providerAccountLabel } from "../../lib/provider-account";
import { composerQueue } from "../../lib/composer-classes";
import {
  fmtTokens,
  fmtUsd,
  limitTone,
  totalTokens,
} from "../../lib/usage-format";
import type { SessionUsage } from "../../lib/types";
import { cn } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { BrandMark } from "../BrandTile";
import { contextFill, UsageDetails } from "../UsageMeter";
import { useCurrentUser } from "../UserPicker";

interface UsageBarProps {
  usage: SessionUsage;
  models: ModelOption[];
  model: string;
  defaultModel: string;
  accounts?: ProviderAccountOption[];
  accountId?: string;
}

// Each cell sits in a slot that owns the divider, so a cell's rounded hover
// wash never bends the line beside it. Cells are padded the same and the row
// is pulled out by that padding, so the first label lines up with the flap.
const slot =
  "flex min-w-0 flex-1 desktop:border-l desktop:border-line desktop:first:border-l-0 desktop:px-1 desktop:first:pl-0 desktop:last:pr-0";
const cell = "flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-1 text-left";
const cellButton =
  "focus-ring rounded-control outline-none transition-colors hover:bg-hover data-[popup-open]:bg-hover cursor-pointer select-none phone:min-h-11 phone:justify-center";
const cellLabel = "text-meta text-faint";
const cellValue =
  "flex min-w-0 items-center gap-1.5 text-label whitespace-nowrap tabular-nums text-dim";

/**
 * The usage bar: a strip that folds out from behind the composer with what a
 * person checks before the next send. How full the context is, what the
 * conversation has spent, how much of the account's limits is left, and which
 * account it runs on. Switched on or off from the model menu or Settings.
 * Context and spend open the same breakdown the model menu's "Conversation
 * usage" row does; limits open their reset times.
 */
export function UsageBar({
  usage,
  models,
  model,
  defaultModel,
  accounts,
  accountId,
}: UsageBarProps) {
  const viewer = useCurrentUser();
  const fill = contextFill(usage);
  const effective = baseModelId(model || defaultModel);
  const provider = models.find((m) => m.id === effective)?.accountProvider;
  const limits = accounts
    ? sessionLimits({
        accounts,
        viewer,
        provider,
        model: effective,
        accountId,
      })
    : undefined;
  const tokens = totalTokens(usage);
  // The tone reads the window itself, as the header meter's does: only a
  // prompt near the real ceiling is a problem.
  const nearlyFull = fill.tone.text === "text-red";

  return (
    <div className={cn(composerQueue, "pt-1.5")} data-usage-bar>
      <div className="-mx-2.5 flex items-stretch phone:grid phone:grid-cols-2">
        <DetailsCell
          label="Context"
          usage={usage}
          ariaLabel={`Context ${fmtTokens(fill.tokens)} of ${fmtTokens(fill.limit)}`}
        >
          {fill.limit > 0 ? (
            <>
              <Track
                pct={fill.frac * 100}
                className={nearlyFull ? "bg-red" : "bg-accent"}
              />
              <span className="min-w-0 truncate">
                {fmtTokens(fill.tokens)} / {fmtTokens(fill.limit)}
              </span>
              <span
                className={cn(
                  "font-medium",
                  nearlyFull ? "text-red" : "text-fg",
                )}
              >
                {Math.round(fill.frac * 100)}%
              </span>
            </>
          ) : (
            <span>{fmtTokens(fill.tokens)}</span>
          )}
        </DetailsCell>
        <DetailsCell
          label="Usage"
          usage={usage}
          ariaLabel={`Usage ${fmtUsd(usage.costUsd)}, ${fmtTokens(tokens)} tokens`}
        >
          <span className="font-medium text-fg">{fmtUsd(usage.costUsd)}</span>
          <span className="min-w-0 truncate">{fmtTokens(tokens)} tokens</span>
        </DetailsCell>
        {limits && <LimitsCell short={limits.short} week={limits.week} />}
        {limits && (
          <div
            className={cell}
            title={
              limits.auto
                ? "Picked automatically for the next turn. Pin one from the model menu."
                : "Pinned for this session"
            }
          >
            <span className={cellLabel}>Account</span>
            <span className={cellValue}>
              <BrandMark
                name={limits.account.provider}
                size={14}
                className="flex-none text-fg"
              />
              <span className="min-w-0 truncate text-fg">
                {providerAccountLabel(limits.account)}
              </span>
              {limits.auto && (
                <span className="flex-none text-faint">Auto</span>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** A cell that opens the conversation's usage breakdown. */
function DetailsCell({
  label,
  usage,
  ariaLabel,
  children,
}: {
  label: string;
  usage: SessionUsage;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <div className={slot}>
      <Popover.Root>
        <Popover.Trigger
          openOnHover
          delay={200}
          closeDelay={100}
          className={cn(cell, cellButton)}
          aria-label={ariaLabel}
        >
          <span className={cellLabel}>{label}</span>
          <span className={cellValue}>{children}</span>
        </Popover.Trigger>
        <Popover.Popup side="top" align="start" className="w-64 p-3 text-xs">
          <UsageDetails usage={usage} />
        </Popover.Popup>
      </Popover.Root>
    </div>
  );
}

function LimitsCell({
  short,
  week,
}: {
  short?: SessionLimit;
  week?: SessionLimit;
}) {
  const rows = [
    short && { name: "5h", long: "5-hour window", limit: short },
    week && {
      name: week.scope ? `Week · ${week.scope}` : "Week",
      long: week.scope ? `${week.scope} weekly cap` : "Weekly",
      limit: week,
    },
  ].filter((row): row is NonNullable<typeof row> => !!row);
  if (rows.length === 0)
    return (
      <div className={cell} title="This account reports no limits">
        <span className={cellLabel}>Limits</span>
        <span className={cellValue}>–</span>
      </div>
    );
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={200}
        closeDelay={100}
        className={cn(cell, cellButton)}
        aria-label={`Limits ${rows
          .map((row) => `${row.long} ${row.limit.used}% used`)
          .join(", ")}`}
      >
        <span className={cellLabel}>Limits</span>
        <span className={cellValue}>
          {rows.map((row) => (
            <span key={row.name} className="flex min-w-0 items-center gap-1">
              <span className="truncate">
                {row.name === "5h" ? "5h" : "Week"}
              </span>
              <span
                className={cn("font-medium text-fg", limitTone(row.limit.used))}
              >
                {row.limit.used}%
              </span>
            </span>
          ))}
        </span>
      </Popover.Trigger>
      <Popover.Popup side="top" align="start" className="w-60 p-3 text-xs">
        <div className="mb-2 font-medium text-fg">Limits used</div>
        <div className="space-y-2">
          {rows.map((row) => {
            const reset = resetsIn(row.limit.resetsAt);
            return (
              <div key={row.name} className="space-y-1">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-dim">{row.long}</span>
                  <span
                    className={cn(
                      "tabular-nums text-fg",
                      limitTone(row.limit.used),
                    )}
                  >
                    {row.limit.used}%
                  </span>
                </div>
                <Track
                  pct={row.limit.used}
                  className={limitFill(row.limit.used)}
                  wide
                />
                {reset && (
                  <div className="text-faint">
                    {reset === "now" ? "Resets now" : `Resets in ${reset}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Popover.Popup>
    </Popover.Root>
  );
}

function limitFill(used: number): string {
  return used >= 90 ? "bg-red" : used >= 70 ? "bg-yellow" : "bg-faint";
}

function Track({
  pct,
  className,
  wide,
}: {
  pct: number;
  className: string;
  wide?: boolean;
}) {
  return (
    <span
      className={cn(
        "block h-1 flex-none overflow-hidden rounded-full bg-active",
        wide ? "w-full" : "w-8 phone:hidden",
      )}
      aria-hidden
    >
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-300",
          className,
        )}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </span>
  );
}
