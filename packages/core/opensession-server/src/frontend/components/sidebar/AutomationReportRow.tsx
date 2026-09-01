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
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
  SIDEBAR_WS_ROW,
  SIDEBAR_WS_TIME,
  SIDEBAR_WS_TIME_HOVER,
} from "../../lib/sidebar-classes";
import { reportUrgencyDot } from "../../lib/report-urgency";
import { shortTime } from "../../lib/time";
import { cn } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { CardFooter, RowCardPopup, useRowHoverCard } from "../SidebarRowCards";
import { SIDEBAR_ROW, SIDEBAR_ROW_TITLE } from "./SidebarItem";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  size7px: {
    width: "7px",
    height: "7px",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  textSm: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-sm--line-height))",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt15: {
    marginTop: "calc(4px * 1.5)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  leading15: {
    lineHeight: "1.5",
  },
  textDim: {
    color: "var(--text-dim)",
  },
});

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
            className={cn(SIDEBAR_ROW, SIDEBAR_WS_ROW, SIDEBAR_HOVER_LAYER)}
            data-sidebar-row=""
            onClick={onOpen}
            aria-label={`Report: ${report.title}`}
          />
        }
      >
        <span className={SIDEBAR_RAIL}>
          <span
            {...stylex.props(sx.size7px, sx.roundedFull)}
            style={{ backgroundColor: reportUrgencyDot(report.urgency) }}
          />
        </span>
        <span className={SIDEBAR_ROW_TITLE}>{report.title}</span>
        {!isPhone && (
          <span
            className={cn(SIDEBAR_WS_TIME, SIDEBAR_WS_TIME_HOVER)}
            aria-label={new Date(report.createdAt).toLocaleString()}
          >
            {shortTime(report.createdAt)}
          </span>
        )}
      </Popover.Trigger>
      <RowCardPopup>
        <div {...stylex.props(sx.textSm, sx.fontMedium, sx.textFg)}>
          {report.title}
        </div>
        {report.summary && (
          <p {...stylex.props(sx.mt15, sx.textXs, sx.leading15, sx.textDim)}>
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
