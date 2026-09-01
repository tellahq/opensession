import { utilityClassName } from "../../ui/cn";
import React from "react";
import {
  SIDEBAR_AUTOMATION_RUNS,
  SIDEBAR_BAND_CHEVRON,
  SIDEBAR_BAND_CHEVRON_COLLAPSED,
  SIDEBAR_BAND_LABEL,
  SIDEBAR_BAND_TOGGLE,
  SIDEBAR_BAND_TOGGLE_INSET,
  SIDEBAR_GROUP_CHEVRON,
  SIDEBAR_GROUP_CHEVRON_COLLAPSED,
  SIDEBAR_GROUP_COUNT,
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_HEADER_ROW,
  SIDEBAR_INDEPENDENT_SCROLL,
  SIDEBAR_INDEPENDENT_SECTION,
  SIDEBAR_RAIL,
  SIDEBAR_STICKY_BAND,
  SIDEBAR_STICKY_BAND_ROW,
  SIDEBAR_STUCK_BACKING,
} from "../../lib/sidebar-classes";
import type { SidebarPersonSessions } from "../../lib/sidebar-people";
import type { UnifiedSession } from "../../lib/types";
import { cn } from "../../ui/cn";
import { UserAvatar } from "../UserAvatar";
import { IconChevronDown } from "../icons";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  minW0: {
    minWidth: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

/**
 * Teammates with a running or just-finished session. Each member is an
 * independent, open-by-default disclosure so a busy teammate can be folded
 * without hiding everybody else.
 */
export function PeopleBand({
  groups,
  open,
  isGroupOpen,
  onToggleBand,
  onToggleGroup,
  renderSession,
}: {
  groups: SidebarPersonSessions[];
  open: boolean;
  isGroupOpen: (key: string) => boolean;
  onToggleBand: () => void;
  onToggleGroup: (key: string) => void;
  renderSession: (session: UnifiedSession) => React.ReactNode;
}) {
  if (groups.length === 0) return null;

  return (
    <div
      className={cn(SIDEBAR_INDEPENDENT_SECTION, utilityClassName("mt-2 pb-7"))}
    >
      <div
        className={cn(
          SIDEBAR_BAND_LABEL,
          utilityClassName("py-0 pl-0 pr-2 desktop:pr-0"),
          SIDEBAR_STICKY_BAND,
          SIDEBAR_STICKY_BAND_ROW,
          SIDEBAR_STUCK_BACKING,
        )}
        data-sticky-head
      >
        <button
          className={cn(SIDEBAR_BAND_TOGGLE, SIDEBAR_BAND_TOGGLE_INSET)}
          onClick={onToggleBand}
          title={open ? "Collapse team" : "Expand team"}
          aria-expanded={open}
        >
          <span {...stylex.props(sx.minW0, sx.truncate)}>Team</span>
          <span className={SIDEBAR_GROUP_COUNT}>
            {groups.reduce(
              (count, group) => count + group.activeSessions.length,
              0,
            )}
          </span>
          <IconChevronDown
            className={cn(
              SIDEBAR_BAND_CHEVRON,
              "group-hover/band:visible group-hover/band:text-dim",
              !open && SIDEBAR_BAND_CHEVRON_COLLAPSED,
            )}
            size={18}
            style={{ transform: open ? "none" : "rotate(-90deg)" }}
          />
        </button>
      </div>
      {open && (
        <div className={SIDEBAR_INDEPENDENT_SCROLL}>
          {groups.map((group) => {
            const groupKey = `person:${group.key}`;
            const personOpen = isGroupOpen(groupKey);
            return (
              <React.Fragment key={group.key}>
                <button
                  className={cn(
                    SIDEBAR_GROUP_HEADER,
                    SIDEBAR_GROUP_HEADER_INSET,
                    SIDEBAR_HEADER_ROW,
                  )}
                  onClick={(event) => {
                    const header = event.currentTarget;
                    onToggleGroup(groupKey);
                    // Keep the toggled heading visible when a long list folds.
                    requestAnimationFrame(() =>
                      header.scrollIntoView({
                        block: "nearest",
                        inline: "nearest",
                      }),
                    );
                  }}
                  aria-expanded={personOpen}
                  title={`${personOpen ? "Collapse" : "Expand"} ${group.label}'s sessions`}
                >
                  <span className={SIDEBAR_RAIL}>
                    <UserAvatar name={group.label} size={20} />
                  </span>
                  <span className={SIDEBAR_GROUP_NAME}>{group.label}</span>
                  <span
                    className={cn(
                      SIDEBAR_GROUP_COUNT,
                      utilityClassName("shrink-0"),
                    )}
                  >
                    {group.activeSessions.length}
                  </span>
                  <IconChevronDown
                    className={cn(
                      SIDEBAR_GROUP_CHEVRON,
                      !personOpen && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
                    )}
                    size={22}
                    style={{
                      transform: personOpen ? "none" : "rotate(-90deg)",
                    }}
                  />
                </button>
                {personOpen && (
                  <div className={SIDEBAR_AUTOMATION_RUNS}>
                    {group.activeSessions.map(renderSession)}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
