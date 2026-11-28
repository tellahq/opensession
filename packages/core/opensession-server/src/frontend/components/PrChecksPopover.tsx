import type React from "react";
import {
  type CheckVisual,
  checkStatusMeta,
  checkToneClass,
} from "../lib/pr-checks";
import type { PrCheck } from "../lib/types";
import { Popover } from "../ui/popover";
import { CheckStatusIcon } from "./CheckStatusIcon";

/** A shared checks preview: hover for detail, click its trigger to open Review's Checks tab. */
export function PrChecksPopover({
  checks,
  trigger,
  nested = false,
}: {
  checks: PrCheck[];
  trigger: React.ReactElement;
  /** Keep a parent popup open and paint this hover preview above its layer. */
  nested?: boolean;
}) {
  const order: Record<CheckVisual, number> = {
    failure: 0,
    pending: 1,
    success: 2,
    skipped: 3,
    neutral: 3,
  };
  const sorted = [...checks].sort(
    (a, b) => order[checkStatusMeta(a).kind] - order[checkStatusMeta(b).kind],
  );
  const summary = sorted.reduce(
    (sum, check) => {
      switch (checkStatusMeta(check).kind) {
        case "success":
          sum.passed++;
          break;
        case "failure":
          sum.failed++;
          break;
        case "pending":
          sum.pending++;
          break;
      }
      return sum;
    },
    { passed: 0, failed: 0, pending: 0 },
  );

  return (
    <Popover.Root exclusive={!nested}>
      <Popover.Trigger
        render={trigger}
        openOnHover
        delay={200}
        closeDelay={120}
      />
      <Popover.Popup
        // Base UI inherits a parent popover's portal container. The workspace
        // summary lives in the header actions, whose z-1 stacking context sits
        // below Review's sticky topbar. Escape that context so this child preview
        // can use the shared floating layer above both surfaces.
        portalContainer={
          nested && typeof document !== "undefined" ? document.body : undefined
        }
        side="left"
        align="start"
        sideOffset={10}
        className="flex max-h-[min(560px,70vh,var(--available-height))] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden p-0"
      >
        <div className="flex items-baseline justify-between gap-2.5 border-b border-divider bg-surface px-3 py-[9px]">
          <span className="text-label font-semibold text-fg">
            {sorted.length} check{sorted.length === 1 ? "" : "s"}
          </span>
          <span className="inline-flex gap-2 text-meta font-semibold">
            {summary.passed > 0 && (
              <span className="text-green">{summary.passed} passed</span>
            )}
            {summary.failed > 0 && (
              <span className="text-red">{summary.failed} failed</span>
            )}
            {summary.pending > 0 && (
              <span className="text-yellow">{summary.pending} running</span>
            )}
          </span>
        </div>
        <div className="overflow-y-auto p-1">
          {sorted.map((check, i) => {
            const status = checkStatusMeta(check);
            const content = (
              <>
                <span
                  className={`inline-flex size-4 shrink-0 ${checkToneClass(status.kind)}`}
                >
                  <CheckStatusIcon kind={status.kind} />
                </span>
                <span className="min-w-0 flex-1 truncate text-label font-medium text-fg">
                  {check.name}
                </span>
                <span className="shrink-0 text-label font-medium text-dim">
                  {status.label}
                </span>
              </>
            );
            return check.url ? (
              <a
                key={`${check.name}:${i}`}
                className="flex items-center gap-[9px] rounded-md px-2 py-1.5 text-fg no-underline hover:bg-hover"
                href={check.url}
                target="_blank"
                rel="noopener"
              >
                {content}
              </a>
            ) : (
              <div
                key={`${check.name}:${i}`}
                className="flex items-center gap-[9px] rounded-md px-2 py-1.5 text-fg"
              >
                {content}
              </div>
            );
          })}
        </div>
      </Popover.Popup>
    </Popover.Root>
  );
}
