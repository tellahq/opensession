import React, { useCallback, useEffect, useState } from "react";
import { BASE_PATH } from "../lib/base";
import {
	fetchSessionReports,
	reportRawUrl,
} from "../lib/api";
import type { ReportMeta, WSServerMessage } from "../lib/types";
import { parseNewSessionLink, type NewSessionPrefill } from "../lib/new-session-link";

export function useSessionReports(
	sessionId: string,
	addHandler: (handler: (message: WSServerMessage) => void) => () => void,
) {
	const [reports, setReports] = useState<ReportMeta[]>([]);
	const refresh = useCallback(() => {
		fetchSessionReports(sessionId)
			.then(setReports)
			.catch(() => {});
	}, [sessionId]);
	useEffect(() => {
		setReports([]);
		refresh();
	}, [refresh]);
	useEffect(
		() =>
			addHandler((message) => {
				if (
					message.type === "reports_changed" &&
					message.sessionId === sessionId
				)
					refresh();
			}),
		[addHandler, sessionId, refresh],
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
			<div className="shrink-0 border-b border-line px-3 py-2.5">
				<div className="flex items-start gap-2">
					<div className="min-w-0 flex-1">
						<div className="truncate text-control-label font-semibold text-fg">
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
					<select
						aria-label="Report from this session"
						className="mt-2 w-full rounded-md border border-line bg-panel px-2 py-1.5 text-label text-fg"
						value={reportKey(selected)}
						onChange={(event) => setSelectedKey(event.target.value)}
					>
						{reports.map((report) => (
							<option key={reportKey(report)} value={reportKey(report)}>
								{report.title} · {formatDate(report.createdAt)}
							</option>
						))}
					</select>
				)}
				{selected.summary && (
					<p className="m-0 mt-2 text-label leading-5 text-dim">
						{selected.summary}
					</p>
				)}
			</div>
			<iframe
				key={reportKey(selected)}
				title={selected.title}
				sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				src={reportRawUrl(selected.automationId, selected.id)}
				onLoad={(event) => {
					const document = event.currentTarget.contentDocument;
					if (!document) return;
					for (const link of document.querySelectorAll("a")) {
						if (parseNewSessionLink(link.href)) {
							link.removeAttribute("target");
							continue;
						}
						link.target = "_blank";
						link.rel = "noopener noreferrer";
					}
					document.addEventListener("click", (clickEvent) => {
						const link = (clickEvent.target as Element | null)?.closest?.("a");
						const prefill = link ? parseNewSessionLink(link.href) : null;
						if (!prefill) return;
						clickEvent.preventDefault();
						onOpenNewSession(prefill);
					});
				}}
				className="min-h-0 flex-1 border-0 bg-white"
			/>
		</div>
	);
}
