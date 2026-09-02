import React, { useState } from "react";
import { IconChevronDown, IconCheckCircle, IconX } from "./icons";
import { cn } from "../ui/cn";
import type { ReviewLoopResult } from "../lib/review-loop";

/**
 * A review handoff and the work it triggered, folded like a normal turn. Once
 * settled, the closed row says what the loop concluded; opening it reveals the
 * same icon-led work rows as any other worker, followed by the final verdict.
 */
export function ReviewLoopBlock({
  prNumber,
  rounds,
  live,
  result,
  children,
  defaultOpen = false,
  onOpenChange,
}: {
  prNumber: number | null;
  rounds: number;
  live: boolean;
  result?: ReviewLoopResult;
  children: React.ReactNode;
  /** Preview/test hook; the transcript never passes it, so sessions stay folded. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const status = live ? "pending" : result?.status;
  const resultDetail = reviewLoopDetail(status, rounds);
  const visibleDetail =
    open && status !== "pending"
      ? `${rounds} ${rounds === 1 ? "round" : "rounds"}`
      : resultDetail;
  const label = [
    "Review loop",
    resultDetail,
    prNumber ? `PR #${prNumber}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <section
      className="mx-auto mb-3 w-full max-w-[var(--session-col)]"
      aria-label="Review loop"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        onClick={() =>
          setOpen((value) => {
            const next = !value;
            onOpenChange?.(next);
            return next;
          })
        }
        className="-mx-2 flex w-[calc(100%+16px)] min-w-0 cursor-pointer items-baseline gap-2 rounded-control border-0 bg-transparent px-3 py-1 text-left font-sans text-item-title leading-5 text-dim transition-colors hover:bg-hover/40 hover:text-fg phone:min-h-10"
      >
        <span
          className={cn(
            "grid size-5 flex-none self-center place-items-center leading-none text-faint transition-transform duration-150",
            open ? "-translate-y-px" : "-rotate-90",
          )}
        >
          <IconChevronDown size={20} className="block" />
        </span>
        <span className="shrink-0 font-medium">Review loop</span>
        <span className="min-w-0 truncate text-label leading-4 text-faint">
          {visibleDetail}
        </span>
        {prNumber && (
          <span className="hidden shrink-0 text-label leading-4 text-faint desktop:block">
            PR #{prNumber}
          </span>
        )}
        {live && (
          <span
            className="ml-auto size-[11px] flex-none self-center animate-spin rounded-full border border-b-line-strong border-l-line-strong border-r-line-strong border-t-dim"
            aria-label="Review in progress"
          />
        )}
      </button>
      {open && (
        <div className="mt-0.5 pl-2 [&>*:last-child]:mb-0">
          {children}
          {result && !live && result.status !== "pending" && (
            <ReviewLoopResultRow result={result} rounds={rounds} />
          )}
        </div>
      )}
    </section>
  );
}

function reviewLoopDetail(
  status: ReviewLoopResult["status"] | undefined,
  rounds: number,
): string {
  if (status === "passed") return "Ready to merge";
  if (status === "failed") return "Needs changes";
  if (status === "pending") return "Working";
  return `${rounds} ${rounds === 1 ? "round" : "rounds"}`;
}

function ReviewLoopResultRow({
  result,
  rounds,
}: {
  result: ReviewLoopResult;
  rounds: number;
}) {
  const facts = [
    `${rounds} ${rounds === 1 ? "round" : "rounds"}`,
    result.confidence !== undefined ? `${result.confidence}/5` : null,
    result.blocking ? `${result.blocking} blocking` : null,
    result.checksFailed
      ? `${result.checksFailed} ${result.checksFailed === 1 ? "check" : "checks"} failed`
      : null,
    result.checksPassed ? `${result.checksPassed} checks passed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const passed = result.status === "passed";
  return (
    <div
      className="mt-1 flex w-full min-w-0 items-baseline gap-2 rounded-control bg-transparent px-1 py-[3px] font-sans"
      aria-label={passed ? "Review passed" : "Review failed"}
    >
      <span
        className={cn(
          "relative z-[1] flex size-[22px] flex-none self-center items-center justify-center",
          passed ? "text-faint" : "text-red",
        )}
      >
        {passed ? <IconCheckCircle size={20} /> : <IconX size={20} />}
      </span>
      <span className="shrink-0 text-item-title font-medium leading-5 text-dim">
        {passed ? "Ready to merge" : "Needs changes"}
      </span>
      <span className="min-w-0 truncate text-label leading-4 text-faint">
        {facts}
      </span>
    </div>
  );
}
