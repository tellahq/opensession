import React, { useMemo, useState } from "react";
import type { TranscriptEntry } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { MarkdownBody } from "./MarkdownBody";
import {
	parseHumanReply,
	parseAttribution,
	isGitHubAttribution,
	parseRecoveryNotice,
	parseReviewHandoff,
	parseSessionNotice,
	parseWorkerReport,
	parseWorkflowNotice,
} from "../lib/humanReply";
import { useCurrentUser } from "./UserPicker";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { BASE_PATH } from "../lib/base";
import { resolveEntryImageSrc } from "../lib/osBlob";
import { fullTime, shortTime } from "../lib/time";
import { IconChevronDown } from "./icons";
import { noticeTone, stripNoticeGlyph } from "../lib/notice-tone";
import { cn } from "../ui/cn";

// Only this much of a message is markdown-parsed eagerly. marked is
// superlinear on input size (~25ms at 10KB, ~400ms at 80KB, seconds past
// 200KB), and a transcript can hold dozens of giant machine-written entries
// (automation prompts embedding a full PR diff) — parsing them all on open is
// what made "Loading transcript…" hang for minutes on such sessions. Longer
// contents render their head plus a "Show full message" expander.
const EAGER_MD_CHARS = 6000;
// Expanded content still renders as markdown up to this size; past it the
// content is machine payload, not prose — a plain <pre> shows it instantly.
const FULL_MD_CHARS = 32 * 1024;

function sizeLabel(chars: number): string {
	return chars >= 1024 ? `${Math.round(chars / 1024)} KB` : `${chars} chars`;
}

/**
 * Message body that clamps how much markdown is parsed eagerly. Contents the
 * server clamped for the wire (entry.contentClamped) fetch the full entry on
 * expand; locally-long contents just reveal in place.
 */
export function ClampedBody({
	content,
	className,
	entry,
	sessionId,
}: {
	content: string;
	className: string;
	entry?: TranscriptEntry;
	sessionId?: string;
}) {
	const bubbleStyles = className.includes("msg-body-user")
		? "inline-block max-w-[min(600px,90%)] self-end rounded-panel bg-panel px-3.5 py-2.5 text-fg"
		: className.includes("msg-body-human")
			? "inline-block max-w-[min(600px,90%)] self-end rounded-lg bg-[rgb(31_158_138_/_0.12)] px-3.5 py-[9px] text-fg"
			: "text-fg";
	const wireClamped = !!entry?.contentClamped;
	const fullLength = entry?.contentLength ?? content.length;
	const isLong = wireClamped || content.length > EAGER_MD_CHARS;
	const [showAll, setShowAll] = useState(false);
	const [fetched, setFetched] = useState<string | null>(null);
	const [fetching, setFetching] = useState(false);

	// Cut the eager head at a line boundary so we don't render half a line of
	// a diff/log as its own paragraph.
	const head = useMemo(() => {
		if (!isLong || showAll) return content;
		const slice = content.slice(0, EAGER_MD_CHARS);
		const nl = slice.lastIndexOf("\n");
		return nl > EAGER_MD_CHARS / 2 ? slice.slice(0, nl) : slice;
	}, [content, isLong, showAll]);

	const shown = showAll ? (fetched ?? content) : head;
	// Giant expanded payloads skip markdown entirely — see FULL_MD_CHARS.
	const asMarkdown = shown.length <= FULL_MD_CHARS;
	const html = useMemo(
		() => (asMarkdown ? renderMarkdown(shown) : ""),
		[asMarkdown, shown],
	);

	const expand = async () => {
		if (wireClamped && !fetched && entry && sessionId) {
			setFetching(true);
			try {
				const res = await fetch(
					`${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(entry.id)}`,
				);
				if (res.ok) {
					const data = await res.json();
					if (typeof data?.content === "string") setFetched(data.content);
				}
			} catch {
				// keep the wire-clamped text — the tail just stays truncated
			} finally {
				setFetching(false);
			}
		}
		setShowAll(true);
	};

	return (
		<>
			{asMarkdown ? (
				<MarkdownBody className={`flex flex-col items-stretch text-body leading-6 break-words ${bubbleStyles} ${className}`} html={html || ""} />
			) : (
				// A <pre> only for the preserved whitespace: this branch renders a
				// message too long for the markdown pass, which is prose, not code.
				// `font-sans` is load-bearing — the app ships no Tailwind Preflight,
				// so the UA's `pre { font-family: monospace }` applies otherwise.
				<pre
					className={
						"my-1 max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-3 font-sans text-label leading-relaxed text-fg"
					}
				>
					{shown}
				</pre>
			)}
			{isLong && (
				<Button
					variant="ghost"
					size="xs"
					onClick={showAll ? () => setShowAll(false) : expand}
					className="mt-1 min-h-0 justify-start whitespace-normal rounded-md border-0 px-2 py-1 text-left font-sans text-label font-medium hover:bg-hover/40"
				>
					{fetching
						? "Loading…"
						: showAll
							? "Collapse"
							: `Show full message · ${sizeLabel(fullLength)}`}
				</Button>
			)}
		</>
	);
}

