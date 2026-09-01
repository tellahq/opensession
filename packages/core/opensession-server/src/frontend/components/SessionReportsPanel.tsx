import React, { useEffect, useEffectEvent, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { fetchSessionReports } from "../lib/api";
import type { ReportMeta, WSServerMessage } from "../lib/types";
import { type NewSessionPrefill } from "../lib/new-session-link";
import { OptionSelect } from "../ui/select";
import { ReportFrame } from "./ReportFrame";
import { errorMessage } from "../lib/error-message";

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-divider px-3 py-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-label font-semibold text-fg">
              {selected.title}
            </div>
            <div className="mt-0.5 text-meta text-faint">
              {formatDate(selected.createdAt)}
            </div>
          </div>
          <a
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-meta text-dim hover:bg-hover hover:text-fg"
            href={fullReportUrl}
          >
            Open full report
          </a>
        </div>
        {reports.length > 1 && (
          <OptionSelect
            size="sm"
            label="Report from this session"
            className="mt-2"
            value={reportKey(selected)}
            options={reports.map((report) => ({
              value: reportKey(report),
              label: `${report.title} · ${formatDate(report.createdAt)}`,
            }))}
            onChange={setSelectedKey}
          />
        )}
        {selected.summary && (
          <p className="m-0 mt-2 text-label leading-5 text-dim">
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
