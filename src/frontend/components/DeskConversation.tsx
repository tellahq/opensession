import React, { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../lib/types";
import { useWebSocket } from "../hooks/useWebSocket";
import { getCurrentUser } from "./UserPicker";
import { renderMarkdown } from "../lib/markdown";
import { fetchFileMentions } from "../lib/api";
import { TranscriptBlocks } from "./TranscriptBlocks";
import { MARKDOWN_STYLES } from "./MarkdownBody";
import { useFileMentions } from "./useFileMentions";
import { IconArrowUp } from "./icons";
import { mergeTranscriptEntries } from "../lib/transcript-state";

interface DeskConversationProps {
	sessionId: string;
	emptyState?: React.ReactNode;
	placeholder?: string;
	effort?: string;
	hideBefore?: string;
}

/**
 * Compact conversation view for the standing Desk session. It owns a separate
 * socket because the app-wide socket may already be watching a regular session.
 */
export function DeskConversation({
	sessionId,
	emptyState,
	placeholder,
	effort,
	hideBefore,
}: DeskConversationProps) {
	const { connected, send, addHandler } = useWebSocket();
	const [entries, setEntries] = useState<TranscriptEntry[]>([]);
	const [streamText, setStreamText] = useState("");
	const [isRunning, setIsRunning] = useState(false);
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState<string | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	// Stick to the live edge only while the reader is already there, so a
	// streaming reply doesn't yank them up from scrollback.
	const followRef = useRef(true);
	const streamSeqRef = useRef(0);

	// "@"-mentions: files (this session's repo), other sessions, teammates —
	// same suggestions endpoint as the main composer.
	const mentions = useFileMentions({
		value: draft,
		onChange: setDraft,
		textareaRef,
		mentionFetch: (q) => fetchFileMentions(q, sessionId),
	});

	// Watch the Desk only and tear the socket down on unmount / id change.
	useEffect(() => {
		if (!connected) return;
		setEntries([]);
		setStreamText("");
		setPending(null);
		followRef.current = true;
		// supportsSeq: transcript v2 capability (docs/transcripts.md).
		// This view merges by entry id and never uses offset/rev cursors or
		// history paging, so seq-mode frames need no extra state here; old
		// servers ignore the field entirely.
		send({
			type: "watch",
			sessionId,
			user: getCurrentUser(),
			supportsSeq: true,
			supportsChangeSeq: true,
		});

		const unsubscribe = addHandler((msg) => {
			if ("sessionId" in msg && msg.sessionId && msg.sessionId !== sessionId)
				return;
			switch (msg.type) {
				case "transcript_init":
					setEntries(msg.entries);
					break;
				case "transcript_history":
					setEntries((prev) =>
						mergeTranscriptEntries(prev, msg.entries, msg.v2 === true),
					);
					break;
				case "transcript_append": {
					setEntries((prev) =>
						mergeTranscriptEntries(prev, msg.entries, msg.v2 === true),
					);
					if (msg.entries.some((e) => e.type === "user")) setPending(null);
					const landed = msg.entries.filter(
						(e) => e.type === "assistant" && e.content,
					);
					if (landed.length) {
						setStreamText((prev) => {
							let next = prev;
							for (const e of landed) next = next.replace(e.content, "");
							return next.trim() ? next : "";
						});
					}
					break;
				}
				case "session_status":
					setIsRunning(msg.isRunning);
					break;
				case "stream_start":
					streamSeqRef.current++;
					setIsRunning(true);
					setStreamText("");
					setPending(null);
					break;
				case "stream_text":
					setStreamText((prev) => prev + msg.text);
					break;
				case "stream_tool_use":
				case "stream_tool_result":
					setEntries((prev) => mergeTranscriptEntries(prev, [msg.entry]));
					break;
				case "stream_done": {
					const seq = streamSeqRef.current;
					window.setTimeout(() => {
						if (streamSeqRef.current === seq) setStreamText("");
					}, 5000);
					break;
				}
				// A slash-command reply / server heads-up. Weave it in as a system
				// line so it reads inline with the conversation (mirrors SessionViewer).
				case "notice":
					setEntries((prev) => [
						...prev,
						{
							id: crypto.randomUUID(),
							type: "system",
							content: msg.message,
							timestamp: new Date().toISOString(),
						},
					]);
					break;
				// A failed/aborted run. Without this the panel just stops silently —
				// surface the error where the reply would have been and clear any
				// streaming/sending state so nothing sticks (mirrors SessionViewer).
				case "error":
					streamSeqRef.current++;
					setIsRunning(false);
					setStreamText("");
					setPending(null);
					if (msg.message) {
						setEntries((prev) => [
							...prev,
							{
								id: crypto.randomUUID(),
								type: "system",
								content: `⚠ Run failed: ${msg.message}`,
								timestamp: new Date().toISOString(),
							},
						]);
					}
					break;
			}
		});

		return () => {
			unsubscribe();
			send({ type: "unwatch", sessionId });
		};
	}, [connected, sessionId, send, addHandler]);

	// Keep a following reader pinned to the live edge as content lands.
	useEffect(() => {
		const el = bodyRef.current;
		if (el && followRef.current) el.scrollTop = el.scrollHeight;
	}, [entries, streamText, pending]);

	function onScroll() {
		const el = bodyRef.current;
		if (!el) return;
		followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	}

	function handleSend() {
		const content = draft.trim();
		if (!content || !connected) return;
		// Slash commands (/model, /loop, /goal, …) are handled by the main
		// session's command system, which this compact composer deliberately
		// doesn't wire up. Sent as a plain prompt they produce no turn, so the
		// optimistic "sending…" bubble below would never reconcile and stick
		// forever. Surface an inline hint instead — the input isn't silently
		// eaten, and no bubble is left dangling.
		if (content.startsWith("/")) {
			setEntries((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					type: "system",
					content:
						"Slash commands aren't supported in the Desk — run them from a session.",
					timestamp: new Date().toISOString(),
				},
			]);
			setDraft("");
			return;
		}
		send({
			type: "prompt",
			sessionId,
			content,
			user: getCurrentUser(),
			effort: effort || "high",
		});
		setPending(content);
		setDraft("");
		followRef.current = true;
	}

	// The Desk's "Clear" marker: everything at/before it stays out of this view
	// (locally-minted system lines have fresh timestamps and survive).
	const visibleEntries = hideBefore
		? entries.filter((e) => !e.timestamp || e.timestamp > hideBefore)
		: entries;
	const hasContent = visibleEntries.length > 0 || !!streamText || !!pending;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
				ref={bodyRef}
				onScroll={onScroll}
			>
				{!hasContent ? (
					<div className="mx-auto mt-6 max-w-[320px] text-center text-control-label font-medium leading-relaxed text-dim">
						{emptyState ?? "Ask your Desk anything."}
					</div>
				) : (
					<>
						<TranscriptBlocks entries={visibleEntries} live={isRunning} />
						{streamText && (
							<div className="msg msg-assistant msg-streaming mb-[18px] flex w-full max-w-[var(--chat-col)] flex-col [overflow-anchor:none]">
								<div
									className={`msg-body msg-body-assistant markdown ${MARKDOWN_STYLES} flex flex-col items-stretch text-body leading-6 break-words text-fg [overflow-anchor:none] [&::after]:ml-[3px] [&::after]:inline-block [&::after]:h-[14px] [&::after]:w-[7px] [&::after]:rounded-xs [&::after]:bg-accent [&::after]:align-[-2px] [&::after]:content-[''] [&::after]:animate-pulse`}
									dangerouslySetInnerHTML={{ __html: renderMarkdown(streamText) }}
								/>
							</div>
						)}
						{/* Optimistic echo of the just-sent message — rendered as a normal
						    sent bubble (not the dimmed "sending" look) so it reads as
						    delivered the instant Enter lands; reconciles away when the
						    real user entry arrives. */}
						{pending && (
							<div className="msg msg-user mb-[18px] mt-1 flex w-full max-w-[var(--chat-col)] flex-col">
								<div className="msg-body msg-body-user inline-block max-w-[min(600px,90%)] self-end rounded-panel bg-panel px-3.5 py-2.5 text-body leading-6 text-fg">{pending}</div>
							</div>
						)}
					</>
				)}
			</div>

			<div
				className="flex items-end gap-2 border-t border-line px-3 py-2"
				ref={mentions.inputWrapRef}
			>
				{mentions.popup}
				<textarea
					ref={textareaRef}
					className="max-h-40 min-h-[36px] flex-1 resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-control-label font-medium text-fg outline-none placeholder:text-dim focus:border-fg/30 focus-ring"
					rows={1}
					value={draft}
					placeholder={
						connected ? placeholder || "Ask your Desk…" : "Not connected"
					}
					disabled={!connected}
					onChange={(e) => setDraft(e.target.value)}
					onKeyUp={mentions.sync}
					onClick={mentions.sync}
					onBlur={() => setTimeout(mentions.close, 120)}
					onKeyDown={(e) => {
						if (mentions.handleKeyDown(e)) return;
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							handleSend();
						}
					}}
				/>
				<button
					className="flex shrink-0 items-center justify-center rounded-md bg-fg p-1.5 text-panel transition-transform active:scale-[0.96] disabled:opacity-40 focus-ring"
					onClick={handleSend}
					disabled={!connected || !draft.trim()}
					aria-label="Send"
				>
					<IconArrowUp size={20} />
				</button>
			</div>
		</div>
	);
}
