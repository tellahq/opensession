import type { ReactNode } from "react";
import { composerQueue } from "../../lib/composer-classes";
import { setUsageBarPref } from "../../lib/usage-bar-pref";
import { fmtTokens, fmtUsd, limitTone } from "../../lib/usage-format";
import {
  usageSummary,
  type LimitRow,
  type UsageSummaryInput,
} from "../../lib/usage-summary";
import type { SessionUsage } from "../../lib/types";
import { cn } from "../../ui/cn";
import { ContextMenu, MENU_ICON } from "../../ui/menu";
import { Popover } from "../../ui/popover";
import { IconEyeOff } from "../icons";
import { UsageDetails } from "../UsageMeter";
import { useCurrentUser } from "../UserPicker";
import { ACCOUNT_TITLE, AccountValue, LimitRows, Track } from "./UsageParts";

// Each cell sits in a slot that owns the divider, so a cell's rounded-xs hover
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
 * account it runs on. Switched on from the model menu, the ring beside the
 * model pill, or Settings; a right-click (a long press on touch) hides it.
 * Context and spend open the same breakdown the model menu's "Conversation
 * usage" row does; limits open their reset times.
 */
export function UsageBar(props: UsageSummaryInput) {
  const viewer = useCurrentUser();
  const { usage } = props;
  const { fill, nearlyFull, tokens, limits, limitRows } = usageSummary(
    props,
    viewer,
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={<div className={cn(composerQueue, "pt-1.5")} data-usage-bar />}
      >
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
          {limits && (
            <div className={slot}>
              <LimitsCell rows={limitRows} />
            </div>
          )}
          {limits && (
            <div className={slot}>
              <div
                className={cell}
                title={limits.auto ? ACCOUNT_TITLE.auto : ACCOUNT_TITLE.pinned}
              >
                <span className={cellLabel}>Account</span>
                <span className={cellValue}>
                  <AccountValue account={limits.account} auto={limits.auto} />
                </span>
              </div>
            </div>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Popup>
        <ContextMenu.Item onClick={() => setUsageBarPref(false)}>
          <IconEyeOff size={17} aria-hidden className={MENU_ICON} />
          Hide usage bar
        </ContextMenu.Item>
      </ContextMenu.Popup>
    </ContextMenu.Root>
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

function LimitsCell({ rows }: { rows: LimitRow[] }) {
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
              <span className="truncate">{row.name}</span>
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
        <div className="mb-2 font-medium text-fg">Limits</div>
        <LimitRows rows={rows} />
      </Popover.Popup>
    </Popover.Root>
  );
}
