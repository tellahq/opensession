import React, { useEffect, useRef, useState } from "react";
import { docTitle } from "../lib/brand";
import {
	fetchReportGroups,
	fetchReports,
	reportRawUrl,
} from "../lib/api";
import type { ReportGroup, ReportMeta } from "../lib/types";
import { useIsPhone } from "../hooks/useIsPhone";
import { BASE_PATH } from "../lib/base";
import { absoluteLink } from "../lib/share-link";
import { parseNewSessionLink, type NewSessionPrefill } from "../lib/new-session-link";
import { Button } from "../ui/button";
import { CopyCheck, useCopy } from "../ui/copy";
import { IconChevronLeft, IconChevronRight, IconFile, IconLink } from "./icons";

interface Props {
	selectedAutomationId?: string;
	selectedReportId?: string;
	onSelect: (automationId: string, reportId?: string) => void;
	/** Phone list/detail navigation: clear the selection to return to the list. */
	onBack: () => void;
	onOpenSession: (id: string) => void;
	onOpenSupport: (threadId: string) => void;
	onOpenNewSession: (prefill: NewSessionPrefill) => void;
	addHandler: (handler: (message: any) => void) => () => void;
}

function formatDate(value: string, detailed = false): string {
	const date = new Date(value);
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		...(detailed ? { year: "numeric", hour: "numeric", minute: "2-digit" } : {}),
	}).format(date);
}

