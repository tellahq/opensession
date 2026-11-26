import { paletteIconBtn } from "../../lib/palette-classes";
import { setUsageBarPref } from "../../lib/usage-bar-pref";
import { fmtTokens, fmtUsd } from "../../lib/usage-format";
import { usageSummary, type UsageSummaryInput } from "../../lib/usage-summary";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { ContextRing } from "../UsageMeter";
import { useCurrentUser } from "../UserPicker";
import { ACCOUNT_TITLE, AccountValue, LimitRows } from "./UsageParts";

const row = "flex items-baseline justify-between gap-4";
const value = "flex min-w-0 items-center gap-1.5 tabular-nums";

/**
 * The usage bar folded down to a small ring after the model pill, for when the bar
 * is hidden. The ring is the context fill; hover or tap opens the bar's
 * readouts as one compact card, with a way to bring the bar back.
 */
export function UsageRing({
  onOpenChange,
  ...input
}: UsageSummaryInput & { onOpenChange?: (open: boolean) => void }) {
  const viewer = useCurrentUser();
  const { fill, nearlyFull, tokens, limits, limitRows } = usageSummary(
    input,
    viewer,
  );
  const pct = Math.round(fill.frac * 100);

  return (
    <Popover.Root onOpenChange={(open) => onOpenChange?.(open)}>
      <Popover.Trigger
        openOnHover
        delay={200}
        closeDelay={100}
        // A quiet glance, not a control: smaller than the toolbar's icon
        // buttons and muted until the context is nearly full.
        className={cn(
          paletteIconBtn,
          "size-7 shrink-0 self-center before:inset-0.5 phone:size-9 phone:[&_svg]:size-3.5",
        )}
        aria-label={`Usage: context ${pct}% full, ${fmtUsd(input.usage.costUsd)} spent`}
        data-usage-ring
      >
        <ContextRing
          frac={fill.frac}
          tone={nearlyFull ? "stroke-red" : "stroke-faint"}
          size={12}
        />
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
          className="mt-3 w-full phone:min-h-11"
          onClick={() => setUsageBarPref(true)}
        >
          Show usage bar
        </Button>
      </Popover.Popup>
    </Popover.Root>
  );
}
