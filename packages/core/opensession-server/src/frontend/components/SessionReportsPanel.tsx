import { mergeStylexOverrideClassName } from "../ui/cn";
import React, { useEffect, useEffectEvent, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { fetchSessionReports } from "../lib/api";
import type { ReportMeta, WSServerMessage } from "../lib/types";
import { type NewSessionPrefill } from "../lib/new-session-link";
import { OptionSelect } from "../ui/select";
import { ReportFrame } from "./ReportFrame";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  hFull: {
    height: "100%",
  },
  minH0: {
    minHeight: "0",
  },
  flexCol: {
    flexDirection: "column",
  },
  shrink0: {
    flexShrink: "0",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py25: {
    paddingBlock: "calc(4px * 2.5)",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py05: {
    paddingBlock: "calc(4px * 0.5)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  m0: {
    margin: "0",
  },
  leading5: {
    lineHeight: "calc(4px * 5)",
  },
});

export function useSessionReports(
  sessionId: string,
  addHandler: (handler: (message: WSServerMessage) => void) => () => void,
) {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const refresh = useEffectEvent(() => {
    fetchSessionReports(sessionId)
      .then(setReports)
      .catch((error: unknown) => {
        // Reports are an optional secondary panel. On the first failed load
        // there is no panel to own an error, while refresh failures leave the
        // current report list visible and usable.
        console.warn(errorMessage(error, "Failed to refresh session reports"));
      });
  });
  useEffect(() => {
    setReports([]);
    refresh();
  }, [sessionId]);
  useEffect(
    () =>
      addHandler((message) => {
        if (
          message.type === "reports_changed" &&
          message.sessionId === sessionId
        )
          refresh();
      }),
    [addHandler, sessionId],
  );
  return reports;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function reportKey(report: ReportMeta): string {
  return `${report.automationId}/${report.id}`;
}

export function SessionReportsPanel({
  reports,
  onOpenNewSession,
}: {
  reports: ReportMeta[];
  onOpenNewSession: (prefill: NewSessionPrefill) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected =
    reports.find((report) => reportKey(report) === selectedKey) ||
    reports[0] ||
    null;

  useEffect(() => {
    if (
      !selectedKey ||
      !reports.some((report) => reportKey(report) === selectedKey)
    )
      setSelectedKey(reports[0] ? reportKey(reports[0]) : null);
  }, [reports, selectedKey]);

  if (!selected) return null;
  const fullReportUrl =
    `${BASE_PATH}/reports/${encodeURIComponent(selected.automationId)}` +
    `/${encodeURIComponent(selected.id)}`;

  return (
    <div {...stylex.props(sx.flex, sx.hFull, sx.minH0, sx.flexCol)}>
      <div
        {...stylex.props(
          sx.shrink0,
          sx.borderB,
          sx.borderDivider,
          sx.px3,
          sx.py25,
        )}
      >
        <div {...stylex.props(sx.flex, sx.itemsStart, sx.gap2)}>
          <div {...stylex.props(sx.minW0, sx.flex1)}>
            <div
              {...stylex.props(
                sx.truncate,
                sx.fontSemibold,
                sx.textFg,
                typography.label,
              )}
            >
              {selected.title}
            </div>
            <div {...stylex.props(sx.mt05, sx.textFaint, typography.meta)}>
              {formatDate(selected.createdAt)}
            </div>
          </div>
          <a
            {...stylex.props(
              sx.shrink0,
              sx.roundedSm,
              sx.px15,
              sx.py05,
              sx.textDim,
              sx.hoverBgHover,
              sx.hoverTextFg,
              typography.meta,
            )}
            href={fullReportUrl}
          >
            Open full report
          </a>
        </div>
        {reports.length > 1 && (
          <OptionSelect
            size="sm"
            label="Report from this session"
            className={mergeStylexOverrideClassName("", sx.mt2)}
            value={reportKey(selected)}
            options={reports.map((report) => ({
              value: reportKey(report),
              label: `${report.title} · ${formatDate(report.createdAt)}`,
            }))}
            onChange={setSelectedKey}
          />
        )}
        {selected.summary && (
          <p
            {...stylex.props(
              sx.m0,
              sx.mt2,
              sx.leading5,
              sx.textDim,
              typography.label,
            )}
          >
            {selected.summary}
          </p>
        )}
      </div>
      <ReportFrame
        automationId={selected.automationId}
        reportId={selected.id}
        title={selected.title}
        onOpenNewSession={onOpenNewSession}
      />
    </div>
  );
}