/** Centered system pill whose full markdown body stays out of the transcript
 * until requested. Used for informational machine-authored messages. */
function CollapsibleSystemNotice({
	entry,
	sessionId,
	label,
	toggleNoun,
	content,
}: {
	entry: TranscriptEntry;
	sessionId?: string;
	label: string;
	toggleNoun: string;
	content: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="msg msg-system mb-3 flex w-full max-w-[var(--chat-col)] flex-col text-center" data-eid={entry.id}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="msg-system-text inline-block max-w-[min(560px,100%)] self-center rounded-lg bg-panel px-3.5 py-1.5 text-center text-supporting leading-[1.45] text-faint cursor-pointer [font-family:inherit]"
			>
				{label} ·{" "}
				<span className="font-medium text-dim">
					{open ? `hide ${toggleNoun}` : `show ${toggleNoun}`}
				</span>
			</button>
			{open && (
				<div className="mx-auto mt-2 w-full max-w-[560px] rounded-lg bg-panel px-4 py-3 text-left">
					<ClampedBody
						className="msg-body markdown"
						content={content}
						entry={entry}
						sessionId={sessionId}
					/>
				</div>
			)}
		</div>
	);
}

/** Triangle-alert glyph for a toned notice; inherits the pill's colour. */
function NoticeGlyph() {
	return (
		<svg
			className="msg-system-glyph"
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
			<path d="M12 9v4" />
			<path d="M12 17h.01" />
		</svg>
	);
}

/** An operational line from the server/runner. A failed run reads as a
 *  failure — the transcript used to give a dead session and an account
 *  rotation the same faint grey pill. */
function SystemNotice({ entry }: { entry: TranscriptEntry }) {
	const tone = noticeTone(entry.content);
	return (
		<div className="msg msg-system" data-eid={entry.id}>
			<span
				className="msg-system-text"
				data-tone={tone === "info" ? undefined : tone}
				role={tone === "error" ? "alert" : undefined}
			>
				{tone !== "info" && <NoticeGlyph />}
				<span>{stripNoticeGlyph(entry.content)}</span>
			</span>
		</div>
	);
}

function CompactionNotice({
	entry,
	sessionId,
}: {
	entry: TranscriptEntry;
	sessionId?: string;
}) {
	// Without this fold, context compaction looks like the model randomly
	// dumping a status report in the middle of the conversation.
	return (
		<CollapsibleSystemNotice
			entry={entry}
			sessionId={sessionId}
			label="Context compacted — earlier conversation summarized to keep going"
			toggleNoun="summary"
			content={entry.content}
		/>
	);
}

