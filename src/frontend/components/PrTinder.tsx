import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	AnimatePresence,
	motion,
	useMotionValue,
	useTransform,
	type PanInfo,
} from "motion/react";
import {
	fetchTinderDeck,
	keepTinderPr,
	unkeepTinderPr,
	closeTinderPr,
	reopenTinderPr,
	commentTinderPr,
	uncommentTinderPr,
	labelTinderPr,
	type TinderPr,
} from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { providerFromUrl } from "../lib/provider";
import { useCurrentUser } from "./UserPicker";

/**
 * PR Tinder — a swipe deck over tella-fusion's open PRs, one card at a time:
 *   swipe right / Keep  (→ or k) → remember it for 14 days, next
 *   swipe left  / Close (← or c) → close the PR, next
 *   Comment (m) → post a comment, counts as triaged, next
 *   Label   (l) → add/remove labels in place
 *   GitHub  (o) → open the PR in a new tab
 *   Back    (b) → previous card · Esc → leave
 * Every action lands on an undo stack: z (or the header ↩) reverses the most
 * recent one — un-keeps, reopens, deletes the comment, reverts the label —
 * and jumps back to that card. Not just a 7-second toast window: the whole
 * session's actions stay undoable, newest first.
 * The deck is shuffled once per session (fresh eyes on the stale middle of the
 * list) and frozen, so acting on cards never reshuffles the rest.
 */

const SWIPE_DISTANCE = 110; // px of drag past which a release commits
const SWIPE_VELOCITY = 520; // px/s flick that commits regardless of distance
const UNDO_MS = 7000;

// The label shortlist pinned to the top of the label picker — the ones triage
// actually reaches for (mirrors the CLI's LABEL_SHORTLIST).
const LABEL_SHORTLIST = ["Do Not Merge", "stale", "codex"];

type Action = "keep" | "close" | "comment";

/** One reversible deck action; `at` is the card's index, for jumping back. */
type UndoEntry =
	| { kind: "keep"; pr: TinderPr; at: number }
	| { kind: "close"; pr: TinderPr; at: number }
	| { kind: "comment"; pr: TinderPr; at: number; commentId?: number }
	| {
			kind: "label";
			pr: TinderPr;
			at: number;
			name: string;
			color: string;
			/** true = the action added the label (undo removes it). */
			added: boolean;
	  };

interface Props {
	/** Leave the deck (back / done). */
	onExit: () => void;
}

function shuffle<T>(arr: T[]): T[] {
	const out = arr.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function ageDays(ts: string): number {
	return Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000);
}

function ageLabel(ts: string): string {
	const d = ageDays(ts);
	if (d <= 0) return "today";
	return `${d}d`;
}

/** Fresh activity green, drifting yellow, stale red — the CLI's age tint. */
function ageTone(ts: string): string {
	const d = ageDays(ts);
	if (d < 3) return "text-green";
	if (d < 14) return "text-yellow";
	return "text-red";
}

/** GitHub label chip: label's own hex as bg, black/white text by luminance. */
function LabelChip({
	name,
	color,
	onRemove,
}: {
	name: string;
	color: string;
	onRemove?: () => void;
}) {
	const style = useMemo(() => {
		const hex = /^[0-9a-fA-F]{6}$/.test(color) ? color : "6e7681";
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		const lum = 0.299 * r + 0.587 * g + 0.114 * b;
		return {
			backgroundColor: `#${hex}`,
			color: lum > 140 ? "#1a1a1a" : "#fff",
		};
	}, [color]);
	return (
		<span
			className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4"
			style={style}
		>
			{name}
			{onRemove && (
				<button
					className="-mr-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-transparent opacity-70 hover:opacity-100"
					style={{ color: style.color }}
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					title={`Remove "${name}"`}
					aria-label={`Remove label ${name}`}
				>
					×
				</button>
			)}
		</span>
	);
}

function ReviewBadge({ decision }: { decision: string }) {
	if (decision === "APPROVED")
		return <span className="text-label font-semibold text-green">Approved</span>;
	if (decision === "CHANGES_REQUESTED")
		return <span className="text-label font-semibold text-red">Changes requested</span>;
	if (decision === "REVIEW_REQUIRED")
		return <span className="text-label font-semibold text-yellow">Review required</span>;
	return null;
}

