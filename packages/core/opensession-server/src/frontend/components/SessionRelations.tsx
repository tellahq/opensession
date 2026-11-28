import type { ModelOption } from "../lib/api";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { IconArrowDownRight } from "./icons";
import { shortModelLabel } from "./ModelEffortSelect";

/**
 * The DOWNWARD half of a session's orchestrator/executor tree: the workers this
 * session delegated to, derived by the caller from the sessions list (each
 * carries this session's id as its `parentSessionId`). Hopping down into one
 * and steering it is the whole point of making the engines interchangeable.
 *
 * The upward half is not a chip. A worker's header renders its parent as a
 * breadcrumb crumb before the title (repo > session > worker, see
 * SessionViewer), because "where am I" belongs in the path, not in a chip after
 * the name.
 */

export interface RelatedSession {
  id: string;
  title: string;
  model?: string;
  isRunning?: boolean;
}

function shortModel(
  model: string | undefined,
  models: ModelOption[],
): string | null {
  if (!model) return null;
  return shortModelLabel(model, models);
}

const chip =
  "inline-flex max-w-[220px] items-center gap-1 rounded-control px-1.5 py-[2px] text-label font-medium text-dim transition-colors hover:bg-hover hover:text-fg";

export function SessionRelations({
  workers,
  models,
  onOpen,
}: {
  workers?: RelatedSession[];
  models: ModelOption[];
  onOpen: (id: string) => void;
}) {
  const hasWorkers = !!workers && workers.length > 0;
  if (!hasWorkers) return null;
  const workerLabel = `${workers!.length} delegated worker${workers!.length > 1 ? "s" : ""}`;

  return (
    <div className="flex items-center gap-1.5">
      {hasWorkers && (
        <Menu.Root>
          {/* Count only: the arrow already says "delegated to", so the word
					    "workers" was two thirds of the chip carrying no information.
					    The glyph and the number take that room instead, and the
					    accessible name still spells it out. */}
          <Menu.Trigger
            className={cn(
              chip,
              "data-[popup-open]:bg-hover data-[popup-open]:text-fg",
            )}
            aria-label={workerLabel}
            title={workerLabel}
          >
            <IconArrowDownRight className="size-5 shrink-0" />
            <span className="tabular-nums">{workers!.length}</span>
          </Menu.Trigger>
          <Menu.Popup align="start">
            {/* GroupLabel MUST live inside a Group — bare it throws Base UI
						    error #31 and white-screens the app on open. */}
            <Menu.Group>
              <Menu.GroupLabel>Delegated workers</Menu.GroupLabel>
              {workers!.map((w) => (
                <Menu.Item key={w.id} onClick={() => onOpen(w.id)}>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      w.isRunning ? "bg-yellow" : "bg-line-strong",
                    )}
                  />
                  <span className="truncate">{w.title}</span>
                  {shortModel(w.model, models) && (
                    <span className="ml-auto shrink-0 pl-2 text-meta text-faint">
                      {shortModel(w.model, models)}
                    </span>
                  )}
                </Menu.Item>
              ))}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Root>
      )}
    </div>
  );
}