function supportIdFromHref(href: string | undefined): string | null {
	if (!href) return null;
	try {
		const url = new URL(href, location.href);
		if (url.origin !== location.origin) return null;
		const match = url.pathname.match(/^\/(?:opensession\/|backstage\/)?support\/([^/?#]+)/);
		return match ? decodeURIComponent(match[1]) : null;
	} catch {
		return null;
	}
}

export function Reports({
	selectedAutomationId,
	selectedReportId,
	onSelect,
	onBack,
	onOpenSession,
	onOpenSupport,
	onOpenNewSession,
	addHandler,
}: Props) {
	const [groups, setGroups] = useState<ReportGroup[] | null>(null);
	const [history, setHistory] = useState<ReportMeta[]>([]);
	const [error, setError] = useState("");
	const isPhone = useIsPhone();

	// loadGroups is also invoked from the mount-scoped ws handler, where props
	// from that first render would be stale — read the live values via refs.
	const selectionRef = useRef(selectedAutomationId);
	selectionRef.current = selectedAutomationId;
	const isPhoneRef = useRef(isPhone);
	isPhoneRef.current = isPhone;

	async function loadGroups() {
		try {
			const next = await fetchReportGroups();
			setGroups(next);
			setError("");
			// On phones the bare /reports route IS the list page, so don't
			// auto-select — that would skip straight past it into the detail.
			if (!selectionRef.current && !isPhoneRef.current && next[0])
				onSelect(next[0].automationId);
		} catch (e: any) {
			setError(e?.message || "Failed to load reports");
			setGroups([]);
		}
	}

	useEffect(() => {
		document.title = docTitle("Reports");
		loadGroups();
		return addHandler((message) => {
			if (message.type === "reports_changed") loadGroups();
		});
	}, [addHandler]);

	useEffect(() => {
		if (!selectedAutomationId) {
			setHistory([]);
			return;
		}
		let alive = true;
		fetchReports(selectedAutomationId)
			.then((reports) => {
				if (!alive) return;
				setHistory(reports);
				if (!selectedReportId && reports[0])
					onSelect(selectedAutomationId, reports[0].id);
			})
			.catch((e) => alive && setError(e?.message || "Failed to load history"));
		return () => {
			alive = false;
		};
	}, [selectedAutomationId]);

	const selected = history.find((report) => report.id === selectedReportId) || history[0];
	const { copied, share } = useCopy();
	const shareSelected = () => {
		if (!selected) return;
		const link = absoluteLink(
			`${BASE_PATH}/reports/${encodeURIComponent(selected.automationId)}/${encodeURIComponent(selected.id)}`,
		);
		share(link, { toast: true, title: selected.title });
	};

	if (groups === null)
		return <div className="flex flex-1 items-center justify-center text-dim">Loading reports…</div>;

	if (!groups.length)
		return (
			<div className="flex flex-1 items-center justify-center p-8">
				<div className="max-w-[420px] text-center">
					<div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-lg bg-surface text-dim">
						<IconFile size={24} />
					</div>
					<h1 className="m-0 text-section-title font-semibold text-fg">Reports</h1>
					<p className="mt-2 text-body leading-relaxed text-dim">
						Recurring automation reports will collect here, with the latest result and full history in one place.
					</p>
                    {error && <p className="mt-3 text-body text-red">{error}</p>}
				</div>
			</div>
		);

	// Phone: the two panes become separate pages — the list at bare /reports,
	// the detail once an automation is selected, with a back button between.
	const showList = !isPhone || !selectedAutomationId;
	const showDetail = !isPhone || !!selectedAutomationId;

	return (
		<div className="flex min-h-0 flex-1">
			{showList && (
				<aside className={`flex min-h-0 flex-col bg-panel ${isPhone ? "w-full flex-1" : "w-[300px] shrink-0 border-r border-line"}`}>
					<div className="border-b border-line px-4 py-4">
						<h1 className="m-0 text-section-title font-semibold tracking-[-0.02em] text-fg">Reports</h1>
						<p className="m-0 mt-1 text-label text-dim">Recurring intelligence, organized by automation</p>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto p-2">
						{groups.map((group) => (
							<button
								key={group.automationId}
								type="button"
								className={`mb-1 flex w-full items-start gap-3 rounded-md border-0 px-3 py-3 text-left cursor-pointer ${!isPhone && selectedAutomationId === group.automationId ? "bg-active" : "bg-transparent hover:bg-hover"}`}
								onClick={() => onSelect(group.automationId)}
							>
								<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-accent"><IconFile size={17} /></span>
								<span className="min-w-0 flex-1">
                                    <span className="block truncate text-control-label font-medium text-fg">{group.automationName}</span>
                                    <span className="mt-1 block truncate text-label text-dim">{group.latest.title}</span>
									<span className="mt-1.5 block text-meta text-faint">{formatDate(group.latest.createdAt)} · {group.count} {group.count === 1 ? "report" : "reports"}</span>
								</span>
								<IconChevronRight size={16} className="mt-2 shrink-0 text-faint" />
							</button>
						))}
					</div>
				</aside>
			)}

			{showDetail && (
				<section className="flex min-w-0 flex-1 flex-col bg-bg">
					{isPhone ? (
						<header className="shrink-0 border-b border-line px-3 pb-3 pt-2">
							<button
								type="button"
                                className="-ml-1 flex items-center gap-0.5 rounded-md border-0 bg-transparent py-1.5 pl-1 pr-2.5 text-control-label font-medium text-accent cursor-pointer"
								onClick={onBack}
							>
								<IconChevronLeft size={18} />
								Reports
							</button>
							{selected && (
								<>
                                    <h2 className="m-0 mt-1 px-1 text-body font-semibold leading-snug text-fg">{selected.title}</h2>
                                    <p className="m-0 mt-1 px-1 text-label leading-5 text-dim line-clamp-2">{formatDate(selected.createdAt, true)}{selected.summary ? ` · ${selected.summary}` : ""}</p>
									<div className="mt-2.5 flex items-center gap-2 px-1">
										<select
											aria-label="Report history"
                                            className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1.5 text-label text-fg"
											value={selected.id}
											onChange={(event) => onSelect(selected.automationId, event.target.value)}
										>
											{history.map((report) => <option key={report.id} value={report.id}>{formatDate(report.createdAt, true)}</option>)}
										</select>
										{selected.sessionId && <Button size="sm" className="min-h-[30px] shrink-0" onClick={() => onOpenSession(selected.sessionId!)}>Open run</Button>}
										<Button size="sm" className="min-h-[30px] w-[30px] shrink-0" icon={<CopyCheck copied={copied} size={15} idle={<IconLink size={15} />} />} aria-label="Share report" onClick={shareSelected} />
									</div>
								</>
							)}
						</header>
					) : (
						selected && (
							<header className="flex shrink-0 items-start gap-4 border-b border-line px-5 py-3">
								<div className="min-w-0 flex-1">
                                    <h2 className="m-0 truncate text-body font-semibold text-fg">{selected.title}</h2>
                                    <p className="m-0 mt-1 text-label text-dim">{formatDate(selected.createdAt, true)}{selected.summary ? ` · ${selected.summary}` : ""}</p>
								</div>
								<Button size="sm" className="min-h-[30px] w-[30px] shrink-0" icon={<CopyCheck copied={copied} size={15} idle={<IconLink size={15} />} />} aria-label="Share report" title="Share report" onClick={shareSelected} />
								{selected.sessionId && <Button size="sm" className="min-h-[30px] shrink-0" onClick={() => onOpenSession(selected.sessionId!)}>Open run</Button>}
								<select
									aria-label="Report history"
                                    className="max-w-[190px] shrink-0 rounded-md border border-line bg-panel px-2 py-1.5 text-label text-fg"
									value={selected.id}
									onChange={(event) => onSelect(selected.automationId, event.target.value)}
								>
									{history.map((report) => <option key={report.id} value={report.id}>{formatDate(report.createdAt, true)}</option>)}
								</select>
							</header>
						)
					)}
					{selected && (
						<iframe
							key={selected.id}
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
									if (supportIdFromHref(link.href)) link.removeAttribute("target");
								}
								document.addEventListener("click", (clickEvent) => {
									const link = (clickEvent.target as Element | null)?.closest?.("a");
									const prefill = link ? parseNewSessionLink(link.href) : null;
									if (prefill) {
										clickEvent.preventDefault();
										onOpenNewSession(prefill);
										return;
									}
									const supportId = supportIdFromHref(link?.href);
									if (!supportId) return;
									clickEvent.preventDefault();
									onOpenSupport(supportId);
								});
							}}
							className="min-h-0 flex-1 border-0 bg-white"
						/>
					)}
				</section>
			)}
		</div>
	);
}
