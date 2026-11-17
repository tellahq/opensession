import React from "react";
import { cn } from "../ui/cn";
import { IconCheck, IconClock, IconChevronRight } from "./icons";
import { useLoopOpen } from "./ReviewLoopBlock";
import {
  parseProgressUpdate,
  type ProgressGroup,
  type ProgressUpdate,
} from "../lib/progress-updates";

/** Agent-reported status, not an inferred verdict from a turn ending. One row
 * per task: it shows the latest update and, opened, the earlier updates and
 * the check-back work behind them. Styled like the work folds around it: the
 * status, then a trailing chevron, then a spinner while a check-back runs. */
export function ProgressStatusRow({
  group,
  live = false,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  group: ProgressGroup;
  /** A check-back folded under this row is still running. */
  live?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The check-back work this row reports on. */
  children?: React.ReactNode;
}) {
  const { latest, entries } = group;
  const [open, toggle] = useLoopOpen(defaultOpen, onOpenChange);
  const history = entries.slice(0, -1);
  const work = React.Children.toArray(children).some(Boolean);
  const label = `${latest.topic}: ${latest.text}`;
  const status = (
    <span className="flex min-w-0 items-start gap-2">
      <StatusIcon
        update={latest}
        className={latest.state === "done" ? "text-green" : "text-dim"}
      />
      <span className="min-w-0 break-words">
        <span className="font-medium text-fg">{latest.topic}</span>
        <span className="text-dim">: {latest.text}</span>
      </span>
    </span>
  );
  const rowClasses =
    "-mx-2 flex w-fit max-w-[calc(100%+16px)] min-w-0 items-center gap-1.5 rounded-control border-0 bg-transparent px-2 py-1 text-left font-sans text-label leading-5 phone:min-h-11";
  return (
    <section
      className="mx-auto mb-3 w-full max-w-[var(--session-col)] text-label leading-5"
      data-progress-topic={latest.topic}
    >
      <span className="sr-only" role="status" aria-atomic="true">
        {label}
      </span>
      {history.length || work ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${label}. Show ${work ? "work and earlier updates" : "update history"}`}
          onClick={toggle}
          className={cn(rowClasses, "focus-ring group cursor-pointer")}
        >
          {status}
          <span
            aria-hidden="true"
            className={cn(
              "grid size-5 flex-none place-items-center text-faint transition-transform duration-150 group-hover:text-dim motion-reduce:transition-none",
              open && "rotate-90",
            )}
          >
            <IconChevronRight size={20} className="block" />
          </span>
          {live && (
            <span
              className="ml-1 size-[11px] flex-none animate-spin rounded-full border border-b-line-strong border-l-line-strong border-r-line-strong border-t-dim"
              aria-label="Check-back in progress"
            />
          )}
        </button>
      ) : (
        <div className={rowClasses}>{status}</div>
      )}
      {open && (
        <div className="mt-0.5 pl-2 [&>*:last-child]:mb-0">
          {history.length > 0 && (
            <ol
              className="m-0 mb-2 list-none space-y-2 py-1 pl-1 pr-2 text-dim"
              aria-label="Earlier updates"
            >
              {history.map((entry) => {
                const update = parseProgressUpdate(entry)!;
                // Same topic reads as a step of the latest; a different one
                // says what that step was about.
                const sameTopic =
                  update.topic.toLowerCase() === latest.topic.toLowerCase();
                return (
                  <li key={entry.id} className="flex items-start gap-2">
                    <StatusIcon update={update} />
                    <span className="min-w-0 break-words">
                      {sameTopic
                        ? update.text
                        : `${update.topic}: ${update.text}`}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          {children}
        </div>
      )}
    </section>
  );
}

function StatusIcon({
  update,
  className,
}: {
  update: ProgressUpdate;
  className?: string;
}) {
  return (
    <span
      className={cn("flex h-5 shrink-0 items-center", className)}
      aria-hidden="true"
    >
      {update.state === "done" ? (
        <IconCheck size={20} />
      ) : (
        <IconClock size={20} />
      )}
    </span>
  );
}
