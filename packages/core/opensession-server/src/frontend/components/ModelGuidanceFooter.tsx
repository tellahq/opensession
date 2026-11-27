import type { ModelGuidance } from "../lib/model-guidance";
import { isTouchPrimary } from "../lib/platform";
import { ModelMark } from "./ModelMark";

export interface ModelGuidancePreview {
  readonly id: string;
  readonly label: string;
  readonly engine?: string;
  readonly guidance: ModelGuidance | null;
}

function GuidanceBody({ guidance }: { guidance: ModelGuidance }) {
  return (
    <div className="flex flex-col gap-2">
      {guidance.strongAt.length > 0 && (
        <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5">
          <span
            aria-hidden="true"
            className="flex h-[1.35em] items-center justify-center text-meta"
          >
            <span className="size-1.5 rounded-full bg-green" />
          </span>
          <div className="min-w-0">
            <div className="text-meta font-medium leading-[1.35] text-fg">
              Strong at
            </div>
            <ul className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0 text-meta leading-[1.4] text-dim">
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
            className="flex h-[1.35em] items-center justify-center text-meta"
          >
            <span className="size-1.5 rounded-full bg-yellow-tint" />
          </span>
          <div className="min-w-0">
            <div className="text-meta font-medium leading-[1.35] text-dim">
              Watch for
            </div>
            <ul className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0 text-meta leading-[1.4] text-faint">
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
 * Docked model-picker footer showing candid strengths and trade-offs for the
 * hovered or selected model. Renders every unique guidance card for the menu's
 * models as an invisible CSS Grid sizer in the same cell, so hovering between
 * models never changes the popup height or shifts rows under the pointer.
 */
export function ModelGuidanceFooter({
  active,
  sizerGuidances,
}: {
  active: ModelGuidancePreview;
  sizerGuidances: readonly ModelGuidance[];
}) {
  return (
    <div
      data-model-guidance-footer
      className="shrink-0 border-t border-divider bg-raised/70 py-2.5 pl-3.5 pr-3"
    >
      <div className="mb-2 flex items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center text-dim">
          <ModelMark id={active.id} provider={active.engine} />
        </span>
        <span className="min-w-0 truncate text-meta font-medium leading-4 text-fg">
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
              <GuidanceBody guidance={guidance} />
            </div>
          ))}
        <div className="col-start-1 row-start-1">
          {active.guidance ? (
            <GuidanceBody guidance={active.guidance} />
          ) : (
            <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5">
              <p className="col-start-2 m-0 text-meta leading-[1.4] text-faint">
                No notes for this model yet.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
