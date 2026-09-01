import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
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
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  relative: {
    position: "relative",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  top12: {
    top: "calc(1 / 2 * 100%)",
  },
  right7px: {
    right: "7px",
  },
  TranslateY12: {
    translate: "0 calc(calc(1 / 2 * 100%) * -1)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  opacity0: {
    opacity: "0%",
  },
  transitionOpacity: {
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  durationDurMicro: {
    transitionDuration: "var(--dur-micro)",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  phoneRight0: {
    "@media (max-width: 720px)": {
      right: "0",
    },
  },
  phoneSize11: {
    "@media (max-width: 720px)": {
      width: "calc(4px * 11)",
      height: "calc(4px * 11)",
    },
  },
});

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
      {items.map(({ session, depth }) => {
        const selected = session.id === selectedId;
        const label = stateLabel(session);
        const showPrStatus =
          !session.waitingForInput &&
          !session.isRunning &&
          (session.queuedCount ?? 0) === 0 &&
          sessionHasPr(session);
        return (
          <div {...mergeStylexProps("group", sx.relative)} key={session.id}>
            <button
              type="button"
              className={cn(
                utilityClassName(
                  "relative mt-0.5 flex w-full items-center rounded-row border-0 bg-transparent py-[var(--sidebar-row-pad)] pr-10 text-left text-fg phone:py-[13px] phone:pr-12",
                ),
                SIDEBAR_RAIL_GAP,
                SIDEBAR_RAIL_PAD,
                SIDEBAR_HOVER_LAYER,
                selected && utilityClassName("bg-selected"),
              )}
              // A direct worker's title sits 13px past its parent, enough to
              // read as nested without spending a full icon column on empty
              // space. Deeper levels take two smaller steps, then stop so a
              // long delegation chain keeps room for its title.
              style={
                {
                  "--sidebar-icon-left": `${29 + Math.min(depth - 1, 2) * 10}px`,
                } as CSSProperties
              }
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
                className={cn(SIDEBAR_RAIL, utilityClassName("text-faint"))}
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
                    utilityClassName("size-1.5 shrink-0 rounded-full"),
                    session.waitingForInput
                      ? SIDEBAR_STATUS_DOT.waiting
                      : session.isRunning || (session.queuedCount ?? 0) > 0
                        ? SIDEBAR_STATUS_DOT.running
                        : utilityClassName("bg-faint"),
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
                className={mergeStylexOverrideClassName(
                  "group-hover:pointer-events-auto group-hover:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
                  sx.pointerEventsNone,
                  sx.absolute,
                  sx.top12,
                  sx.right7px,
                  sx.TranslateY12,
                  sx.textFaint,
                  sx.opacity0,
                  sx.transitionOpacity,
                  sx.durationDurMicro,
                  sx.hoverTextFg,
                  sx.phoneRight0,
                  sx.phoneSize11,
                )}
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
