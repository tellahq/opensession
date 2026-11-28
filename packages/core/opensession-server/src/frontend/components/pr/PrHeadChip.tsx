import type React from "react";
import type { PrTone } from "../../lib/pr-refs";
import { PR_STATE_TEXT } from "../../lib/pr-tone-classes";
import { providerFromUrl } from "../../lib/provider";
import type { PrDetails } from "../../lib/types";
import { cn } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { IconArrowUpRight } from "../icons";
import { PrStateIcon } from "./PrStateIcon";
import { prBodyExcerpt } from "../../lib/pr-body-excerpt";
import { InlineAlert } from "../../ui/state";

/**
 * The session's PR in the new layout's window row: a state glyph and the
 * number, nothing else. The bar stays quiet; the title, where the PR stands
 * and its next step (Merge, Archive once it landed) wait in the hover card.
 */
export function PrHeadChip({
  pr,
  tone,
  label,
  action,
  error,
  onOpenPrTab,
}: {
  pr: PrDetails;
  tone: PrTone;
  /** The headline, as the strip would say it ("Ready to merge"). */
  label: string;
  /** The primary action, shown in the card's footer. */
  action?: React.ReactNode;
  error?: string | null;
  onOpenPrTab?: () => void;
}) {
  const excerpt = prBodyExcerpt(pr.body);
  const provider = providerFromUrl(pr.url);
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={200}
        closeDelay={120}
        render={
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-control px-2 text-label font-semibold text-fg transition-colors hover:bg-hover data-[popup-open]:bg-hover [corner-shape:squircle]"
            onClick={onOpenPrTab}
            aria-label={`Pull request #${pr.number}: ${label}`}
          />
        }
      >
        <span className={cn("inline-flex", PR_STATE_TEXT[tone])}>
          <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
        </span>
        <span className="tabular-nums">#{pr.number}</span>
      </Popover.Trigger>
      <Popover.Popup
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-[min(420px,calc(100vw-24px))] px-3 pt-2.5 pb-3"
      >
        <div className="flex min-w-0 items-start gap-2">
          <span
            className={cn("mt-px inline-flex shrink-0", PR_STATE_TEXT[tone])}
          >
            <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-label leading-snug">
              <span className="font-semibold text-fg">{pr.title}</span>{" "}
              <span className="text-faint tabular-nums">#{pr.number}</span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-meta">
              {excerpt && (
                <>
                  <span className="min-w-0 truncate text-dim">{excerpt}</span>
                  <span className="shrink-0 text-faint">·</span>
                </>
              )}
              <span className={cn("shrink-0 font-medium", PR_STATE_TEXT[tone])}>
                {label}
              </span>
            </div>
            {error && (
              <InlineAlert appearance="plain" className="mt-1 line-clamp-2">
                {error}
              </InlineAlert>
            )}
          </div>
        </div>
        <div className="mt-3 flex min-w-0 items-center gap-2 pl-[23px]">
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-meta text-dim no-underline hover:text-fg"
          >
            Open on {provider.name}
            <IconArrowUpRight dense size={14} aria-hidden />
          </a>
          {action && <span className="ml-auto flex shrink-0">{action}</span>}
        </div>
      </Popover.Popup>
    </Popover.Root>
  );
}
