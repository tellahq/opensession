import { mergeStylexProps } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import React from "react";
import type { AutomationOverviewByName } from "../../lib/automation-overview";
import {
  SIDEBAR_AUTO_COG,
  SIDEBAR_AUTOMATION_RUNS,
  SIDEBAR_BAND_CHEVRON,
  SIDEBAR_BAND_CHEVRON_COLLAPSED,
  SIDEBAR_BAND_LABEL,
  SIDEBAR_BAND_TOGGLE,
  SIDEBAR_BAND_TOGGLE_INSET,
  SIDEBAR_GROUP_CHEVRON,
  SIDEBAR_GROUP_CHEVRON_COLLAPSED,
  SIDEBAR_GROUP_COUNT,
  SIDEBAR_GROUP_DOT,
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
import type { Group } from "../../lib/sidebar-types";
import type { UnifiedSession } from "../../lib/types";
import { cn } from "../../ui/cn";
import { IconChevronDown, IconSliders } from "../icons";
import { AutomationReportRow } from "./AutomationReportRow";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

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
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  pb1: {
    paddingBottom: "4px",
  },
  pt05: {
    paddingTop: "calc(4px * 0.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

export function AutomationsBand({
  groups,
  automationOverview,
  open,
  hasPeople,
  isGroupOpen,
  onToggleBand,
  onToggleGroup,
  onOpenAutomation,
  onOpenReport,
  renderSession,
}: {
  groups: Group[];
  automationOverview: AutomationOverviewByName;
  open: boolean;
  hasPeople: boolean;
  isGroupOpen: (key: string) => boolean;
  onToggleBand: () => void;
  onToggleGroup: (key: string) => void;
  onOpenAutomation: (name: string) => void;
  onOpenReport: (automationId: string, reportId: string) => void;
  renderSession: (session: UnifiedSession) => React.ReactNode;
}) {
  if (groups.length === 0) return null;

  return (
    <div
      className={cn(
        SIDEBAR_INDEPENDENT_SECTION,
        utilityClassName("mt-2"),
        hasPeople ? utilityClassName("pb-2") : utilityClassName("pb-7"),
      )}
    >
      <div
        className={cn(
          SIDEBAR_BAND_LABEL,
          // A band heading carries no leading mark, so on phones it takes the
          // 8px a 22px glyph spends on its own padding before the ink starts.
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
          title={open ? "Collapse automations" : "Expand automations"}
        >
          <span {...stylex.props(sx.minW0, sx.truncate)}>Automations</span>
          {/* The count sits right after the heading, not pinned to the far
              right; any future action can still be pushed there with ml-auto. */}
          <span className={SIDEBAR_GROUP_COUNT}>
            {groups.reduce(
              (count, group) =>
                count + (group.totalItems || group.items.length),
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
            const groupOpen = isGroupOpen(group.key);
            const overview = automationOverview.get(group.label);
            const report = overview?.latestReport;
            return (
              <React.Fragment key={group.key}>
                <button
                  className={cn(
                    SIDEBAR_GROUP_HEADER,
                    SIDEBAR_GROUP_HEADER_INSET,
                    SIDEBAR_HEADER_ROW,
                  )}
                  onClick={() => onToggleGroup(group.key)}
                >
                  {/* The dot is 7px but the header's leading column is a rail,
                      so its name lands where every other one does. */}
                  <span className={SIDEBAR_RAIL}>
                    {group.dotColor && (
                      <span
                        className={SIDEBAR_GROUP_DOT}
                        style={{ backgroundColor: group.dotColor }}
                      />
                    )}
                  </span>
                  <span className={SIDEBAR_GROUP_NAME}>{group.label}</span>
                  {/* The count belongs to the name, not the row's far edge. An
                      automation heading titles the runs under it, so this reads
                      “iOS parity check, 5” like every band above it. */}
                  <span
                    className={cn(
                      SIDEBAR_GROUP_COUNT,
                      utilityClassName("shrink-0"),
                    )}
                  >
                    {group.totalItems || group.items.length}
                  </span>
                  {/* Collapsed, the chevron shows at rest. A closed automation
                      can still list its latest report, so without the chevron
                      nothing says whether the rows are all of them or one of
                      eight. */}
                  <IconChevronDown
                    className={cn(
                      SIDEBAR_GROUP_CHEVRON,
                      !groupOpen && SIDEBAR_GROUP_CHEVRON_COLLAPSED,
                    )}
                    size={22}
                    style={{
                      transform: groupOpen ? "none" : "rotate(-90deg)",
                    }}
                  />
                  {/* The settings glyph is a span, not another button, because
                      it sits inside the header button. Its target is the row's
                      full height, so a click can land anywhere at the row end. */}
                  <span
                    role="button"
                    className={SIDEBAR_AUTO_COG}
                    title="Automation settings"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenAutomation(group.label);
                    }}
                  >
                    <IconSliders size={20} />
                  </span>
                </button>
                {/* The automation's work is stepped inside its heading. The
                    step still holds for a collapsed group's report; the
                    heading chevron is what says the group is closed. */}
                <div className={SIDEBAR_AUTOMATION_RUNS}>
                  {/* An automation with an owner reports to someone rather
                      than being a house routine nobody has taken. Show its
                      conclusion even while collapsed because someone asked to
                      hear from it; ownerless routines stay quiet. */}
                  {(groupOpen || !!overview?.owner) && report && (
                    <AutomationReportRow
                      report={report}
                      onOpen={() => {
                        if (overview?.latestReport)
                          onOpenReport(overview.id, overview.latestReport.id);
                      }}
                    />
                  )}
                  {groupOpen &&
                    (group.totalItems || group.items.length) >
                      group.items.length && (
                      <div
                        {...mergeStylexProps(
                          "tabular-nums",
                          sx.px4,
                          sx.pb1,
                          sx.pt05,
                          sx.textFaint,
                          typography.meta,
                        )}
                      >
                        Latest {group.items.length} of {group.totalItems} runs
                      </div>
                    )}
                  {groupOpen && group.items.map(renderSession)}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
