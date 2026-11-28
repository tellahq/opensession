import { palettePill } from "../../lib/palette-classes";
import { setUsageBarPref } from "../../lib/usage-bar-pref";
import { fmtTokens, fmtUsd } from "../../lib/usage-format";
import { usageSummary, type UsageSummaryInput } from "../../lib/usage-summary";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { composerToolbarPill } from "../../lib/composer-classes";
import { Popover } from "../../ui/popover";
import { useCurrentUser } from "../UserPicker";
import { ACCOUNT_TITLE, AccountValue, LimitRows } from "./UsageParts";

const row = "flex items-baseline justify-between gap-4";
const value = "flex min-w-0 items-center gap-1.5 tabular-nums";

/**
 * The one usage readout the composer keeps when the usage bar is hidden: a
 * short red "92% context" once the context is nearly full, the only moment it
 * needs attention. Below that it shows nothing; spend and limits stay in the
 * model menu. A ring gauge used to sit here at every fill, and at a third
 * full it read as a loading spinner. Hover or tap opens the bar's readouts as
 * one compact card, with a way to bring the bar back.
 */
export function ContextWarning({
  onOpenChange,
  ...input
}: UsageSummaryInput & { onOpenChange?: (open: boolean) => void }) {
  const viewer = useCurrentUser();
  const { fill, nearlyFull, tokens, limits, limitRows } = usageSummary(
    input,
    viewer,
  );
  const pct = Math.round(fill.frac * 100);
  if (!nearlyFull) return null;

  return (
    <Popover.Root onOpenChange={(open) => onOpenChange?.(open)}>
      <Popover.Trigger
        openOnHover
        delay={200}
        closeDelay={100}
        className={cn(
          palettePill,
          composerToolbarPill,
          "shrink-0 self-center tabular-nums text-red hover:text-red",
        )}
        aria-label={`Context ${pct}% full, ${fmtUsd(input.usage.costUsd)} spent`}
        data-context-warning
      >
        {pct}% context
      </Popover.Trigger>
      <Popover.Popup side="top" align="end" className="w-64 p-3 text-xs">
        <div className="space-y-1.5">
          {fill.limit > 0 && (
            <div className={row}>
              <span className="text-dim">Context</span>
              <span className={value}>
                <span className="text-dim">
                  {fmtTokens(fill.tokens)} / {fmtTokens(fill.limit)}
                </span>
                <span
                  className={cn(
                    "font-medium",
                    nearlyFull ? "text-red" : "text-fg",
                  )}
                >
                  {pct}%
                </span>
              </span>
            </div>
          )}
          <div className={row}>
            <span className="text-dim">Usage</span>
            <span className={value}>
              <span className="text-dim">{fmtTokens(tokens)} tokens</span>
              <span className="font-medium text-fg">
                {fmtUsd(input.usage.costUsd)}
              </span>
            </span>
          </div>
          {limits && (
            <div
              className={cn(row, "items-center")}
              title={limits.auto ? ACCOUNT_TITLE.auto : ACCOUNT_TITLE.pinned}
            >
              <span className="text-dim">Account</span>
              <span className={value}>
                <AccountValue account={limits.account} auto={limits.auto} />
              </span>
            </div>
          )}
        </div>
        {limitRows.length > 0 && (
          <>
            <div className="my-2.5 h-px bg-line" />
            <LimitRows rows={limitRows} />
          </>
        )}
        <Button
          variant="soft"
          size="md"
          className="mt-3 w-full"
          onClick={() => setUsageBarPref(true)}
        >
          Show usage bar
        </Button>
      </Popover.Popup>
    </Popover.Root>
  );
}
