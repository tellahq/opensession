import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
	PlainEntryAttachment,
	PlainLabelType,
	PlainThread,
	PlainTimelineEntry,
	PlainWorkspaceUser,
} from "../lib/types";
import {
	API_BASE,
	changePlainThreadLabelsApi,
	fetchPlainLabelTypesApi,
	fetchPlainThreadApi,
	fetchPlainUsersApi,
	sendPlainReplyApi,
	setPlainThreadAssigneeApi,
	setPlainThreadPriorityApi,
	setPlainThreadSpamApi,
	setPlainThreadStatusApi,
	setPlainThreadTitleApi,
} from "../lib/api";
import { BASE_PATH } from "../lib/base";
import { Menu } from "../ui/menu";
import { renderMarkdown } from "../lib/markdown";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { useCurrentUser } from "./UserPicker";
import { cn } from "../ui/cn";
import { PLAIN_WORKSPACE_ID, PRODUCT_NAME } from "../lib/brand";

interface Props {
	sessionId: string;
	/** The linked Plain thread id — panel re-fetches when it changes. */
	threadId: string;
	/** Deep link into the thread in the Plain app (the "jump into Plain" action). */
	plainUrl: string;
}

export const STATUS_LABEL: Record<string, string> = {
	TODO: "Todo",
	SNOOZED: "Snoozed",
	DONE: "Done",
};

/** Deep link into the Plain app, or "" when the instance has no configured
 *  Plain workspace id (integrations.plain.workspaceId) — links hide. */
export function plainThreadUrl(threadId: string): string {
	return PLAIN_WORKSPACE_ID
		? `https://app.plain.com/workspace/${PLAIN_WORKSPACE_ID}/thread/${threadId}/`
		: "";
}

function timeOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Read-only conversation timeline for a session's linked Plain thread: customer
 * emails/chats on the left, support/bot replies on the right, internal notes
 * inline. Polls lightly so new replies show up, and offers a one-click jump into
 * the thread in Plain. Shown as the session viewer's "Plain" workspace tab.
 */
export function PlainThreadPanel({ sessionId, threadId, plainUrl }: Props) {
	const [thread, setThread] = useState<PlainThread | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);

	// Load on mount / thread change, then poll — a customer can reply at any time
	// and there's no live push for Plain, so a gentle refresh keeps it current.
	// `load` is callable on its own so the reply box can refresh the timeline
	// right after a send instead of waiting out the poll.
	const aliveRef = useRef(true);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);
	const load = useCallback(
		() =>
			fetchPlainThreadApi(sessionId)
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
				}),
		[sessionId],
	);
	useEffect(() => {
		setLoading(true);
		setError(null);
		load();
		const poll = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			load();
		}, 20000);
		return () => clearInterval(poll);
	}, [threadId, load]);

	// Keep the newest message in view, but only when the reader is already near the
	// bottom — a poll refresh shouldn't yank them out of scrollback.
	useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
		if (nearBottom) el.scrollTop = el.scrollHeight;
	}, [thread?.entries.length]);

	const status = thread?.status;

	return (
		<div className="plain-panel flex h-full min-h-0 flex-col bg-raised">
			<div className="plain-panel-head flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
				<div className="plain-head-info flex min-w-0 items-center gap-2">
					<span className="plain-customer truncate text-control-label font-semibold text-fg" title={thread?.customer?.email || ""}>
						{thread?.customer?.name || thread?.customer?.email || "Plain thread"}
					</span>
					{status && (
						<span className={`plain-status plain-status-${status.toLowerCase()} shrink-0 rounded-full bg-active px-1.5 py-0.5 text-meta font-bold text-faint ${status === "TODO" ? "bg-accent-soft text-accent" : status === "DONE" ? "bg-green-soft text-green" : "bg-yellow/20 text-yellow"}`}>
							{STATUS_LABEL[status] || status}
						</span>
					)}
				</div>
				<a
					className="plain-open shrink-0 whitespace-nowrap text-meta font-semibold text-accent no-underline hover:underline"
					href={plainUrl}
					target="_blank"
					rel="noreferrer"
					title="Open this thread in Plain"
				>
					Open in Plain ↗
				</a>
			</div>

			{thread?.waitingSince && (
				<PlainWaitingBanner
					thread={thread}
					className="shrink-0 mx-3 mt-2 rounded-md"
				/>
			)}

			{thread && (
				<PlainThreadActions
					threadId={threadId}
					thread={thread}
					onChanged={load}
					className="shrink-0 px-3 py-2 border-b border-line"
				/>
			)}

			{thread?.title && <div className="plain-title shrink-0 border-b border-line px-3 py-2 text-control-label font-semibold text-fg">{thread.title}</div>}

			<div className="plain-timeline flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" ref={bodyRef}>
				{loading && !thread ? (
					<div className="plain-loading mt-5 text-center text-control-label text-faint">Loading conversation…</div>
				) : error && !thread ? (
					<div className="plain-loading mt-5 text-center text-control-label text-faint">Couldn't load Plain thread: {error}</div>
				) : thread && thread.entries.length === 0 ? (
					<div className="plain-loading mt-5 text-center text-control-label text-faint">No messages in this thread yet.</div>
				) : (
					thread?.entries.map((e) => (
						<PlainEntryRow key={e.id} entry={e} threadId={threadId} />
					))
				)}
			</div>

			{thread && (
				<PlainReplyBox
					key={threadId}
					threadId={threadId}
					customerName={thread.customer?.name || thread.customer?.email || null}
					onSent={load}
					className="border-t border-line"
				/>
			)}
		</div>
	);
}

