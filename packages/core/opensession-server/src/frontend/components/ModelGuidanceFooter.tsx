import type { ModelGuidance } from "../lib/model-guidance";
import { isTouchPrimary } from "../lib/platform";
import { cn } from "../ui/cn";
import { ModelMark } from "./ModelMark";

export interface ModelGuidancePreview {
  readonly id: string;
  readonly label: string;
  readonly engine?: string;
  readonly guidance: ModelGuidance | null;
}

function GuidanceBody({
  guidance,
  roomy,
}: {
  guidance: ModelGuidance;
  /** The side card has the width for label-sized type. */
  roomy?: boolean;
}) {
  const size = roomy ? "text-label" : "text-meta";
  return (
    <div className="flex flex-col gap-2">
      {guidance.strongAt.length > 0 && (
        <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5">
          <span
            aria-hidden="true"
            className={cn("flex h-[1.35em] items-center justify-center", size)}
          >
            <span className="size-1.5 rounded-full bg-green" />
          </span>
          <div className="min-w-0">
            <div className={cn(size, "font-medium leading-snug text-fg")}>
              Strong at
            </div>
            <ul
              className={cn(
                size,
                "m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0 leading-snug text-dim",
              )}
            >
              {guidance.strongAt.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {guidance.watchFor.length > 0 && (
        <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5">
          <span
            aria-hidden="true"
            className={cn("flex h-[1.35em] items-center justify-center", size)}
          >
            <span className="size-1.5 rounded-full bg-yellow-tint" />
          </span>
          <div className="min-w-0">
            <div className={cn(size, "font-medium leading-snug text-dim")}>
              Watch for
            </div>
            <ul
              className={cn(
                size,
                "m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0 leading-snug text-faint",
              )}
            >
              {guidance.watchFor.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Model-picker notes on the hovered or selected model: candid strengths and
 * trade-offs. On a desktop they sit in a card beside the list (`aside`); a
 * phone, which has no hover to preview with, docks them under the list.
 * Every unique guidance card for the menu's models renders as an invisible
 * CSS Grid sizer in the same cell, so moving between models never changes
 * the popup's size or shifts rows under the pointer.
 */
export function ModelGuidanceFooter({
  active,
  sizerGuidances,
  placement = "footer",
}: {
  active: ModelGuidancePreview;
  sizerGuidances: readonly ModelGuidance[];
  placement?: "footer" | "aside";
}) {
  const aside = placement === "aside";
  return (
    <div
      data-model-guidance-footer
      className={
        aside
          ? "my-1.5 mr-1.5 w-64 shrink-0 self-start rounded-lg bg-hover p-3.5"
          : "shrink-0 border-t border-divider bg-raised/70 py-2.5 pl-3.5 pr-3"
      }
    >
      <div className={cn("flex items-center gap-2.5", aside ? "mb-3" : "mb-2")}>
        <span
          className={cn(
            "flex shrink-0 items-center justify-center",
            aside ? "size-5 text-fg" : "size-4 text-dim",
          )}
        >
          <ModelMark
            id={active.id}
            provider={active.engine}
            size={aside ? 18 : undefined}
          />
        </span>
        <span
          className={cn(
            "min-w-0 truncate font-medium text-fg",
            aside ? "text-item-title leading-5" : "text-meta leading-4",
          )}
        >
          {active.label}
        </span>
      </div>
      <div className="grid">
        {!isTouchPrimary &&
          sizerGuidances.map((guidance) => (
            <div
              key={guidance.summary}
              aria-hidden="true"
              className="invisible pointer-events-none col-start-1 row-start-1 select-none [@media(hover:none)_and_(pointer:coarse)]:hidden"
            >
              <GuidanceBody guidance={guidance} roomy={aside} />
            </div>
          ))}
        <div className="col-start-1 row-start-1">
          {active.guidance ? (
            <GuidanceBody guidance={active.guidance} roomy={aside} />
          ) : (
            <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5">
              <p
                className={cn(
                  "col-start-2 m-0 leading-snug text-faint",
                  aside ? "text-label" : "text-meta",
                )}
              >
                No notes for this model yet.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
