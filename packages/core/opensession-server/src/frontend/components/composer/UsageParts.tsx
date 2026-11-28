import { resetsIn } from "../../lib/account-limits";
import type { ProviderAccountOption } from "../../lib/api";
import { providerAccountLabel } from "../../lib/provider-account";
import { limitTone } from "../../lib/usage-format";
import { limitFill, type LimitRow } from "../../lib/usage-summary";
import { cn } from "../../ui/cn";
import { BrandMark } from "../BrandTile";

/** A thin fill track: the usage bar's inline one, or full width in a popup. */
export function Track({
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
          "block h-full rounded-full transition-[width] duration-long",
          className,
        )}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </span>
  );
}

/** The account a session runs on: brand mark, name, and "Auto" when routed. */
export function AccountValue({
  account,
  auto,
}: {
  account: ProviderAccountOption;
  auto: boolean;
}) {
  return (
    <>
      <BrandMark
        name={account.provider}
        size={14}
        className="flex-none text-fg"
      />
      <span className="min-w-0 truncate text-fg">
        {providerAccountLabel(account)}
      </span>
      {auto && <span className="flex-none text-faint">Auto</span>}
    </>
  );
}

export const ACCOUNT_TITLE = {
  auto: "Picked automatically for the next turn. Pin one from the model menu.",
  pinned: "Pinned for this session",
};

/** Each limit with its track and how long until it frees up. */
export function LimitRows({ rows }: { rows: LimitRow[] }) {
  return (
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
                {row.limit.used}% used
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
  );
}
