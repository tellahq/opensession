import type { CSSProperties } from "react";
import {
  sessionHasOpenPr,
  type WorkspaceSubagent,
} from "../../lib/sidebar-workspaces";
import {
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
  SIDEBAR_RAIL_GAP,
  SIDEBAR_RAIL_PAD,
  SIDEBAR_STATUS_DOT,
} from "../../lib/sidebar-classes";
import { sessionHasPr, sessionPrMerged } from "../../lib/session-prs";
import type { UnifiedSession } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconArchive, IconArrowTurnDownRight } from "../icons";
import { WsPrStatusMark } from "./HoverCards";
import { SIDEBAR_ROW_TITLE } from "./SidebarItem";

type SidebarIconStyle = CSSProperties & { "--sidebar-icon-left": string };

function stateLabel(session: UnifiedSession): string {
  if (session.waitingForInput) return "Waiting for input";
  if (session.isRunning) return "Running";
  if ((session.queuedCount ?? 0) > 0) return "Queued";
  if (sessionPrMerged(session)) return "Merged";
  if (sessionHasOpenPr(session)) return "PR open";
  if (sessionHasPr(session)) return "PR closed";
  return "Idle";
}

/** Unarchived workers nested under their selected root workspace. */
export function SubagentRows({
  items,
  selectedId,
  onSelect,
  onArchive,
}: {
  items: WorkspaceSubagent[];
  selectedId: string | null;
  onSelect: (session: UnifiedSession) => void;
  onArchive: (session: UnifiedSession) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div data-subagents="">
      {items.map(({ session, depth, sharesRootPr }) => {
        const selected = session.id === selectedId;
        const label = stateLabel(session);
        const showPrStatus =
          !sharesRootPr &&
          !session.waitingForInput &&
          !session.isRunning &&
          (session.queuedCount ?? 0) === 0 &&
          sessionHasPr(session);
        const iconStyle: SidebarIconStyle = {
          "--sidebar-icon-left": `${29 + Math.min(depth - 1, 2) * 10}px`,
        };
        return (
          <div className="group relative" key={session.id}>
            <button
              type="button"
              className={cn(
                "relative mt-0.5 flex w-full items-center rounded-row border-0 bg-transparent py-[var(--sidebar-row-pad)] pr-10 text-left text-fg phone:py-[13px] phone:pr-12",
                SIDEBAR_RAIL_GAP,
                SIDEBAR_RAIL_PAD,
                SIDEBAR_HOVER_LAYER,
                selected && "bg-selected",
              )}
              // A direct worker's title sits 13px past its parent, enough to
              // read as nested without spending a full icon column on empty
              // space. Deeper levels take two smaller steps, then stop so a
              // long delegation chain keeps room for its title.
              style={iconStyle}
              data-sidebar-row=""
              data-sidebar-item-key={`session:${session.id}`}
              data-subagent-row=""
              data-parent-session-id={session.parentSessionId}
              data-selected={selected || undefined}
              aria-current={selected ? "page" : undefined}
              aria-label={`${session.title}, subagent, ${label}`}
              onClick={() => onSelect(session)}
            >
              <span
                className={cn(SIDEBAR_RAIL, "text-faint")}
                aria-hidden="true"
              >
                <IconArrowTurnDownRight size={16} />
              </span>
              <span className={SIDEBAR_ROW_TITLE}>{session.title}</span>
              {showPrStatus ? (
                <WsPrStatusMark sessions={[session]} size={16} />
              ) : (
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    session.waitingForInput
                      ? SIDEBAR_STATUS_DOT.waiting
                      : session.isRunning || (session.queuedCount ?? 0) > 0
                        ? SIDEBAR_STATUS_DOT.running
                        : "bg-faint",
                  )}
                  aria-hidden="true"
                  title={label}
                />
              )}
            </button>
            <Tooltip label="Archive session">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={<IconArchive size={19} />}
                className="pointer-events-none absolute top-1/2 right-[7px] -translate-y-1/2 text-faint opacity-0 transition-opacity duration-(--dur-micro) hover:text-fg group-hover:pointer-events-auto group-hover:opacity-100 phone:right-0 phone:size-11 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
                aria-label={`Archive ${session.title}`}
                onClick={() => onArchive(session)}
              />
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}