/** Relative time in a message's label row ("5m"), hover for the real one. */
function MsgTime({ ts }: { ts?: string }) {
	if (!ts) return null;
	const label = shortTime(ts);
	if (!label) return null;
	return (
		<Tooltip label={fullTime(ts)}>
			<span className="msg-time">{label}</span>
		</Tooltip>
	);
}

/** The real time below your own bubble, faded in while the row is hovered —
 * those turns carry no label row to hang a MsgTime off, and a timestamp on
 * every one of them would just be noise while reading. Hover-capable pointers
 * only (see .msg-hover-time); on touch the row renders exactly as before. */
function BubbleHoverTime({ ts }: { ts?: string }) {
	if (!ts) return null;
	const label = fullTime(ts);
	if (!label) return null;
	return <span className="msg-hover-time hidden select-none whitespace-nowrap text-meta font-medium text-faint [@media(hover:hover)]:block [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity">{label}</span>;
}

interface Props {
	entry: TranscriptEntry;
	/**
	 * Who owns/drives this session (session.startedBy). An un-attributed user
	 * turn is this person's own words, so it's credited to them — "You" only
	 * when the current viewer IS the owner. Omitted (e.g. sub-agent panel) means
	 * fall back to "You".
	 */
	owner?: string;
	/** Lets a wire-clamped entry's "Show full message" fetch the full content. */
	sessionId?: string;
}

/** Inline images carried on an entry (Read-of-image results, pasted images).
 *  os-blob: markers (transcript-v2 bounded entries) resolve to the
 *  transcript-image route; real srcs pass through untouched. */
function EntryImages({
	images,
	sessionId,
}: {
	images?: string[];
	sessionId?: string;
}) {
	if (!images || images.length === 0) return null;
	return (
		<div className="msg-images mt-1.5 flex flex-wrap gap-2">
			{images.map((raw, i) => {
				const src = resolveEntryImageSrc(raw, sessionId);
				return (
					<a
						key={i}
						href={src}
						target="_blank"
						rel="noopener noreferrer"
						className="md-image-link"
					>
						<img className="md-image" src={src} alt="" loading="lazy" />
					</a>
				);
			})}
		</div>
	);
}

/** Inline video players for attached/staged videos (streamed via <base>/media). */
function EntryVideos({ videos }: { videos?: string[] }) {
	if (!videos || videos.length === 0) return null;
	return (
		<div className="msg-videos mt-1.5 flex flex-wrap gap-2">
			{videos.map((src, i) => (
				<div key={i} className="md-video-wrap">
					<video
						className="md-video"
						src={src}
						controls
						playsInline
						preload="metadata"
					/>
				</div>
			))}
		</div>
	);
}

/** Short uppercase extension badge for a filename (e.g. "PDF"), or "FILE". */
function extBadge(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "FILE";
	return name.slice(dot + 1, dot + 5).toUpperCase();
}

/** Non-media attachments on a user turn — download chips (served via <base>/media). */
function EntryFiles({ files }: { files?: TranscriptEntry["files"] }) {
	if (!files || files.length === 0) return null;
	return (
		<div className="msg-files mt-1.5 flex flex-wrap gap-2">
			{files.map((f, i) => (
				<a
					key={i}
					className="composer-file-card msg-file-card"
					href={`/backstage/media?path=${encodeURIComponent(f.path)}`}
					download={f.name}
					title={f.name}
				>
					<span className="composer-file-thumb">{extBadge(f.name)}</span>
					<span className="composer-file-meta">
						<span className="composer-file-name">{f.name}</span>
						<span className="composer-file-sub">Attachment</span>
					</span>
				</a>
			))}
		</div>
	);
}

