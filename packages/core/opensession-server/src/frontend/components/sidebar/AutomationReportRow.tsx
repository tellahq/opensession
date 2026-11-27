/**
 * An automation's latest report, as the first row under its heading.
 *
 * A band of runs named "iOS parity check — 2026-08-15 07:00" says an
 * automation ran; it never says what it found, so the outcome only existed
 * wherever the run happened to post it. The report is the durable form of
 * that outcome (src/server/reports.ts), so it leads the group: title on the
 * row, the gist in the hover card the rest of the sidebar already uses, and
 * the whole document a click away.
 */

import React from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import type { AutomationOverview } from "../../lib/api/automations";
import {
  SIDEBAR_RAIL,
  SIDEBAR_ROW_TITLE,
  sidebarRow,
  sidebarRowTime,
} from "../../lib/sidebar-classes";
import { reportUrgencyDot } from "../../lib/report-urgency";
import { shortTime } from "../../lib/time";
import { cn } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { CardFooter, RowCardPopup, useRowHoverCard } from "../SidebarRowCards";

type Report = NonNullable<AutomationOverview["latestReport"]>;

export function AutomationReportRow({
  report,
  onOpen,
}: {
  report: Report;
  onOpen: () => void;
}) {
  const isPhone = useIsPhone();
  const card = useRowHoverCard();
  return (
    <Popover.Root {...card.rootProps}>
      <Popover.Trigger
        {...card.triggerProps}
        render={
          <button
            type="button"
            className={sidebarRow({ layout: "rail", chips: 3 })}
            data-sidebar-row=""
            onClick={onOpen}
            aria-label={`Report: ${report.title}`}
          />
        }
      >
        <span className={SIDEBAR_RAIL}>
          <span
            className="size-[7px] rounded-full"
            style={{ backgroundColor: reportUrgencyDot(report.urgency) }}
          />
        </span>
        <span className={SIDEBAR_ROW_TITLE}>{report.title}</span>
        {!isPhone && (
          <span
            className={sidebarRowTime({ reveal: true })}
            aria-label={new Date(report.createdAt).toLocaleString()}
          >
            {shortTime(report.createdAt)}
          </span>
        )}
      </Popover.Trigger>
      <RowCardPopup>
        <div className="text-sm font-medium text-fg">{report.title}</div>
        {report.summary && (
          <p className="mt-1.5 text-xs leading-body text-dim">
            {report.summary}
          </p>
        )}
        <CardFooter
          time={shortTime(report.createdAt)}
          timeTitle={new Date(report.createdAt).toLocaleString()}
        />
      </RowCardPopup>
    </Popover.Root>
  );
}
