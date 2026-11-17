import React from "react";
import { Collapsible, collapsiblePanelClasses } from "../ui/collapsible";
import { cn } from "../ui/cn";
import { IconCheck, IconClock, IconChevronDown } from "./icons";
import {
  parseProgressUpdate,
  type ProgressGroup,
} from "../lib/progress-updates";

/** Agent-reported status, not an inferred verdict from a turn ending. */
export function ProgressStatusRow({ group }: { group: ProgressGroup }) {
  const { latest, entries } = group;
  const history = entries.slice(0, -1);
  const label = `${latest.topic}: ${latest.text}`;
  const status = (
    <span className="flex min-w-0 items-start gap-2">
      <span
        className={cn(
          "flex h-5 shrink-0 items-center",
          latest.state === "done" ? "text-green" : "text-dim",
        )}
        aria-hidden="true"
      >
        {latest.state === "done" ? (
          <IconCheck size={20} />
        ) : (
          <IconClock size={20} />
        )}
      </span>
      <span className="min-w-0 break-words">
        <span className="font-medium text-fg">{latest.topic}</span>
        <span className="text-dim">: {latest.text}</span>
      </span>
    </span>
  );
  const rowClasses =
    "-mx-2 box-border flex min-h-8 w-[calc(100%+16px)] items-center justify-between gap-2 rounded-control border-0 bg-transparent px-2 py-1 text-left font-sans text-label leading-5 phone:min-h-11";
  return (
    <Collapsible.Root
      className="mx-auto mb-3 w-full max-w-[var(--session-col)] text-label leading-5"
      data-progress-topic={latest.topic}
    >
      <span className="sr-only" role="status" aria-atomic="true">
        {label}
      </span>
      {history.length ? (
        <Collapsible.Trigger
          className={cn(rowClasses, "focus-ring group hover:bg-hover")}
          aria-label={`${label}. Show update history`}
        >
          {status}
          <IconChevronDown
            size={20}
            className="shrink-0 text-faint transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
          />
        </Collapsible.Trigger>
      ) : (
        <div className={rowClasses}>{status}</div>
      )}
      <Collapsible.Panel className={collapsiblePanelClasses}>
        <ol
          className="m-0 list-none space-y-2 py-2 pl-6 pr-2 text-dim"
          aria-label={`${latest.topic} update history`}
        >
          {history.map((entry) => {
            const update = parseProgressUpdate(entry)!;
            return (
              <li key={entry.id} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className="flex h-5 shrink-0 items-center"
                >
                  {update.state === "done" ? (
                    <IconCheck size={20} />
                  ) : (
                    <IconClock size={20} />
                  )}
                </span>
                <span className="min-w-0 break-words">{update.text}</span>
              </li>
            );
          })}
        </ol>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
