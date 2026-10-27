import React, { useEffect, useRef, useState } from "react";
import { useTurnActivityPrefs } from "./TurnBlock";
import { IconChevronDown, IconCheckCircle, IconX } from "./icons";
import { cn } from "../ui/cn";
import type { ReviewLoopResult } from "../lib/review-loop";
import type { ReviewSettledOutcome } from "@tellahq/opensession-protocol/notices";

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
  settled,
  children,
  defaultOpen = false,
  onOpenChange,
}: {
  prNumber: number | null;
  rounds: number;
  live: boolean;
  result?: ReviewLoopResult;
  /** How the transcript says the loop closed. Outranked by a live `result`,
   *  which only the final loop of an open PR carries; every earlier or
   *  merged loop keeps this durable verdict instead of a bare round count. */
  settled?: ReviewSettledOutcome | null;
  children: React.ReactNode;
  /** Opens the fold regardless of preferences (previews, tests, a fold the
   *  person opened before it remounted). Otherwise it follows Steps. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, toggle] = useLoopOpen(defaultOpen, onOpenChange);
  const status = live ? "pending" : result?.status;
  const resultDetail = reviewLoopDetail(status, rounds, settled);
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
    <LoopDisclosure
      title="Review loop"
      label={label}
      detail={visibleDetail}
      aside={prNumber ? `PR #${prNumber}` : undefined}
      live={live}
      liveLabel="Review in progress"
      open={open}
      onToggle={toggle}
    >
      {children}
      {result && !live && result.status !== "pending" && (
        <ReviewLoopResultRow result={result} rounds={rounds} />
      )}
    </LoopDisclosure>
  );
}

/**
 * Turns the agent started itself, with no person in between: a background
 * wait waking it (usually to look at CI again) or its own scheduled
 * check-back. Folded like a review loop; the last turn's answer stays outside.
 */
export function CheckBackBlock({
  rounds,
  live,
  children,
  defaultOpen = false,
  onOpenChange,
}: {
  rounds: number;
  live: boolean;
  children: React.ReactNode;
  /** Opens the fold regardless of preferences (previews, tests, a fold the
   *  person opened before it remounted). Otherwise it follows Steps. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, toggle] = useLoopOpen(defaultOpen, onOpenChange);
  const detail = live ? "Working" : checkBackCount(rounds);
  return (
    <LoopDisclosure
      title="Checked back"
      label={`Checked back, ${detail}`}
      detail={detail}
      live={live}
      liveLabel="Check-back in progress"
      open={open}
      onToggle={toggle}
    >
      {children}
    </LoopDisclosure>
  );
}

/**
 * A loop is a fold of work, so it starts the way the Steps preference says a
 * turn's work does: open under "Open", folded otherwise. "With updates" keeps
 * it folded; that is the quiet these loops exist for. Once toggled by hand,
 * the person's choice wins over a later preference change.
 */
function useLoopOpen(
  forceOpen: boolean,
  onOpenChange?: (open: boolean) => void,
): [boolean, () => void] {
  const { work } = useTurnActivityPrefs();
  const defaultOpen = forceOpen || work === "open";
  const [open, setOpen] = useState(defaultOpen);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) setOpen(defaultOpen);
  }, [defaultOpen]);
  const toggle = () => {
    toggled.current = true;
    const next = !open;
    onOpenChange?.(next);
    setOpen(next);
  };
  return [open, toggle];
}

function checkBackCount(rounds: number): string {
  return rounds === 1 ? "once" : `${rounds} times`;
}

/** The folded row both loops share: chevron, title, quiet detail, spinner. */
function LoopDisclosure({
  title,
  label,
  detail,
  aside,
  live,
  liveLabel,
  open,
  onToggle,
  children,
}: {
  title: string;
  label: string;
  detail: string;
  aside?: string;
  live: boolean;
  liveLabel: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className="mx-auto mb-3 w-full max-w-[var(--session-col)]"
      aria-label={title}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        onClick={onToggle}
        className="-mx-2 flex w-[calc(100%+16px)] min-w-0 cursor-pointer items-baseline gap-2 rounded-control border-0 bg-transparent py-1 pl-1 pr-3 text-left font-sans text-item-title leading-5 text-dim transition-colors hover:bg-hover/40 hover:text-fg phone:min-h-10 phone:items-center"
      >
        <span
          className={cn(
            "grid size-5 flex-none self-center place-items-center leading-none text-faint transition-transform duration-150",
            open ? "-translate-y-px" : "-rotate-90",
          )}
        >
          <IconChevronDown size={20} className="block" />
        </span>
        <span className="shrink-0 font-medium">{title}</span>
        <span className="min-w-0 truncate text-label leading-4 text-faint">
          {detail}
        </span>
        {aside && (
          <span className="hidden shrink-0 text-label leading-4 text-faint desktop:block">
            {aside}
          </span>
        )}
        {live && (
          <span
            className="ml-auto size-[11px] flex-none self-center animate-spin rounded-full border border-b-line-strong border-l-line-strong border-r-line-strong border-t-dim"
            aria-label={liveLabel}
          />
        )}
      </button>
      {open && (
        <div className="mt-0.5 pl-2 [&>*:last-child]:mb-0">{children}</div>
      )}
    </section>
  );
}

function reviewLoopDetail(
  status: ReviewLoopResult["status"] | undefined,
  rounds: number,
  settled?: ReviewSettledOutcome | null,
): string {
  if (status === "passed") return "Ready to merge";
  if (status === "failed") return "Needs changes";
  if (status === "pending") return "Working";
  if (settled === "passed") return "Review passed";
  if (settled === "capped") return "Over to humans";
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