// Memoized: entries keep stable references across stream events (mergeEntries
// reuses objects) and owner is stable upstream, so a tool event appended to
// the transcript re-renders only the affected blocks — not every bubble's
// markdown/highlighting.
export const MessageBubble = React.memo(function MessageBubble({
	entry,
	owner,
	sessionId,
}: Props) {
	const me = useCurrentUser();
	// A routed-back teammate reply (human-in-the-loop): credit the teammate and
	// render just their words (the header is stripped — the label carries "who").
	const humanReply = useMemo(() => {
		if (entry.type !== "user") return null;
		const parsed = parseHumanReply(entry.content);
		return parsed ? { name: parsed.name, body: parsed.body } : null;
	}, [entry.type, entry.content]);
	// A "[Name] …" attributed turn: a named teammate steered/sent into this
	// session. It's the driver, so it keeps a normal user bubble — but credited
	// to the sender (and the prefix stripped). When the sender is the viewer it
	// stays "You"; only the body changes (prefix removed).
	const attribution = useMemo(() => {
		if (entry.type !== "user" || humanReply) return null;
		return parseAttribution(entry.content);
	}, [entry.type, entry.content, humanReply]);
	const displayContent = attribution ? attribution.body : entry.content;

	// A review handoff (unsatisfied PR review's findings delivered into this
	// session) is a long instruction block, not an FYI — render it as a distinct
	// card with real markdown instead of the tiny centered msg-system pill
	// (which is right for short "🔀 merged" notices and stays for those).
	const reviewHandoff = useMemo(
		() =>
			entry.type === "user" && attribution && isGitHubAttribution(attribution.name)
				? parseReviewHandoff(attribution.body)
				: null,
		[entry.type, attribution],
	);
	// Agent-to-agent deliveries that arrive as "user" turns but are nobody's
	// instruction: a worker reporting to its parent, and the nudge a finished
	// workflow sends its launching session. Parsed off the raw content — the
	// worker attribution is too long for parseAttribution, and the workflow
	// nudge is attributed to the human who launched it, so both would otherwise
	// render as words the human appears to have typed.
	const workerReport = useMemo(
		() => (entry.type === "user" ? parseWorkerReport(entry.content) : null),
		[entry.type, entry.content],
	);
	const workflowNotice = useMemo(
		() =>
			entry.type === "user" && !workerReport
				? parseWorkflowNotice(entry.content)
				: null,
		[entry.type, entry.content, workerReport],
	);
	const sessionNotice = useMemo(
		() =>
			entry.type === "user" && !workerReport && !workflowNotice
				? parseSessionNotice(entry.content)
				: null,
		[entry.type, entry.content, workerReport, workflowNotice],
	);
	const recoveryNotice = useMemo(
		() => (entry.type === "user" ? parseRecoveryNotice(entry.content) : null),
		[entry.type, entry.content],
	);
	const [workerReportOpen, setWorkerReportOpen] = useState(false);
	const [reviewHandoffOpen, setReviewHandoffOpen] = useState(false);

	if (entry.type === "user" && recoveryNotice) {
		return (
			<CollapsibleSystemNotice
				entry={entry}
				sessionId={sessionId}
				label="Session resumed after a service restart"
				toggleNoun="details"
				content={recoveryNotice.body}
			/>
		);
	}

	if (entry.type === "user" && workerReport) {
		return (
			<div className="msg" data-eid={entry.id}>
				{/* Folded, this is one quiet line in the transcript — no surface of its
				    own, like the other collapsible notices. The panel appears only when
				    there is a report body for it to hold. */}
				<div
					className={cn(
						"overflow-hidden rounded-lg transition-colors",
						workerReportOpen ? "bg-panel" : "hover:bg-hover",
					)}
				>
					<div className="flex items-center gap-2 px-2.5 py-1.5 text-label font-medium text-dim">
						<Button
							variant="ghost"
							size="xs"
							aria-expanded={workerReportOpen}
							onClick={() => setWorkerReportOpen((open) => !open)}
							className="min-h-0 min-w-0 flex-1 justify-start gap-1.5 whitespace-normal rounded-md border-0 px-1 py-0.5 text-left font-sans text-label font-medium hover:bg-transparent"
						>
							<span
								className={cn(
									"shrink-0 text-faint transition-transform duration-150",
									!workerReportOpen && "-rotate-90",
								)}
							>
								<IconChevronDown size={16} />
							</span>
							<span>Worker report</span>
						</Button>
						<MsgTime ts={entry.timestamp} />
					</div>
					{workerReportOpen && (
						<>
							<ClampedBody
								className="msg-body markdown px-3.5 py-2.5"
								content={workerReport.body}
								entry={entry}
								sessionId={sessionId}
							/>
							{/* Part of the report, not the collapsed row: the header stays
							    title + time like every other folded notice, and the jump to
							    the worker reads as the end of what it reported. The
							    data-session-id is what the transcript's delegated click
							    handler navigates on, so it opens in place — the href is
							    there for cmd-click and copy-link. */}
							{workerReport.sessionId && (
								<div className="px-3.5 pb-2.5">
									<a
										className="text-xs text-dim no-underline hover:text-fg"
										data-session-id={workerReport.sessionId}
										href={`${BASE_PATH}/session/${workerReport.sessionId}`}
									>
										Open worker
									</a>
								</div>
							)}
						</>
					)}
				</div>
			</div>
		);
	}

	// Short and purely informational — the centered system pill, like "🔀 merged".
	if (entry.type === "user" && workflowNotice) {
		return (
			<div className="msg msg-system" data-eid={entry.id}>
				<span className="msg-system-text">{workflowNotice.body}</span>
			</div>
		);
	}

	if (entry.type === "user" && sessionNotice) {
		return (
			<CollapsibleSystemNotice
				entry={entry}
				sessionId={sessionId}
				label="Heads-up from another session"
				toggleNoun="message"
				content={sessionNotice.body}
			/>
		);
	}

	if (entry.type === "user" && reviewHandoff) {
		return (
			<div className="msg" data-eid={entry.id}>
				{/* Same folded-notice treatment as the worker report above. */}
				<div
					className={cn(
						"overflow-hidden rounded-lg transition-colors",
						reviewHandoffOpen ? "bg-panel" : "hover:bg-hover",
					)}
				>
					<div className="flex items-center gap-2 px-2.5 py-1.5 text-label font-medium text-dim">
						<Button
							variant="ghost"
							size="xs"
							aria-expanded={reviewHandoffOpen}
							onClick={() => setReviewHandoffOpen((open) => !open)}
							className="min-h-0 min-w-0 flex-1 justify-start gap-1.5 whitespace-normal rounded-md border-0 px-1 py-0.5 text-left font-sans text-label font-medium hover:bg-transparent"
						>
							<span
								className={cn(
									"shrink-0 text-faint transition-transform duration-150",
									!reviewHandoffOpen && "-rotate-90",
								)}
							>
								<IconChevronDown size={16} />
							</span>
							<span>
								🔍 Review findings
								{reviewHandoff.prNumber ? ` · PR #${reviewHandoff.prNumber}` : ""}
							</span>
						</Button>
						<MsgTime ts={entry.timestamp} />
					</div>
					{reviewHandoffOpen && (
						<ClampedBody
							className="msg-body markdown px-3.5 py-2.5"
							content={reviewHandoff.body}
							entry={entry}
							sessionId={sessionId}
						/>
					)}
				</div>
			</div>
		);
	}

	if (entry.type === "user" && attribution && isGitHubAttribution(attribution.name)) {
		return (
			<div className="msg msg-system" data-eid={entry.id}>
				<span className="msg-system-text">{displayContent}</span>
			</div>
		);
	}

	if (entry.type === "system" && entry.compaction) {
		return <CompactionNotice entry={entry} sessionId={sessionId} />;
	}

	if (entry.type === "system") {
		return <SystemNotice entry={entry} />;
	}

	if (entry.type === "user" && humanReply) {
		return (
			<div
				className="msg msg-human mb-[18px] mt-1 flex w-full max-w-[var(--chat-col)] flex-col"
				data-eid={entry.id}
			>
				<div className="msg-label msg-label-human mb-1.5 flex flex-row-reverse items-center gap-[7px] text-meta font-semibold tracking-[-0.01em] text-[#1f9e8a] before:size-[7px] before:shrink-0 before:rounded-full before:bg-[linear-gradient(135deg,#28d3b4,#0f8f7a)]">
					💬 {humanReply.name} · via Slack
					<MsgTime ts={entry.timestamp} />
				</div>
				<ClampedBody
					className="msg-body msg-body-human markdown"
					content={humanReply.body}
					entry={entry}
					sessionId={sessionId}
				/>
				<EntryImages images={entry.images} sessionId={sessionId} />
				<EntryVideos videos={entry.videos} />
				<EntryFiles files={entry.files} />
			</div>
		);
	}

	if (entry.type === "user") {
		// Who sent this turn: an explicit "[Name] " attribution (a teammate who
		// steered/sent into the session) wins; otherwise it's the session owner's
		// own words. Either way, credit the sender — "You" only when the sender is
		// the current viewer. Falls back to "You" when the owner is unknown.
		const sender = attribution ? attribution.name : owner;
		const fromOther = sender && sender !== me ? sender : null;
		// Nothing to show: an entry that strips down to just its "[Name] "
		// delivery attribution is plumbing whose body was fenced context (the
		// auto-continue nudge). Render nothing rather than a label + identity dot
		// hovering above the next message. New turns no longer take an
		// attribution at all (see isContextOnly); this also hides the ones
		// already persisted.
		if (
			!displayContent &&
			!entry.images?.length &&
			!entry.videos?.length &&
			!entry.files?.length
		) {
			return null;
		}
		// Your own settled messages skip the label entirely — the right-aligned
		// bubble already says "you". Turns sent by someone else keep the
		// attribution label.
		return (
			<div
				className={cn("msg msg-user mb-[18px] mt-1 flex w-full max-w-[var(--chat-col)] flex-col", !fromOther && "msg-user-own [@media(hover:hover)]:mb-[35px]")}
				data-eid={entry.id}
			>
				{fromOther && (
					<div className="msg-label msg-label-user mb-1.5 flex flex-row-reverse items-center gap-[7px] text-meta font-semibold tracking-[-0.01em] text-faint before:size-[7px] before:shrink-0 before:rounded-xs before:bg-[#5b7cfa] before:opacity-90">
						{fromOther}
						<MsgTime ts={entry.timestamp} />
					</div>
				)}
				{/* One stack anchors the hover time below both the bubble and attachments. */}
				<div className="msg-user-row relative flex min-w-0 flex-col [&_.msg-hover-time]:absolute [&_.msg-hover-time]:right-0 [&_.msg-hover-time]:top-[calc(100%+8px)] [&_.msg-hover-time]:leading-none hover:[&_.msg-hover-time]:opacity-100">
					{!fromOther && <BubbleHoverTime ts={entry.timestamp} />}
					{displayContent && (
						<ClampedBody
							className="msg-body msg-body-user markdown"
							content={displayContent}
							entry={entry}
							sessionId={sessionId}
						/>
					)}
					<EntryImages images={entry.images} sessionId={sessionId} />
					<EntryVideos videos={entry.videos} />
					<EntryFiles files={entry.files} />
				</div>
			</div>
		);
	}

	// assistant — no speaker label: every left-aligned bubble is the agent, so
	// the name row was pure noise above each answer.
	return (
		<div
			className="msg msg-assistant mb-[18px] flex w-full max-w-[var(--chat-col)] flex-col"
			data-eid={entry.id}
		>
			<ClampedBody
				className="msg-body msg-body-assistant markdown"
				content={displayContent}
				entry={entry}
				sessionId={sessionId}
			/>
			<EntryImages images={entry.images} sessionId={sessionId} />
			<EntryVideos videos={entry.videos} />
		</div>
	);
});