export function PrTinder({ onExit }: Props) {
	const currentUser = useCurrentUser();

	// One fetch per visit; the deck is then frozen — see the header comment.
	const [deck, setDeck] = useState<{
		cards: TinderPr[];
		labels: Array<{ name: string; color: string }>;
		keptCount: number;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Set when the user opts back into their kept PRs ("Show N kept").
	const allPrs = useRef<TinderPr[]>([]);

	useEffect(() => {
		let alive = true;
		fetchTinderDeck(currentUser)
			.then((d) => {
				if (!alive) return;
				allPrs.current = d.prs;
				const seen = new Set(d.seen);
				const fresh = d.prs.filter((p) => !seen.has(p.number));
				setDeck({
					cards: shuffle(fresh),
					labels: d.labels,
					keptCount: d.prs.length - fresh.length,
				});
			})
			.catch((e) => {
				if (alive) setError(e.message || String(e));
			});
		return () => {
			alive = false;
		};
	}, [currentUser]);

	const [index, setIndex] = useState(0);
	const [dir, setDir] = useState<Action | null>(null);
	// Per-card label edits (optimistic), keyed by PR number.
	const [labelEdits, setLabelEdits] = useState<
		Record<number, Array<{ name: string; color: string }>>
	>({});
	const [panel, setPanel] = useState<"comment" | "label" | null>(null);
	const [toast, setToast] = useState<{
		text: string;
		undo?: () => void;
	} | null>(null);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [busy, setBusy] = useState(false);
	// The busy flag, readable from long-lived closures (toast undo buttons).
	const busyRef = useRef(false);
	busyRef.current = busy;
	// Undo stack, newest last. Lives in a ref so toast/keyboard closures always
	// see the current stack; the length mirror re-renders the header ↩ button.
	const historyRef = useRef<UndoEntry[]>([]);
	const [historyLen, setHistoryLen] = useState(0);
	function pushHistory(e: UndoEntry) {
		historyRef.current.push(e);
		setHistoryLen(historyRef.current.length);
	}

	const cards = deck?.cards || [];
	const card: TinderPr | undefined = cards[index];
	const done = deck !== null && index >= cards.length;
	const next = cards[index + 1];

	// A new card always starts at the top (the deck area is one normal scroll).
	const deckScrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		deckScrollRef.current?.scrollTo(0, 0);
	}, [index]);

	function showToast(text: string, undo?: () => void) {
		if (toastTimer.current) clearTimeout(toastTimer.current);
		setToast({ text, undo });
		toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
	}
	useEffect(
		() => () => {
			if (toastTimer.current) clearTimeout(toastTimer.current);
		},
		[],
	);

	function advance(action: Action) {
		setPanel(null);
		setDir(action);
		setIndex((i) => i + 1);
	}

	function keep() {
		if (!card) return;
		pushHistory({ kind: "keep", pr: card, at: index });
		keepTinderPr(card.number, currentUser).catch(() => {});
		advance("keep");
	}

	function close() {
		if (!card || busy) return;
		const closing = card;
		const at = index;
		setBusy(true);
		closeTinderPr(closing.number)
			.then(() => {
				setBusy(false);
				pushHistory({ kind: "close", pr: closing, at });
				advance("close");
				showToast(`Closed #${closing.number}`, undoLast);
			})
			.catch((e) => {
				setBusy(false);
				showToast(`Close failed: ${e.message}`);
			});
	}

	function comment(text: string) {
		if (!card || busy) return;
		const target = card;
		const at = index;
		setBusy(true);
		commentTinderPr(target.number, text, currentUser)
			.then((r) => {
				setBusy(false);
				pushHistory({ kind: "comment", pr: target, at, commentId: r.commentId });
				advance("comment");
				showToast(`Commented on #${target.number}`, undoLast);
			})
			.catch((e) => {
				setBusy(false);
				showToast(`Comment failed: ${e.message}`);
			});
	}

	function cardLabels(pr: TinderPr): Array<{ name: string; color: string }> {
		return labelEdits[pr.number] ?? pr.labels;
	}

	// Flip one label on a PR (optimistic, reverted on failure). Undo replays the
	// opposite flip via the history stack; the replay itself isn't re-recorded.
	function applyLabelToggle(
		pr: TinderPr,
		name: string,
		color: string,
		at: number,
		record = true,
	) {
		const current = labelEdits[pr.number] ?? pr.labels;
		const has = current.some((l) => l.name === name);
		setLabelEdits((prev) => ({
			...prev,
			[pr.number]: has
				? current.filter((l) => l.name !== name)
				: [...current, { name, color }],
		}));
		labelTinderPr(pr.number, has ? { remove: name } : { add: name })
			.then(() => {
				if (record)
					pushHistory({ kind: "label", pr, at, name, color, added: !has });
			})
			.catch((e) => {
				setLabelEdits((prev) => ({ ...prev, [pr.number]: current }));
				showToast(`Label change failed: ${e.message}`);
			});
	}

	function toggleLabel(name: string, color: string) {
		if (card) applyLabelToggle(card, name, color, index);
	}

	// Reverse the newest action on the stack and jump back to its card. Works
	// any time (z / header ↩ / the toast button) — not just while a toast shows.
	function undoLast() {
		if (busyRef.current) return;
		const entry = historyRef.current[historyRef.current.length - 1];
		if (!entry) return;
		const finish = (msg: string) => {
			historyRef.current.pop();
			setHistoryLen(historyRef.current.length);
			setBusy(false);
			setPanel(null);
			setDir(null);
			setIndex(entry.at);
			showToast(msg);
		};
		const fail = (e: any) => {
			setBusy(false);
			showToast(`Undo failed: ${e.message || e}`);
		};
		if (entry.kind === "label") {
			// The optimistic flip handles its own failure path; pop eagerly.
			historyRef.current.pop();
			setHistoryLen(historyRef.current.length);
			applyLabelToggle(entry.pr, entry.name, entry.color, entry.at, false);
			setDir(null);
			setIndex(entry.at);
			showToast(
				`${entry.added ? "Removed" : "Re-added"} "${entry.name}" on #${entry.pr.number}`,
			);
			return;
		}
		setBusy(true);
		if (entry.kind === "keep") {
			unkeepTinderPr(entry.pr.number, currentUser)
				.then(() => finish(`Un-kept #${entry.pr.number}`))
				.catch(fail);
		} else if (entry.kind === "close") {
			reopenTinderPr(entry.pr.number)
				.then(() => finish(`Reopened #${entry.pr.number}`))
				.catch(fail);
		} else if (entry.kind === "comment") {
			if (entry.commentId != null) {
				uncommentTinderPr(entry.pr.number, entry.commentId, currentUser)
					.then(() => finish(`Deleted comment on #${entry.pr.number}`))
					.catch(fail);
			} else {
				// Couldn't identify the comment on GitHub — at least un-keep the PR
				// and come back to it.
				unkeepTinderPr(entry.pr.number, currentUser)
					.then(() =>
						finish(`Back on #${entry.pr.number} — comment left in place`),
					)
					.catch(fail);
			}
		}
	}

	function back() {
		setPanel(null);
		setDir(null);
		setIndex((i) => Math.max(0, i - 1));
	}

	function showKept() {
		const inDeck = new Set(cards.map((c) => c.number));
		const kept = allPrs.current.filter((p) => !inDeck.has(p.number));
		setDeck((d) =>
			d ? { cards: [...d.cards, ...shuffle(kept)], labels: d.labels, keptCount: 0 } : d,
		);
	}

	// Keyboard: →/k keep, ←/c close, m comment, l label, o GitHub, b back,
	// z undo; Esc closes an open panel first, then leaves the deck.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				if (panel) return setPanel(null);
				return onExit();
			}
			const el = e.target as HTMLElement | null;
			if (
				el &&
				(el.tagName === "TEXTAREA" ||
					el.tagName === "INPUT" ||
					el.isContentEditable)
			)
				return;
			// Undo works even on the "Deck done" screen (no card left). Plain z,
			// and ⌘Z/^Z for muscle memory.
			if (e.key === "z") {
				e.preventDefault();
				return undoLast();
			}
			if (!card) return;
			if (e.key === "ArrowRight" || e.key === "k") {
				e.preventDefault();
				keep();
			} else if (e.key === "ArrowLeft" || e.key === "c") {
				e.preventDefault();
				close();
			} else if (e.key === "m") {
				e.preventDefault();
				setPanel((p) => (p === "comment" ? null : "comment"));
			} else if (e.key === "l") {
				e.preventDefault();
				setPanel((p) => (p === "label" ? null : "label"));
			} else if (e.key === "o" || e.key === "w") {
				e.preventDefault();
				window.open(card.url, "_blank", "noopener");
			} else if (e.key === "b") {
				e.preventDefault();
				back();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [card, index, panel, busy, onExit]);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col items-center bg-surface">
			{/* Header: back + "N Left" counter (same chrome as the catch-up deck).
			    The chevron is phone-only for the same reason it is there — see
			    CatchUpDeck; Esc leaves the deck on both. */}
			<div className="deck-header relative flex w-full items-center justify-between px-4 py-3">
				<button
					className="hidden h-8 w-8 items-center justify-center rounded-md bg-transparent text-dim hover:bg-panel hover:text-fg max-[720px]:flex"
					onClick={onExit}
					title="Back (Esc)"
					aria-label="Back"
				>
					<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
						<path
							d="M10 3.5 5.5 8l4.5 4.5"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
				<div className="deck-header-title absolute left-1/2 -translate-x-1/2 text-control-label font-semibold text-fg">
					{deck === null
						? "PR Tinder"
						: done
							? "Deck done"
							: `${cards.length - index} Left`}
				</div>
				{/* ml-auto: with the chevron hidden this is the row's only in-flow
				    child, and justify-between alone would pack it against the left. */}
				<button
					className="ml-auto flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-dim hover:bg-panel hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
					onClick={undoLast}
					disabled={historyLen === 0 || busy}
					title="Undo last action (z)"
					aria-label="Undo last action"
				>
					<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
						<path
							d="M6.5 3.5 3 7l3.5 3.5M3 7h6.75A3.25 3.25 0 0 1 13 10.25v.25"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			</div>

			{error ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
					<div className="text-control-label font-semibold text-red">
						Couldn't load the deck
					</div>
					<div className="max-w-sm text-control-label text-dim">{error}</div>
				</div>
			) : deck === null ? (
				<div className="flex flex-1 items-center justify-center text-control-label text-faint">
					Dealing open PRs…
				</div>
			) : done ? (
				<DeckDone
					reviewed={index}
					keptCount={deck.keptCount}
					onShowKept={showKept}
					onExit={onExit}
				/>
			) : (
				/* The deck area scrolls like a normal page: the card is auto-height
				   (the full PR description, no inner scroll pane) and long bodies
				   just flow past the fold. */
				<div
					ref={deckScrollRef}
					className="min-h-0 w-full flex-1 overflow-y-auto px-4 pb-4"
				>
					<div className="relative mx-auto w-full max-w-[640px]">
						{/* Peek of the next card behind the top one, for depth. */}
						{next && (
							<div
								className="absolute inset-x-0 -bottom-1.5 top-3 scale-x-[0.97] rounded-lg border border-line bg-panel opacity-60"
								aria-hidden
							/>
						)}
						<AnimatePresence initial={false} custom={dir}>
							<SwipeCard
								key={card!.number}
								pr={card!}
								labels={cardLabels(card!)}
								custom={dir}
								onKeep={keep}
								onClose={close}
								onRemoveLabel={(name) =>
									toggleLabel(
										name,
										cardLabels(card!).find((l) => l.name === name)?.color ||
											"",
									)
								}
							/>
						</AnimatePresence>
					</div>
				</div>
			)}

			{/* Comment / label panels float above the action bar (they must stay
			    on-screen however far the card is scrolled). */}
			{panel === "comment" && card && (
				<CommentPanel
					key={`comment-${card.number}`}
					busy={busy}
					onSubmit={comment}
					onCancel={() => setPanel(null)}
				/>
			)}
			{panel === "label" && card && deck && (
				<LabelPanel
					key={`label-${card.number}`}
					all={deck.labels}
					active={new Set(cardLabels(card).map((l) => l.name))}
					onToggle={toggleLabel}
					onClose={() => setPanel(null)}
				/>
			)}

			{/* Action bar (works without gestures). */}
			{deck !== null && !done && !error && (
				<div className="flex w-full max-w-[640px] items-stretch gap-2.5 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
					<button
						className="flex items-center justify-center rounded-lg border border-red/40 bg-red-soft px-4 py-3 text-control-label font-semibold text-red hover:border-red/70 disabled:opacity-50"
						onClick={close}
						disabled={busy}
						title="Close PR (← or c) — undo available"
					>
						Close
					</button>
					<button
						className={`flex-1 rounded-lg border border-line px-3 py-3 text-control-label font-semibold hover:bg-surface ${panel === "label" ? "bg-surface text-fg" : "bg-panel text-dim hover:text-fg"}`}
						onClick={() => setPanel((p) => (p === "label" ? null : "label"))}
						title="Labels (l)"
					>
						Label
					</button>
					<button
						className={`flex-1 rounded-lg border border-line px-3 py-3 text-control-label font-semibold hover:bg-surface ${panel === "comment" ? "bg-surface text-fg" : "bg-panel text-dim hover:text-fg"}`}
						onClick={() => setPanel((p) => (p === "comment" ? null : "comment"))}
						title="Comment (m)"
					>
						Comment
					</button>
					<button
						className="flex-1 rounded-lg border border-line bg-panel px-3 py-3 text-control-label font-semibold text-dim hover:bg-surface hover:text-fg"
						onClick={() => card && window.open(card.url, "_blank", "noopener")}
						title={`Open on ${providerFromUrl(card?.url).name} (o)`}
					>
						{providerFromUrl(card?.url).name}
					</button>
					<button
						className="flex-1 rounded-lg bg-green px-4 py-3 text-control-label font-semibold text-white hover:opacity-90"
						onClick={keep}
						title="Keep (→ or k)"
					>
						Keep
					</button>
				</div>
			)}

			{/* Undo / status toast. */}
			{toast && (
				<div className="pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2">
					<div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-line-strong bg-panel px-4 py-2.5 text-control-label text-fg shadow-[0_6px_20px_rgba(0,0,0,0.35)]">
						{toast.text}
						{toast.undo && (
							<button
								className="font-semibold text-accent hover:underline"
								onClick={toast.undo}
							>
								Undo
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function SwipeCard({
	pr,
	labels,
	custom,
	onKeep,
	onClose,
	onRemoveLabel,
}: {
	pr: TinderPr;
	labels: Array<{ name: string; color: string }>;
	custom: Action | null;
	onKeep: () => void;
	onClose: () => void;
	onRemoveLabel: (name: string) => void;
}) {
	const x = useMotionValue(0);
	const rotate = useTransform(x, [-260, 260], [-9, 9]);
	const closeTint = useTransform(x, [-SWIPE_DISTANCE, -20], [1, 0]);
	const keepTint = useTransform(x, [20, SWIPE_DISTANCE], [0, 1]);

	function onDragEnd(_: unknown, info: PanInfo) {
		if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY)
			onClose();
		else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY)
			onKeep();
	}

	// Exit flings left for close, right for keep/comment (both are "dealt
	// with"). The card lives in normal flow (auto height), so the exiting one
	// is popped to absolute for its fling — otherwise it would hold layout and
	// shove the incoming card down while both are mounted.
	const variants = {
		exit: (a: Action | null) => ({
			position: "absolute" as const,
			top: 0,
			left: 0,
			right: 0,
			x: a === "close" ? -640 : 640,
			rotate: a === "close" ? -12 : 12,
			opacity: 0,
			transition: { duration: 0.26 },
		}),
	};

	const bodyHtml = useMemo(
		() => (pr.body.trim() ? renderMarkdown(pr.body) : ""),
		[pr.body],
	);

	return (
		<motion.div
			className="relative z-10 flex w-full touch-pan-y flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-[0_8px_30px_rgba(0,0,0,0.28)]"
			style={{ x, rotate }}
			drag="x"
			dragConstraints={{ left: 0, right: 0 }}
			dragElastic={0.7}
			onDragEnd={onDragEnd}
			variants={variants}
			initial={{ scale: 0.97, opacity: 0, y: 12 }}
			animate={{ scale: 1, opacity: 1, y: 0 }}
			exit="exit"
			custom={custom}
			transition={{ type: "spring", stiffness: 400, damping: 34 }}
		>
			{/* Swipe intent stamps. */}
			<motion.div
				className="pointer-events-none absolute left-4 top-16 z-10 rounded-md border-2 border-red px-2.5 py-1 text-control-label font-bold tracking-wide text-red"
				style={{ opacity: closeTint, rotate: -12 }}
			>
				Close
			</motion.div>
			<motion.div
				className="pointer-events-none absolute right-4 top-16 z-10 rounded-md border-2 border-green px-2.5 py-1 text-control-label font-bold tracking-wide text-green"
				style={{ opacity: keepTint, rotate: 12 }}
			>
				Keep
			</motion.div>

			{/* Card head: number/author/ages, title, labels, diffstat. */}
			<div className="shrink-0 border-b border-line px-5 py-3.5">
				<div className="flex items-center gap-2 text-label text-faint">
					<a
						className="font-semibold tabular-nums text-dim hover:text-fg hover:underline"
						href={pr.url}
						target="_blank"
						rel="noopener"
						onPointerDownCapture={(e) => e.stopPropagation()}
					>
						#{pr.number}
					</a>
					<img
						className="h-4.5 w-4.5 rounded-full"
						src={`https://github.com/${pr.author}.png?size=40`}
						alt=""
						loading="lazy"
					/>
					<span className="text-dim">{pr.author}</span>
					<span>·</span>
					<span className={ageTone(pr.updatedAt)}>
						updated {ageLabel(pr.updatedAt)}
					</span>
					<span>·</span>
					<span>{ageLabel(pr.createdAt)} old</span>
					{pr.isDraft && (
						<span className="rounded border border-yellow/50 px-1.5 py-px text-meta font-bold tracking-[-0.01em] text-yellow">
							Draft
						</span>
					)}
				</div>
				<div className="mt-1 text-item-title font-semibold leading-snug text-fg">
					{pr.title}
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					{labels.map((l) => (
						<LabelChip
							key={l.name}
							name={l.name}
							color={l.color}
							onRemove={() => onRemoveLabel(l.name)}
						/>
					))}
					<span className="ml-auto flex items-center gap-2 text-label tabular-nums">
						<span className="text-green">+{pr.additions}</span>
						<span className="text-red">−{pr.deletions}</span>
						<span className="text-faint">
							{pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
						</span>
						<ReviewBadge decision={pr.reviewDecision} />
					</span>
				</div>
			</div>

			{/* Full-height body: the whole description renders, no inner scroll —
			    overflow flows into the deck's normal page scroll. */}
			<div className="px-5 py-4">
				{bodyHtml ? (
					/* .pr-body-md clamps itself to 360px + inner scroll for the PR
					   panel — undo that here: the card shows the whole description. */
					<div
						className="pr-body-md markdown max-h-none overflow-visible p-0 text-control-label"
						dangerouslySetInnerHTML={{ __html: bodyHtml }}
					/>
				) : (
					<div className="text-control-label italic text-faint">(no description)</div>
				)}
			</div>
		</motion.div>
	);
}

function CommentPanel({
	busy,
	onSubmit,
	onCancel,
}: {
	busy: boolean;
	onSubmit: (text: string) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState("");
	return (
		<div
			className="absolute inset-x-4 bottom-24 z-30 mx-auto w-auto max-w-[600px] rounded-lg border border-line-strong bg-panel p-3 shadow-[0_10px_34px_rgba(0,0,0,0.4)] sm:inset-x-auto sm:left-1/2 sm:w-[600px] sm:-translate-x-1/2"
			onPointerDownCapture={(e) => e.stopPropagation()}
		>
			<textarea
				autoFocus
				rows={3}
				value={text}
				placeholder="Comment on this PR… (Enter to send, Esc to cancel)"
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						if (text.trim()) onSubmit(text.trim());
					}
				}}
				className="w-full resize-none appearance-none rounded-md border border-line bg-surface px-3 py-2 text-control-label leading-relaxed text-fg outline-none [-webkit-appearance:none] placeholder:text-faint focus:border-line-strong"
			/>
			<div className="mt-2 flex justify-end gap-2">
				<button
					className="rounded-md border border-line bg-transparent px-3 py-1.5 text-label font-semibold text-dim hover:text-fg"
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					className="rounded-md bg-accent px-3 py-1.5 text-label font-semibold text-white disabled:opacity-40"
					disabled={busy || !text.trim()}
					onClick={() => onSubmit(text.trim())}
				>
					Comment & next
				</button>
			</div>
		</div>
	);
}

function LabelPanel({
	all,
	active,
	onToggle,
	onClose,
}: {
	all: Array<{ name: string; color: string }>;
	active: Set<string>;
	onToggle: (name: string, color: string) => void;
	onClose: () => void;
}) {
	const [q, setQ] = useState("");
	const shortlist = all.filter((l) =>
		LABEL_SHORTLIST.some((s) => s.toLowerCase() === l.name.toLowerCase()),
	);
	const rest = all.filter((l) => !shortlist.includes(l));
	const match = (l: { name: string }) =>
		l.name.toLowerCase().includes(q.toLowerCase());
	const rows = [...shortlist, ...rest].filter(match);
	return (
		<div
			className="absolute inset-x-4 bottom-24 z-30 mx-auto flex max-h-[55%] w-auto max-w-[600px] flex-col rounded-lg border border-line-strong bg-panel shadow-[0_10px_34px_rgba(0,0,0,0.4)] sm:inset-x-auto sm:left-1/2 sm:w-[600px] sm:-translate-x-1/2"
			onPointerDownCapture={(e) => e.stopPropagation()}
		>
			<div className="flex items-center gap-2 border-b border-line px-3 py-2">
				<input
					autoFocus
					value={q}
					placeholder="Filter labels…"
					onChange={(e) => setQ(e.target.value)}
					className="flex-1 appearance-none border-0 bg-transparent text-control-label text-fg outline-none placeholder:text-faint"
				/>
				<button
					className="text-label font-semibold text-dim hover:text-fg"
					onClick={onClose}
				>
					Done
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{rows.length === 0 ? (
					<div className="px-2 py-3 text-control-label text-faint">No matching labels.</div>
				) : (
					rows.map((l) => {
						const on = active.has(l.name);
						return (
							<button
								key={l.name}
								className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-control-label hover:bg-surface ${on ? "text-fg" : "text-dim"}`}
								onClick={() => onToggle(l.name, l.color)}
							>
								<span className={`w-4 text-center ${on ? "text-green" : "text-transparent"}`}>
									✓
								</span>
								<LabelChip name={l.name} color={l.color} />
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}

function DeckDone({
	reviewed,
	keptCount,
	onShowKept,
	onExit,
}: {
	reviewed: number;
	keptCount: number;
	onShowKept: () => void;
	onExit: () => void;
}) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
			<div className="text-4xl">🔥</div>
			<div className="text-item-title font-semibold text-fg">Deck done</div>
			<div className="max-w-xs text-control-label text-dim">
				{reviewed > 0
					? `You went through ${reviewed} PR${reviewed === 1 ? "" : "s"}.`
					: "Nothing new to triage."}
			</div>
			<div className="mt-2 flex gap-2">
				{keptCount > 0 && (
					<button
						className="rounded-lg border border-line bg-panel px-4 py-2.5 text-control-label font-semibold text-dim hover:bg-surface hover:text-fg"
						onClick={onShowKept}
					>
						Deal {keptCount} kept PR{keptCount === 1 ? "" : "s"}
					</button>
				)}
				<button
					className="rounded-lg bg-panel px-4 py-2.5 text-control-label font-semibold text-fg hover:bg-surface"
					onClick={onExit}
				>
					Done
				</button>
			</div>
		</div>
	);
}
