import React from "react";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import { cn } from "../ui/cn";
import { IconCheck, IconClock, IconChevronRight } from "./icons";
import { useLoopOpen } from "./ReviewLoopBlock";
import {
  parseProgressUpdate,
  type FoldStatus,
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
  meta,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  group: ProgressGroup;
  /** A check-back folded under this row is still running. */
  live?: boolean;
  /** How long the folded work took, kept whole after the status. */
  meta?: string;
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
        done={latest.state === "done"}
        className={latest.state === "done" ? "text-green" : "text-dim"}
      />
      <span className="min-w-0 break-words">
        <span className="font-medium text-fg">{latest.topic}</span>
        <span className="text-dim">: {latest.text}</span>
      </span>
      {meta && <span className="flex-none text-faint">· {meta}</span>}
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
        <div className="mt-0.5 [&>*:last-child]:mb-0">
          {history.length > 0 && (
            <ol className="m-0 mb-2 list-none p-0" aria-label="Earlier updates">
              {history.map((entry) => {
                const update = parseProgressUpdate(entry)!;
                // Same topic reads as a step of the latest; a different one
                // says what that step was about.
                const sameTopic =
                  update.topic.toLowerCase() === latest.topic.toLowerCase();
                return (
                  <StatusStep
                    key={entry.id}
                    as="li"
                    done={update.state === "done"}
                  >
                    {sameTopic
                      ? update.text
                      : `${update.topic}: ${update.text}`}
                  </StatusStep>
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

/** A status as the work row's title: "◷ Native build: Running". */
export function ProgressStatusLabel({ update }: { update: ProgressUpdate }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <StatusIcon
        done={update.state === "done"}
        className={update.state === "done" ? "text-green" : "text-dim"}
      />
      <span className="min-w-0 truncate">
        <span className="font-medium text-fg">{update.topic}</span>
        <span className="text-dim">: {update.text}</span>
      </span>
    </span>
  );
}

/** A status message inside a work fold, drawn as one more step: the tool
 * row's 22px glyph slot, type and pitch, so "CI passed · 4m" between two runs
 * of commands reads as part of the same list. `foldStatuses` words it. */
export function ProgressStatusLine({ status }: { status: FoldStatus }) {
  return <StatusStep done={status.done}>{status.text}</StatusStep>;
}

/** One status as a fold step. An open status row's earlier updates use it
 * too, so the two lists keep one pitch. Like a tool row, it hangs its glyph
 * slot 4px into the gutter, where the icon's ink starts inside the slot. */
function StatusStep({
  done,
  as: Row = "div",
  children,
}: {
  done: boolean;
  as?: "div" | "li";
  children: React.ReactNode;
}) {
  return (
    <Row className="-ml-1 flex min-w-0 items-start gap-2 py-[3px] text-item-title leading-5 text-dim">
      <StatusIcon
        done={done}
        className="size-[22px] justify-center text-faint"
      />
      {/* 1px each side centres a one-line status on the 22px glyph slot and
          still lets a long one wrap under itself. */}
      <span className="min-w-0 break-words py-px">{children}</span>
    </Row>
  );
}

function StatusIcon({
  done,
  className,
}: {
  done: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("flex h-5 shrink-0 items-center", className)}
      aria-hidden="true"
    >
      {done ? <IconCheck size={20} /> : <IconClock size={20} />}
    </span>
  );
}
