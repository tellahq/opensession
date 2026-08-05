import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PlainThread } from "../lib/types";
import { fetchPlainThreadById, startPlainTriageApi } from "../lib/api";
import { Button } from "../ui/button";
import {
	PlainEntryRow,
	PlainReplyBox,
	PlainThreadActions,
	PlainWaitingBanner,
	plainThreadUrl,
	STATUS_LABEL,
} from "./PlainThreadPanel";

interface Props {
	/** The Plain thread id — the pane's key. */
	threadId: string;
	/** Navigate into a session (the triage button resolves to one over HTTP). */
	onOpenSession: (id: string) => void;
	/** Hide the "Triage this ticket" affordance (e.g. a triage chat already exists). */
	hideTriage?: boolean;
	className?: string;
}

/**
 * The support-ticket Conversation surface: the full thread straight from Plain
 * (no LLM involved) with ticket admin (status/priority/assign/labels/spam), a
 * customer-reply / internal-note box, and the one-click triage affordance.
 * Rendered as a workspace view tab (the Conversation tab of ticket-backed
 * workspaces) and by the legacy session-less /support preview. Polls at 20s —
 * there's no live push for Plain.
 */
export function ConversationPane({
	threadId,
	onOpenSession,
	hideTriage,
	className,
}: Props) {
	const [thread, setThread] = useState<PlainThread | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [triaging, setTriaging] = useState(false);
	const [triageError, setTriageError] = useState<string | null>(null);
	const aliveRef = useRef(true);

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	// Load on mount / thread change, then poll — the customer can reply while
	// the ticket is being read and there's no live push for Plain.
	const load = useCallback(() => {
		return fetchPlainThreadById(threadId)
			.then((t) => {
				if (!aliveRef.current) return;
				setThread(t);
				setError(null);
			})
			.catch((e) => {
				if (aliveRef.current) setError(e?.message || "Failed to load");
			})
			.finally(() => {
				if (aliveRef.current) setLoading(false);
			});
	}, [threadId]);
	useEffect(() => {
		setLoading(true);
		setThread(null);
		setError(null);
		load();
		const poll = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			load();
		}, 20000);
		return () => clearInterval(poll);
	}, [load]);

	// The triage automation reuses a live session for this thread when one
	// exists, else boots a fresh run — that takes tens of seconds, so keep the
	// button in a visible in-progress state the whole way.
	async function handleTriage() {
		if (triaging) return;
		setTriaging(true);
		setTriageError(null);
		try {
			const sessionId = await startPlainTriageApi(threadId);
			if (aliveRef.current) onOpenSession(sessionId);
		} catch (e: any) {
			if (aliveRef.current)
				setTriageError(e?.message || "Failed to start the triage run.");
		} finally {
			if (aliveRef.current) setTriaging(false);
		}
	}

	const status = thread?.status;
	const customerLabel =
		thread?.customer?.name || thread?.customer?.email || "Unknown customer";

	return (
		<div className={`flex-1 min-h-0 overflow-y-auto ${className || ""}`}>
			<div className="w-full max-w-[760px] mx-auto px-5 py-6">
				{loading && !thread ? (
					<div className="panel-placeholder px-4 py-12 text-center text-control-label text-faint">Loading ticket…</div>
				) : error && !thread ? (
					<div className="panel-placeholder px-4 py-12 text-center text-control-label text-faint">
						Couldn't load this Plain thread: {error}
					</div>
				) : (
					<>
						<div className="flex items-center gap-2.5 min-w-0">
							<span
								className="truncate text-item-title font-semibold text-fg"
								title={thread?.customer?.email || ""}
							>
								{customerLabel}
							</span>
							{thread?.customer?.name && thread?.customer?.email && (
								<span className="text-faint text-label truncate">
									{thread.customer.email}
								</span>
							)}
							{status && (
								<span
									className={`plain-status plain-status-${status.toLowerCase()} shrink-0 rounded-full bg-active px-1.5 py-0.5 text-meta font-bold text-faint ${status === "TODO" ? "bg-accent-soft text-accent" : status === "DONE" ? "bg-green-soft text-green" : "bg-yellow/20 text-yellow"}`}
								>
									{STATUS_LABEL[status] || status}
								</span>
							)}
							<a
								className="plain-open ml-auto shrink-0 whitespace-nowrap text-meta font-semibold text-accent no-underline hover:underline"
								href={plainThreadUrl(threadId)}
								target="_blank"
								rel="noreferrer"
								title="Open this thread in Plain"
							>
								Open in Plain ↗
							</a>
						</div>
						{thread?.title && (
							<div className="mt-2 text-section-title font-semibold text-fg">
								{thread.title}
							</div>
						)}

						{/* Is anyone still owed an answer? Plain leads with this;
						    so should we. */}
						{thread && (
							<PlainWaitingBanner thread={thread} className="mt-3" />
						)}

						{/* One-click ticket admin, straight from here: status,
						    priority, spam — no need to jump into Plain. */}
						{thread && (
							<PlainThreadActions
								threadId={threadId}
								thread={thread}
								onChanged={load}
								className="mt-3"
							/>
						)}

						{/* The "do you want to triage this?" affordance: one click runs
						    the Plain triage automation and lands in its session. */}
						{!hideTriage && (
							<div className="flex items-center gap-3 flex-wrap mt-4 p-3 rounded-lg border border-line bg-panel">
								<div className="min-w-0 flex-1">
									<div className="text-body font-semibold text-fg">
										Triage this ticket?
									</div>
									<div className="text-dim text-label mt-0.5">
										Runs the Plain triage automation: investigates, posts an
										internal note, and can open a PR for review.
									</div>
								</div>
								<Button
									variant="ink"
									className="shrink-0 text-control-label"
									onClick={handleTriage}
									disabled={triaging}
								>
									{triaging ? "Starting triage… (~30s)" : "Triage this ticket"}
								</Button>
								{triageError && (
									<div className="basis-full text-red text-label">
										{triageError}
									</div>
								)}
							</div>
						)}

						<div className="flex flex-col gap-3 mt-5">
							{thread && thread.entries.length === 0 ? (
								<div className="plain-loading mt-5 text-center text-control-label text-faint">
									No messages in this thread yet.
								</div>
							) : (
								thread?.entries.map((e) => (
									<PlainEntryRow key={e.id} entry={e} threadId={threadId} />
								))
							)}
						</div>

						{/* Answer the customer (or leave a team note) right here —
						    no Plain, no LLM. */}
						{thread && (
							<PlainReplyBox
								key={threadId}
								threadId={threadId}
								customerName={
									thread.customer?.name || thread.customer?.email || null
								}
								onSent={load}
								className="mt-4 border border-line rounded-lg bg-panel"
							/>
						)}
					</>
				)}
			</div>
		</div>
	);
}
