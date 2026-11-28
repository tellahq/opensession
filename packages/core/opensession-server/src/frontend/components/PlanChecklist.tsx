import type { PlanItem } from "@tellahq/opensession-protocol/todo-plan";
import { cn } from "../ui/cn";

/**
 * The model's plan rendered as a checklist — shared by the status flap above
 * the composer and the expanded TodoWrite row in the transcript, so the same
 * list reads the same way in both places. See packages/core/protocol/src/todo-plan.ts for why this is
 * "Plan" and not "todos".
 */
interface Props {
  items: readonly PlanItem[];
  /** Cap the rendered rows; the remainder folds into a "+N more" line. */
  max?: number;
  /** Pulse the current step when this checklist represents a live run. */
  live?: boolean;
  className?: string;
}

export function PlanChecklist({ items, max, live = false, className }: Props) {
  const shown = max && items.length > max ? items.slice(0, max) : items;
  const hidden = items.length - shown.length;
  return (
    <ol
      className={cn(
        "m-0 flex list-none flex-col gap-1.5 p-0 text-label leading-4",
        className,
      )}
    >
      {shown.map((item, i) => (
        <li
          key={`${i}-${item.content}`}
          className={cn(
            "flex min-w-0 items-start gap-2",
            item.status === "in_progress" && "font-medium text-fg",
            item.status === "completed" && "text-dim",
            item.status === "pending" && "text-faint",
          )}
        >
          <PlanMark status={item.status} live={live} />
          <span className="min-w-0 flex-1">{item.content}</span>
        </li>
      ))}
      {hidden > 0 && <li className="pl-[22px] text-faint">+{hidden} more</li>}
    </ol>
  );
}

/** One quiet marker language: green when done, amber while active, and an
 *  empty ring for what's still ahead. */
function PlanMark({
  status,
  live,
}: {
  status: PlanItem["status"];
  live: boolean;
}) {
  return (
    <span
      className={cn(
        "mt-1 size-2 flex-none rounded-full",
        status === "completed" && "bg-green",
        status === "in_progress" && ["bg-yellow", live && "animate-agents"],
        status === "pending" && "border border-line",
      )}
    />
  );
}