/** Plain thread priorities, as Plain's own UI names them. */
const PRIORITY_LABEL: Record<number, string> = {
	0: "Urgent",
	1: "High",
	2: "Normal",
	3: "Low",
};

const SNOOZE_OPTIONS: { label: string; seconds: number }[] = [
	{ label: "1 hour", seconds: 3_600 },
	{ label: "4 hours", seconds: 4 * 3_600 },
	{ label: "1 day", seconds: 86_400 },
	{ label: "3 days", seconds: 3 * 86_400 },
	{ label: "1 week", seconds: 7 * 86_400 },
];

const actionPill =
	"cursor-pointer rounded-full border border-line bg-transparent px-2 py-0.5 text-meta font-semibold text-dim hover:border-line-strong hover:text-fg disabled:cursor-default disabled:opacity-50";

/**
 * Quick thread actions mirroring Plain's own inbox: status (Todo / Snoozed /
 * Done), priority, and mark-as-spam. Spam lives on the customer in Plain, so
 * marking spam also closes the thread. Shared by the session viewer's Plain
 * tab and the Support ticket preview — like the reply box, these are the
 * human gate: agent runs never get Plain writes as tools.
 */
export function PlainThreadActions({
	threadId,
	thread,
	onChanged,
	className,
}: {
	threadId: string;
	thread: PlainThread;
	/** Called after any successful action so the owner can refresh. */
	onChanged: () => void;
	className?: string;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const currentUser = useCurrentUser();

	// Assign/Labels menu data — server-cached (~5 min), so fetching per mount
	// is cheap. Errors just leave the menus empty/hidden.
	const [users, setUsers] = useState<PlainWorkspaceUser[] | null>(null);
	const [labelTypes, setLabelTypes] = useState<PlainLabelType[] | null>(null);
	useEffect(() => {
		let alive = true;
		fetchPlainUsersApi()
			.then((u) => {
				if (alive) setUsers(u);
			})
			.catch(() => {});
		fetchPlainLabelTypesApi()
			.then((lt) => {
				if (alive) setLabelTypes(lt);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	async function run(fn: () => Promise<void>) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await fn();
			onChanged();
		} catch (e: any) {
			setError(e?.message || "Plain update failed");
		} finally {
			setBusy(false);
		}
	}

	const status = thread.status;
	const setStatus = (
		s: "todo" | "done" | "snoozed",
		durationSeconds?: number,
	) =>
		run(() =>
			setPlainThreadStatusApi(threadId, s, {
				durationSeconds,
				user: currentUser,
			}),
		);

	const customerLabel =
		thread.customer?.name || thread.customer?.email || "this customer";
	const isSpam = !!thread.customer?.isSpam;

	return (
		<div className={cn("flex flex-col gap-1", className)}>
			<div className="flex items-center gap-1.5 flex-wrap">
				{status === "DONE" ? (
					<button
						type="button"
						className={actionPill}
						disabled={busy}
						onClick={() => setStatus("todo")}
						title="Reopen this thread (back to Todo)"
					>
						Reopen
					</button>
				) : (
					<>
						<button
							type="button"
							className={cn(actionPill, "hover:text-green")}
							disabled={busy}
							onClick={() => setStatus("done")}
							title="Mark this thread Done in Plain"
						>
							✓ Done
						</button>
						{status === "SNOOZED" ? (
							<button
								type="button"
								className={actionPill}
								disabled={busy}
								onClick={() => setStatus("todo")}
								title="Unsnooze — back to Todo"
							>
								Unsnooze
							</button>
						) : (
							<Menu.Root>
								<Menu.Trigger
									className={actionPill}
									disabled={busy}
									title="Snooze this thread"
								>
									Snooze ▾
								</Menu.Trigger>
								<Menu.Popup align="start">
									{SNOOZE_OPTIONS.map((o) => (
										<Menu.Item
											key={o.seconds}
											onClick={() => setStatus("snoozed", o.seconds)}
										>
											{o.label}
										</Menu.Item>
									))}
								</Menu.Popup>
							</Menu.Root>
						)}
					</>
				)}
				<Menu.Root>
					<Menu.Trigger
						className={actionPill}
						disabled={busy}
						title="Change priority in Plain"
					>
						{thread.priority != null
							? (PRIORITY_LABEL[thread.priority] ?? `P${thread.priority}`)
							: "Priority"}{" "}
						▾
					</Menu.Trigger>
					<Menu.Popup align="start">
						{([0, 1, 2, 3] as const).map((p) => (
							<Menu.Item
								key={p}
								onClick={() =>
									run(() =>
										setPlainThreadPriorityApi(threadId, p, currentUser),
									)
								}
							>
								<span className="w-4 shrink-0">
									{thread.priority === p ? "✓" : ""}
								</span>
								{PRIORITY_LABEL[p]}
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Root>
				<Menu.Root>
					<Menu.Trigger
						className={actionPill}
						disabled={busy}
						title="Assign this thread to a teammate in Plain"
					>
						{thread.assignee ? `@ ${thread.assignee.name}` : "Assign"} ▾
					</Menu.Trigger>
					<Menu.Popup align="start">
						{users === null ? (
							<div className="px-2.5 py-1.5 text-faint text-label">
								Loading…
							</div>
						) : (
							users.map((u) => (
								<Menu.Item
									key={u.id}
									onClick={() =>
										run(() =>
											setPlainThreadAssigneeApi(threadId, u.id, currentUser),
										)
									}
								>
									<span className="w-4 shrink-0">
										{thread.assignee?.id === u.id ? "✓" : ""}
									</span>
									{u.name}
								</Menu.Item>
							))
						)}
						{thread.assignee && (
							<>
								<Menu.Separator />
								<Menu.Item
									onClick={() =>
										run(() =>
											setPlainThreadAssigneeApi(threadId, null, currentUser),
										)
									}
								>
									<span className="w-4 shrink-0" />
									Unassign
								</Menu.Item>
							</>
						)}
					</Menu.Popup>
				</Menu.Root>
				{(labelTypes?.length || 0) > 0 && (
					<Menu.Root>
						<Menu.Trigger
							className={actionPill}
							disabled={busy}
							title="Labels on this thread in Plain"
						>
							{(thread.labels?.length || 0) > 0
								? `${thread.labels![0].name}${
										thread.labels!.length > 1
											? ` +${thread.labels!.length - 1}`
											: ""
									}`
								: "Labels"}{" "}
							▾
						</Menu.Trigger>
						<Menu.Popup align="start">
							{labelTypes!.map((lt) => {
								const existing = (thread.labels || []).find(
									(l) => l.labelTypeId === lt.id,
								);
								return (
									<Menu.CheckboxItem
										key={lt.id}
										checked={!!existing}
										closeOnClick={false}
										onClick={() =>
											run(() =>
												changePlainThreadLabelsApi(
													threadId,
													existing
														? { removeLabelIds: [existing.id] }
														: { addLabelTypeIds: [lt.id] },
													currentUser,
												),
											)
										}
									>
										<span className="w-4 shrink-0">
											{existing ? "✓" : ""}
										</span>
										{lt.name}
									</Menu.CheckboxItem>
								);
							})}
						</Menu.Popup>
					</Menu.Root>
				)}
				<button
					type="button"
					className={actionPill}
					disabled={busy}
					onClick={() => {
						const next = window.prompt(
							"Rename this thread in Plain:",
							thread.title || "",
						);
						const t = next?.trim();
						if (t && t !== thread.title)
							run(() => setPlainThreadTitleApi(threadId, t, currentUser));
					}}
					title="Rename this thread in Plain"
				>
					Rename
				</button>
				<button
					type="button"
					className={cn(
						actionPill,
						!isSpam && "hover:text-red hover:border-red",
					)}
					disabled={busy}
					onClick={() => {
						if (
							isSpam ||
							window.confirm(
								`Mark ${customerLabel} as spam?\n\nPlain filters all their threads and this one is closed right away. Reversible via “Not spam”.`,
							)
						)
							run(() =>
								setPlainThreadSpamApi(threadId, !isSpam, currentUser),
							);
					}}
					title={
						isSpam
							? "This customer is marked as spam in Plain — click to undo"
							: "Mark this customer as spam in Plain (also closes the thread)"
					}
				>
					{isSpam ? "Not spam" : "Spam"}
				</button>
			</div>
			{error && (
				<span className="text-red text-label truncate" title={error}>
					{error}
				</span>
			)}
		</div>
	);
}

/**
 * Human reply box for a Plain thread — a customer-facing reply (sent via
 * Plain as the Michael machine user) or an internal note for the team.
 * Shared by the session viewer's Plain tab and the Support ticket preview.
 * ⌘/Ctrl+Enter sends; the draft persists per thread.
 */
export function PlainReplyBox({
	threadId,
	customerName,
	onSent,
	className,
}: {
	threadId: string;
	customerName: string | null;
	/** Called after a successful send, so the owner can refresh the timeline. */
	onSent?: () => void;
	className?: string;
}) {
	const draftKey = `plain-reply:${threadId}`;
	const [text, setText] = useState(() => loadDraft(draftKey).text);
	useEffect(() => {
		saveDraft(draftKey, { text });
	}, [draftKey, text]);
	const [kind, setKind] = useState<"reply" | "note">("reply");
	const [sending, setSending] = useState(false);
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(sentTimer.current), []);
	const currentUser = useCurrentUser();

	async function handleSend() {
		const t = text.trim();
		if (!t || sending) return;
		setSending(true);
		setError(null);
		try {
			await sendPlainReplyApi(threadId, t, kind, currentUser);
			setText("");
			clearDraft(draftKey);
			setSent(true);
			clearTimeout(sentTimer.current);
			sentTimer.current = setTimeout(() => setSent(false), 3000);
			onSent?.();
		} catch (e: any) {
			setError(e?.message || "Failed to send");
		} finally {
			setSending(false);
		}
	}

	return (
		<div className={cn("shrink-0 p-2.5 flex flex-col gap-1.5", className)}>
			<div className="flex items-center gap-1.5">
				{(["reply", "note"] as const).map((k) => (
					<button
						key={k}
						type="button"
						className={cn(
							"cursor-pointer rounded-full border px-2 py-0.5 text-meta font-semibold",
							kind === k
								? "bg-active text-fg border-line-strong"
								: "bg-transparent text-faint border-line hover:text-dim",
						)}
						onClick={() => setKind(k)}
					>
						{k === "reply" ? "Reply" : "Internal note"}
					</button>
				))}
				{sent && (
					<span className="text-meta font-semibold text-green">Sent ✓</span>
				)}
			</div>
			<textarea
				className="plain-reply-textarea w-full min-h-[128px] resize-y rounded-md border border-line bg-surface p-2 text-control-label leading-normal text-fg placeholder:text-faint focus:border-line-strong focus:outline-none"
				placeholder={
					kind === "note"
						? "Internal note for the team (English)…"
						: `Reply to ${customerName || "the customer"} — sent via Plain…`
				}
				value={text}
				disabled={sending}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.preventDefault();
						handleSend();
					}
				}}
			/>
			<div className="flex items-center gap-2 min-w-0">
				{error ? (
					<span className="text-red text-label truncate" title={error}>
						{error}
					</span>
				) : (
					<span className="truncate text-meta text-faint">
						{kind === "note"
							? `Posted as ${currentUser} (via ${PRODUCT_NAME})`
							: `Sends via Plain, signed “${currentUser.split(/\s+/)[0]}”`}
					</span>
				)}
				<button
					type="button"
					className="ml-auto shrink-0 rounded-md bg-accent text-white text-supporting font-semibold px-2.5 py-1 cursor-pointer border-0 hover:opacity-90 disabled:opacity-50 disabled:cursor-default"
					onClick={handleSend}
					disabled={sending || !text.trim()}
					title="Send (⌘↵)"
				>
					{sending
						? "Sending…"
						: kind === "note"
							? "Add note"
							: "Send reply"}
				</button>
			</div>
		</div>
	);
}

/** "3d 4h" / "2h 15m" / "8m" — coarse enough to read at a glance. */
function waitDuration(since: string): string {
	const ms = Date.now() - new Date(since).getTime();
	if (!Number.isFinite(ms) || ms < 0) return "";
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * "Customer waiting 2d 4h" — the signal Plain gives a whole banner to and we
 * previously dropped. Uses Plain's own inbound/outbound tracking, so the
 * autoresponder never counts as an answer.
 */
export function PlainWaitingBanner({
	thread,
	className,
}: {
	thread: PlainThread;
	className?: string;
}) {
	if (!thread.waitingSince || thread.status === "DONE") return null;
	const waited = waitDuration(thread.waitingSince);
	if (!waited) return null;
	const who = thread.customer?.name || thread.customer?.email || "Customer";
	return (
		<div
			className={cn(
				"flex items-center gap-2 rounded-md border border-yellow/40 bg-yellow/10 px-2.5 py-1.5 text-supporting text-fg",
				className,
			)}
		>
			<span aria-hidden>⏳</span>
			<span className="min-w-0 truncate">
				{thread.awaitingFirstResponse ? (
					<>
						<strong className="font-semibold">{who}</strong> is waiting
						for a first response
					</>
				) : (
					<>
						<strong className="font-semibold">{who}</strong> is waiting
						for a reply
					</>
				)}
				<span className="text-dim"> · {waited}</span>
			</span>
		</div>
	);
}

/** Human-readable file size for an attachment chip. */
function fileSize(bytes: number): string {
	if (!bytes) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A message's attachments. Images render inline — on a visual bug report the
 * screenshot usually *is* the report — and click through to the full-size file.
 * Everything else gets a download chip.
 */
function PlainAttachments({
	attachments,
}: {
	attachments: PlainEntryAttachment[];
}) {
	const [failed, setFailed] = useState<Record<string, boolean>>({});
	return (
		<div className="flex flex-wrap gap-2 mt-2">
			{attachments.map((a) => {
				const href = `${API_BASE}/plain/attachments/${encodeURIComponent(a.id)}`;
				const isImage = a.mimeType.startsWith("image/") && !failed[a.id];
				return (
					<a
						key={a.id}
						href={href}
						target="_blank"
						rel="noreferrer"
						title={`${a.fileName}${a.sizeBytes ? ` — ${fileSize(a.sizeBytes)}` : ""}`}
						className={cn(
							"block rounded-md border border-line overflow-hidden hover:border-line-strong",
							!isImage && "px-2 py-1 text-label text-dim hover:text-fg",
						)}
					>
						{isImage ? (
							<img
								src={href}
								alt={a.fileName}
								loading="lazy"
								onError={() =>
									setFailed((f) => ({ ...f, [a.id]: true }))
								}
								className="block max-h-[220px] max-w-full object-contain bg-surface"
							/>
						) : (
							<>
								📎 {a.fileName}
								{a.sizeBytes ? (
									<span className="text-faint">
										{" "}
										· {fileSize(a.sizeBytes)}
									</span>
								) : null}
							</>
						)}
					</a>
				);
			})}
		</div>
	);
}

/**
 * Notes posted from here carry an author prefix (see the reply route) because
 * Plain's API can't attribute a write to a workspace user — everything lands
 * as our machine user. Unpick that so a teammate's note shows *their* name,
 * and so anything else from the machine user is honestly labelled as the
 * agent rather than passing for a human.
 */
const NOTE_VIA_PREFIX = /^\*\*(.+?) \(via [^)]+\):\*\*\s*/;

function noteAuthor(entry: PlainTimelineEntry): {
	name: string;
	isAgent: boolean;
	text: string;
} {
	const viaUs = entry.text.match(NOTE_VIA_PREFIX);
	if (viaUs)
		return {
			name: viaUs[1],
			isAgent: false,
			text: entry.text.slice(viaUs[0].length),
		};
	if (entry.actorType === "bot") {
		// Agents open their notes with their own name; the badge says it now.
		const selfSigned = new RegExp(
			`^${entry.actorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`,
		);
		return {
			name: entry.actorName,
			isAgent: true,
			text: entry.text.replace(selfSigned, ""),
		};
	}
	return { name: entry.actorName, isAgent: false, text: entry.text };
}

export function PlainEntryRow({
	entry,
	threadId,
}: {
	entry: PlainTimelineEntry;
	/** Enables the "open the triage session" link on agent notes. */
	threadId?: string;
}) {
	if (entry.kind === "note") {
		const author = noteAuthor(entry);
		return (
			<div className="plain-entry plain-entry-note flex max-w-full flex-col gap-1 rounded-lg border border-yellow/30 bg-yellow/10 px-3 py-2">
				<div className="plain-entry-head flex flex-wrap items-baseline gap-1.5">
					<span className="plain-kind-badge plain-kind-note rounded-sm border border-yellow/40 px-1 text-meta font-bold text-yellow">note</span>
					<span className="plain-actor text-supporting font-bold text-fg">{author.name}</span>
					{author.isAgent && (
						<span
							className="plain-kind-badge rounded-sm border border-line-strong px-1 text-meta font-bold text-faint"
							title="Written by an agent run, not a teammate"
						>
							agent
						</span>
					)}
					<span className="plain-time text-meta text-faint">{timeOf(entry.timestamp)}</span>
					{author.isAgent && threadId && (
						<a
							className="plain-open ml-auto shrink-0 whitespace-nowrap text-meta font-semibold text-accent no-underline hover:underline"
							href={`${BASE_PATH}/plain-triage/${encodeURIComponent(threadId)}`}
							target="_blank"
							rel="noreferrer"
							title="Open the triage session for this ticket"
						>
							Session ↗
						</a>
					)}
				</div>
				<div
					className="plain-note-body markdown break-words text-control-label leading-relaxed text-fg [&>:first-child]:mt-0 [&>:last-child]:mb-0"
					dangerouslySetInnerHTML={{ __html: renderMarkdown(author.text) }}
				/>
				{entry.attachments?.length ? (
					<PlainAttachments attachments={entry.attachments} />
				) : null}
			</div>
		);
	}

	const side = entry.actorType === "customer" ? "in" : "out";
	return (
		<div className={`plain-entry plain-entry-${side} flex max-w-[88%] flex-col gap-1 rounded-lg border border-line bg-panel px-3 py-2 ${side === "in" ? "self-start rounded-bl-sm" : "self-end rounded-br-sm border-accent/25 bg-accent-soft/50"}`}>
			<div className="plain-entry-head flex flex-wrap items-baseline gap-1.5">
				<span className="plain-actor text-supporting font-bold text-fg">{entry.actorName}</span>
				<span className="plain-kind-badge rounded-sm border border-line-strong px-1 text-meta font-bold text-faint">{entry.kind}</span>
				<span className="plain-time text-meta text-faint">{timeOf(entry.timestamp)}</span>
			</div>
			{entry.subject && <div className="plain-subject text-supporting font-semibold text-fg">{entry.subject}</div>}
			{entry.text && <div className="plain-entry-text break-words whitespace-pre-wrap text-control-label leading-relaxed text-fg">{entry.text}</div>}
			{entry.attachments?.length ? (
				<PlainAttachments attachments={entry.attachments} />
			) : null}
		</div>
	);
}

export default PlainThreadPanel;
