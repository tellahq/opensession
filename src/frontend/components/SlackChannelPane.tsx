import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { IconArrowUp } from "./icons";

interface MessageReaction {
	name: string;
	count: number;
	/** Unicode char for standard emoji. */
	emoji?: string;
	/** Image URL for custom workspace emoji. */
	url?: string;
}

interface ChannelMessage {
	ts: string;
	userName: string;
	avatarUrl?: string;
	text: string;
	isBot: boolean;
	replyCount?: number;
	reactions?: MessageReaction[];
}

/** Markdown-lite renderer for slack text the route emits: ![:name:](url)
 *  custom-emoji images, [label](url) links, [[@Name]]/[[#chan]] mention
 *  chips, bare URLs — everything else as selectable text. */
function MessageText({ text }: { text: string }) {
	const parts: React.ReactNode[] = [];
	const re =
		/!\[([^\]]*)\]\((https?:[^)\s]+)\)|\[([^\]]+)\]\((https?:[^)\s]+)\)|\[\[([@#][^\]]+)\]\]|(https?:\/\/[^\s<>]+[^\s<>.,)\]}])/g;
	let last = 0;
	let m: RegExpExecArray | null;
	let key = 0;
	while ((m = re.exec(text))) {
		if (m.index > last) parts.push(text.slice(last, m.index));
		if (m[2] !== undefined) {
			// Custom emoji image, sized to ride inline with the text.
			parts.push(
				<img
					key={key++}
					src={m[2]}
					alt={m[1]}
					title={m[1]}
					className="inline-block h-[18px] w-[18px] align-text-bottom"
				/>,
			);
		} else if (m[5] !== undefined) {
			parts.push(
				<span
					key={key++}
					className="rounded-sm bg-accent-soft px-1 font-medium text-accent"
				>
					{m[5]}
				</span>,
			);
		} else {
			const href = m[4] || m[6];
			const label = m[3] || m[6];
			parts.push(
				<a
					key={key++}
					href={href}
					target="_blank"
					rel="noreferrer"
					className="text-accent underline decoration-line underline-offset-2 hover:decoration-current"
				>
					{label}
				</a>,
			);
		}
		last = m.index + m[0].length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return (
		<div className="select-text whitespace-pre-wrap break-words text-body leading-snug text-fg">
			{parts}
		</div>
	);
}

function ReactionPills({ reactions }: { reactions?: MessageReaction[] }) {
	if (!reactions?.length) return null;
	return (
		<div className="mt-1 flex flex-wrap gap-1">
			{reactions.map((r) => (
				<span
					key={r.name}
					title={`:${r.name}:`}
					className="inline-flex items-center gap-1 rounded-full border border-line bg-panel px-1.5 py-0.5 text-meta leading-none text-dim"
				>
					{r.url ? (
						<img src={r.url} alt={r.name} className="h-[14px] w-[14px]" />
					) : (
						<span className="text-control-label">{r.emoji || `:${r.name}:`}</span>
					)}
					<span className="font-medium">{r.count}</span>
				</span>
			))}
		</div>
	);
}

function MessageRow({
	m,
	channelId,
	depth = 0,
}: {
	m: ChannelMessage;
	channelId: string;
	depth?: number;
}) {
	const [replies, setReplies] = useState<ChannelMessage[] | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [loadingReplies, setLoadingReplies] = useState(false);

	async function toggleThread() {
		if (expanded) return setExpanded(false);
		setExpanded(true);
		if (replies !== null || loadingReplies) return;
		setLoadingReplies(true);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages?thread_ts=${encodeURIComponent(m.ts)}&limit=50`,
			);
			const body = await res.json();
			if (res.ok) setReplies(body.messages || []);
		} catch {
		} finally {
			setLoadingReplies(false);
		}
	}

	const timeOf = (ts: string) => {
		const d = new Date(Number(ts) * 1000);
		const today = new Date().toDateString() === d.toDateString();
		return today
			? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			: d.toLocaleDateString([], { month: "short", day: "numeric" }) +
					" " +
					d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	};

	return (
		<div className={`mb-3 flex gap-2.5 ${depth ? "mt-2 mb-0" : ""}`}>
			{m.avatarUrl ? (
				<img
					src={m.avatarUrl}
					alt=""
					className="mt-0.5 h-7 w-7 flex-shrink-0 rounded-md"
				/>
			) : (
				<span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-active text-label font-semibold text-dim">
					{m.userName.charAt(0).toUpperCase()}
				</span>
			)}
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<span className="select-text text-body font-semibold text-fg">
						{m.userName}
					</span>
					<span className="text-meta text-faint">{timeOf(m.ts)}</span>
				</div>
				<MessageText text={m.text} />
				<ReactionPills reactions={m.reactions} />
				{depth === 0 && (m.replyCount || 0) > 0 && (
					<button
						className="mt-1 text-meta font-medium text-accent hover:underline"
						onClick={toggleThread}
					>
						{expanded
							? "Hide thread"
							: `${m.replyCount} repl${m.replyCount === 1 ? "y" : "ies"}`}
					</button>
				)}
				{expanded && (
					<div className="mt-1 border-l-2 border-line pl-3">
						{loadingReplies ? (
							<div className="py-1 text-label text-faint">Loading thread…</div>
						) : (
							(replies || []).map((r) => (
								<MessageRow
									key={r.ts}
									m={r}
									channelId={channelId}
									depth={1}
								/>
							))
						)}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * The Conversation pane for slack-channel feed workspaces (the Plain-thread
 * sibling): centred timeline, newest page first with "Load earlier"
 * pagination, 20s poll, inline expandable threads, linkified slack markup,
 * and a session-composer-styled box that posts AS THE SIGNED-IN USER via
 * their Slack grant (routes/slack-channels.ts).
 */
export function SlackChannelPane({
	channelId,
	className,
}: {
	channelId: string;
	className?: string;
}) {
	const [messages, setMessages] = useState<ChannelMessage[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [asUser, setAsUser] = useState(true);
	const [loading, setLoading] = useState(true);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const aliveRef = useRef(true);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const stickBottomRef = useRef(true);
	const lastMarkedRef = useRef("");

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	const loadNewest = useCallback(async () => {
		try {
			const res = await fetch(
				`${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages`,
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			if (!aliveRef.current) return;
			setAsUser(!!body.asUser);
			setHasMore((prev) => prev || !!body.hasMore);
			setMessages((prev) => {
				const incoming: ChannelMessage[] = body.messages || [];
				if (!prev.length) return incoming;
				const oldestIncoming = incoming[0]?.ts;
				const olders = prev.filter(
					(m) => oldestIncoming && m.ts < oldestIncoming,
				);
				return [...olders, ...incoming];
			});
			setError(null);
			// Viewing marks the channel read (as the signed-in user) so the
			// sidebar unread dot clears — same behavior as Slack itself.
			const newest = (body.messages || []).at(-1)?.ts;
			if (body.asUser && newest && newest !== lastMarkedRef.current) {
				lastMarkedRef.current = newest;
				void fetch(
					`${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/read`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ ts: newest }),
					},
				).catch(() => {});
			}
		} catch (e: any) {
			if (aliveRef.current) setError(e.message);
		} finally {
			if (aliveRef.current) setLoading(false);
		}
	}, [channelId]);

	useEffect(() => {
		setMessages([]);
		setLoading(true);
		void loadNewest();
		const t = setInterval(loadNewest, 20_000);
		return () => clearInterval(t);
	}, [loadNewest]);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight;
	}, [messages]);

	async function loadOlder() {
		if (!messages.length || loadingOlder) return;
		setLoadingOlder(true);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages?before=${encodeURIComponent(messages[0].ts)}`,
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			const el = scrollRef.current;
			const prevHeight = el?.scrollHeight || 0;
			stickBottomRef.current = false;
			setMessages((prev) => [...(body.messages || []), ...prev]);
			setHasMore(!!body.hasMore);
			requestAnimationFrame(() => {
				if (el) el.scrollTop = el.scrollHeight - prevHeight;
			});
		} catch (e: any) {
			setError(e.message);
		} finally {
			setLoadingOlder(false);
		}
	}

	async function send() {
		const text = draft.trim();
		if (!text || sending) return;
		setSending(true);
		setError(null);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/slack/channels/${encodeURIComponent(channelId)}/messages`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setDraft("");
			stickBottomRef.current = true;
			void loadNewest();
		} catch (e: any) {
			setError(e.message);
		} finally {
			setSending(false);
		}
	}

	return (
		<div className={`flex h-full min-h-0 flex-col ${className || ""}`}>
			<div
				ref={scrollRef}
				className="min-h-0 flex-1 overflow-y-auto"
				onScroll={(e) => {
					const el = e.currentTarget;
					stickBottomRef.current =
						el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				<div className="mx-auto w-full max-w-[760px] px-5 py-4">
					{hasMore && (
						<div className="mb-3 flex justify-center">
							<Button
								size="sm"
								onClick={loadOlder}
								disabled={loadingOlder}
							>
								{loadingOlder ? "Loading…" : "Load earlier messages"}
							</Button>
						</div>
					)}
					{loading ? (
						<div className="py-8 text-center text-control-label text-faint">
							Loading channel…
						</div>
					) : messages.length === 0 ? (
						<div className="py-8 text-center text-control-label text-faint">
							No recent messages.
						</div>
					) : (
						messages.map((m) => (
							<MessageRow key={m.ts} m={m} channelId={channelId} />
						))
					)}
				</div>
			</div>
			{error && (
				<div className="mx-auto w-full max-w-[760px] px-5 py-2 text-label text-red">
					{error}
				</div>
			)}
			{/* Same visual family as the sessions Composer (.composer classes from
			    foundation adapter) — rounded card, borderless textarea, circular accent
			    send — sized down for a chat channel. */}
			<div className="composer-wrap shrink-0 px-5 pb-4 pt-1">
				<div className={`composer ${!asUser ? "composer-disabled" : ""}`}>
					<textarea
						className="composer-textarea"
						style={{ minHeight: 48 }}
						placeholder={
							asUser
								? "Message the channel as yourself…"
								: "Connect Slack in Settings → My accounts to post as yourself"
						}
						value={draft}
						disabled={!asUser || sending}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void send();
							}
						}}
						rows={1}
					/>
					<div className="composer-toolbar">
						<div className="composer-spacer" />
						<button
							className="composer-send"
							onClick={send}
							disabled={!asUser || !draft.trim() || sending}
							aria-label="Send message"
						>
							<IconArrowUp size={24} />
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
