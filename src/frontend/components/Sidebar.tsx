import { AGENT_NAME, DEFAULT_REPO_ID } from "../lib/brand";
import React, {
	useState,
	useMemo,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { createPortal } from "react-dom";
import type {
	UnifiedSession,
	Project,
	SupportThread,
	FeedDescriptor,
	FeedFilterSpec,
	FeedItem,
} from "../lib/types";
import { sessionPrApproved, sessionPrMerged } from "../lib/session-prs";
import type { ReviewQueueItem } from "../lib/review-queue";
import {
	relativeTime,
	fetchOpenPrs,
	fetchFeeds,
	fetchFeedItems,
	fetchFeedFilterOptions,
	closePrPreviewApi,
	PR_CLOSED_EVENT,
	PR_REVIEW_SUBMITTED_EVENT,
	setPlainThreadStatusApi,
	type PrClosedDetail,
	type OpenPr,
	type WorkspaceOverview,
} from "../lib/api";
import { loadOverview, overviewCache } from "../lib/workspace-overview";
import { openLightbox } from "./MediaLightbox";
import { useCurrentUser, TEAM } from "./UserPicker";
import { getLane, getLanes, onLanesChanged } from "../lib/lanes";
import {
	getPins,
	onPinsChanged,
	togglePin,
	reorderPins,
	unpin,
} from "../lib/pins";
import {
	clearSnooze,
	formatRemaining,
	getSnoozes,
	onSnoozesChanged,
	setSnooze,
	snoozePresets,
} from "../lib/snoozes";
import {
	clearHides,
	getHides,
	onHidesChanged,
	partitionHidden,
	setHide,
} from "../lib/hides";
import { Reorder } from "motion/react";
import { getRecents, onRecentsChanged } from "../lib/recents";
import {
	getReads,
	isUnread,
	markRead,
	markUnread,
	onReadsChanged,
} from "../lib/reads";
import { isNoteUnread, onNoteReadsChanged } from "../lib/note-reads";
import { usePeople } from "../lib/people";
import { TeamPresencePopover, useTeamPresence } from "./TeamPresence";
import { Button } from "../ui/button";
import { chatPath, absoluteLink, copyToClipboard } from "../lib/share-link";
import { providerFromUrl } from "../lib/provider";
import { hasDraft, onDraftsChanged } from "../lib/drafts";
import { getWsTimePref, onWsTimeChanged } from "../lib/workspace-time";
import { getSidebarOrder, onSidebarOrderChanged } from "../lib/sidebar-order";
import {
	getRepoOrder,
	mergeRepoOrder,
	normalizeRepoOrder,
	onRepoOrderChanged,
	replaceVisibleRepoOrder,
	setRepoOrder,
} from "../lib/repo-order";
import { UserAvatar, githubLoginFor } from "./UserAvatar";
import { shortTime, elapsedClock } from "../lib/time";
import {
	IconChevronDown,
	IconChevronRight,
	IconArchive,
	IconUnarchive,
	IconBell,
	IconFilter,
	IconX,
	IconGear,
	IconGitMerge,
	IconCheck,
	IconClock,
	IconFlame,
	IconInbox,
	IconMessageQuestion,
	IconPencil,
	IconPlus,
	IconPullRequest,
	IconEye,
	IconEyeOff,
	IconStack,
	IconPin,
	IconLink,
	IconMail,
	IconMoon,
	IconStatusRing,
	IconTrash,
	IconChart,
	IconDesk,
	IconFile,
	IconDotsHorizontal,
	IconGlobe,
	IconHome,
	IconListChecks,
} from "./icons";
import { Tooltip } from "../ui/tooltip";
import { ContextMenu, Menu } from "../ui/menu";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";
import {
	CardFooter,
	CardLink,
	checksLabel,
	osReviewLabel,
	pointerCanHover,
	RowCardPopup,
	SupportRowCard,
	useRowHoverCard,
} from "./SidebarRowCards";
import { RepoTile, repoLabel } from "./RepoTile";
import { useIsPhone } from "../hooks/useIsPhone";
import { PrRow } from "./PrRow";
import {
	buildReviewQueue,
	reviewRowMatchesPersonFilter,
} from "../lib/review-queue";
import { PixelSpinner } from "./PixelSpinner";
import {
	readHiddenSidebarTools,
	setSidebarToolVisible,
	hideAllSidebarTools,
	onSidebarToolsChanged,
	SIDEBAR_TOOL_LABELS,
	type SidebarToolId,
} from "../lib/sidebar-tools";
import {
	onSidebarFeedsChanged,
	readHiddenSidebarFeeds,
	setSidebarFeedVisible,
} from "../lib/sidebar-feeds";

const AUTOMATION_COLOR = "#d29922";

// Archive the active workspace. The viewer's ⌘E/⌘⇧A archives just the open
// chat and bails on Alt, so the Alt-carrying escalation here never
// double-fires it.
const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const isChromium = /Chrome|Chromium|CriOS|Edg|OPR/.test(navigator.userAgent);
const ARCHIVE_WS_SHORTCUT_KEYS = isApple
	? ["⌘", "⌥", "⇧", "A"]
	: ["Ctrl", "Alt", "Shift", "A"];
// Chromium reserves ⌘E before the page sees it; advertise the working alias.
const ARCHIVE_SHORTCUT_KEYS = isChromium
	? isApple
		? ["⌘", "⇧", "A"]
		: ["Ctrl", "Shift", "A"]
	: isApple
		? ["⌘", "E"]
		: ["Ctrl", "E"];
const PIN_SHORTCUT_KEYS = isApple ? ["⌘", "P"] : ["Ctrl", "P"];

/** ⌘E (primary) or ⌘⇧A (legacy) — the archive-this-chat chord. */
function isArchiveChord(e: KeyboardEvent): boolean {
	if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
	const k = e.key.toLowerCase();
	return (k === "e" && !e.shiftKey) || (k === "a" && e.shiftKey);
}

/** True when an editable element owns focus and should keep the archive
 * chords for itself. The main composer textarea is exempt: it autofocuses on
 * every session open (and ⌘↑/⌘↓ workspace cycling re-focuses it), which left
 * the advertised ⌘E dead almost all the time — and the chord types nothing,
 * so firing there only costs the browser's niche find-selection default.
 * Rename fields, search boxes, etc. keep the guard. */
function editableSwallowsArchiveChord(target: EventTarget | null): boolean {
	const editable = (target as HTMLElement | null)?.closest(
		"input, textarea, select, [contenteditable='true'], [contenteditable='']",
	);
	return !!editable && !editable.classList.contains("composer-textarea");
}

// Long-press (touch) tuning for the mobile action sheet.
const LONG_PRESS_MS = 450; // hold before the sheet opens
const LONG_PRESS_SLOP = 10; // px of finger travel that cancels it (a scroll)
const SWIPE_REVEAL_PX = 82;
const SWIPE_OPEN_THRESHOLD = 36;
const SWIPE_FULL_RATIO = 0.45;
const SWIPE_COMMIT_MS = 210;
const SWIPE_AXIS_LOCK_PX = 8;

// Keep the semantic hooks below for sticky-state tracking, platform chrome and
// test selectors. Their visual contract lives here instead of the foundation adapter.
const SIDEBAR_ITEM_CLASS =
	"sidebar-item relative mt-0.5 block w-full rounded-lg border-0 bg-transparent px-2 py-[9px] pl-2.5 text-left text-fg transition-colors hover:bg-hover max-[720px]:px-2 max-[720px]:py-[13px] max-[720px]:pl-2.5";
const SIDEBAR_WS_ROW_CLASS =
	"sidebar-ws-row group relative flex items-center gap-[9px]";
const SIDEBAR_GROUP_HEADER_CLASS =
	"sidebar-group-header group";
const SIDEBAR_RAIL_CLASS =
	"sidebar-rail relative flex size-[22px] shrink-0 items-center justify-center";
const SIDEBAR_TITLE_CLASS =
	"sidebar-item-title min-w-0 flex-1 truncate text-item-title font-medium leading-[1.35] text-dim max-[720px]:text-[16px]";
const SIDEBAR_GROUP_NAME_CLASS = "sidebar-group-name";
const SIDEBAR_GROUP_COUNT_CLASS =
	"sidebar-group-count";
const SIDEBAR_GROUP_CHEVRON_CLASS =
	"sidebar-group-chevron ml-auto shrink-0 text-faint opacity-0 transition-[transform,opacity] duration-150 group-hover:opacity-100 group-hover:text-fg";
const SIDEBAR_ACTION_CLASS =
	"sidebar-ws-action inline-flex size-8 items-center justify-center rounded-sm text-faint transition-colors hover:bg-hover hover:text-fg";
const SIDEBAR_ACTIONS_CLASS =
	"sidebar-ws-actions absolute right-[7px] top-1/2 hidden -translate-y-1/2 items-center gap-1 rounded-sm bg-hover shadow-[-6px_0_5px_-2px_var(--bg-hover)] [@media(hover:hover)]:group-hover:inline-flex";
const MOBILE_SHEET_ITEM_CLASS =
	"mobile-sheet-item flex w-full items-center gap-[13px] rounded-md border-0 bg-transparent px-3.5 py-[15px] text-left text-[16px] text-fg active:bg-hover-strong [&_svg]:shrink-0 [&_svg]:text-faint";
const HOVERCARD_HEAD_CLASS = "hovercard-head flex min-w-0 items-center gap-[7px]";
const HOVERCARD_BRANCH_CLASS =
	"hovercard-branch min-w-0 flex-1 truncate text-meta text-dim";
const HOVERCARD_TITLE_CLASS =
	"hovercard-title mt-[5px] text-control-label font-semibold leading-[1.3]";
const HOVERCARD_CALLOUT_CLASS =
	"hovercard-callout mt-[7px] rounded-sm bg-accent-soft px-2 py-[5px] text-meta text-dim";
const HOVERCARD_ROWS_CLASS = "hovercard-rows mt-[9px] flex flex-col gap-[3px]";
const HOVERCARD_ROW_CLASS = "hovercard-row flex gap-2 text-meta leading-[1.35]";

type SwipeAction = "archive" | "star";
type SwipeState = { key: string; offset: number; action?: SwipeAction };

function clampSwipe(dx: number, rowWidth: number): number {
	const limit = Math.max(SWIPE_REVEAL_PX, rowWidth);
	return Math.max(-limit, Math.min(limit, dx));
}

function fullSwipeThreshold(rowWidth: number): number {
	const usableWidth = Math.max(SWIPE_REVEAL_PX, rowWidth - 28);
	return Math.min(
		Math.max(SWIPE_REVEAL_PX * 1.8, rowWidth * SWIPE_FULL_RATIO),
		usableWidth,
	);
}

function swipeCommitOffset(action: SwipeAction, rowWidth: number): number {
	return action === "archive" ? -rowWidth : rowWidth;
}

const CTX_MENU_CLASS =
	"sidebar-ctx-menu fixed z-[3000] flex max-h-[60vh] min-w-[210px] max-w-80 flex-col gap-px overflow-y-auto rounded-[14px] border border-line-strong bg-panel p-1 shadow-[0_10px_30px_rgba(0,0,0,0.32)]";
const CTX_ITEM_CLASS =
	"flex w-full items-center gap-[11px] overflow-hidden rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-control-label text-fg hover:bg-hover";
const CTX_SEPARATOR_CLASS = "mx-[3px] my-1 h-px bg-line-strong";

// Per-person group dots share the repo-tile swatch palette (RepoTile.tsx) —
// the same deterministic hash keeps each teammate's color stable.
// ── Support band: priority buckets + persisted filter ──
// Plain priorities are ints 0..3; unset buckets as Normal (Plain's default).
// Colors follow SupportTinder's priority palette (Urgent red / High yellow),
// with Normal on blue so the queue reads at a glance; `dot` colors the row
// circle of tickets that have no linked session (a session's live status
// still wins the dot).
const SUPPORT_PRIORITY_GROUPS = [
	{ p: 0, label: "Urgent", cls: "text-red", dot: "var(--red)" },
	{ p: 1, label: "High", cls: "text-yellow", dot: "var(--yellow)" },
	{ p: 2, label: "Normal", cls: "text-blue", dot: "var(--blue)" },
	{ p: 3, label: "Low", cls: "text-faint", dot: "var(--text-faint)" },
] as const;
const SUPPORT_PRIORITY_DOT: Record<number, string> = Object.fromEntries(
	SUPPORT_PRIORITY_GROUPS.map((g) => [g.p, g.dot]),
);

// Right-click wiring for the feed-shaped rows (Support tickets, feed items).
// They render as Base UI popover triggers rather than as workspace rows, so
// they never inherited the workspace row's menu — but they stand for the same
// work, so they get the same one. Touch keeps the native callout: these rows
// have no long-press sheet to conflict with.
function useRowCtxMenu(onOpen?: () => void) {
	const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
	useEffect(() => {
		if (!ctxMenu) return;
		const close = () => setCtxMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [ctxMenu]);
	return {
		ctxMenu,
		close: () => setCtxMenu(null),
		onContextMenu: (e: React.MouseEvent) => {
			e.preventDefault();
			onOpen?.();
			setCtxMenu({ x: e.clientX, y: e.clientY });
		},
	};
}

// The claim + lane pair a feed-shaped row offers once a run exists for its
// item — the same two entries the workspace rows' menu carries. Without them
// a ticket whose only session is an automation run (Plain triage) could be
// claimed from the Automations band but not from the band it actually reads
// in. Nothing to claim yet (no session) means no entries.
function laneCtxEntries(
	session: UnifiedSession | null,
	onSetStatus?: (status: LaneChoice | null) => void,
): CtxEntry[] {
	if (!session || !onSetStatus) return [];
	const claimed = isClaimed(session);
	return [
		{
			kind: "item",
			icon: <IconInbox size={20} />,
			label: claimed ? "Remove from my workspaces" : "Add to my workspaces",
			onClick: () => onSetStatus(claimed ? null : "mine"),
		},
		{
			kind: "status",
			current: pinnedLane(session) ?? null,
			onPick: onSetStatus,
		},
	];
}

// A Support row: one TODO Plain ticket, single-line in the workspace rows'
// exact shape. The rail dot wears the linked session's status (the ticket's
// priority when no session exists yet), the right edge shows the last status
// change; customer/assignee/preview live in the hover card. Hovering floats a
// "mark done" action over the right edge. Its own component rather than a
// render helper because the card needs a hook per row.
function SupportRow({
	thread: t,
	session,
	active,
	pinned,
	onTogglePin,
	onOpen,
	onMarkDone,
	onSetStatus,
}: {
	thread: SupportThread;
	session: UnifiedSession | null;
	active: boolean;
	/** Pinned into the sidebar's Pinned band (per-user, like workspace pins). */
	pinned: boolean;
	onTogglePin: () => void;
	onOpen: () => void;
	onMarkDone: () => void;
	/** Claim the ticket's session into your lanes (null = back to derived) —
	    only present once a session exists for the thread. */
	onSetStatus?: (status: LaneChoice | null) => void;
}) {
	const isPhone = useIsPhone();
	const card = useRowHoverCard();
	const menu = useRowCtxMenu(card.close);
	const customer = t.customer.name || t.customer.email || "Unknown";
	const label = t.title || customer;
	const dot =
		(session
			? MINE_STATUS_META.find((m) => m.key === mineStatus(session))?.dotColor
			: SUPPORT_PRIORITY_DOT[t.priority ?? 2]) || "var(--text-faint)";
	return (
		<Popover.Root {...card.rootProps}>
			<Popover.Trigger
				{...card.triggerProps}
				render={
					<button
						type="button"
						className={cn(
							SIDEBAR_ITEM_CLASS,
							SIDEBAR_WS_ROW_CLASS,
							active && "sidebar-item-selected !bg-hover-strong",
						)}
						onClick={onOpen}
						onContextMenu={menu.onContextMenu}
						aria-label={label}
					/>
				}
			>
				<span className={SIDEBAR_RAIL_CLASS}>
					<span
						className="size-[7px] rounded-full"
						style={{ backgroundColor: dot }}
					/>
				</span>
				<span className={SIDEBAR_TITLE_CLASS}>{label}</span>
				{!isPhone && t.statusChangedAt && (
					<span
						className="sidebar-ws-time ml-auto min-w-[34px] shrink-0 text-right text-meta text-faint"
						aria-label={new Date(t.statusChangedAt).toLocaleString()}
					>
						{shortTime(t.statusChangedAt)}
					</span>
				)}
				{/* Hover actions: the same pin + finish pair the workspace rows
				    wear — pin keeps the ticket in the Pinned band, the check
				    marks it done in Plain. */}
				<span className={SIDEBAR_ACTIONS_CLASS}>
					<span
						role="button"
						tabIndex={0}
						className={cn(SIDEBAR_ACTION_CLASS, pinned && "is-on text-accent")}
						aria-label={pinned ? "Unpin ticket" : "Pin ticket"}
						onClick={(e) => {
							e.stopPropagation();
							onTogglePin();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.stopPropagation();
								onTogglePin();
							}
						}}
					>
						<IconPin size={21} fill={pinned ? "currentColor" : "none"} />
					</span>
					<Tooltip label="Mark done in Plain">
						<span
							role="button"
							tabIndex={0}
							className={`${SIDEBAR_ACTION_CLASS} sidebar-ws-action--done hover:text-green`}
							aria-label="Mark done in Plain"
							onClick={(e) => {
								e.stopPropagation();
								onMarkDone();
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.stopPropagation();
									onMarkDone();
								}
							}}
						>
							<IconCheck size={21} />
						</span>
					</Tooltip>
				</span>
			</Popover.Trigger>
			<RowCardPopup>
				<SupportRowCard thread={t} session={session} />
			</RowCardPopup>
			{menu.ctxMenu && (
				<SidebarCtxMenu
					x={menu.ctxMenu.x}
					y={menu.ctxMenu.y}
					onClose={menu.close}
					entries={[
						{
							kind: "item",
							icon: (
								<IconPin size={20} fill={pinned ? "currentColor" : "none"} />
							),
							label: pinned ? "Unpin" : "Pin",
							onClick: onTogglePin,
						},
						...laneCtxEntries(session, onSetStatus),
						{ kind: "sep" },
						{
							kind: "item",
							icon: <IconCheck size={20} />,
							label: "Mark done in Plain",
							onClick: onMarkDone,
						},
					]}
				/>
			)}
		</Popover.Root>
	);
}

// A feed row: one external object (e.g. a Tella video) in the workspace rows'
// exact shape — the generic sibling of SupportRow (the feeds design). The
// rail dot wears the linked session's status (the feed lane's color, else
// faint, when no session exists yet); the hover card carries the preview.
function FeedRow({
	feed,
	item,
	session,
	active,
	pinned,
	onTogglePin,
	onOpen,
	onSetStatus,
}: {
	feed: FeedDescriptor;
	item: FeedItem;
	session: UnifiedSession | null;
	active: boolean;
	/** Pinned into the sidebar's Pinned band (per-user, like ticket pins). */
	pinned: boolean;
	onTogglePin: () => void;
	onOpen: () => void;
	/** Claim the item's session into your lanes (null = back to derived) —
	    only present once a session exists for the item. */
	onSetStatus?: (status: LaneChoice | null) => void;
}) {
	const isPhone = useIsPhone();
	const card = useRowHoverCard();
	const menu = useRowCtxMenu(card.close);
	const lane = feed.lanes?.find((l) => l.key === item.lane);
	// Per-viewer unread (e.g. Slack read cursors) renders Slack-style: bold
	// title + accent dot.
	const unread = item.meta?.unread === true;
	const dot =
		(session
			? MINE_STATUS_META.find((m) => m.key === mineStatus(session))?.dotColor
			: lane?.dot) ||
		(unread ? "var(--accent)" : "var(--text-faint)");
	const ts = item.ts ? new Date(item.ts).toISOString() : null;
	return (
		<Popover.Root {...card.rootProps}>
			<Popover.Trigger
				{...card.triggerProps}
				render={
					<button
						type="button"
						className={cn(
							SIDEBAR_ITEM_CLASS,
							SIDEBAR_WS_ROW_CLASS,
							active && "sidebar-item-selected !bg-hover-strong",
						)}
						onClick={onOpen}
						onContextMenu={menu.onContextMenu}
						aria-label={item.title}
					/>
				}
			>
				<span className={SIDEBAR_RAIL_CLASS}>
					<span
						className="size-[7px] rounded-full"
						style={{ backgroundColor: dot }}
					/>
				</span>
				<span
					className={cn(SIDEBAR_TITLE_CLASS, unread && "font-semibold text-fg")}
				>
					{item.title}
				</span>
				{!isPhone && ts && (
					<span
						className="sidebar-ws-time ml-auto min-w-[34px] shrink-0 text-right text-meta text-faint"
						aria-label={new Date(ts).toLocaleString()}
					>
						{shortTime(ts)}
					</span>
				)}
				<span className={SIDEBAR_ACTIONS_CLASS}>
					<span
						role="button"
						tabIndex={0}
						className={cn(SIDEBAR_ACTION_CLASS, pinned && "is-on text-accent")}
						aria-label={pinned ? "Unpin" : "Pin"}
						onClick={(e) => {
							e.stopPropagation();
							onTogglePin();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.stopPropagation();
								onTogglePin();
							}
						}}
					>
						<IconPin size={21} fill={pinned ? "currentColor" : "none"} />
					</span>
				</span>
			</Popover.Trigger>
			<RowCardPopup>
				<div className="hovercard-title">{item.title}</div>
				{item.preview && (
					<div className="selectable mt-1 line-clamp-4 text-xs leading-snug text-dim">
						{item.preview}
					</div>
				)}
				<CardFooter
					time={ts ? `Updated ${relativeTime(ts)}` : ""}
					timeTitle={ts ? new Date(ts).toLocaleString() : undefined}
				>
					{session && (
						<span className="shrink-0 text-xs text-dim">Linked session</span>
					)}
				</CardFooter>
			</RowCardPopup>
			{menu.ctxMenu && (
				<SidebarCtxMenu
					x={menu.ctxMenu.x}
					y={menu.ctxMenu.y}
					onClose={menu.close}
					entries={[
						{
							kind: "item",
							icon: (
								<IconPin size={20} fill={pinned ? "currentColor" : "none"} />
							),
							label: pinned ? "Unpin" : "Pin",
							onClick: onTogglePin,
						},
						...laneCtxEntries(session, onSetStatus),
					]}
				/>
			)}
		</Popover.Root>
	);
}

// ── Generic feed-band filters (the feeds design) ──
// Every band's filter menu is driven by the feed descriptor's FeedFilterSpec
// list: arg-mode specs feed the backing list tool (tella tags/playlists),
// meta-mode specs filter client-side over item.meta (plain assignee/labels,
// options derived from the items). Built-ins on every feed: "Linked session"
// and (non-lane feeds) "Sort". Selections persist per browser, per feed.
// This replaced plain's bespoke SupportFilterState menu.
type FeedFilterValues = Record<string, string>;
const FEED_FILTERS_KEY = "opensession-feed-filters";
function readFeedFilters(): Record<string, FeedFilterValues> {
	try {
		const saved = JSON.parse(localStorage.getItem(FEED_FILTERS_KEY) || "{}");
		return saved && typeof saved === "object" ? saved : {};
	} catch {
		return {};
	}
}

/** `a.b` getter over item meta / option objects. */
function dget(obj: unknown, path?: string): unknown {
	if (!path) return obj;
	let cur: any = obj;
	for (const seg of path.split(".")) {
		if (cur == null) return undefined;
		cur = cur[seg];
	}
	return cur;
}

function FeedFilterMenu({
	feed,
	values,
	rawItems,
	currentUser,
	onSet,
	onHide,
}: {
	feed: FeedDescriptor;
	values: FeedFilterValues;
	rawItems: FeedItem[];
	currentUser: string;
	onSet: (key: string, value: string) => void;
	onHide: () => void;
}) {
	const [argOptions, setArgOptions] = useState<
		Record<string, { value: string; label: string }[]>
	>({});
	const [opened, setOpened] = useState(false);
	const argSpecs = (feed.filters || []).filter((f) => f.mode !== "meta");
	const metaSpecs = (feed.filters || []).filter((f) => f.mode === "meta");
	useEffect(() => {
		if (!opened) return;
		for (const spec of argSpecs) {
			if (argOptions[spec.key]) continue;
			fetchFeedFilterOptions(feed.id, spec.key)
				.then((options) =>
					setArgOptions((prev) => ({ ...prev, [spec.key]: options })),
				)
				.catch(() => {});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [opened, feed.id]);

	const active = Object.entries(values).some(
		([k, v]) => v && !(k === "__sort" && v === "recent"),
	);
	const item = (
		key: string,
		label: string,
		value: string,
		selected: boolean,
	) => (
		<Menu.Item key={`${key}:${value}`} onClick={() => onSet(key, selected ? "" : value)}>
			<span className="flex size-4 shrink-0 items-center justify-center">
				{selected && <IconCheck size={13} />}
			</span>
			<span className="truncate">{label}</span>
		</Menu.Item>
	);
	// meta options derived from the current items (plus static prepends);
	// a "Me" shortcut appears when the viewer's first name is among them.
	const metaOptions = (spec: FeedFilterSpec) => {
		const out = new Map<string, string>();
		for (const o of spec.options || []) out.set(o.value, o.label);
		for (const it of rawItems) {
			const v = dget(it.meta, spec.field);
			const els = Array.isArray(v) ? v : v != null ? [v] : [];
			for (const el of els) {
				const value = String(dget(el, spec.optionsFromItems?.value) ?? "");
				const label = String(dget(el, spec.optionsFromItems?.label) ?? value);
				if (value) out.set(value, label);
			}
		}
		return [...out.entries()].map(([value, label]) => ({ value, label }));
	};
	const meFirst = currentUser.trim().toLowerCase().split(/\s+/)[0];
	return (
		<Menu.Root onOpenChange={setOpened}>
			<Menu.Trigger
				render={
					<span
						role="button"
						tabIndex={0}
						aria-label={`Filter ${feed.title}`}
						title={`Filter ${feed.title}`}
						className={`sidebar-band-action sidebar-filter-btn ml-auto shrink-0${active ? " has-filter" : ""}`}
						onClick={(e: React.MouseEvent) => e.stopPropagation()}
					/>
				}
			>
				<IconFilter size={19} />
			</Menu.Trigger>
			<Menu.Popup align="end" sideOffset={5} className="min-w-[230px]">
				{metaSpecs.map((spec) => {
					const options = metaOptions(spec);
					const me = options.find(
						(o) => o.label.toLowerCase().split(/\s+/)[0] === meFirst,
					);
					const sel = values[spec.key] || "";
					return (
						<Menu.Group key={spec.key}>
							<Menu.GroupLabel>{spec.label}</Menu.GroupLabel>
							{item(spec.key, "Any", "", sel === "")}
							{me && item(spec.key, "Me", me.value, sel === me.value)}
							{options
								.filter((o) => o.value !== me?.value)
								.map((o) => item(spec.key, o.label, o.value, sel === o.value))}
						</Menu.Group>
					);
				})}
				{argSpecs.map((spec) => {
					const options = argOptions[spec.key];
					const sel = values[spec.key] || "";
					return (
						<Menu.Group key={spec.key}>
							<Menu.GroupLabel>{spec.label}</Menu.GroupLabel>
							{item(spec.key, "Any", "", sel === "")}
							{options === undefined ? (
								<div className="px-3 py-1 text-xs text-faint">Loading…</div>
							) : (
								options.map((o) =>
									item(spec.key, o.label, o.value, sel === o.value),
								)
							)}
						</Menu.Group>
					);
				})}
				<Menu.Group>
					<Menu.GroupLabel>Linked session</Menu.GroupLabel>
					{item("__session", "Any", "", !values.__session)}
					{item("__session", "With session", "with", values.__session === "with")}
					{item("__session", "Without session", "without", values.__session === "without")}
				</Menu.Group>
				{!feed.lanes?.length && (
					<Menu.Group>
						<Menu.GroupLabel>Sort</Menu.GroupLabel>
						{(
							feed.sortOptions || [
								{ value: "recent", label: "Most recent" },
								{ value: "oldest", label: "Oldest first" },
								{ value: "title", label: "Title" },
							]
						).map((o, i) =>
							item(
								"__sort",
								o.label,
								o.value,
								(values.__sort ||
									feed.sortOptions?.[0]?.value ||
									"recent") === o.value,
							),
						)}
					</Menu.Group>
				)}
				<Menu.Separator />
				<Menu.Item onClick={onHide}>Hide from sidebar</Menu.Item>
			</Menu.Popup>
		</Menu.Root>
	);
}

// Only recognized people get their own "people" section. Sessions whose
// `startedBy` is something other than a real teammate — test labels
// ("proof-test", "image-test"), action/integration names ("Slack",
// "Make Alice editor (action)"), or empty — are hidden rather than shown as
// stray sections. The agent persona counts as a person here.
const KNOWN_PEOPLE = new Set([...TEAM, AGENT_NAME].map((n) => n.toLowerCase()));

interface Props {
	sessions: UnifiedSession[];
	/** Local-profile-only chrome; false on the hosted app. */
	localMode: boolean;
	/** The configured cloud upstream did not answer the latest merged-list poll. */
	cloudUnreachable: boolean;
	/** Initial sessions + project metadata have loaded, so dependent queues can render. */
	workspaceDataReady: boolean;
	/** Project folders that group chats. */
	projects: Project[];
	/** Notes (id + title), to render pinned-note rows. */
	notes: Array<{ id: string; title: string }>;
	selectedId: string | null;
	/** The note currently open (highlights its pinned row), or null. */
	activeNoteId: string | null;
	/** True while the Notes tool is open. */
	notesActive: boolean;
	/** Open the shared Notes tool. */
	onOpenNotes: () => void;
	/** True while the Home view is open — highlights the Home entry. */
	homeActive: boolean;
	/** Open the home worktree index. */
	onOpenHome: () => void;
	/** True while the Tasks tool is open. */
	tasksActive: boolean;
	/** Open the current user's task list. */
	onOpenTasks: () => void;
	/** Current open-task count. */
	taskCount?: number;
	/** Open one automation's settings (list + detail). Called with the
	    automation's NAME — session rows only carry the name, not the id. */
	onOpenAutomation: (name: string) => void;
	/** Open a PR row's workspace (resolve-or-create, Review tab default). */
	onOpenPrItem: (item: ReviewQueueItem) => void;
	/** The open workspace id (route or the open chat's), for row selection. */
	selectedWorkspaceId?: string | null;
	/** True while the PR Tinder deck is open — highlights its entry. */
	prTinderActive: boolean;
	/** Open PR Tinder (swipe triage of the repo's open PRs). */
	onOpenPrTinder: () => void;
	/** True while the Support Tinder deck is open — highlights its entry. */
	supportTinderActive: boolean;
	/** Open Support Tinder (swipe triage of the Plain Todo queue). */
	onOpenSupportTinder: () => void;
	/** True while the recurring Reports surface is open. */
	reportsActive: boolean;
	/** Open automation-produced recurring reports. */
	onOpenReports: () => void;
	/** True while the Analytics surface is open. */
	analyticsActive: boolean;
	/** Open the Analytics view (sessions/tokens/models/PRs over time). */
	onOpenAnalytics: () => void;
	/** True while the Desk overlay is open. */
	deskActive: boolean;
	/** Summon the Desk overlay (the ⌘J concierge session). */
	onOpenDesk: () => void;
	/** Latest team note per session (unread-note dots on workspace rows). */
	noteActivity?: Record<string, { lastTs: number; lastUser: string }>;
	onSelect: (session: UnifiedSession) => void;
	/** Foreground a session's Review view-tab (from a chat row's context menu). */
	onOpenReview: (session: UnifiedSession) => void;
	/** Open a Support ticket's workspace (resolve-or-create, Conversation tab). */
	onOpenTicket: (t: SupportThread) => void;
	/** Open a feed item's workspace (resolve-or-create — the feeds design). */
	onOpenFeedItem: (feed: FeedDescriptor, item: FeedItem) => void;
	onNewSession: () => void;
	/** Start a new session with a repo pre-selected (the repo-band "+" action). */
	onNewSessionInRepo: (repo: string) => void;
	/** Open a project — its chats surface in the top tab strip. */
	onOpenProject: (id: string) => void;
	/** Rename a project folder. */
	onRenameProject: (id: string, name: string) => void;
	/** Delete a project folder (its chats become standalone). */
	onDeleteProject: (id: string) => void;
	/** Open a note (pinned-note row click). */
	onOpenNote: (id: string) => void;
	onOpenArchived: () => void;
	/** True while the archived view is open — highlights the Archived row. */
	archivedActive: boolean;
	/** Open the catch-up swipe deck (walk through your unread workspaces). */
	onOpenCatchUp: () => void;
	/** True while the catch-up deck is open — highlights its entry. */
	catchUpActive: boolean;
	/**
	 * Archive a session. `next` is the session that follows it in the sidebar's
	 * visible order (or the previous one for the last row) — the caller uses it
	 * to keep a live session open when the active one is archived.
	 */
	onArchive: (session: UnifiedSession, next: UnifiedSession | null) => void;
	/**
	 * Archive every chat in a workspace (the row's archive icon). `next` is the
	 * first chat of the workspace row that follows it in the sidebar's visible
	 * order (or the previous one for the last row) — the caller opens it when
	 * the active workspace is archived away.
	 */
	onArchiveWorkspace: (
		chats: UnifiedSession[],
		next: UnifiedSession | null,
	) => void;
	/**
	 * Bring every chat of an archived row back (the Archived band's unarchive
	 * icon) — the exact inverse of `onArchiveWorkspace`, minus the "what opens
	 * next" dance: nothing is closing, so nothing needs replacing.
	 */
	onUnarchiveWorkspace: (chats: UnifiedSession[]) => void;
	/** Rename a session (double-click its title); empty title resets it. */
	onRename: (session: UnifiedSession, title: string) => void;
	/**
	 * Pin a workspace's chats into a sidebar lane (or clear back to derived with
	 * `null`). Applies to every chat in the row so the aggregated row lands there.
	 */
	onSetStatus: (chats: UnifiedSession[], status: LaneChoice | null) => void;
	/** Who's viewing what right now (global presence), for live People rows. */
	teamViewing?: Array<{ user: string; sessionId: string }>;
	/**
	 * The mobile top-bar's right-side actions slot. On phones the sidebar's
	 * filter button lives here (next to Search) instead of in the workspace
	 * header — the header's own filter/+ buttons are hidden on mobile.
	 */
	headerActionsEl?: HTMLElement | null;
	/** Show a transient toast (e.g. "Link copied"). */
	onToast?: (message: string) => void;
}

export interface SidebarHandle {
	archiveSelected: () => void;
}

// Groups are rendered in three visually separated bands (spacing between each):
//   "personal"    — My sessions (split by status), Pinned
//   "people"      — one group per other teammate (+ ownerless source groups)
//   "automations" — one group per automation ("projects")
type GroupBand = "personal" | "people" | "automations";

// The bands below the personal one get a text header ("People" / "Projects").
function bandLabel(band: GroupBand): string | null {
	if (band === "people") return "People";
	if (band === "automations") return "Automations";
	return null;
}

interface Group {
	key: string;
	label: string;
	dotColor: string | null;
	band: GroupBand;
	items: UnifiedSession[];
}

// "My sessions" is split, Conductor-style, into status buckets. Order + labels +
// dot color are defined here; a session is bucketed by the first rule it matches.
type MineStatus =
	| "needsinput"
	| "merged"
	| "pending"
	| "review"
	| "inprogress";

// What a lane control can write: a forced status lane, "mine" (claimed into
// your sidebar, free to follow its live state), or null to drop the entry.
type LaneChoice = MineStatus | "mine";

// The "review" key renders as "Ready to merge" since the PR-queue dissolution:
// the lane holds work whose PR is green and mergeable (plus anything manually
// pinned there). The key stays "review" because per-user lanes and the legacy
// manualStatus overrides persist it server-side.
const MINE_STATUS_META: Array<{
	key: MineStatus;
	label: string;
	dotColor: string;
}> = [
	{ key: "needsinput", label: "Needs input", dotColor: "var(--blue)" },
	{ key: "inprogress", label: "In progress", dotColor: "var(--yellow)" },
	{ key: "review", label: "Ready to merge", dotColor: "var(--green)" },
	{ key: "pending", label: "Backlog", dotColor: "var(--text-faint)" },
	{ key: "merged", label: "Done", dotColor: "var(--purple)" },
];

// ── Right-click context menu (workspace / chat / PR rows) ──────────────────
// A single presentational menu shared by every sidebar row that has one. Rows
// pass a flat list of entries; a `status` entry renders the "Set status" row
// with a hover flyout (the sub-panel is a sibling of the menu, not a child, so
// the menu's own overflow can't clip it).
type CtxEntry =
	| {
			kind: "item";
			icon?: React.ReactNode;
			label: string;
			shortcut?: string;
			danger?: boolean;
			onClick: () => void;
	  }
	| { kind: "sep" }
	| {
			kind: "status";
			current: MineStatus | null;
			onPick: (status: MineStatus | null) => void;
	  }
	| {
			kind: "snooze";
			/** Active snooze expiry (ISO), or null when not snoozed. */
			until: string | null;
			/** ISO until to snooze, or null to unsnooze. */
			onPick: (until: string | null) => void;
	  };

function CtxItem({
	icon,
	label,
	shortcut,
	danger,
	trailing,
	onClick,
	onMouseEnter,
}: {
	icon?: React.ReactNode;
	label: string;
	shortcut?: string;
	danger?: boolean;
	trailing?: React.ReactNode;
	onClick?: () => void;
	onMouseEnter?: (e: React.MouseEvent) => void;
}) {
	return (
		<button
			type="button"
			className={cn(CTX_ITEM_CLASS, danger && "text-red")}
			onClick={onClick}
			onMouseEnter={onMouseEnter}
		>
			{icon !== undefined && (
				<span className={cn("inline-flex w-5 shrink-0 justify-center", !danger && "text-dim")}>
					{icon}
				</span>
			)}
			<span className="min-w-0 flex-1 truncate">
				{label}
			</span>
			{shortcut && (
				<span className="ml-3 shrink-0 text-control-label text-faint">
					{shortcut}
				</span>
			)}
			{trailing}
		</button>
	);
}

function SidebarCtxMenu({
	x,
	y,
	entries,
	onClose,
}: {
	x: number;
	y: number;
	entries: CtxEntry[];
	onClose: () => void;
}) {
	// Flyout state + hover grace so the pointer can
	// cross the gap between the menu and the panel.
	const [sub, setSub] = useState<{
		kind: "status" | "snooze";
		rect: DOMRect;
	} | null>(null);
	const closeT = useRef<ReturnType<typeof setTimeout> | null>(null);
	function cancelClose() {
		if (closeT.current) clearTimeout(closeT.current);
		closeT.current = null;
	}
	function scheduleClose() {
		cancelClose();
		closeT.current = setTimeout(() => setSub(null), 160);
	}
	useEffect(() => cancelClose, []);

	const statusEntry = entries.find(
		(e): e is Extract<CtxEntry, { kind: "status" }> => e.kind === "status",
	);
	const snoozeEntry = entries.find(
		(e): e is Extract<CtxEntry, { kind: "snooze" }> => e.kind === "snooze",
	);
	const check = (on: boolean) =>
		on ? <IconCheck size={20} style={{ color: "var(--text-dim)" }} /> : undefined;

	const SUB_W = 210;
	const subLeft = sub
		? sub.rect.right + SUB_W + 8 > window.innerWidth
			? sub.rect.left - SUB_W - 4
			: sub.rect.right + 4
		: 0;
	const subTop = sub
		? Math.min(sub.rect.top - 6, window.innerHeight - 280)
		: 0;

	return createPortal(
		<>
			<div
				className={CTX_MENU_CLASS}
				style={{ left: x, top: y }}
				onClick={(e) => e.stopPropagation()}
			>
				{entries.map((entry, i) => {
					if (entry.kind === "sep")
						return <div key={i} className={CTX_SEPARATOR_CLASS} />;
					if (entry.kind === "status") {
						return (
							<button
								key={i}
								type="button"
								className={CTX_ITEM_CLASS}
								onMouseEnter={(e) => {
									cancelClose();
									setSub({
										kind: "status",
										rect: e.currentTarget.getBoundingClientRect(),
									});
								}}
								onMouseLeave={scheduleClose}
								onClick={(e) => {
									cancelClose();
									setSub({
										kind: "status",
										rect: e.currentTarget.getBoundingClientRect(),
									});
								}}
							>
								<span className="inline-flex w-5 shrink-0 justify-center text-dim">
									<IconStatusRing size={20} />
								</span>
								<span className="flex-1">Set status</span>
								<IconChevronRight
									size={16}
									className="shrink-0 text-faint"
								/>
							</button>
						);
					}
					if (entry.kind === "snooze") {
						return (
							<button
								key={i}
								type="button"
								className={CTX_ITEM_CLASS}
								onMouseEnter={(e) => {
									cancelClose();
									setSub({
										kind: "snooze",
										rect: e.currentTarget.getBoundingClientRect(),
									});
								}}
								onMouseLeave={scheduleClose}
								onClick={(e) => {
									cancelClose();
									setSub({
										kind: "snooze",
										rect: e.currentTarget.getBoundingClientRect(),
									});
								}}
							>
								<span className="inline-flex w-5 shrink-0 justify-center text-dim">
									<IconMoon size={20} />
								</span>
								<span className="flex-1">Snooze</span>
								<IconChevronRight
									size={16}
									className="shrink-0 text-faint"
								/>
							</button>
						);
					}
					return (
						<CtxItem
							key={i}
							icon={entry.icon}
							label={entry.label}
							shortcut={entry.shortcut}
							danger={entry.danger}
							onMouseEnter={scheduleClose}
							onClick={() => {
								entry.onClick();
								onClose();
							}}
						/>
					);
				})}
			</div>
			{sub?.kind === "status" && statusEntry && (
				<div
					className={CTX_MENU_CLASS}
					style={{
						left: subLeft,
						top: subTop,
						minWidth: SUB_W,
					}}
					onClick={(e) => e.stopPropagation()}
					onMouseEnter={cancelClose}
					onMouseLeave={scheduleClose}
				>
					{MINE_STATUS_META.map((m) => (
						<CtxItem
							key={m.key}
							icon={statusMenuIcon(m.key, m.dotColor)}
							label={m.label}
							trailing={check(statusEntry.current === m.key)}
							onClick={() => {
								statusEntry.onPick(
									statusEntry.current === m.key ? null : m.key,
								);
								onClose();
							}}
						/>
					))}
					<div className={CTX_SEPARATOR_CLASS} />
					<CtxItem
						icon={<span />}
						label="Auto (default)"
						trailing={check(statusEntry.current === null)}
						onClick={() => {
							statusEntry.onPick(null);
							onClose();
						}}
					/>
				</div>
			)}
			{sub?.kind === "snooze" && snoozeEntry && (
				<div
					className={CTX_MENU_CLASS}
					style={{
						left: subLeft,
						top: subTop,
						minWidth: SUB_W,
					}}
					onClick={(e) => e.stopPropagation()}
					onMouseEnter={cancelClose}
					onMouseLeave={scheduleClose}
				>
					{snoozePresets().map((p) => (
						<CtxItem
							key={p.label}
							label={p.label}
							onClick={() => {
								snoozeEntry.onPick(p.until.toISOString());
								onClose();
							}}
						/>
					))}
					{snoozeEntry.until && (
						<>
							<div className={CTX_SEPARATOR_CLASS} />
							<CtxItem
								label="Unsnooze"
								onClick={() => {
									snoozeEntry.onPick(null);
									onClose();
								}}
							/>
						</>
					)}
				</div>
			)}
		</>,
		document.body,
	);
}

// The status glyphs, sized + colored for a menu row (no group className, so
// the menu controls sizing) — used by the "Set status" flyout. The lane and
// band headers carry no glyph of their own: they're dividers, and the rows
// under them already wear the status marks.
function statusMenuIcon(status: MineStatus, color: string) {
	const style = { color };
	if (status === "needsinput")
		return <IconMessageQuestion size={20} style={style} />;
	if (status === "inprogress") return <IconClock size={20} style={style} />;
	if (status === "review") return <IconGitMerge size={20} style={style} />;
	if (status === "merged") return <IconCheck size={20} style={style} />;
	return <IconInbox size={20} style={style} />;
}

// A run that died on a terminal failure (usage limits/credits exhausted, API
// errors) needs a human to act, exactly like a blocked question — it must not
// sink quietly into the Backlog. A live run means a retry is underway, so the
// stale flag doesn't override "In progress".
function runNeedsAttention(s: UnifiedSession): boolean {
	return !!s.lastRunError && !s.isRunning;
}

// Whether this session lives in YOUR sidebar lanes. Your own chats always do;
// automation runs and teammates' workspaces only once you claim them (the
// lane entry is the claim — see lib/lanes.ts).
function isClaimed(s: UnifiedSession): boolean {
	return !!getLane(s.id) || !!s.manualStatus;
}

// The effective human-pinned lane for a session: YOUR per-user lane
// (lib/lanes.ts) first, then the legacy global override as a fallback for
// entries set before lanes went per-user. A "mine" claim forces nothing — the
// row keeps following its live state — so it reads as no pin at all.
function pinnedLane(s: UnifiedSession): MineStatus | undefined {
	const lane = getLane(s.id);
	if (lane === "mine") return undefined;
	return lane ?? s.manualStatus;
}

// A row you started yourself (automation runs are never "yours" — they arrive
// in the Automations band and need claiming to join your lanes).
function ownedBy(s: UnifiedSession, user: string): boolean {
	return (
		!s.automation &&
		!!s.startedBy &&
		s.startedBy.toLowerCase() === user.toLowerCase()
	);
}

function mineStatus(s: UnifiedSession): MineStatus {
	// A blocked question (or a run that died on an error) needs a human right
	// now — surface it above everything else, even a manual pin or an open PR, so
	// it never hides inside another bucket. This state is transient (it clears the
	// moment the question is answered / the run recovers), so it doesn't stomp the
	// manual pin permanently — it just floats above it while live.
	if (s.waitingForInput || runNeedsAttention(s)) return "needsinput";
	// A human-pinned lane wins over the live run state below.
	const lane = pinnedLane(s);
	if (lane) return lane;
	if (s.isRunning) return "inprogress";
	// Everything else is idle-but-unfinished. PR lifecycle belongs in the review
	// UI, not the workspace state shown in the sidebar. Finishing a session is an
	// explicit act (Archive), never inferred from a merged PR or inactivity.
	return "pending";
}

// PR state overrides the manual review bands. A merged PR means the work is
// done and falls into the "Done" status lane. An approved-but-unmerged PR means
// the review has landed, so the row leaves the sidebar until another review is
// requested. Without this a session you sent out sits in "Awaiting review"
// forever, since the band otherwise only clears on a manual accept.
// A chat that shipped one feature as several PRs has only landed once they all
// have: keying off the primary branch's PR alone drops the row into Done with
// three PRs still open. Single-PR chats keep the exact old behaviour.
function wsPrMerged(r: { chats: UnifiedSession[] }): boolean {
	return r.chats.some(sessionPrMerged);
}
function wsPrApproved(r: { chats: UnifiedSession[] }): boolean {
	return !wsPrMerged(r) && r.chats.some(sessionPrApproved);
}
// Has `person` (lowercase person key) already given their review on the row's
// PR? Their latest submitted review counts whatever the outcome — approve,
// request changes, or comment — unless the author re-requested them since:
// a pending re-request puts the PR back in their queue, matching GitHub's own
// requested-reviewers behavior. Keeps "Needs review" honest when the reviewer
// reviewed on GitHub instead of clicking "Mark as reviewed".
function wsPrReviewGivenBy(
	r: { chats: UnifiedSession[] },
	person: string,
): boolean {
	const has = (list?: string[]) =>
		(list || []).some((p) => p.toLowerCase() === person);
	return (
		r.chats.some((c) => has(c.prReviewedBy)) &&
		!r.chats.some((c) => has(c.prReviewRequested))
	);
}

// Since the PR-queue dissolution the status lanes carry the PR lifecycle too,
// but only one promotion: a green, mergeable, non-draft PR parks its idle row
// in Ready to merge ("review"). Every other open PR — conflicts, failing
// checks, changes requested, drafts, awaiting review — stays in Backlog with
// the red/yellow PR glyph carrying the problem, so In progress keeps meaning
// "a run is live". Returns null to leave the derived lane alone.
function prLaneForChats(chats: UnifiedSession[]): MineStatus | null {
	const chat = frontingPrChat(chats);
	if (!chat || chat.prState !== "OPEN" || chat.prIsDraft) return null;
	const checks = chat.prChecks;
	const ready =
		(!checks || checks.total === 0 || (checks.failed === 0 && checks.pending === 0)) &&
		chat.prMergeable !== "CONFLICTING" &&
		chat.prReviewDecision !== "CHANGES_REQUESTED";
	return ready ? "review" : null;
}

const EXPANDED_KEY = "opensession-sidebar-expanded";

const DEFAULT_EXPANDED = [
	"recently",
	"pinned",
	"needsreview",
	"awaitingreview",
	"status:needsinput",
	"status:merged",
	"status:pending",
	"status:review",
	"status:inprogress",
	"status:snoozed",
];

function readExpanded(): Set<string> {
	try {
		return new Set(
			JSON.parse(
				localStorage.getItem(EXPANDED_KEY) || JSON.stringify(DEFAULT_EXPANDED),
			),
		);
	} catch {
		return new Set(DEFAULT_EXPANDED);
	}
}

// ── Grouping / filtering controls (the filter popover) ─────────────────────
// The sidebar can be organized several ways ("Group by": Status, Repo as a
// flat Conductor-style list, Repo and status with lanes nested per repo,
// Repo and inbox with the activity bands nested per repo instead, Recently
// opened, or Inbox — an email-style flat list of two-line rows banded by
// activity), narrowed to a single repo ("Repo") or a single person
// ("Person"), and ordered by recency of activity or creation ("Sort by"). The
// choices persist together per browser; the default grouping is repo + status.
type GroupBy =
	| "status"
	| "repo"
	| "repo-status"
	| "repo-inbox"
	| "recently"
	| "inbox";
type SortBy = "updated" | "created";
// Session-less PR rows folded into the project lanes: the default shows your
// own PRs + explicit review requests (the retired PR band's default sources),
// "all" widens to everyone's open PRs (incl. automation output), "none" hides
// PR rows entirely.
type PrsFilter = "default" | "all" | "none";
const DEFAULT_PROJECT = DEFAULT_REPO_ID;
const FILTER_KEY = "opensession-sidebar-filter";
// Bumped when the default grouping changes. Because setFilter persists the
// whole state, a stored "status" from before v2 is ambiguous — most people got
// it by touching Repo or Person, not by choosing it — so a pre-v2 blob keeps
// its repo/person/sort but takes the new default grouping once. Anything
// written after that carries v2 and is honoured verbatim.
const FILTER_VERSION = 2;
const DEFAULT_GROUP_BY: GroupBy = "repo-status";

interface FilterState {
	groupBy: GroupBy;
	repo: string; // a repo id, or "all"
	// "me" (your workspaces — the default), "everyone" (literally all
	// workspaces), "unassigned" (the aggregate backlog view), or a lowercased
	// person key for a specific teammate.
	person: string;
	sort: SortBy;
	prs: PrsFilter;
}

function readFilter(): FilterState {
	try {
		const v = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
		const chosen = v.v === FILTER_VERSION;
		return {
			groupBy:
				v.groupBy === "repo" ||
				v.groupBy === "repo-status" ||
				v.groupBy === "repo-inbox" ||
				v.groupBy === "recently" ||
				v.groupBy === "inbox" ||
				(chosen && v.groupBy === "status")
					? v.groupBy
					: DEFAULT_GROUP_BY,
			repo: typeof v.repo === "string" ? v.repo : "all",
			// Legacy stored "all" behaved as "you" in the lanes — map it to "me"
			// so nobody's default flips to everyone.
			person:
				typeof v.person === "string" && v.person && v.person !== "all"
					? v.person
					: "me",
			sort: v.sort === "created" ? "created" : "updated",
			prs: v.prs === "all" || v.prs === "none" ? v.prs : "default",
		};
	} catch {
		return {
			groupBy: DEFAULT_GROUP_BY,
			repo: "all",
			person: "me",
			sort: "updated",
			prs: "default",
		};
	}
}

function sessionRepo(s: UnifiedSession): string {
	// Repo-less feed/scratch chats file under their feed's kind ("tella") so
	// they don't mislabel as the default repo (the feeds design).
	return s.repo || s.externalRefs?.[0]?.kind || DEFAULT_PROJECT;
}

// Every `repo\nbranch` key a chat's work can be reached by: its own checkout
// plus each PR / attached-repo / linked-PR ref it carries. Matching chats to
// the open-PR list runs through this, so the PR-row dedupe and the live-review
// lookup below can't drift apart.
function chatPrKeys(c: UnifiedSession): string[] {
	const keys = c.branch ? [`${sessionRepo(c)}\n${c.branch}`] : [];
	for (const ref of [
		...(c.prs || []),
		...(c.attachedRepos || []),
		...(c.linkedPrs || []),
	])
		keys.push(`${ref.repo}\n${ref.branch}`);
	return keys;
}


export const Sidebar = React.forwardRef<SidebarHandle, Props>(function Sidebar({
	sessions,
	localMode,
	cloudUnreachable,
	workspaceDataReady,
	projects,
	notes,
	selectedId,
	activeNoteId,
	notesActive,
	onOpenNotes,
	homeActive,
	onOpenHome,
	tasksActive,
	onOpenTasks,
	taskCount = 0,
	onOpenAutomation,
	onOpenPrItem,
	selectedWorkspaceId = null,
	prTinderActive,
	onOpenPrTinder,
	supportTinderActive,
	onOpenSupportTinder,
	reportsActive,
	onOpenReports,
	analyticsActive,
	onOpenAnalytics,
	deskActive,
	onOpenDesk,
	noteActivity = {},
	onSelect,
	onOpenReview,
	onOpenTicket,
	onOpenFeedItem,
	onNewSession,
	onNewSessionInRepo,
	onOpenProject,
	onRenameProject,
	onDeleteProject,
	onOpenNote,
	onOpenArchived,
	archivedActive,
	onOpenCatchUp,
	catchUpActive,
	onArchive,
	onArchiveWorkspace,
	onUnarchiveWorkspace,
	onRename,
	onSetStatus,
	teamViewing = [],
	headerActionsEl = null,
	onToast,
}, ref) {
	const isPhone = useIsPhone();
	const [search, setSearch] = useState("");
	// Groups are collapsed by default; the expanded set persists per browser
	const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
	const [hiddenTools, setHiddenTools] = useState(readHiddenSidebarTools);
	const [hiddenFeeds, setHiddenFeeds] = useState(readHiddenSidebarFeeds);
	const [sidebarOrder, setSidebarOrder] = useState(getSidebarOrder);
	useEffect(
		() => onSidebarOrderChanged(() => setSidebarOrder(getSidebarOrder())),
		[],
	);
	// Tools stay at flex order 0, so only these bands move beneath it.
	const sectionOrder = (section: (typeof sidebarOrder)[number]) =>
		sidebarOrder.indexOf(section) + 1;
	const [savedRepoOrder, setSavedRepoOrder] = useState(getRepoOrder);
	useEffect(
		() => onRepoOrderChanged(() => setSavedRepoOrder(getRepoOrder())),
		[],
	);
	const [repoOrderDraft, setRepoOrderDraft] = useState<string[] | null>(null);
	const repoOrderAtDragStart = useRef<string[] | null>(null);
	const repoOrderPending = useRef<string[] | null>(null);
	const repoVisualOrder = useRef<string[] | null>(null);
	const repoDragging = useRef<string | null>(null);
	const [repoDragKey, setRepoDragKey] = useState<string | null>(null);
	const repoAutoScrollFrame = useRef<number | null>(null);
	const repoAutoScrollSpeed = useRef(0);
	const repoAutoScrollContainer = useRef<HTMLElement | null>(null);
	const repoJustDragged = useRef(false);
	const stopRepoAutoScroll = () => {
		if (repoAutoScrollFrame.current !== null)
			cancelAnimationFrame(repoAutoScrollFrame.current);
		repoAutoScrollFrame.current = null;
		repoAutoScrollSpeed.current = 0;
		repoAutoScrollContainer.current = null;
	};
	const tickRepoAutoScroll = () => {
		const container = repoAutoScrollContainer.current;
		if (!container || repoAutoScrollSpeed.current === 0) {
			repoAutoScrollFrame.current = null;
			return;
		}
		container.scrollTop += repoAutoScrollSpeed.current;
		repoAutoScrollFrame.current = requestAnimationFrame(tickRepoAutoScroll);
	};
	const handleRepoAutoScroll = (event: React.DragEvent<HTMLDivElement>) => {
		if (!repoDragging.current) return;
		event.preventDefault();
		const container = event.currentTarget;
		const rect = container.getBoundingClientRect();
		const edge = Math.min(96, rect.height * 0.18);
		const fromTop = event.clientY - rect.top;
		const fromBottom = rect.bottom - event.clientY;
		const maxSpeed = 18;
		let speed = 0;
		if (fromTop < edge)
			speed = -Math.ceil(maxSpeed * (1 - Math.max(0, fromTop) / edge));
		else if (fromBottom < edge)
			speed = Math.ceil(maxSpeed * (1 - Math.max(0, fromBottom) / edge));
		if (speed === 0) {
			stopRepoAutoScroll();
			return;
		}
		repoAutoScrollContainer.current = container;
		repoAutoScrollSpeed.current = speed;
		if (repoAutoScrollFrame.current === null)
			repoAutoScrollFrame.current = requestAnimationFrame(tickRepoAutoScroll);
	};
	useEffect(
		() => () => {
			if (repoAutoScrollFrame.current !== null)
				cancelAnimationFrame(repoAutoScrollFrame.current);
		},
		[],
	);
	const [pins, setPins] = useState<string[]>(getPins);
	// Per-user workspace snoozes (row key → ISO until). An overlay like pins:
	// actively-snoozed rows park in the Snoozed section; the wake sweep below
	// prunes lapsed entries and marks their rows unread.
	const [snoozes, setSnoozesState] = useState<Record<string, string>>(
		getSnoozes,
	);
	// Per-user sidebar hides (row key → ISO hidden-at). The personal
	// counterpart to Archive, which is global: a hidden row leaves only THIS
	// user's sidebar, and the chat keeps running for everyone else.
	const [hides, setHidesState] = useState<Record<string, string>>(getHides);
	// Drag-to-reorder in the Pinned band. onReorder fires continuously during a
	// drag, so the in-flight order lives in local state (pinOrderDraft) and only
	// commits to the pins store on drop — mirroring the composer queue's pattern.
	// pinDragKey marks the floating row (background + stacking); pinJustDragged
	// swallows the click that lands on the row right after a drop.
	const [pinOrderDraft, setPinOrderDraft] = useState<string[] | null>(null);
	const pinOrderPending = useRef<string[] | null>(null);
	const [pinDragKey, setPinDragKey] = useState<string | null>(null);
	const pinJustDragged = useRef(false);
	// Drag-into-lane: while a Pinned row is mid-drag, the status lanes below
	// double as drop targets (per-repo lanes only for the row's own repo).
	// pinDragMeta carries the dragged entry's chats/repo/pin keys; laneDropHover
	// marks the lane under the pointer. Both keep a ref twin so the drag-end
	// commit never reads a stale closure mid-batch.
	type PinDragMeta = {
		repo: string | null;
		chats: UnifiedSession[];
		pinKeys: string[];
	};
	type LaneDropTarget = { gkey: string; lane: MineStatus };
	const [pinDragMeta, setPinDragMeta] = useState<PinDragMeta | null>(null);
	const pinDragMetaRef = useRef<PinDragMeta | null>(null);
	const [laneDropHover, setLaneDropHover] = useState<LaneDropTarget | null>(
		null,
	);
	const laneDropHoverRef = useRef<LaneDropTarget | null>(null);

	// Hit-test the pointer against the lane drop targets below the Pinned band
	// (they carry data-lane-* attributes while a drag is live). Geometric rect
	// checks instead of elementFromPoint — the dragged row itself rides under
	// the pointer and would swallow the hit.
	function updateLaneDropHover(clientX: number, clientY: number) {
		const meta = pinDragMetaRef.current;
		let next: LaneDropTarget | null = null;
		if (meta && meta.chats.length > 0) {
			const targets =
				sidebarScrollRef.current?.querySelectorAll<HTMLElement>(
					"[data-lane-drop]",
				) ?? [];
			for (const el of targets) {
				const r = el.getBoundingClientRect();
				const inside =
					clientX >= r.left &&
					clientX <= r.right &&
					clientY >= r.top &&
					clientY <= r.bottom;
				if (!inside) continue;
				// Per-repo lanes only take rows of their own repo; the global
				// lanes (no data-lane-repo) take anything.
				const laneRepo = el.dataset.laneRepo || "";
				if (laneRepo && laneRepo !== meta.repo) continue;
				next = {
					gkey: el.dataset.laneDrop!,
					lane: el.dataset.laneStatus as MineStatus,
				};
				break;
			}
		}
		if (laneDropHoverRef.current?.gkey !== next?.gkey) {
			laneDropHoverRef.current = next;
			setLaneDropHover(next);
		}
	}
	const [recents, setRecents] = useState<string[]>(getRecents);
	// Per-session last-read marks, driving the unread dot. Kept in sync via the
	// same event the viewer fires when it marks a session read.
	const [reads, setReads] = useState(getReads);
	const currentUser = useCurrentUser();
	const meUser = currentUser;
	// Team directory (GET /api/people) — the always-on People band roster.
	const roster = usePeople();
	// The same roster with live status attached, for the Home entry's face pile.
	const team = useTeamPresence({ sessions, teamViewing, currentUser });
	// Per-person latest session + any-running, keyed by lowercased first name —
	// what a People row shows when the person isn't live right now.
	const personActivity = useMemo(() => {
		const m = new Map<
			string,
			{ id: string; title: string; last: string; running: boolean }
		>();
		for (const s of sessions) {
			if (s.archived || s.sideChatOf || s.automation) continue;
			const key = (s.startedBy || "").toLowerCase();
			if (!key) continue;
			const cur = m.get(key);
			const running = (cur?.running ?? false) || s.isRunning === true;
			if (!cur || (s.lastActivity || "") > cur.last) {
				m.set(key, {
					id: s.id,
					title: s.title || "",
					last: s.lastActivity || "",
					running,
				});
			} else if (running !== cur.running) {
				m.set(key, { ...cur, running });
			}
		}
		return m;
	}, [sessions]);
	// Note-read stamps live in localStorage; bump to recompute the rows when
	// the viewer marks a session's notes read.
	const [noteReadsRev, setNoteReadsRev] = useState(0);
	useEffect(
		() => onNoteReadsChanged(() => setNoteReadsRev((r) => r + 1)),
		[],
	);
	useEffect(
		() => onSidebarToolsChanged(() => setHiddenTools(readHiddenSidebarTools())),
		[],
	);
	useEffect(
		() => onSidebarFeedsChanged(() => setHiddenFeeds(readHiddenSidebarFeeds())),
		[],
	);
	const sidebarScrollRef = useRef<HTMLDivElement>(null);

	// CSS has no interoperable :stuck selector. Track the shared sidebar
	// scrollport instead so section/lane labels can stay transparent in-flow and
	// gain an opaque surface only while position:sticky is actively pinning them.
	useLayoutEffect(() => {
		const root = sidebarScrollRef.current;
		if (!root) return;
		let frame = 0;
		const selector = [
			".sidebar-sticky-head",
			".sidebar-status-group > .sidebar-group-header",
			".sidebar-group--pinned > .sidebar-group-header",
			".sidebar-group--review > .sidebar-group-header",
			".sidebar-repo-group > .sidebar-repo-head",
		].join(",");

		const update = () => {
			frame = 0;
			const rootTop = root.getBoundingClientRect().top;
			root.querySelectorAll<HTMLElement>(selector).forEach((header) => {
				const style = getComputedStyle(header);
				const parent = header.parentElement;
				if (style.position !== "sticky" || !parent) {
					header.classList.remove("is-stuck");
					return;
				}
				const stickyTop = Number.parseFloat(style.top) || 0;
				const rect = header.getBoundingClientRect();
				const pinned = rect.top <= rootTop + stickyTop + 0.5;
				// Pin-line position alone also matches a header that naturally
				// RESTS at its sticky offset (the first section at scrollTop 0 —
				// the solid-pill-while-unscrolled bug), so additionally require
				// real displacement from the parent. All of these headers sit
				// flush with their parent's top in static layout, so a positive
				// delta means sticky is actively holding the header back. (Don't
				// try offsetTop for this: Chromium reports the displaced sticky
				// position there, not static layout.)
				const displaced =
					rect.top - parent.getBoundingClientRect().top > 1.5;
				header.classList.toggle("is-stuck", pinned && displaced);
			});
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};

		update();
		root.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		const resizeObserver = new ResizeObserver(schedule);
		resizeObserver.observe(root);
		const mutationObserver = new MutationObserver(schedule);
		mutationObserver.observe(root, { childList: true, subtree: true });

		return () => {
			root.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			resizeObserver.disconnect();
			mutationObserver.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	}, []);

	// Filter popover (group by / repo / sort) — its choices persist together.
	const [filter, setFilterState] = useState<FilterState>(readFilter);
	const [filterOpen, setFilterOpen] = useState(false);
	const filterBtnRef = useRef<HTMLButtonElement>(null);
	// The phone stand-in for the header filter button (portaled into the top
	// bar next to Search). The popover anchors to whichever button is live.
	const mobileFilterBtnRef = useRef<HTMLButtonElement>(null);
	function setFilter(patch: Partial<FilterState>) {
		setFilterState((prev) => {
			const next = { ...prev, ...patch };
			localStorage.setItem(
				FILTER_KEY,
				JSON.stringify({ ...next, v: FILTER_VERSION }),
			);
			return next;
		});
	}

	// The active repo-filter chip prefers to sit inline in the "My sessions"
	// header (right after the title); it drops to its own row only when the
	// sidebar is too narrow to fit it there. `repoInline` is decided by measuring
	// the header against an off-layout probe copy of the chip, so toggling it can't
	// feed back into the measurement (title/actions/probe widths don't depend on
	// where the real chip lands).
	const [repoInline, setRepoInline] = useState(true);
	const headRef = useRef<HTMLDivElement>(null);
	const titleRef = useRef<HTMLSpanElement>(null);
	const actionsRef = useRef<HTMLDivElement>(null);
	const probeRef = useRef<HTMLSpanElement>(null);
	// Client-observed run starts, keyed by workspace-row key — the fallback when
	// the server hasn't stamped runStartedAt yet (external CLI runs, or the brief
	// gap between isRunning flipping via WS and the next sessions poll). Entries
	// are pruned once a row stops running so a later run starts its clock fresh.
	const runStartSeen = useRef<Map<string, number>>(new Map());
	useLayoutEffect(() => {
		if (filter.repo === "all") return;
		const measure = () => {
			const head = headRef.current;
			const title = titleRef.current;
			const actions = actionsRef.current;
			const probe = probeRef.current;
			if (!head || !title || !actions || !probe) return;
			const GAP = 6; // .sidebar-workspace-head gap
			const MARGIN = 8; // breathing room so it never crowds the buttons
			const avail =
				head.clientWidth -
				title.offsetWidth -
				actions.offsetWidth -
				GAP * 2 -
				MARGIN;
			setRepoInline(probe.offsetWidth <= avail);
		};
		measure();
		const ro = new ResizeObserver(measure);
		if (headRef.current) ro.observe(headRef.current);
		return () => ro.disconnect();
		// filter.person changes the title text ("X's workspaces"), so re-measure.
	}, [filter.repo, filter.person]);

	useEffect(() => onPinsChanged(() => setPins(getPins())), []);
	useEffect(() => onSnoozesChanged(() => setSnoozesState(getSnoozes())), []);
	useEffect(() => onHidesChanged(() => setHidesState(getHides())), []);
	// Per-user lanes (lib/lanes.ts). mineStatus/pinnedLane read the lib cache
	// directly; this state exists to re-render (and re-derive the memos below)
	// when your lanes change.
	const [lanes, setLanesState] = useState<Record<string, string>>(getLanes);
	useEffect(() => onLanesChanged(() => setLanesState(getLanes())), []);
	useEffect(() => onRecentsChanged(() => setRecents(getRecents())), []);
	useEffect(() => onReadsChanged(() => setReads(getReads())), []);
	// Re-render when a composer draft appears/disappears — rows check hasDraft()
	// during render to show the Slack-style "unsent draft" pencil.
	const [, setDraftsRev] = useState(0);
	useEffect(() => onDraftsChanged(() => setDraftsRev((v) => v + 1)), []);
	// Opt-in "last used" time badge on workspace rows (off / always / on hover).
	const [wsTimePref, setWsTimePref] = useState(getWsTimePref);
	useEffect(() => onWsTimeChanged(() => setWsTimePref(getWsTimePref())), []);

	// Right-click menu on a workspace row (mark unread / pin / status / rename /
	// copy link / delete), and inline rename (double-click the project name).
	const [projectMenu, setProjectMenu] = useState<{
		id: string;
		x: number;
		y: number;
	} | null>(null);
	const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
	const [projectDraft, setProjectDraft] = useState("");
	function commitProjectRename() {
		if (editingProjectId) {
			const name = projectDraft.trim();
			if (name) onRenameProject(editingProjectId, name);
		}
		setEditingProjectId(null);
	}
	// Inline rename for workspace-less rows (slack/linear/solo chats). These
	// used window.prompt(), which iOS standalone PWAs silently suppress —
	// Rename tapped, nothing happened. Same inline editor as workspace rows;
	// an empty commit clears the manual title back to the derived one.
	const [editingChatId, setEditingChatId] = useState<string | null>(null);
	const [chatDraft, setChatDraft] = useState("");
	function startChatRename(chat: { id: string; title: string }) {
		setChatDraft(chat.title);
		setEditingChatId(chat.id);
	}
	function commitChatRename(chat: UnifiedSession) {
		if (editingChatId) onRename(chat, chatDraft.trim());
		setEditingChatId(null);
	}
	/** Is this row's title currently being inline-edited (workspace or chat)? */
	function rowRenameEditing(row: WsRow): boolean {
		return row.workspace
			? editingProjectId === row.workspace.id
			: !!row.chats[0] && editingChatId === row.chats[0].id;
	}
	useEffect(() => {
		if (!projectMenu) return;
		const close = () => setProjectMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [projectMenu]);

	// The Archived row counts *my* archived sessions (the current user's), and honors
	// the active repo filter — same lens as the archived page it opens.
	const archivedCount = useMemo(() => {
		const user = currentUser.toLowerCase();
		return sessions.filter(
			(s) =>
				s.archived &&
				!s.automation &&
				s.startedBy &&
				s.startedBy.toLowerCase() === user &&
				(filter.repo === "all" || sessionRepo(s) === filter.repo),
		).length;
	}, [sessions, currentUser, filter.repo]);

	// Catch-up badge: how many of *my* unread workspaces the deck would walk
	// through (distinct workspace groups, same grouping the deck uses) — so the
	// count matches the "N Left" it opens on.
	const catchUpCount = useMemo(() => {
		const user = currentUser.toLowerCase();
		const groups = new Set<string>();
		for (const s of sessions) {
			if (s.archived || s.automation) continue;
			if (!s.startedBy || s.startedBy.toLowerCase() !== user) continue;
			if (!isUnread(s.id, s.lastActivity, reads)) continue;
			groups.add(s.projectId ? `ws:${s.projectId}` : `chat:${s.id}`);
		}
		return groups.size;
	}, [sessions, currentUser, reads]);

	// The repo-wide open-PR list (every open PR, session or not), from the
	// server's batched cache. Null until the first fetch lands — the rows memo
	// falls back to session-derived PRs so the section still renders if the
	// endpoint is unreachable.
	const [openPrs, setOpenPrs] = useState<OpenPr[] | null>(null);
	const prCloseGeneration = useRef(0);
	const closedPrTombstones = useRef(new Map<string, number>());
	const openPrRequestSequence = useRef(0);
	const latestOpenPrResponse = useRef(0);
	useEffect(() => {
		let alive = true;
		const load = () => {
			const requestSequence = ++openPrRequestSequence.current;
			const requestGeneration = prCloseGeneration.current;
			return (
				fetchOpenPrs()
					.then((prs) => {
						if (!alive) return;
						if (requestSequence < latestOpenPrResponse.current) return;
						latestOpenPrResponse.current = requestSequence;
						for (const [url, closeGeneration] of closedPrTombstones.current) {
							if (closeGeneration <= requestGeneration)
								closedPrTombstones.current.delete(url);
						}
						setOpenPrs(
							prs.filter((pr) => !closedPrTombstones.current.has(pr.url)),
						);
					})
					.catch(() => {})
			);
		};
		load();
		const onReviewSubmitted = () => void load();
		window.addEventListener(PR_REVIEW_SUBMITTED_EVENT, onReviewSubmitted);
		// The response is backed by the server's PR cache, but also carries live
		// OpenSession review state. Poll it often enough that a PR moves in and out
		// of "Review running" promptly without triggering extra GitHub requests.
		const t = setInterval(load, 15_000);
		return () => {
			alive = false;
			clearInterval(t);
			window.removeEventListener(PR_REVIEW_SUBMITTED_EVENT, onReviewSubmitted);
		};
	}, []);
	useEffect(() => {
		const onClosed = (event: Event) => {
			const { repo, branch, url } = (event as CustomEvent<PrClosedDetail>).detail;
			if (url) {
				prCloseGeneration.current++;
				closedPrTombstones.current.set(url, prCloseGeneration.current);
			}
			setOpenPrs((current) =>
				current?.filter(
					(pr) =>
						!(url && pr.url === url) &&
						!(!url && repo === pr.repo && branch === pr.branch),
				) ?? null,
			);
		};
		window.addEventListener(PR_CLOSED_EVENT, onClosed);
		return () => window.removeEventListener(PR_CLOSED_EVENT, onClosed);
	}, []);

	// Generic feed bands (Tella videos, … — the feeds design): descriptors
	// once on mount. Hidden feeds remain available to Settings but do not poll.
	const [feeds, setFeeds] = useState<FeedDescriptor[]>([]);
	const [feedItems, setFeedItems] = useState<Record<string, FeedItem[]>>({});
	useEffect(() => {
		let alive = true;
		fetchFeeds()
			.then((descriptors) => {
				if (!alive) return;
				setFeeds(descriptors);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	const visibleFeeds = useMemo(
		() => feeds.filter((feed) => !hiddenFeeds.has(feed.id)),
		[feeds, hiddenFeeds],
	);

	// The Support queue now arrives through the generic feeds poll: the plain
	// feed's items carry the full SupportThreadSummary in meta, so all the
	// bespoke Support UI (SupportRow, filters, Tinder hand-offs) keeps working
	// off the same derived shape (the feeds design W5).
	const supportThreads = useMemo<SupportThread[] | null>(() => {
		const items = feedItems["plain"];
		if (!items) return null;
		return items.map((i) => i.meta as unknown as SupportThread);
	}, [feedItems]);

	// Newest live session per feed item (keyed `<kind>:<id>`) — a feed row with
	// one wears that session's status dot.
	const feedSessionByRef = useMemo(() => {
		const m = new Map<string, UnifiedSession>();
		for (const s of sessions) {
			if (s.archived || !s.externalRefs?.length) continue;
			for (const r of s.externalRefs) {
				const key = `${r.kind}:${r.id}`;
				const prev = m.get(key);
				if (!prev || s.lastActivity > prev.lastActivity) m.set(key, s);
			}
		}
		return m;
	}, [sessions]);

	// Per-feed filter selections (generic — see FeedFilterMenu). Arg-mode
	// changes refetch that feed immediately; meta/builtin ones just re-derive.
	const [feedFilters, setFeedFiltersState] = useState<
		Record<string, FeedFilterValues>
	>(readFeedFilters);
	const feedFiltersRef = useRef(feedFilters);
	feedFiltersRef.current = feedFilters;
	const argFiltersFor = (feed: FeedDescriptor, all = feedFiltersRef.current) =>
		Object.fromEntries(
			(feed.filters || [])
				.filter((f) => f.mode !== "meta")
				.map((f) => [f.key, (all[feed.id] || {})[f.key] || ""])
				.filter(([, v]) => v),
		) as Record<string, string>;
	const setFeedFilter = (feed: FeedDescriptor, key: string, value: string) => {
		setFeedFiltersState((prev) => {
			const next = {
				...prev,
				[feed.id]: { ...(prev[feed.id] || {}), [key]: value },
			};
			try {
				localStorage.setItem(FEED_FILTERS_KEY, JSON.stringify(next));
			} catch {}
			const spec = (feed.filters || []).find((f) => f.key === key);
			if (spec && spec.mode !== "meta")
				fetchFeedItems(feed.id, argFiltersFor(feed, next))
					.then((items) =>
						setFeedItems((p) => ({ ...p, [feed.id]: items })),
					)
					.catch(() => {});
			return next;
		});
	};
	// Items use the same gentle 60s cadence as Support (the server caches ~60s).
	// Re-enabling a source loads it immediately; hiding one tears its timer down.
	useEffect(() => {
		if (visibleFeeds.length === 0) return;
		let alive = true;
		const load = () => {
			for (const feed of visibleFeeds) {
				fetchFeedItems(feed.id, argFiltersFor(feed))
					.then((items) => {
						if (alive)
							setFeedItems((prev) => ({ ...prev, [feed.id]: items }));
					})
					.catch(() => {});
			}
		};
		load();
		const timer = setInterval(load, 60_000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [visibleFeeds]);

	// Newest live session per Plain thread — a Support row with one opens that
	// session instead of the session-less ticket preview.
	const supportSessionByThread = useMemo(() => {
		const m = new Map<string, UnifiedSession>();
		for (const s of sessions) {
			if (s.archived || !s.plainThreadId) continue;
			const prev = m.get(s.plainThreadId);
			if (!prev || s.lastActivity > prev.lastActivity)
				m.set(s.plainThreadId, s);
		}
		return m;
	}, [sessions]);

	// Distinct repos across the (non-archived) sessions, most-used first, for the
	// Repo filter dropdown. Built off every session (not the search-filtered set)
	// so the options don't churn while you type.
	const discoveredRepos = useMemo(() => {
		const counts = new Map<string, number>();
		for (const s of sessions) {
			if (s.archived) continue;
			const p = sessionRepo(s);
			counts.set(p, (counts.get(p) || 0) + 1);
		}
		for (const pr of openPrs || [])
			counts.set(pr.repo, (counts.get(pr.repo) || 0) + 1);
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([name]) => name);
	}, [sessions, openPrs]);
	const repos = useMemo(
		() => mergeRepoOrder(repoOrderDraft ?? savedRepoOrder, discoveredRepos),
		[repoOrderDraft, savedRepoOrder, discoveredRepos],
	);
	const completeRepoOrder = useMemo(() => {
		const next = normalizeRepoOrder(savedRepoOrder);
		const seen = new Set(next);
		for (const repo of discoveredRepos) {
			if (!seen.has(repo)) {
				seen.add(repo);
				next.push(repo);
			}
		}
		return next;
	}, [savedRepoOrder, discoveredRepos]);
	useEffect(() => {
		if (
			savedRepoOrder.length > 0 &&
			JSON.stringify(completeRepoOrder) !== JSON.stringify(savedRepoOrder)
		)
			setRepoOrder(completeRepoOrder);
	}, [savedRepoOrder, completeRepoOrder]);

	// Distinct people who started sessions, most-active first, for the Person
	// filter dropdown. Only recognized teammates (see KNOWN_PEOPLE) are offered;
	// keyed by lowercased name to merge casing, with the first-seen spelling as
	// the display label. Built off every session so options don't churn on search.
	const people = useMemo(() => {
		const entries = new Map<string, { label: string; count: number }>();
		for (const s of sessions) {
			if (s.archived || s.automation || !s.startedBy) continue;
			const key = s.startedBy.toLowerCase();
			if (!KNOWN_PEOPLE.has(key)) continue;
			const e = entries.get(key) || { label: s.startedBy, count: 0 };
			e.count++;
			entries.set(key, e);
		}
		for (const pr of openPrs || []) {
			if (!pr.person || entries.has(pr.person)) continue;
			const label =
				TEAM.find((name) => name.toLowerCase() === pr.person) || pr.person;
			entries.set(pr.person, { label, count: 1 });
		}
		return Array.from(entries.entries())
			.sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
			.map(([key, { label }]) => ({ key, label }));
	}, [sessions, openPrs]);

	// Every non-archived chat, narrowed by the repo/person filters and search.
	// Rows are built per-workspace below; a chat matching the filter surfaces its
	// whole workspace row.
	const filtered = useMemo(() => {
		let visible = sessions.filter((s) => !s.archived);
		if (filter.repo !== "all") {
			// A workspace can span repos, and a chat's own repo is just the
			// checkout it runs from — so a chat also matches when its workspace
			// is the filtered repo. Without this, narrowing to a repo hides the
			// very workspaces that belong to it.
			const wsRepo = new Map(projects.map((p) => [p.id, p.repo]));
			visible = visible.filter(
				(s) =>
					sessionRepo(s) === filter.repo ||
					(!!s.projectId && wsRepo.get(s.projectId) === filter.repo),
			);
		}
		// Only a specific teammate narrows the chats themselves. "me" and
		// "everyone" keep every chat so workspace rows stay whole (your
		// workspaces can contain teammates' chats, and pinned rows survive) —
		// the owner lens is applied per-row in focusWsRows instead.
		if (
			filter.person !== "me" &&
			filter.person !== "everyone" &&
			filter.person !== "unassigned"
		)
			visible = visible.filter(
				(s) =>
					!s.automation &&
					!!s.startedBy &&
					s.startedBy.toLowerCase() === filter.person,
			);
		if (!search) return visible;
		const q = search.toLowerCase();
		return visible.filter(
			(s) =>
				s.title.toLowerCase().includes(q) ||
				(s.branch || "").toLowerCase().includes(q) ||
				(s.startedBy || "").toLowerCase().includes(q) ||
				(s.automation || "").toLowerCase().includes(q),
		);
	}, [sessions, projects, search, filter.repo, filter.person]);

	// Sort order applied to every group's items: newest activity or newest
	// creation first. Groups read from this pre-sorted list so ordering is uniform.
	const sorted = useMemo(() => {
		const key = filter.sort === "created" ? "createdAt" : "lastActivity";
		return [...filtered].sort(
			(a, b) => new Date(b[key]).getTime() - new Date(a[key]).getTime(),
		);
	}, [filtered, filter.sort]);

	// PRs with an automated OpenSession review in flight, keyed `repo\nbranch`
	// — the same signal the PR rows spell out as "Review running". The review
	// itself runs in a `bks-ghpr-*` chat that lives in the Automations band, so
	// the workspace lanes below can't see it in their own chats.
	const activeReviewPrKeys = useMemo(() => {
		const keys = new Set<string>();
		for (const pr of openPrs || [])
			if (pr.reviewActive) keys.add(`${pr.repo}\n${pr.branch}`);
		return keys;
	}, [openPrs]);

	// ── Workspace rows ──────────────────────────────────────────────────────
	// The sidebar's main list is Workspaces (not individual chats): one row per
	// workspace, plus one implicit row per not-yet-wrapped standalone chat (the
	// pre-migration case — the data migration wraps those 1:1). A row's status
	// dot is derived from its most urgent chat; clicking opens the first chat.
	interface WsRow {
		/** Pin/menu key: `workspace:<id>` for real workspaces, the chat id solo. */
		key: string;
		/** Real workspace record, or null for an implicit single-chat row. */
		workspace: Project | null;
		name: string;
		chats: UnifiedSession[]; // createdAt asc — chats[0] is "the first chat"
		status: MineStatus;
		lastActivity: string;
		createdAt: string;
		unread: boolean;
		running: boolean;
		/** Lowercased owner (workspace creator, else the first chat's starter). */
		owner: string;
	}

	// Most-urgent-first for the row dot: a blocked question beats everything,
	// a live run beats a ready-to-merge PR, merged/pending are quiet states.
	const STATUS_PRIORITY: MineStatus[] = [
		"needsinput",
		"inprogress",
		"review",
		"merged",
		"pending",
	];
	const STATUS_DOT: Record<MineStatus, string> = Object.fromEntries(
		MINE_STATUS_META.map((m) => [m.key, m.dotColor]),
	) as Record<MineStatus, string>;

	const allWsRows = useMemo(() => {
		const rows: WsRow[] = [];
		const byWs = new Map<string, UnifiedSession[]>();
		const solo: UnifiedSession[] = [];
		for (const s of filtered) {
			// Automations render in their own band — EXCEPT runs YOU claimed
			// (right-click → Add to my workspaces / Set status): those graduate
			// into the workspace rows and take part in your lanes like your own
			// work, sitting in In progress while they run and Backlog once idle.
			// Lanes are per-user, so a claimed run moves only for the user who
			// claimed it (legacy global overrides still count for all).
			if (s.automation && !isClaimed(s)) continue;
			if (s.sideChatOf) continue; // side chats live in the parent's panel, not the sidebar
			if (s.desk) continue; // the Desk session lives in the ⌘J overlay, not the sidebar
			if (s.projectId) {
				const list = byWs.get(s.projectId) || [];
				list.push(s);
				byWs.set(s.projectId, list);
			} else solo.push(s);
		}
		const mkRow = (
			key: string,
			workspace: Project | null,
			name: string,
			chats: UnifiedSession[],
		): WsRow => {
			chats.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			// Spawned workers are implementation details of their parent chat. A failed
			// oracle/task must not leave the whole workspace looking blocked after the
			// parent recovered, but live workers still make the workspace actively busy.
			// Fall back for an unusual child-only workspace.
			const stateChats = chats.filter((c) => !c.parentSessionId);
			const statusSources = stateChats.length > 0 ? stateChats : chats;
			const workerRunning = chats.some((c) => c.parentSessionId && c.isRunning);
			// Automated PR reviews run in a separate bks-ghpr-* automation chat,
			// so the workspace's own chats never carry isRunning for that work.
			// The PR feed is the authoritative live signal for both its lane and
			// its leading spinner.
			const reviewRunning = chats.some((c) =>
				chatPrKeys(c).some((k) => activeReviewPrKeys.has(k)),
			);
			let status =
				STATUS_PRIORITY.find((st) =>
					statusSources.some((c) => mineStatus(c) === st),
				) ||
				"pending";
			// A running worker is live workspace activity even though child failures and
			// blocked states stay isolated from the parent. Needs-input and explicit
			// human lanes still win, matching mineStatus's priority rules.
			if (
				workerRunning &&
				status !== "needsinput" &&
				!chats.some((c) => pinnedLane(c))
			)
				status = "inprogress";
			// An idle row's lane follows its PR lifecycle (ready → Ready to
			// merge, otherwise-open → In progress). A human-pinned lane wins —
			// deliberately parking a row in Backlog must stick.
			if (status === "pending" && !chats.some((c) => pinnedLane(c))) {
				// …unless an automated review is still running. The row already
				// wears the spinner for it (see `running` below), and a spinning
				// row parked outside In progress reads as a contradiction. The
				// review can still come back requesting changes, so no PR lane is
				// trustworthy until it lands — including when the live review is
				// on a sibling PR (a cross-repo port, say) while the fronting PR
				// has already merged.
				status = reviewRunning
					? "inprogress"
					: (prLaneForChats(statusSources) ?? status);
			}
			return {
				key,
				workspace,
				name,
				chats,
				status,
				lastActivity: chats.reduce(
					(m, c) => (c.lastActivity > m ? c.lastActivity : m),
					"",
				),
				createdAt: chats[0]?.createdAt || "",
				unread:
					chats.some(
						(c) =>
							c.id !== selectedId && isUnread(c.id, c.lastActivity, reads),
					) ||
					// Unread team notes (transcript NoteBubbles) light the row too.
					chats.some((c) => {
						const a = noteActivity[c.id];
						return (
							!!a &&
							c.id !== selectedId &&
							isNoteUnread(c.id, a.lastTs, a.lastUser, meUser)
						);
					}),
				running: chats.some((c) => c.isRunning) || reviewRunning,
				owner: (workspace?.createdBy || chats[0]?.startedBy || "").toLowerCase(),
			};
		};
		for (const [wsId, chats] of byWs) {
			const ws = projects.find((p) => p.id === wsId) || null;
			rows.push(
				mkRow(`workspace:${wsId}`, ws, ws?.name || chats[0].title, chats),
			);
		}
		// A workspace with no chats gets NO row. Workspaces are minted with their
		// first chat (or by the PR/ticket resolvers, which park them under Pull
		// requests / Support until a chat joins), so a chatless one is a leftover —
		// its chats were archived or deleted — not a place to start work.
		//
		// Automation runs are the one chat kind that lives outside a workspace: a
		// workspace per run would bury every real one, so they render in the
		// Automations band instead. A *claimed* run is pulled into this list, and
		// groups by shared isolated worktree — the SAME rule the tab strip uses —
		// so the sidebar and tabs agree on what belongs together. Every other chat
		// carries a workspace (server-side invariant: see chat-workspace.ts), so
		// these fallback rows stay empty in practice.
		const byWorktree = new Map<string, UnifiedSession[]>();
		const loose: UnifiedSession[] = [];
		for (const s of solo) {
			if (s.worktreeDir?.includes("/worktrees/")) {
				const list = byWorktree.get(s.worktreeDir) || [];
				list.push(s);
				byWorktree.set(s.worktreeDir, list);
			} else loose.push(s);
		}
		for (const [dir, chats] of byWorktree) {
			chats.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			// The branch is the row's stable name (chat titles drift as generated
			// titles land; the branch names the shared piece of work). A manual
			// rename is explicit user intent though — it wins over the branch,
			// otherwise renaming a slack/linear session looks like a no-op.
			const renamed = chats.find((c) => c.titleOverridden);
			rows.push(
				mkRow(
					`wt:${dir}`,
					null,
					renamed?.title || chats[0].branch || chats[0].title,
					chats,
				),
			);
		}
		for (const s of loose) rows.push(mkRow(s.id, null, s.title, [s]));
		const key = filter.sort === "created" ? "createdAt" : "lastActivity";
		rows.sort((a, b) => (b[key] || "").localeCompare(a[key] || ""));
		return rows;
		// `lanes` feeds mineStatus/pinnedLane (read via the lib cache).
	}, [filtered, sessions, projects, selectedId, reads, search, filter, lanes, noteActivity, noteReadsRev, activeReviewPrKeys]);

	// ── Hidden rows ─────────────────────────────────────────────────────────
	// "Hide from my sidebar" is the personal counterpart to Archive: archiving
	// is global (archive.ts), so it's the wrong tool when a teammate is still
	// working in the chat. A hide drops the row from THIS user's sidebar only,
	// and every band below derives from `wsRows` — so hiding removes it from
	// pins, lanes, review and snoozed in one go.
	//
	// The one exception: a hidden row resurfaces while any of its chats is
	// blocked on a question, so a hide can never swallow work waiting on you.
	// Resurfacing consumes the entry (see the sweep below), which keeps the
	// rule "it came back because it needed me, and stays back until I hide it
	// again" instead of flickering as questions get asked and answered.
	//
	// Otherwise you get a hidden row back by opening one of its chats — ⌘K
	// still finds it — which resurfaces the row (below) so its menu can offer
	// "Restore to my sidebar"; prompting in it clears the hide outright
	// (SessionViewer → unhideForChat). There is no Hidden band: hiding is
	// removal from your sidebar, not a folder to browse.
	const { hiddenKeys: hiddenRowKeys, resurfaced: resurfacedRows } = useMemo(
		() => partitionHidden(allWsRows, hides),
		[allWsRows, hides],
	);
	// The open chat's row always shows, hidden or not — the same rule that keeps
	// it from disappearing inside a collapsed band. It's what makes hiding
	// reversible without a Hidden band to browse: ⌘K finds a hidden chat (the
	// palette ignores hides), opening it brings its row back, and the row menu
	// then offers "Restore to my sidebar".
	const wsRows = useMemo(
		() =>
			allWsRows.filter(
				(r) =>
					!hiddenRowKeys.has(r.key) ||
					r.chats.some((c) => c.id === selectedId),
			),
		[allWsRows, hiddenRowKeys, selectedId],
	);
	// Consume the hide of any row that just resurfaced (blocked on a question),
	// marking its chats unread so the return reads as fresh activity — the same
	// shape as the snooze wake above. Idempotent: clearHides ignores keys that
	// another tab already dropped.
	useEffect(() => {
		if (!resurfacedRows.length) return;
		for (const r of resurfacedRows) r.chats.forEach((c) => markUnread(c.id));
		clearHides(resurfacedRows.map((r) => r.key));
	}, [resurfacedRows]);

	// Automations keep their own collapsible band, one group per automation —
	// hundreds of one-shot runs would drown the Workspaces list otherwise.
	const groups = useMemo(() => {
		const out: Group[] = [];
		const byAutomation = new Map<string, UnifiedSession[]>();
		for (const s of sorted) {
			if (!s.automation) continue;
			// A run you claimed (or a legacy global override) lives in the
			// workspace rows instead — don't render it twice.
			if (isClaimed(s)) continue;
			const list = byAutomation.get(s.automation) || [];
			list.push(s);
			byAutomation.set(s.automation, list);
		}
		for (const name of Array.from(byAutomation.keys()).sort()) {
			out.push({
				key: `auto:${name}`,
				label: name,
				dotColor: AUTOMATION_COLOR,
				band: "automations",
				items: byAutomation.get(name)!,
			});
		}
		return out;
		// `lanes` feeds pinnedLane (read via the lib cache).
	}, [sorted, lanes]);

	// Sessions in sidebar order (pinned rows first, then each group's items) —
	// used to hand onArchive the row that should become active when the open
	// session is archived away.
	const flatOrder = useMemo(() => {
		const pinned = pins
			.filter((e) => !e.startsWith("note:"))
			.map((id) =>
				sessions.find((s) => s.id === id || s.aliasIds?.includes(id)),
			)
			.filter((s): s is UnifiedSession => !!s);
		return [...pinned, ...groups.flatMap((g) => g.items)];
	}, [pins, sessions, groups]);

	function archiveWithNext(s: UnifiedSession) {
		const idx = flatOrder.findIndex((x) => x.id === s.id);
		const rest = flatOrder.filter((x) => x.id !== s.id);
		const next =
			idx >= 0 ? (rest[Math.min(idx, rest.length - 1)] ?? null) : (rest[0] ?? null);
		onArchive(s, next);
	}
	function sessionPinState(s: UnifiedSession) {
		const keys = [s.id, ...(s.aliasIds || [])].filter(
			(k, i, a) => pins.includes(k) && a.indexOf(k) === i,
		);
		const pinned = keys.length > 0;
		const toggle = () => {
			if (pinned) {
				let next = pins;
				for (const k of keys) next = togglePin(k);
				setPins(next);
			} else {
				setPins(togglePin(s.id));
			}
		};
		return { pinned, toggle };
	}
	function workspacePinState(row: WsRow) {
		const pinKey = row.workspace ? `workspace:${row.workspace.id}` : row.key;
		const keys = [
			pinKey,
			row.key,
			...row.chats.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
		].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
		const pinned = keys.length > 0;
		const toggle = () => {
			if (pinned) {
				let next = pins;
				for (const k of keys) next = togglePin(k);
				setPins(next);
			} else {
				setPins(togglePin(pinKey));
			}
		};
		return { pinned, toggle };
	}

	// Pinned rows (pinned via their own key or a legacy pin on a member chat)
	// and the focus person's rows — shared by the list rendering below and by
	// archive-next, so both always agree on what's actually in the sidebar.
	// Rows a teammate flagged for YOUR review (the info panel's Reviewer picker).
	// Explicit teammate filters stay owner-scoped, while the default "Me" view
	// also includes cross-owner work that was sent to or requested by you.
	// ── Snoozed rows ────────────────────────────────────────────────────────
	// A row with an active snooze leaves every band (review, pinned, status
	// lanes) and parks in the Snoozed section, soonest wake first. The sweep
	// below prunes lapsed entries — marking the row's chats unread first, so
	// the wake surfaces like fresh activity — which re-derives membership.
	const activeSnoozeKeys = useMemo(() => {
		const now = Date.now();
		return new Set(
			Object.entries(snoozes)
				.filter(([, until]) => Date.parse(until) > now)
				.map(([key]) => key),
		);
	}, [snoozes]);
	const snoozedWsRows = useMemo(
		() =>
			wsRows
				.filter((r) => activeSnoozeKeys.has(r.key))
				.sort(
					(a, b) =>
						Date.parse(snoozes[a.key] || "") -
						Date.parse(snoozes[b.key] || ""),
				),
		[wsRows, activeSnoozeKeys, snoozes],
	);
	useEffect(() => {
		if (Object.keys(snoozes).length === 0) return;
		const sweep = () => {
			const now = Date.now();
			for (const [key, until] of Object.entries(snoozes)) {
				if (Date.parse(until) > now) continue;
				const row = wsRows.find((r) => r.key === key);
				row?.chats.forEach((c) => markUnread(c.id));
				clearSnooze(key);
			}
		};
		sweep();
		const t = setInterval(sweep, 30_000);
		return () => clearInterval(t);
	}, [snoozes, wsRows]);

	const reviewScopeRows = useMemo(() => {
		return wsRows.filter(
			(r) =>
				!activeSnoozeKeys.has(r.key) &&
				reviewRowMatchesPersonFilter(
					r.owner,
					r.chats.map((chat) => chat.reviewRequest),
					filter.person,
					currentUser,
				),
		);
	}, [wsRows, activeSnoozeKeys, filter.person, currentUser]);
	const needsReviewRows = useMemo(() => {
		const me = currentUser.toLowerCase();
		return reviewScopeRows.filter(
			(r) =>
				!wsPrMerged(r) &&
				!wsPrApproved(r) &&
				// You already reviewed the PR on GitHub (approve/changes/comment,
				// no re-request since) → your part is done, so hide the row.
				!wsPrReviewGivenBy(r, me) &&
				r.chats.some(
					(c) =>
						c.reviewRequest?.to?.toLowerCase() === me &&
						!c.reviewRequest?.accepted,
				),
		);
	}, [reviewScopeRows, currentUser]);
	// The mirror of "Needs review": workspaces where YOU asked a teammate to
	// review (the info panel's Reviewer picker, `reviewRequest.by === me`). They
	// get their own band so a session you've sent out for review moves out of the
	// status lanes and into one place you can track what you're waiting on. A row
	// where you're also the reviewer stays in Needs review (a direct ask of you
	// wins), so we exclude those keys.
	const awaitingReviewRows = useMemo(() => {
		const me = currentUser.toLowerCase();
		const needsKeys = new Set(needsReviewRows.map((r) => r.key));
		return reviewScopeRows.filter(
			(r) =>
				!needsKeys.has(r.key) &&
				!wsPrMerged(r) &&
				!wsPrApproved(r) &&
				r.chats.some(
					(c) =>
						c.reviewRequest?.by?.toLowerCase() === me &&
						!c.reviewRequest?.accepted &&
						// The reviewer already gave their review on GitHub → the
						// request landed, so it leaves the sidebar.
						!wsPrReviewGivenBy(r, c.reviewRequest.to.toLowerCase()),
				),
		);
	}, [reviewScopeRows, currentUser, needsReviewRows]);
	// Completed reviews are hidden from the sidebar, but their keys still need to
	// be excluded from the normal status lanes. A fresh or reopened request clears
	// the completion state and makes the row actionable again. Completion can come
	// from the info panel's "Mark as reviewed" (`reviewRequest.accepted`), approval
	// on GitHub (`prReviewDecision === "APPROVED"`, wsPrApproved), or submitted
	// their review on GitHub in any form (approve/changes/comment, no pending
	// re-request — wsPrReviewGivenBy). A merged PR skips this hidden set because it
	// belongs in the "Done" status lane.
	const completedReviewRows = useMemo(() => {
		const me = currentUser.toLowerCase();
		return reviewScopeRows.filter((r) => {
			if (wsPrMerged(r)) return false;
			const mineRequest = r.chats.some((c) => {
				const rq = c.reviewRequest;
				return (
					rq && (rq.by.toLowerCase() === me || rq.to.toLowerCase() === me)
				);
			});
			if (!mineRequest) return false;
			return (
				r.chats.some((c) => c.reviewRequest?.accepted) ||
				wsPrApproved(r) ||
				r.chats.some(
					(c) =>
						c.reviewRequest &&
						wsPrReviewGivenBy(r, c.reviewRequest.to.toLowerCase()),
				)
			);
		});
	}, [reviewScopeRows, currentUser]);
	// Every workspace with active or completed review state is excluded from the
	// pinned/status lanes. Completed rows therefore disappear rather than falling
	// back into Backlog.
	const reviewBandKeys = useMemo(
		() =>
			new Set([
				...needsReviewRows.map((r) => r.key),
				...awaitingReviewRows.map((r) => r.key),
				...completedReviewRows.map((r) => r.key),
			]),
		[needsReviewRows, awaitingReviewRows, completedReviewRows],
	);
	const pinnedWsRows = useMemo(() => {
		const pinSet = new Set(pins);
		const pinIdx = new Map(pins.map((p, i) => [p, i] as const));
		// A row's slot in the band = its first matching key's position in the
		// pins array (rows can be pinned via their workspace key or a legacy
		// member-chat pin) — pins order is user-controlled (drag-to-reorder), so
		// it wins over wsRows' recency order.
		const rowIdx = (r: WsRow) => {
			const hits = [r.key, ...r.chats.map((c) => c.id)]
				.map((k) => pinIdx.get(k))
				.filter((i): i is number => i !== undefined);
			return hits.length ? Math.min(...hits) : Infinity;
		};
		return wsRows
			.filter(
				(r) =>
					!reviewBandKeys.has(r.key) &&
					!activeSnoozeKeys.has(r.key) &&
					(pinSet.has(r.key) || r.chats.some((c) => pinSet.has(c.id))),
			)
			.sort((a, b) => rowIdx(a) - rowIdx(b));
	}, [wsRows, pins, reviewBandKeys, activeSnoozeKeys]);
	// Feed workspaces (repo-less, externalRefs — Tella videos, PostHog
	// dashboards) are represented by their feed band's rows. They only join
	// the status lanes when they demand attention (running / needs input) —
	// an idle one in Backlog is a duplicate of its feed row.
	const feedRefKinds = useMemo(
		() => new Set(feeds.map((f) => f.refKind)),
		[feeds],
	);
	const rowIsFeedOnly = (r: WsRow) =>
		!r.workspace?.repo &&
		!!r.workspace?.externalRefs?.length &&
		feedRefKinds.has(r.workspace.externalRefs[0].kind);
	const focusWsRows = useMemo(() => {
		const focus =
			filter.person === "me" ? currentUser.toLowerCase() : filter.person;
		// Pinned rows are NOT excluded here: Pinned is quick access, not a
		// status, so a pinned in-progress session still shows under In
		// progress and Add-to-backlog on a pinned row still lands it in
		// Backlog (with auto-pin-new on, hiding pinned rows emptied the lanes).
		return wsRows.filter(
			(r) =>
				(focus === "everyone" ||
					(focus === "unassigned"
						? r.status === "pending"
						: // A row YOU lane-pinned belongs in your own lens no matter who
							// owns it — lanes are per-user triage, so filing a teammate's
							// PR workspace into your Backlog must show it in YOUR Backlog.
							// Ownerless rows (automation runs with no startedBy) ride the
							// same rule under any personal lens; a legacy global override
							// still surfaces only under Everyone.
							r.owner === focus ||
							// Ownership follows the people in the room, not whoever
							// opened the door: a PR/ticket workspace is minted by an
							// automation, so its creator is a bot even when the work
							// inside is yours. Your own chat in it makes the row yours.
							r.chats.some(
								(c) =>
									!c.automation &&
									(c.startedBy || "").toLowerCase() === focus,
							) ||
							((r.owner === "" || focus === currentUser.toLowerCase()) &&
								r.chats.some((c) => getLane(c.id))))) &&
				!reviewBandKeys.has(r.key) &&
				!activeSnoozeKeys.has(r.key) &&
				// Idle feed workspaces stay out of the lanes (their feed row is
				// the representation); attention states still surface.
				(!rowIsFeedOnly(r) || r.running || r.status === "needsinput"),
		);
	}, [
		wsRows,
		filter.person,
		currentUser,
		reviewBandKeys,
		activeSnoozeKeys,
		lanes,
	]);

	// ── PR rows in the project lanes ────────────────────────────────────────
	// The retired standalone Pull-requests band dissolved into the project
	// groups: every open PR classifies into a lane (ready → Ready to merge,
	// attention → In progress, drafts → Backlog, the rest → In progress).
	const githubLogin = githubLoginFor(currentUser);
	const reviewQueueItems = useMemo(
		() => buildReviewQueue(openPrs || [], sessions, currentUser, githubLogin),
		[openPrs, sessions, currentUser, githubLogin],
	);
	// Session-backed PRs ride their workspace row (which already wears the PR
	// state); a PR row renders only when no rendered workspace row carries the
	// same repo+branch. Dedupe is against the rows in view — not all wsRows —
	// so a teammate's PR outside your person lens can still surface as a PR
	// row when the PR filter includes it.
	const prRowItems = useMemo(() => {
		if (!workspaceDataReady || filter.prs === "none") return [];
		const q = search.trim().toLowerCase();
		const covered = new Set<string>();
		const rowsInView = [
			...focusWsRows,
			...pinnedWsRows,
			...snoozedWsRows,
			...needsReviewRows,
			...awaitingReviewRows,
		];
		for (const r of rowsInView)
			for (const c of r.chats) for (const k of chatPrKeys(c)) covered.add(k);
		return reviewQueueItems.filter((item) => {
			if (covered.has(`${item.pr.repo}\n${item.pr.branch}`)) return false;
			if (filter.repo !== "all" && item.pr.repo !== filter.repo)
				return false;
			if (
				q &&
				![item.pr.title, item.pr.branch, item.pr.author].some((v) =>
					v.toLowerCase().includes(q),
				)
			)
				return false;
			// The person lens: a specific teammate shows their PRs; the
			// aggregate Backlog lens has no authored-PR meaning. "Me" and
			// "Everyone" fall through to the PR-source preset.
			if (filter.person === "unassigned") return false;
			if (filter.person !== "me" && filter.person !== "everyone")
				return item.pr.person === filter.person;
			if (filter.prs === "all") return true;
			return item.source === "mine" || item.source === "requested";
		});
	}, [
		reviewQueueItems,
		workspaceDataReady,
		focusWsRows,
		pinnedWsRows,
		snoozedWsRows,
		needsReviewRows,
		awaitingReviewRows,
		filter.repo,
		filter.person,
		filter.prs,
		search,
	]);

	// Which lane a PR row files under: ready → Ready to merge, everything else
	// → Backlog. In progress is reserved for live runs — a PR that needs a
	// hand signals through its red/yellow glyph and hover card instead.
	function prItemLane(item: ReviewQueueItem): MineStatus {
		return item.bucket === "ready" ? "review" : "pending";
	}

	// Closing a PR from a row's context menu — optimistic spinner per URL; the
	// PR_CLOSED_EVENT listener above prunes the open-PR list on success.
	const [closingPrUrls, setClosingPrUrls] = useState<Set<string>>(
		() => new Set(),
	);
	async function closePrRow(item: ReviewQueueItem) {
		if (!window.confirm(`Close PR #${item.pr.number} without merging it?`))
			return;
		setClosingPrUrls((current) => new Set(current).add(item.pr.url));
		try {
			await closePrPreviewApi(item.pr.repo, item.pr.branch);
		} catch (error: any) {
			onToast?.(error.message || `Failed to close PR #${item.pr.number}.`);
		} finally {
			setClosingPrUrls((current) => {
				const next = new Set(current);
				next.delete(item.pr.url);
				return next;
			});
		}
	}

	// A PR row is selected while the open workspace carries its PR.
	function prRowSelected(item: ReviewQueueItem): boolean {
		const ws = selectedWorkspaceId
			? projects.find((p) => p.id === selectedWorkspaceId)
			: null;
		return (
			!!ws &&
			(ws.repo || DEFAULT_PROJECT) === item.pr.repo &&
			(ws.prNumber === item.pr.number || ws.branch === item.pr.branch)
		);
	}

	function renderPrRow(item: ReviewQueueItem) {
		const pinKey = `pr:${item.pr.url}`;
		return (
			<PrRow
				key={item.pr.url}
				item={item}
				selected={prRowSelected(item)}
				pinned={pins.includes(pinKey)}
				onTogglePin={() => setPins(togglePin(pinKey))}
				onOpen={() => onOpenPrItem(item)}
				onClose={() => void closePrRow(item)}
				closing={closingPrUrls.has(item.pr.url)}
			/>
		);
	}

	// GitHub review requests pointed at YOU are a notification, not a lane
	// item: they render in the "Needs review" band at the top, alongside the
	// internal review requests (both are the same ask of you), and stay out of
	// the project lanes below.
	const requestedPrItems = prRowItems.filter(
		(item) => item.source === "requested",
	);
	const lanePrItems = prRowItems.filter(
		(item) => item.source !== "requested",
	);

	// Workspace rows in the sidebar's visual order (Pinned band first, then the
	// status lanes) — archiveWorkspaceWithNext walks this to pick the row that
	// should open when the active workspace is archived away.
	const wsRowOrder = useMemo(
		() => {
			// Pinned rows appear in the Pinned band AND their status lane —
			// dedupe by key so the archive-next walk sees each row once.
			const seen = new Set<string>();
			return [
				...needsReviewRows,
				...awaitingReviewRows,
				...pinnedWsRows,
				...MINE_STATUS_META.flatMap((meta) =>
					focusWsRows.filter((r) => r.status === meta.key),
				),
				...snoozedWsRows,
			].filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
		},
		[
			needsReviewRows,
			awaitingReviewRows,
			pinnedWsRows,
			focusWsRows,
			snoozedWsRows,
		],
	);
	const hasWorkspaceFilter =
		!!search || filter.repo !== "all" || filter.person !== "me";
	const workspaceListEmpty =
		needsReviewRows.length === 0 &&
		awaitingReviewRows.length === 0 &&
		pinnedWsRows.length === 0 &&
		focusWsRows.length === 0 &&
		snoozedWsRows.length === 0 &&
		prRowItems.length === 0;

	function archiveWorkspaceWithNext(row: WsRow) {
		// Chatless rows can't be opened, so they're not "next" candidates.
		const candidates = wsRowOrder.filter((r) => r.chats.length > 0);
		const idx = candidates.findIndex((r) => r.key === row.key);
		const rest = candidates.filter((r) => r.key !== row.key);
		const next =
			idx >= 0 ? (rest[Math.min(idx, rest.length - 1)] ?? null) : (rest[0] ?? null);
		onArchiveWorkspace(row.chats, next?.chats[0] ?? null);
	}

	/**
	 * Hide a row from THIS user's sidebar, leaving the chats untouched for
	 * everyone else (the point of the feature — see `hiddenRowKeys`). Drops the
	 * row's pins and any snooze first: a pinned-but-hidden row would snap to the
	 * top of Pinned the moment it resurfaced, and a snooze wake would resurface
	 * a row the user just hid. Lane membership is deliberately kept, so a
	 * restored row returns to where it was.
	 */
	function hideRow(row: WsRow) {
		const pinnedKeys = [
			row.key,
			...row.chats.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
		].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
		if (pinnedKeys.length) {
			let next = pins;
			for (const k of pinnedKeys) next = togglePin(k);
			setPins(next);
		}
		clearSnooze(row.key);
		// Keep something open if the row being hidden owns the active chat.
		if (row.chats.some((c) => c.id === selectedId)) {
			const candidates = wsRowOrder.filter((r) => r.chats.length > 0);
			const idx = candidates.findIndex((r) => r.key === row.key);
			const rest = candidates.filter((r) => r.key !== row.key);
			const next =
				idx >= 0
					? (rest[Math.min(idx, rest.length - 1)] ?? null)
					: (rest[0] ?? null);
			if (next) onSelect(next.chats[0]);
		}
		setHide(row.key);
	}

	// Archive just the open chat and pick what becomes active. We resolve the open
	// session through wsRowOrder (the rendered workspace rows) rather than flatOrder
	// — flatOrder only carries pinned + automation chats, so a normal open session
	// isn't in it. If the chat has siblings in its workspace, land on one of them;
	// otherwise the row empties out, so land on the next workspace's first chat.
	function archiveOpenChatWithNext() {
		const candidates = wsRowOrder.filter((r) => r.chats.length > 0);
		const rowIdx = candidates.findIndex((r) =>
			r.chats.some((c) => c.id === selectedId),
		);
		if (rowIdx < 0) {
			// The open chat can be hidden by the current person/repo/search lens.
			// Archiving the active chat must not depend on it being rendered.
			const chat = sessions.find((s) => s.id === selectedId && !s.archived);
			if (chat) onArchive(chat, null);
			return;
		}
		const row = candidates[rowIdx];
		const chat = row.chats.find((c) => c.id === selectedId);
		if (!chat) return;
		let next: UnifiedSession | null;
		const siblings = row.chats.filter((c) => c.id !== selectedId);
		if (siblings.length > 0) {
			const chatIdx = row.chats.findIndex((c) => c.id === selectedId);
			next = siblings[Math.min(chatIdx, siblings.length - 1)] ?? null;
		} else {
			const rest = candidates.filter((r) => r.key !== row.key);
			next = rest[Math.min(rowIdx, rest.length - 1)]?.chats[0] ?? null;
		}
		onArchive(chat, next);
	}

	React.useImperativeHandle(ref, () => ({
		archiveSelected: archiveOpenChatWithNext,
	}));

	// ⌘E (or the legacy ⌘⇧A) archives the open chat and lands on the next entry
	// in the sidebar, rather than dropping back to Home. This lives here (not in
	// the viewer) because the sidebar owns the row ordering that defines "next".
	// The viewer keeps the same chord only for the unarchive toggle on an
	// already-archived session — that session isn't in this list, so this
	// handler no-ops on it and the two never both fire. ⌘⌥⇧A below escalates to
	// the whole workspace.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.defaultPrevented || !isArchiveChord(e)) return;
			if (
				document.querySelector(
					".palette-backdrop, .composer-schedule-modal-backdrop, .session-delete-overlay",
				)
			)
				return;
			if (editableSwallowsArchiveChord(e.target)) return;
			const canArchive = sessions.some(
				(s) => s.id === selectedId && !s.archived,
			);
			if (!canArchive) return;
			e.preventDefault();
			closeWsHover();
			archiveOpenChatWithNext();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [wsRowOrder, sessions, selectedId, onArchive]);

	// ⌘⌥⇧A escalates the chat archive (⌘E/⌘⇧A) to the whole active workspace.
	// The Alt modifier is the only thing that separates the two handlers, so
	// exactly one fires. Targets the workspace holding the open session.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (
				e.defaultPrevented ||
				e.key.toLowerCase() !== "a" ||
				!(e.metaKey || e.ctrlKey) ||
				!e.shiftKey ||
				!e.altKey
			)
				return;
			if (editableSwallowsArchiveChord(e.target)) return;
			const row = wsRowOrder.find(
				(r) => r.chats.length > 0 && r.chats.some((c) => c.id === selectedId),
			);
			if (!row) return;
			e.preventDefault();
			closeWsHover();
			archiveWorkspaceWithNext(row);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [wsRowOrder, selectedId, onArchiveWorkspace]);

	// ⌘↓/⌘↑ cycle through the sidebar's rendered items in visual order (down =
	// next row), wrapping at the ends. Reading the DOM here is intentional: each
	// section owns its filtering and collapsed state, so rendered buttons are the
	// single source of truth for what keyboard navigation can reach.
	// Deliberately fires while the composer is focused (unlike the archive
	// chords): jumping workspaces without leaving the keyboard is the point,
	// and that costs the textarea its ⌘-arrow caret-to-start/end moves. Alt is
	// excluded so ⌘⌥ arrows stay free for the reasoning-effort chord
	// (SessionViewer); Shift so ⌘⇧-arrow text selection keeps working.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (
				e.defaultPrevented ||
				(e.key !== "ArrowUp" && e.key !== "ArrowDown") ||
				!(e.metaKey || e.ctrlKey) ||
				e.altKey ||
				e.shiftKey
			)
				return;
			if (
				document.querySelector(
					".palette-backdrop, .composer-schedule-modal-backdrop, .session-delete-overlay",
				)
			)
				return;
			const candidates = Array.from(
				document.querySelectorAll<HTMLButtonElement>(
					".sidebar-list button.sidebar-item",
				),
			);
			if (candidates.length === 0) return;
			const idx = candidates.findIndex((item) =>
				item.classList.contains("sidebar-item-selected"),
			);
			const dir = e.key === "ArrowDown" ? 1 : -1;
			// No selected sidebar item (e.g. Home): enter from the edge.
			const next =
				idx < 0
					? dir === 1
						? candidates[0]
						: candidates[candidates.length - 1]
					: candidates[(idx + dir + candidates.length) % candidates.length];
			if (!next) return;
			e.preventDefault();
			closeWsHover();
			next.scrollIntoView({ block: "nearest" });
			next.click();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// ── Workspace hover card ────────────────────────────────────────────────
	// The same card every sidebar row raises, driven by hand: workspace rows
	// come out of a render function rather than a component, so one card serves
	// the whole list (only one row can be dwelled on at a time) and the hovered
	// row is its anchor. The card carries actions (Archive, PR link,
	// thumbnails), so leaving the row schedules the close with a short grace
	// period and entering the card cancels it — the pointer can travel the 8px
	// gap without the card vanishing under it.
	const wsHoverOpenT = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wsHoverCloseT = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The row element itself is the anchor — the popover tracks it, so a
	// scrolling list repositions the card instead of dropping it.
	const [wsHover, setWsHover] = useState<{ row: WsRow; el: HTMLElement } | null>(
		null,
	);
	// Mobile long-press sheet (the touch stand-in for the hover card).
	const [wsSheet, setWsSheet] = useState<WsRow | null>(null);

	function cancelWsHoverTimers() {
		if (wsHoverOpenT.current) clearTimeout(wsHoverOpenT.current);
		if (wsHoverCloseT.current) clearTimeout(wsHoverCloseT.current);
		wsHoverOpenT.current = null;
		wsHoverCloseT.current = null;
	}
	function wsRowHoverEnter(row: WsRow, el: HTMLElement) {
		if (rowRenameEditing(row) || !pointerCanHover()) return;
		cancelWsHoverTimers();
		if (wsHover) {
			setWsHover({ row, el });
			return;
		}
		wsHoverOpenT.current = setTimeout(() => {
			setWsHover({ row, el });
		}, 380);
	}
	function scheduleWsHoverClose() {
		if (wsHoverOpenT.current) clearTimeout(wsHoverOpenT.current);
		wsHoverOpenT.current = null;
		if (wsHoverCloseT.current) clearTimeout(wsHoverCloseT.current);
		wsHoverCloseT.current = setTimeout(() => setWsHover(null), 140);
	}
	function closeWsHover() {
		cancelWsHoverTimers();
		setWsHover(null);
	}
	useEffect(() => cancelWsHoverTimers, []);

	// Mobile: tap-to-open a workspace row fires from `touchend`, not the
	// synthesized click — same trick as SessionRow. The row has :hover styles
	// (the reveal-on-hover pin/archive swap, the hover background) plus a
	// mouseenter hover card, and iOS treats the first tap on such an element as
	// a hover-in, swallowing the click — so a click-driven open needs a second
	// tap. A hold that stays roughly in place for LONG_PRESS_MS opens the
	// workspace menu (the touch stand-in for right-click); real finger travel
	// (a scroll) cancels both. Only one touch happens at a time, so one set of
	// refs serves every row.
	const wsPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wsPressOrigin = useRef<{ x: number; y: number } | null>(null);
	const wsLongPressed = useRef(false);
	const wsMoved = useRef(false);
	const wsSwipeOrigin = useRef<{ x: number; y: number; width: number } | null>(
		null,
	);
	const wsSwiping = useRef(false);
	const wsSwipeOffset = useRef(0);
	const [wsSwipe, setWsSwipe] = useState<SwipeState | null>(null);
	const [wsDraggingKey, setWsDraggingKey] = useState<string | null>(null);
	// Which action the in-flight drag is revealing. Split from wsSwipe so a
	// touchmove only re-renders when the side FLIPS — the per-frame offset is
	// written straight to the DOM in wsRowTouchMove.
	const [wsDragSide, setWsDragSide] = useState<SwipeAction | null>(null);
	useEffect(() => {
		if (!isPhone) {
			setWsSwipe(null);
			wsSwipeOffset.current = 0;
			setWsDraggingKey(null);
			setWsDragSide(null);
		}
	}, [isPhone]);
	useEffect(() => {
		setWsSwipe(null);
		wsSwipeOffset.current = 0;
		setWsDraggingKey(null);
		setWsDragSide(null);
	}, [selectedId]);

	function clearWsPress() {
		if (wsPressTimer.current) clearTimeout(wsPressTimer.current);
		wsPressTimer.current = null;
		wsPressOrigin.current = null;
	}
	function wsRowTouchStart(row: WsRow, e: React.TouchEvent) {
		if (rowRenameEditing(row)) return;
		if (e.touches.length !== 1) return;
		const t = e.touches[0];
		wsLongPressed.current = false;
		wsMoved.current = false;
		wsSwiping.current = false;
		clearWsPress();
		if (wsSwipe?.key && wsSwipe.key !== row.key) setWsSwipe(null);
		// After clearWsPress (which nulls it) so it survives to move/end.
		wsPressOrigin.current = { x: t.clientX, y: t.clientY };
		wsSwipeOrigin.current = {
			x: t.clientX - (wsSwipe?.key === row.key ? wsSwipe.offset : 0),
			y: t.clientY,
			width: e.currentTarget.clientWidth,
		};
		wsPressTimer.current = setTimeout(() => {
			wsLongPressed.current = true;
			closeWsHover();
			navigator.vibrate?.(10);
			// The touch stand-in for both the hover card AND right-click: a
			// bottom sheet with the overview block plus every workspace action.
			setWsSheet(row);
		}, LONG_PRESS_MS);
	}
	function wsRowTouchMove(row: WsRow, e: React.TouchEvent) {
		if (e.touches.length !== 1) return;
		const t = e.touches[0];
		const swipeO = wsSwipeOrigin.current;
		if (swipeO && !wsLongPressed.current) {
			const dx = t.clientX - swipeO.x;
			const dy = t.clientY - swipeO.y;
			if (
				wsSwiping.current ||
				(Math.abs(dx) > SWIPE_AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy))
			) {
				wsSwiping.current = true;
				wsMoved.current = true;
				setWsDraggingKey(row.key);
				clearWsPress();
				e.preventDefault();
				const offset = clampSwipe(dx, swipeO.width);
				wsSwipeOffset.current = offset;
				// Per-frame position goes straight to the DOM: a setState here
				// re-rendered the entire sidebar on every touchmove, which
				// phones can't do at 60fps. React only hears about drag start
				// and side flips; touchend reconciles the settled state.
				const btn = e.currentTarget as HTMLElement;
				btn.style.setProperty("--swipe-x", `${offset}px`);
				btn.parentElement?.style.setProperty(
					"--swipe-action-w",
					`${Math.max(SWIPE_REVEAL_PX, Math.abs(offset))}px`,
				);
				setWsDragSide(offset < 0 ? "archive" : offset > 0 ? "star" : null);
				return;
			}
		}
		const o = wsPressOrigin.current;
		if (!o) return;
		if (
			Math.abs(t.clientX - o.x) > LONG_PRESS_SLOP ||
			Math.abs(t.clientY - o.y) > LONG_PRESS_SLOP
		) {
			wsMoved.current = true;
			clearWsPress();
		}
	}
	function wsRowTouchEnd(row: WsRow, e: React.TouchEvent) {
		const hadOrigin = wsPressOrigin.current !== null;
		const wasSwiping = wsSwiping.current;
		const rowWidth = wsSwipeOrigin.current?.width ?? e.currentTarget.clientWidth;
		// Read the committed distance straight off the ref (like SessionRow),
		// gated on the `wasSwiping` ref — NOT the `wsSwipe` state. Touch events are
		// continuous, so React can batch the last touchmove's setWsSwipe and not
		// re-render before touchend; a `wsSwipe?.key === row.key` gate would then
		// read stale state, collapse the offset to 0, and silently drop the swipe
		// (the intermittent "slide didn't archive"). The ref is always current.
		const swipeOffset = isPhone && wasSwiping ? wsSwipeOffset.current : 0;
		clearWsPress();
		wsSwipeOrigin.current = null;
		wsSwiping.current = false;
		setWsDraggingKey(null);
		setWsDragSide(null);
		// The drag wrote --swipe-x / --swipe-action-w straight onto the DOM;
		// React never owned them, so a re-render with an undefined style prop
		// won't remove them. Clear here — the settled wsSwipe state (if any)
		// re-applies them through the style props on this same flush.
		const rowEl = e.currentTarget as HTMLElement;
		rowEl.style.removeProperty("--swipe-x");
		rowEl.parentElement?.style.removeProperty("--swipe-action-w");
		if (rowRenameEditing(row)) return;
		if (wasSwiping) {
			e.preventDefault();
			if (Math.abs(swipeOffset) >= fullSwipeThreshold(rowWidth)) {
				const action: SwipeAction = swipeOffset < 0 ? "archive" : "star";
				setWsSwipe({
					key: row.key,
					offset: swipeCommitOffset(action, rowWidth),
					action,
				});
				window.setTimeout(() => {
					if (action === "archive") archiveWorkspaceWithNext(row);
					else {
						workspacePinState(row).toggle();
						setWsSwipe({ key: row.key, offset: 0, action });
						window.setTimeout(() => setWsSwipe(null), SWIPE_COMMIT_MS);
					}
					wsSwipeOffset.current = 0;
				}, SWIPE_COMMIT_MS);
				return;
			}
			setWsSwipe(
				(() => {
					const snapped =
						Math.abs(swipeOffset) > SWIPE_OPEN_THRESHOLD
							? swipeOffset > 0
								? SWIPE_REVEAL_PX
								: -SWIPE_REVEAL_PX
							: 0;
					wsSwipeOffset.current = snapped;
					return snapped ? { key: row.key, offset: snapped } : null;
				})(),
			);
			return;
		}
		// A clean tap: started on this row, never became a long-press, never
		// turned into a scroll. Open now and swallow the ghost click — which
		// also keeps the synthesized mouseenter from opening the hover card.
		if (hadOrigin && !wsLongPressed.current && !wsMoved.current) {
			e.preventDefault();
			if (wsSwipe?.key === row.key && wsSwipe.offset !== 0) {
				setWsSwipe(null);
				wsSwipeOffset.current = 0;
				return;
			}
			if (row.workspace) onOpenProject(row.workspace.id);
			else if (row.chats[0]) onSelect(row.chats[0]);
		} else if (wsLongPressed.current) {
			// Release after a long-press: the workspace sheet is already up —
			// swallow any ghost click so it can't land on the sheet (or its
			// backdrop's close handler) and immediately dismiss it.
			e.preventDefault();
		}
	}

	// Repo, review, project and support groups are open by default (grouping is
	// itself the point), so we track their *collapsed* state under a
	// "collapsed:" key; every other group is closed by default and tracked
	// directly. This list must match isOpen's — a key toggled here but read
	// bare there (or vice versa) makes its chevron a no-op.
	const collapseKey = (key: string) =>
		key.startsWith("repo:") ||
		key.startsWith("review:") ||
		key.startsWith("project:") ||
		key.startsWith("support:") ||
		key.startsWith("inbox:")
			? `collapsed:${key}`
			: key;

	function toggleGroup(key: string) {
		const stored = collapseKey(key);
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(stored)) next.delete(stored);
			else next.add(stored);
			localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	// While searching, show everything that matched.
	const isOpen = (key: string) => {
		if (search.trim().length > 0) return true;
		if (
			key.startsWith("repo:") ||
			key.startsWith("review:") ||
			key.startsWith("support:") ||
			key.startsWith("project:") ||
			key.startsWith("inbox:")
		)
			return !expanded.has(`collapsed:${key}`);
		return expanded.has(key);
	};

	// Collapsible bands are open by default, so — like
	// repo groups — their *collapsed* state is what's persisted. Collapsing one
	// hides every group within that band. Searching forces them open.
	const bandOpen = (band: GroupBand | "workspaces") =>
		search.trim().length > 0 ? true : !expanded.has(`collapsed:band:${band}`);
	const toolsOpen = !expanded.has("collapsed:band:tools");
	const workspacesOpen = bandOpen("workspaces");
	// Assignee/label/session filter over the Plain queue; free text rides the
	// sidebar-wide search box (title/customer/preview).
	// Generic feed filtering: sidebar search (title/preview + descriptor
	// searchMeta paths), meta-mode filter specs over item.meta, and the
	// builtin linked-session filter. Arg-mode specs were already applied
	// server-side by the fetch. Replaces filteredSupportThreads.
	function sessionForItem(feed: FeedDescriptor, item: FeedItem) {
		return feed.id === "plain"
			? supportSessionByThread.get(item.id)
			: feedSessionByRef.get(`${feed.refKind}:${item.id}`);
	}
	function applyFeedFilters(feed: FeedDescriptor, items: FeedItem[]) {
		let list = items;
		const q = search.trim().toLowerCase();
		if (q)
			list = list.filter((i) =>
				[
					i.title,
					i.preview,
					...(feed.searchMeta || []).map((p) => dget(i.meta, p)),
				].some(
					(v) => typeof v === "string" && v.toLowerCase().includes(q),
				),
			);
		const vals = feedFilters[feed.id] || {};
		for (const spec of feed.filters || []) {
			if (spec.mode !== "meta") continue;
			const sel = vals[spec.key];
			if (!sel) continue;
			list = list.filter((i) => {
				const v = dget(i.meta, spec.field);
				if (v == null || (Array.isArray(v) && v.length === 0))
					return sel === "__unassigned__";
				const els = Array.isArray(v) ? v : [v];
				return els.some(
					(el) =>
						String(dget(el, spec.optionsFromItems?.value) ?? el) === sel,
				);
			});
		}
		if (vals.__session === "with")
			list = list.filter((i) => !!sessionForItem(feed, i));
		else if (vals.__session === "without")
			list = list.filter((i) => !sessionForItem(feed, i));
		return list;
	}
	const automationsOpen = bandOpen("automations");
	const visibleAutomationGroups = automationsOpen
		? groups
		: groups.filter((group) =>
				group.items.some((session) => session.id === selectedId),
			);
	function toggleBand(band: GroupBand | "tools" | "workspaces") {
		const key = `collapsed:band:${band}`;
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	const tools: Array<{
		id: SidebarToolId;
		label: string;
		icon: React.ReactNode;
		active: boolean;
		onClick: () => void;
		title?: string;
		count?: number;
	}> = [
		{
			id: "home",
			label: SIDEBAR_TOOL_LABELS.home,
			icon: <IconHome />,
			active: homeActive,
			onClick: onOpenHome,
			title: "Pull request worktrees",
		},
		{
			id: "tasks",
			label: SIDEBAR_TOOL_LABELS.tasks,
			icon: <IconListChecks />,
			active: tasksActive,
			onClick: onOpenTasks,
			title: "Your open tasks",
			count: taskCount,
		},
		{
			id: "catchup",
			label: SIDEBAR_TOOL_LABELS.catchup,
			icon: <IconStack />,
			active: catchUpActive,
			onClick: onOpenCatchUp,
			title: "Swipe through your unread workspaces",
			count: catchUpCount,
		},
		{
			id: "prtinder",
			label: SIDEBAR_TOOL_LABELS.prtinder,
			icon: <IconFlame />,
			active: prTinderActive,
			onClick: onOpenPrTinder,
			title: "Swipe through the repo's open PRs",
		},
		{
			id: "supporttinder",
			label: SIDEBAR_TOOL_LABELS.supporttinder,
			icon: <IconInbox />,
			active: supportTinderActive,
			onClick: onOpenSupportTinder,
			title: "Swipe through the Plain Todo queue",
		},
		{
			id: "reports",
			label: SIDEBAR_TOOL_LABELS.reports,
			icon: <IconFile />,
			active: reportsActive,
			onClick: onOpenReports,
			title: "Recurring automation reports",
		},
		{
			id: "analytics",
			label: SIDEBAR_TOOL_LABELS.analytics,
			icon: <IconChart />,
			active: analyticsActive,
			onClick: onOpenAnalytics,
			title: "Sessions, tokens, models & PRs over time",
		},
		{
			id: "notes",
			label: SIDEBAR_TOOL_LABELS.notes,
			icon: <IconPencil />,
			active: notesActive,
			onClick: onOpenNotes,
			title: "Shared notes and documentation",
		},
		{
			id: "desk",
			label: SIDEBAR_TOOL_LABELS.desk,
			icon: <IconDesk />,
			// The Desk is an overlay rather than a route, so it stays lit while
			// it's up the same way an open page does.
			active: deskActive,
			onClick: onOpenDesk,
			title: "Your standing concierge session (⌘J)",
		},
	];
	const visibleTools = tools.filter(
		(tool) => !hiddenTools.has(tool.id) && (!isPhone || tool.id !== "home"),
	);

	const setToolVisible = setSidebarToolVisible;

	// "Archived" reads as a peer of the My-sessions status buckets (Needs input /
	// Done …): an icon-led row that sits flush under them. Unlike those, it doesn't
	// expand inline — it navigates to the archived page, and highlights while that
	// page is open.
	// The inline Archived band rows: my archived sessions (same lens as
	// archivedCount) grouped by workspace, newest activity first. Capped in the
	// JSX — the "More…" row opens the full archived page for the rest.
	const archivedRows = useMemo(() => {
		const user = currentUser.toLowerCase();
		const mine = sessions.filter(
			(s) =>
				s.archived &&
				!s.automation &&
				s.startedBy &&
				s.startedBy.toLowerCase() === user &&
				(filter.repo === "all" || sessionRepo(s) === filter.repo),
		);
		const byWs = new Map<string, UnifiedSession[]>();
		const rows: Array<{
			key: string;
			name: string;
			chats: UnifiedSession[];
			lastActivity: string;
		}> = [];
		for (const s of mine) {
			if (s.projectId) {
				const list = byWs.get(s.projectId) || [];
				list.push(s);
				byWs.set(s.projectId, list);
			} else {
				rows.push({
					key: s.id,
					name: s.title || "Untitled",
					chats: [s],
					lastActivity: s.lastActivity || "",
				});
			}
		}
		for (const [wsId, chats] of byWs) {
			const ws = projects.find((p) => p.id === wsId) || null;
			chats.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			rows.push({
				key: `workspace:${wsId}`,
				name: ws?.name || chats[0].title || "Untitled",
				chats,
				lastActivity: chats.reduce(
					(m, c) => (c.lastActivity > m ? c.lastActivity : m),
					"",
				),
			});
		}
		rows.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
		return rows;
	}, [sessions, projects, currentUser, filter.repo]);

	// Bring an archived row back. `pin` is the one-gesture escalation: unarchive
	// AND drop it in Pinned, so a row you're resurrecting to work on lands at the
	// top of the sidebar instead of wherever its derived lane puts it. The pin key
	// matches workspacePinState's (workspace key, or the solo chat's id), which is
	// exactly what `archivedRows` keys rows by.
	function unarchiveRow(row: { key: string; chats: UnifiedSession[] }, pin: boolean) {
		onUnarchiveWorkspace(row.chats);
		if (pin && !pins.includes(row.key)) setPins(togglePin(row.key));
	}

	// Archived: a collapsible group like the status lanes (T3's "Settled" —
	// visible at the bottom of the same list so archiving feels cheap, not like
	// a one-way door). Shows the most recent rows inline; "More…" opens the
	// full archived page, which keeps unarchive/bulk actions.
	const ARCHIVED_INLINE_MAX = 20;
	const archivedBand =
		archivedCount > 0
			? (() => {
					const open = isOpen("archived");
					return (
						<div className="sidebar-status-group">
							<button
								className={SIDEBAR_GROUP_HEADER_CLASS}
								onClick={() => toggleGroup("archived")}
							>
								<span className="inline-flex shrink-0 items-center text-faint">
									<svg
										width="18"
										height="18"
										viewBox="0 0 16 16"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.4"
									>
										<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
										<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
										<path d="M6.5 8.5h3" strokeLinecap="round" />
									</svg>
								</span>
								<span className={SIDEBAR_GROUP_NAME_CLASS}>Archived</span>
								<span className={SIDEBAR_GROUP_COUNT_CLASS}>{archivedCount}</span>
								<IconChevronDown
									className={SIDEBAR_GROUP_CHEVRON_CLASS}
									size={22}
									style={{ transform: open ? "none" : "rotate(-90deg)" }}
								/>
							</button>
							{open &&
								archivedRows.slice(0, ARCHIVED_INLINE_MAX).map((r) => (
									<button
										key={r.key}
										className={cn(SIDEBAR_ITEM_CLASS, SIDEBAR_WS_ROW_CLASS, "sidebar-archived-row max-[720px]:pr-[72px]")}
										onClick={() => onSelect(r.chats[0])}
										aria-label={r.name}
									>
										<span className={SIDEBAR_RAIL_CLASS}>
											<span className="sidebar-item-status sidebar-status-idle" />
										</span>
										<span
											className={SIDEBAR_TITLE_CLASS}
											style={{ color: "var(--text-dim)" }}
										>
											{stripPrTitlePrefix(r.name)}
										</span>
										{!isPhone && r.lastActivity && (
											<span className="sidebar-ws-time ml-auto min-w-[34px] shrink-0 text-right text-meta text-faint">
												{shortTime(r.lastActivity)}
											</span>
										)}
										{/* Hover actions, mirroring a live row's pin + archive pair:
										    here they bring the row back, with pin as the one-gesture
										    "unarchive AND put it where I'll see it". */}
										<span className="sidebar-ws-actions absolute right-[7px] top-1/2 flex -translate-y-1/2 items-center gap-1 max-[720px]:bg-transparent max-[720px]:shadow-none [@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover:inline-flex">
											<Tooltip label="Unarchive and pin">
												<span
													role="button"
													tabIndex={0}
													className={SIDEBAR_ACTION_CLASS}
													aria-label={
														r.chats.length > 1
															? `Unarchive workspace (${r.chats.length} chats) and pin`
															: "Unarchive and pin"
													}
													onClick={(e) => {
														e.stopPropagation();
														unarchiveRow(r, true);
													}}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.stopPropagation();
															unarchiveRow(r, true);
														}
													}}
												>
													<IconPin size={21} />
												</span>
											</Tooltip>
											<Tooltip
												label={
													r.chats.length > 1
														? `Unarchive workspace (${r.chats.length} chats)`
														: "Unarchive"
												}
											>
												<span
													role="button"
													tabIndex={0}
													className={SIDEBAR_ACTION_CLASS}
													aria-label="Unarchive"
													onClick={(e) => {
														e.stopPropagation();
														unarchiveRow(r, false);
													}}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.stopPropagation();
															unarchiveRow(r, false);
														}
													}}
												>
													<IconUnarchive size={21} />
												</span>
											</Tooltip>
										</span>
									</button>
								))}
							{open && (
								<button
									className={cn(
										SIDEBAR_ITEM_CLASS,
										SIDEBAR_WS_ROW_CLASS,
										archivedActive && "sidebar-item-selected",
									)}
									onClick={onOpenArchived}
									title="View all archived sessions"
								>
									<span className={SIDEBAR_RAIL_CLASS} />
									<span
										className={SIDEBAR_TITLE_CLASS}
										style={{ color: "var(--text-faint)" }}
									>
										{archivedCount > ARCHIVED_INLINE_MAX
											? `More… (${archivedCount - ARCHIVED_INLINE_MAX} older)`
											: "Open archive page"}
									</span>
								</button>
							)}
						</div>
					);
				})()
			: null;

	// One sidebar row per workspace: status dot (most urgent chat), name, chat
	// count, unread dot. Click opens the first chat (or the workspace itself for
	// real workspaces — App resolves that to its first chat / scoped New palette).
	// Right-click opens the workspace menu (pin / color / rename / delete);
	// double-click renames inline.
	function renderWsRow(row: WsRow) {
		return renderWsRowImpl(row, false);
	}

	// `inbox` renders the Inbox-mode variant of the same row — a repo tile in
	// front of the title, idle timestamp on every row — with identical behavior
	// (click, swipe, context menu, pin, archive).
	// Separate impl rather than an optional param because `.map(renderWsRow)`
	// callers would pass the array index into it.
	//
	// `banded` says the row already sits under a header that means "blocked on
	// you" — the Needs input lane, the Inbox's Needs action band. There the
	// attention dot is the third copy of the same fact (header, count, and the
	// row's own accent wash), so it's dropped.
	function renderWsRowImpl(row: WsRow, inbox: boolean, banded = false) {
		const active = row.chats.some((s) => s.id === selectedId);
		const editing = rowRenameEditing(row);
		const waiting = row.status === "needsinput";
		// The "in progress" ticker start: the earliest running chat's start, so a
		// workspace with several live chats shows how long it's been busy overall.
		// Done/idle chats don't count — only chats actually running feed the clock.
		// Prefer the server's runStartedAt (survives refresh); fall back to the
		// first moment we saw this row running. Pruned when the row goes idle.
		let runStartMs: number | null = null;
		if (row.running) {
			const stamps = row.chats
				.filter((c) => c.isRunning && c.runStartedAt)
				.map((c) => Date.parse(c.runStartedAt!))
				.filter((n) => !Number.isNaN(n));
			if (stamps.length) {
				runStartMs = Math.min(...stamps);
				runStartSeen.current.set(row.key, runStartMs);
			} else {
				runStartMs = runStartSeen.current.get(row.key) ?? Date.now();
				runStartSeen.current.set(row.key, runStartMs);
			}
		} else {
			runStartSeen.current.delete(row.key);
		}
		const swipeOffset = isPhone && wsSwipe?.key === row.key ? wsSwipe.offset : 0;
		const swipeAction = isPhone && wsSwipe?.key === row.key ? wsSwipe.action : null;
		const draggingRow = wsDraggingKey === row.key;
		// Which underlay to show: the in-flight drag reveals its side via
		// wsDragSide (per-frame offsets live only in the DOM now), a settled
		// open/committing row falls back to the reconciled wsSwipe state.
		const swipeSide: SwipeAction | null = draggingRow
			? wsDragSide
			: swipeAction === "archive" || swipeOffset < 0
				? "archive"
				: swipeAction === "star" || swipeOffset > 0
					? "star"
					: null;
		const rowPin = workspacePinState(row);
		const pinned = rowPin.pinned;
		const toggleRowPin = rowPin.toggle;
		// Active snooze → the row wears a wake countdown instead of the idle time.
		const snoozeIso = activeSnoozeKeys.has(row.key)
			? (snoozes[row.key] ?? null)
			: null;
		const flatRepoGrouping = filter.groupBy === "repo";
		return (
			<div
				key={row.key}
				className={`sidebar-swipe-row${
					swipeSide ? ` is-open is-swipe-${swipeSide}` : ""
				}${draggingRow ? " is-dragging" : ""}`}
				style={
					swipeOffset
						? ({
								"--swipe-action-w": `${Math.max(
									SWIPE_REVEAL_PX,
									Math.abs(swipeOffset),
								)}px`,
							} as React.CSSProperties)
						: undefined
				}
			>
				{isPhone && row.chats.length > 0 && (
					<button
						className="sidebar-swipe-action sidebar-swipe-action--archive"
						onClick={(e) => {
							e.stopPropagation();
							setWsSwipe(null);
							archiveWorkspaceWithNext(row);
						}}
						title={
							row.chats.length > 1
								? `Archive workspace (${row.chats.length} chats)`
								: "Archive"
						}
					>
						<IconArchive size={22} />
						<span>Archive</span>
					</button>
				)}
				{isPhone && (
					<button
						className={`sidebar-swipe-action sidebar-swipe-action--star${pinned ? " is-on" : ""}`}
						onClick={(e) => {
							e.stopPropagation();
							setWsSwipe(null);
							toggleRowPin();
						}}
						title={pinned ? "Unpin workspace" : "Pin workspace"}
					>
						<IconPin size={22} fill={pinned ? "currentColor" : "none"} />
						<span>{pinned ? "Unpin" : "Pin"}</span>
					</button>
				)}
				<button
					className={cn(
						SIDEBAR_ITEM_CLASS,
						SIDEBAR_WS_ROW_CLASS,
						inbox && "sidebar-item--twoline flex-wrap gap-y-0.5 py-[7px]",
						active && "sidebar-item-selected !bg-hover-strong",
						waiting && "sidebar-item-waiting !bg-blue-soft",
						row.unread && "sidebar-item-unread",
					)}
					style={
						swipeOffset
							? ({ "--swipe-x": `${swipeOffset}px` } as React.CSSProperties)
							: undefined
					}
					onClick={(e) => {
					// Touch taps open from touchend (their ghost click is
					// preventDefault'd), so this is the mouse/desktop path. Still
					// swallow a click that ends a long-press, belt-and-suspenders.
					if (wsLongPressed.current) {
						wsLongPressed.current = false;
						e.preventDefault();
						return;
					}
					if (editing) return;
					if (row.workspace) onOpenProject(row.workspace.id);
					else if (row.chats[0]) onSelect(row.chats[0]);
				}}
					onMouseEnter={(e) => wsRowHoverEnter(row, e.currentTarget)}
					onMouseLeave={scheduleWsHoverClose}
					onMouseDown={closeWsHover}
					onTouchStart={(e) => wsRowTouchStart(row, e)}
					onTouchMove={(e) => wsRowTouchMove(row, e)}
					onTouchEnd={(e) => wsRowTouchEnd(row, e)}
					onTouchCancel={(e) => {
						clearWsPress();
						wsSwipeOrigin.current = null;
						wsSwiping.current = false;
						setWsDraggingKey(null);
						setWsDragSide(null);
						const rowEl = e.currentTarget as HTMLElement;
						rowEl.style.removeProperty("--swipe-x");
						rowEl.parentElement?.style.removeProperty("--swipe-action-w");
					}}
					onContextMenu={(e) => {
					e.preventDefault();
					// On touch this is the long-press callout: our long-press already
					// opened the menu, so don't stack a second one (or the native
					// text-selection callout) on top of it.
					if (wsLongPressed.current || wsPressOrigin.current) return;
					closeWsHover();
					setProjectMenu({
						id: row.workspace ? row.workspace.id : row.key,
						x: e.clientX,
						y: e.clientY,
					});
					}}
					// The button's label replaces its content for assistive tech, so
					// the blocked state — now carried visually by the row's wash —
					// rides here rather than on a marker element.
					aria-label={waiting ? `${row.name}, needs your attention` : row.name}
				>
				{/* Flat repo grouping has no lane heading, so its leading mark must carry
				    the workspace status. Grouped lanes already provide that context and
				    keep the richer PR lifecycle mark here instead. Blocked-on-you never
				    adds a second leading mark: the row's accent wash and bold title
				    already say it, and a green dot hanging off the rail collides with
				    the glyph it precedes (green means "PR healthy" everywhere else). */}
				<span className={SIDEBAR_RAIL_CLASS}>
					{flatRepoGrouping ? (
						<WsStatusMark row={row} size={18} />
					) : row.running ? (
						<PixelSpinner className="text-yellow sidebar-spinner" />
					) : (
						<WsPrStatusMark chats={row.chats} size={18} workspace={row.workspace} />
					)}
				</span>
				{/* Inbox rows name their repo with the tile alone, in front of the
				    title — the repo/branch meta line it replaces cost a second line
				    per row for two words most of the list repeats. */}
				{inbox && !editing && (
					<RepoTile name={wsRowRepo(row)} size={14} />
				)}
				{editing ? (
					<input
						className="min-w-0 flex-1 rounded-md border border-[var(--accent,#6b8afd)] bg-bg px-[3px] text-item-title font-medium text-inherit outline-none"
						value={row.workspace ? projectDraft : chatDraft}
						autoFocus
						onChange={(e) =>
							row.workspace
								? setProjectDraft(e.target.value)
								: setChatDraft(e.target.value)
						}
						onClick={(e) => e.stopPropagation()}
						onDoubleClick={(e) => e.stopPropagation()}
						onBlur={() =>
							row.workspace
								? commitProjectRename()
								: commitChatRename(row.chats[0])
						}
						onKeyDown={(e) => {
							if (e.key === "Enter")
								row.workspace
									? commitProjectRename()
									: commitChatRename(row.chats[0]);
							else if (e.key === "Escape")
								row.workspace
									? setEditingProjectId(null)
									: setEditingChatId(null);
							e.stopPropagation();
						}}
					/>
				) : (
					<span
						// Same class as a session row's title, so workspace rows pick up
						// the shared type scale (incl. the phone bump) and the
						// selected/waiting/unread emphasis from the row's own classes.
						// Inbox rows flex-wrap, where an intrinsic-width title would push
						// the trailing ticker/time onto a wrapped line instead of
						// shrinking — flex-1 keeps the first line a single line.
						className={cn(SIDEBAR_TITLE_CLASS, inbox && "flex-1")}
						onDoubleClick={(e) => {
							e.stopPropagation();
							if (row.workspace) {
								setProjectDraft(row.workspace.name);
								setEditingProjectId(row.workspace.id);
							} else if (row.chats[0]) {
								// Solo chat rows rename the chat itself.
								startChatRename(row.chats[0]);
							}
						}}
					>
						{stripPrTitlePrefix(row.name)}
					</span>
				)}
				{localMode && row.chats.some((chat) => chat.local) && !editing && (
					<span className="shrink-0 rounded-full border border-line px-1.5 py-px text-meta font-medium tracking-wide text-faint">
						local
					</span>
				)}
				{/* Teammates currently viewing a chat in this workspace. */}
				{!editing &&
					(() => {
						const viewers = teamViewing.filter(
							(v) =>
								v.user.toLowerCase() !== currentUser.toLowerCase() &&
								row.chats.some((c) => c.id === v.sessionId),
						);
						if (!viewers.length) return null;
						// Faces sit side by side rather than stacked: an overlapped pile
						// needs an opaque ring the color of what's behind it, and a row's
						// backdrop varies (sidebar material, hover ink, selected, waiting),
						// so any fixed ring reads as a hard frame on most of them.
						return (
							<span
								className="flex shrink-0 items-center gap-0.5"
								aria-label={`Viewing: ${viewers.map((v) => v.user).join(", ")}`}
							>
								{viewers.slice(0, 3).map((v) => (
									<UserAvatar
										key={v.user}
										name={v.user}
										size={16}
										title={`${v.user} is here`}
									/>
								))}
							</span>
						);
					})()}
				{/* A live workspace run always earns its elapsed ticker. Idle timestamps
				    are reserved for standalone chats, so an automation review does not
				    make its PR workspace look recently active. */}
				{runStartMs !== null && <RunTicker startMs={runStartMs} />}
				{snoozeIso && !editing && <SnoozeBadge until={snoozeIso} />}
				{!isPhone &&
					// Date-banded modes earn a timestamp on every row: the band says
					// which day, the stamp says when within it. ("Project and inbox"
					// renders compact rows, so it asks for the time here.)
					(inbox || filter.groupBy === "repo-inbox" || !row.workspace) &&
					!snoozeIso &&
					wsTimePref !== "off" &&
					row.lastActivity && (
						<span
							className={`sidebar-ws-time${
								wsTimePref === "hover" ? " sidebar-ws-time--hover" : ""
							}${runStartMs !== null ? " sidebar-ws-time--running" : ""}`}
							aria-label={new Date(row.lastActivity).toLocaleString()}
						>
							{shortTime(row.lastActivity)}
						</span>
					)}
				{/* Slack-style pencil: a chat here holds an unsent draft — come back
				    and finish it. Yields to the hover actions like the count/time. */}
				{row.chats.some((c) => hasDraft(`chat:${c.id}`)) && (
					<span
						className="sidebar-ws-draft"
						aria-label="Unsent draft. Return to finish it."
					>
						<IconPencil size={20} />
					</span>
				)}
				{isPhone && !banded && waiting && (
					<span
						className="ml-auto flex h-[22px] w-7 shrink-0 items-center justify-center"
						aria-label="Needs your attention"
					>
						<span className="block size-[7px] rounded-full bg-green" />
					</span>
				)}
				{/* Hover actions: pin + archive, side by side. */}
				<span className={SIDEBAR_ACTIONS_CLASS}>
					<span
						role="button"
						tabIndex={0}
						className={cn(SIDEBAR_ACTION_CLASS, pinned && "is-on text-accent")}
						aria-label={pinned ? "Unpin workspace" : "Pin workspace"}
						onClick={(e) => {
							e.stopPropagation();
							toggleRowPin();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.stopPropagation();
								toggleRowPin();
							}
						}}
					>
						<IconPin size={21} fill={pinned ? "currentColor" : "none"} />
					</span>
					{row.chats.length > 0 && (
						<Tooltip
							label={
								row.chats.length > 1
									? `Archive workspace (${row.chats.length} chats)`
									: "Archive workspace"
							}
							shortcut={
								// Single-chat workspace: archiving the workspace is archiving
								// the open chat, so advertise its browser-compatible chord. The
								// ⌘⌥⇧A escalation only matters with more than one chat.
								active
									? row.chats.length > 1
										? ARCHIVE_WS_SHORTCUT_KEYS
										: ARCHIVE_SHORTCUT_KEYS
									: undefined
							}
						>
							<span
								role="button"
								tabIndex={0}
								className={SIDEBAR_ACTION_CLASS}
								aria-label="Archive workspace"
								onClick={(e) => {
									e.stopPropagation();
									archiveWorkspaceWithNext(row);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.stopPropagation();
										archiveWorkspaceWithNext(row);
									}
								}}
							>
								<IconArchive size={21} />
							</span>
						</Tooltip>
					)}
				</span>
				</button>
			</div>
		);
	}

	// Quick "mark done" straight from a Support row — optimistic removal (the
	// ticket leaves Plain's Todo queue), restored by a refetch if Plain says no.
	async function markSupportRowDone(threadId: string) {
		setFeedItems((prev) => ({
			...prev,
			plain: (prev.plain || []).filter((x) => x.id !== threadId),
		}));
		try {
			await setPlainThreadStatusApi(threadId, "done", { user: currentUser });
		} catch {
			fetchFeedItems("plain")
				.then((items) =>
					setFeedItems((prev) => ({ ...prev, plain: items })),
				)
				.catch(() => {});
		}
	}

	// A Support row: one TODO Plain ticket. The dot wears the linked session's
	// status (faint when no session exists yet); click opens the session, or the
	// session-less ticket preview when there isn't one. Hovering reveals the
	// one-click "mark done" button at the row's right edge.
	function supportThreadActive(t: SupportThread) {
		// The ticket's workspace is open (chat-less route or one of its chats)…
		if (selectedWorkspaceId) {
			const ws = projects.find((p) => p.id === selectedWorkspaceId);
			if (ws?.plainThreadId === t.id) return true;
		}
		// …or its linked session is the open chat (pre-workspace sessions).
		const session = supportSessionByThread.get(t.id);
		return !!session && session.id === selectedId;
	}

	// A Support row in the workspace rows' shape — see SupportRow for the
	// markup; this binds it to the sidebar's state and handlers.
	function renderSupportRow(t: SupportThread) {
		const pinKey = `support:${t.id}`;
		const linked = supportSessionByThread.get(t.id) || null;
		return (
			<SupportRow
				key={pinKey}
				thread={t}
				session={linked}
				active={supportThreadActive(t)}
				pinned={pins.includes(pinKey)}
				onTogglePin={() => setPins(togglePin(pinKey))}
				onOpen={() => onOpenTicket(t)}
				onMarkDone={() => markSupportRowDone(t.id)}
				onSetStatus={
					linked ? (status) => onSetStatus([linked], status) : undefined
				}
			/>
		);
	}

	// The repo band a workspace row files under. The workspace's own repo wins:
	// it's what the work is *about*, while a chat's repo is only the checkout it
	// happens to run from — a PR workspace for shared-infra whose chat runs in a
	// tella-fusion worktree belongs under shared-infra. A workspace spanning
	// repos still files under one band (a row in two bands double-counts and
	// reads as two pieces of work); the repo *filter* honours every repo it
	// touches, so it stays findable from the others.
	function wsRowRepo(row: WsRow): string {
		return (
		row.workspace?.repo ||
		row.workspace?.externalRefs?.[0]?.kind ||
		row.chats[0]?.repo ||
		sessionRepo(row.chats[0] || ({} as UnifiedSession))
	);
	}

	// The Snoozed group — the quiet zone, shared by the status lanes (slotted
	// just above Backlog) and the inbox bands (appended last, after Earlier).
	// `ns` keeps each repo's copy collapsible on its own.
	function renderSnoozedGroup(rows: WsRow[], ns = "") {
		const gkey = `${ns}status:snoozed`;
		const open = isOpen(gkey);
		return (
			<div className="sidebar-status-group sidebar-lane-group" key={gkey}>
				<button
					// Same bare .sidebar-group-header as the lanes: utilities here
					// would out-specify its phone/nesting overrides and leave this
					// one header out of line with the rest.
					className={SIDEBAR_GROUP_HEADER_CLASS}
					onClick={() => toggleGroup(gkey)}
				>
					<span className={SIDEBAR_GROUP_NAME_CLASS}>Snoozed</span>
					<span className={SIDEBAR_GROUP_COUNT_CLASS}>{rows.length}</span>
					<IconChevronDown
						className={SIDEBAR_GROUP_CHEVRON_CLASS}
						size={22}
						style={{ transform: open ? "none" : "rotate(-90deg)" }}
					/>
				</button>
				{rows
					.filter((r) => open || r.chats.some((c) => c.id === selectedId))
					.map(renderWsRow)}
			</div>
		);
	}

	// The Conductor-style status lanes (Needs input / In progress / …) over a set
	// of workspace rows. `ns` keeps each repo's lane collapse state independent.
	// `snoozedRows` (when given) render as a Snoozed group slotted just above
	// the final Backlog lane — the quiet zone, per the T3-style snooze design.
	function renderStatusLanes(
		rows: WsRow[],
		ns = "",
		snoozedRows?: WsRow[],
		laneRepo?: string,
		prItems: ReviewQueueItem[] = [],
	) {
		// While an eligible Pinned row is mid-drag these lanes double as drop
		// targets: per-repo lanes only for the row's own repo, and empty lanes
		// materialize (dimmed) so every status can take the drop.
		const dropEligible =
			!!pinDragMeta &&
			pinDragMeta.chats.length > 0 &&
			(!laneRepo || laneRepo === pinDragMeta.repo);
		const lanes = MINE_STATUS_META.map((meta) => {
			const items = rows.filter((r) => r.status === meta.key);
			// Session-less PR rows share the lanes since the PR-band dissolution.
			const prs = prItems.filter((i) => prItemLane(i) === meta.key);
			if (items.length === 0 && prs.length === 0 && !dropEligible)
				return null;
			const gkey = `${ns}status:${meta.key}`;
			const open = isOpen(gkey);
			const dropHover = dropEligible && laneDropHover?.gkey === gkey;
			return (
				<div
					className={`sidebar-status-group sidebar-lane-group${
						dropEligible && items.length === 0 && prs.length === 0
							? " is-lane-empty"
							: ""
					}${dropHover ? " is-lane-drop-hover" : ""}`}
					key={gkey}
					data-lane-drop={dropEligible ? gkey : undefined}
					data-lane-status={dropEligible ? meta.key : undefined}
					data-lane-repo={dropEligible && laneRepo ? laneRepo : undefined}
				>
					<button
						// Layout, padding and type all come from .sidebar-group-header —
						// utilities here would out-specify its phone overrides and leave
						// these two headers indented (and smaller) than the rest.
						className={SIDEBAR_GROUP_HEADER_CLASS}
						onClick={() => toggleGroup(gkey)}
					>
						<span className={SIDEBAR_GROUP_NAME_CLASS}>{meta.label}</span>
						{/* Count rides directly behind the lane name, not pinned right. */}
						<span className={SIDEBAR_GROUP_COUNT_CLASS}>
							{items.length + prs.length}
						</span>
						<IconChevronDown
							className={SIDEBAR_GROUP_CHEVRON_CLASS}
							size={22}
							style={{ transform: open ? "none" : "rotate(-90deg)" }}
						/>
					</button>
					{items
						.filter((r) => open || r.chats.some((c) => c.id === selectedId))
						.map((r) => renderWsRowImpl(r, false, meta.key === "needsinput"))}
					{prs
						.filter((i) => open || prRowSelected(i))
						.map(renderPrRow)}
				</div>
			);
		});
		if (snoozedRows && snoozedRows.length > 0) {
			// Snoozed slots directly after Backlog ("pending") — the quiet zone
			// sits with the parked work, ahead of Ready to merge / Done.
			lanes.splice(
				MINE_STATUS_META.findIndex((m) => m.key === "pending") + 1,
				0,
				renderSnoozedGroup(snoozedRows, ns),
			);
		}
		return lanes;
	}

	// ── Inbox mode: the workspace rows as one activity-ranked list ─────────
	// No repo/status grouping — bands mirror an email inbox instead: Needs
	// action (blocked on you) → Recent (running or touched today, one
	// activity-ranked mix) → Yesterday → Earlier. Bands are exclusive with
	// priority needs-action > recent > date, and the ranking always follows
	// lastActivity ("Sort by: Created" deliberately doesn't apply — an inbox
	// orders by what moved last).
	//
	// "Project and inbox" reuses these bands nested under each repo band, so
	// `ns` (the repo's key prefix) keeps every copy collapsible on its own,
	// and the flat mode's flush row inset is dropped when nested. That mode
	// also passes the repo's snoozed rows (one Snoozed group per repo, like
	// the status lanes do) and its session-less PR rows, banded by the PR's
	// own updatedAt — under a repo band those rows are part of the project's
	// inventory, so hiding them the way flat Inbox does would lose work.
	function renderInboxBands(
		rows: WsRow[],
		ns = "",
		snoozedRows: WsRow[] = [],
		prItems: ReviewQueueItem[] = [],
	) {
		const sorted = [...rows].sort((a, b) =>
			(b.lastActivity || "").localeCompare(a.lastActivity || ""),
		);
		const dayStart = new Date();
		dayStart.setHours(0, 0, 0, 0);
		const todayMs = dayStart.getTime();
		const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;
		const bands: Array<{
			key: string;
			label: string;
			rows: WsRow[];
			prs: ReviewQueueItem[];
		}> = [
			{ key: "needsaction", label: "Needs action", rows: [], prs: [] },
			{ key: "recent", label: "Recent", rows: [], prs: [] },
			{ key: "yesterday", label: "Yesterday", rows: [], prs: [] },
			{ key: "earlier", label: "Earlier", rows: [], prs: [] },
		];
		const [needsAction, recent, yesterday, earlier] = bands;
		for (const r of sorted) {
			// NaN (no lastActivity) compares false on both → Earlier. A running
			// row counts as Recent whatever its day — live work is recent by
			// definition — but ranks by lastActivity like its neighbours.
			const t = Date.parse(r.lastActivity || "");
			if (r.status === "needsinput") needsAction.rows.push(r);
			else if (r.running || t >= todayMs) recent.rows.push(r);
			else if (t >= yesterdayMs) yesterday.rows.push(r);
			else earlier.rows.push(r);
		}
		// A bare PR is never "blocked on you" here (review requests aimed at you
		// ride the notification band instead), so it only ever bands by date.
		for (const item of [...prItems].sort((a, b) =>
			(b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || ""),
		)) {
			const t = Date.parse(item.pr.updatedAt || "");
			if (t >= todayMs) recent.prs.push(item);
			else if (t >= yesterdayMs) yesterday.prs.push(item);
			else earlier.prs.push(item);
		}
		const nodes = bands
			.filter((b) => b.rows.length > 0 || b.prs.length > 0)
			.map((b) => {
				const gkey = `${ns}inbox:${b.key}`;
				const open = isOpen(gkey);
				return (
					<div className="sidebar-status-group sidebar-lane-group" key={gkey}>
						<button
							// Bare .sidebar-group-header like the status lanes — see
							// renderStatusLanes for why utilities stay off it.
							className={SIDEBAR_GROUP_HEADER_CLASS}
							onClick={() => toggleGroup(gkey)}
						>
							<span className={SIDEBAR_GROUP_NAME_CLASS}>{b.label}</span>
							<span className={SIDEBAR_GROUP_COUNT_CLASS}>
								{b.rows.length + b.prs.length}
							</span>
							<IconChevronDown
								className={SIDEBAR_GROUP_CHEVRON_CLASS}
								size={22}
								style={{ transform: open ? "none" : "rotate(-90deg)" }}
							/>
						</button>
						{b.rows
							.filter((r) => open || r.chats.some((c) => c.id === selectedId))
							// Nested, the two-line variant's meta line would repeat the
							// repo tile + name the band header already carries, so the
							// rows stay compact like every other repo-nested mode's.
							.map((r) =>
								renderWsRowImpl(r, !ns, b.key === "needsaction"),
							)}
						{b.prs.filter((i) => open || prRowSelected(i)).map(renderPrRow)}
					</div>
				);
			});
		if (snoozedRows.length > 0) nodes.push(renderSnoozedGroup(snoozedRows, ns));
		return nodes;
	}

	// The repo bands — one collapsible band per repo, shared by three "Group by"
	// modes: "flat" holds a Conductor-style row list (status reads from
	// each row's own glyph, needs-input rows float to the top), while "status"
	// nests the labeled status lanes under each band and "inbox" nests the
	// activity bands (Needs action / Recent / Yesterday / Earlier) instead. In
	// both, a collapsed band wears a count of the urgent rows it hides. Repos
	// are ordered by the user's shared preference (`repos`), with newly seen
	// repositories appended in frequency order; a band is force-open while it
	// holds the selected row so the open session never hides inside a collapsed repo.
	function renderRepoGroups(mode: "flat" | "status" | "inbox") {
		const byRepo = new Map<string, WsRow[]>();
		const snoozedByRepo = new Map<string, WsRow[]>();
		const bucket = (map: Map<string, WsRow[]>, repo: string) => {
			let b = map.get(repo);
			if (!b) {
				b = [];
				map.set(repo, b);
			}
			return b;
		};
		// Feed workspaces are represented by their feed band's item rows —
		// don't also mint a pseudo-repo band for them (rowIsFeedOnly above).
		for (const r of focusWsRows)
			if (!rowIsFeedOnly(r)) bucket(byRepo, wsRowRepo(r)).push(r);
		// The grouped modes keep each repo's snoozed rows in that repo's own
		// band, as a Snoozed group beside the other lanes/bands — a global
		// Snoozed group would strand them away from their repo. Flat "Repo" mode
		// has nothing to slot one into, so there they stay in the single global
		// group.
		if (mode !== "flat")
			for (const r of snoozedWsRows)
				if (!rowIsFeedOnly(r)) bucket(snoozedByRepo, wsRowRepo(r)).push(r);
		// Session-less PR rows file into their repo's band alongside the
		// workspace rows (the dissolved Pull-requests band). Review requests
		// pointed at you are excluded — they ride the notification band under
		// Pinned instead.
		const prByRepo = new Map<string, ReviewQueueItem[]>();
		for (const item of lanePrItems) {
			const list = prByRepo.get(item.pr.repo) || [];
			list.push(item);
			prByRepo.set(item.pr.repo, list);
		}
		const present = new Set([
			...byRepo.keys(),
			...snoozedByRepo.keys(),
			...prByRepo.keys(),
		]);
		const order = [
			...repos.filter((r) => present.has(r)),
			...Array.from(present).filter((r) => !repos.includes(r)),
		];
		const fullOrder = normalizeRepoOrder([
			...normalizeRepoOrder(savedRepoOrder),
			...repos.filter((repo) => !savedRepoOrder.includes(repo)),
			...order.filter((repo) => !repos.includes(repo)),
		]);
		const canReorder = !isPhone && filter.repo === "all" && order.length > 1;
		const moveDraggedRepo = (
			targetRepo: string,
			event: React.DragEvent<HTMLDivElement>,
		) => {
			const draggedRepo = repoDragging.current;
			if (!draggedRepo) return;
			event.preventDefault();
			if (draggedRepo === targetRepo) return;
			const visibleOrder = [...(repoVisualOrder.current ?? order)];
			const from = visibleOrder.indexOf(draggedRepo);
			if (from < 0) return;
			visibleOrder.splice(from, 1);
			let target = visibleOrder.indexOf(targetRepo);
			if (target < 0) return;
			const header = event.currentTarget.querySelector<HTMLElement>(
				":scope > .sidebar-repo-head",
			);
			const rect = (header ?? event.currentTarget).getBoundingClientRect();
			if (event.clientY > rect.top + rect.height / 2) target++;
			visibleOrder.splice(target, 0, draggedRepo);
			if (JSON.stringify(visibleOrder) === JSON.stringify(repoVisualOrder.current))
				return;
			repoVisualOrder.current = visibleOrder;
			const baseline = repoOrderAtDragStart.current ?? fullOrder;
			const next = replaceVisibleRepoOrder(baseline, visibleOrder);
			repoOrderPending.current = next;
			setRepoOrderDraft(next);
		};
		const finishRepoDrag = (commit: boolean) => {
			stopRepoAutoScroll();
			repoJustDragged.current = true;
			setTimeout(() => {
				repoJustDragged.current = false;
			}, 0);
			repoOrderAtDragStart.current = null;
			repoVisualOrder.current = null;
			repoDragging.current = null;
			setRepoDragKey(null);
			const pending = repoOrderPending.current;
			repoOrderPending.current = null;
			setRepoOrderDraft(null);
			if (commit && pending) setRepoOrder(pending);
		};
		return (
			<div className="sidebar-repo-order-list">
				{order.map((repo) => {
				const rows = byRepo.get(repo) || [];
				const snoozedRows = snoozedByRepo.get(repo) || [];
				const prs = prByRepo.get(repo) || [];
				const urgent = rows.filter((r) => r.status === "needsinput");
				// Flat mode: rows keep the status-lane ordering (needs input, then
				// in progress, review, done, backlog) so a live run never sinks
				// below idle rows; the sort is stable, so activity order holds
				// within each bucket.
				const laneRank = (s: MineStatus) =>
					MINE_STATUS_META.findIndex((m) => m.key === s);
				const ordered = [...rows].sort(
					(a, b) => laneRank(a.status) - laneRank(b.status),
				);
				const gkey = `repo:${repo}`;
				const open = isOpen(gkey);
				// A collapsed band still surfaces the selected row(s) so the
				// open session never hides — without force-opening the band
				// (which made its chevron a frustrating no-op).
				const selectedRows = open
					? []
					: [...rows, ...snoozedRows].filter((r) =>
							r.chats.some((c) => c.id === selectedId),
						);
				const selectedPrs = open ? [] : prs.filter(prRowSelected);
				return (
					<div
						className={cn(
							"sidebar-repo-group",
							canReorder && "cursor-grab active:cursor-grabbing",
							repoDragKey === repo &&
								"[&>.sidebar-repo-head]:rounded-md [&>.sidebar-repo-head]:bg-hover [&>.sidebar-repo-head]:opacity-50 [&>.sidebar-repo-head]:ring-1 [&>.sidebar-repo-head]:ring-inset [&>.sidebar-repo-head]:ring-line-strong",
						)}
						key={gkey}
						data-repo-id={repo}
						onDragOver={(event) => moveDraggedRepo(repo, event)}
						onDrop={(event) => {
							event.preventDefault();
							finishRepoDrag(true);
						}}
						onClickCapture={(event: React.MouseEvent) => {
							if (!repoJustDragged.current) return;
							event.preventDefault();
							event.stopPropagation();
						}}
					>
						<button
							className={`${SIDEBAR_GROUP_HEADER_CLASS} sidebar-repo-head`}
							draggable={canReorder}
							title={canReorder ? "Drag to reorder repositories" : undefined}
							onDragStart={(event) => {
								repoDragging.current = repo;
								setRepoDragKey(repo);
								repoOrderAtDragStart.current = [...fullOrder];
								repoOrderPending.current = null;
								repoVisualOrder.current = [...order];
								event.dataTransfer.effectAllowed = "move";
								event.dataTransfer.setData("text/plain", repo);
							}}
							onDragEnd={() => finishRepoDrag(false)}
							onClick={() => toggleGroup(gkey)}
						>
							{/* The tile is 18px; the rail holds it on the same column
							    (and text rail) as every other header's mark. */}
							<span className={SIDEBAR_RAIL_CLASS}>
								<RepoTile name={repo} />
							</span>
							<span className={SIDEBAR_GROUP_NAME_CLASS}>{repoLabel(repo)}</span>
							{/* Count rides directly behind the repo name, not pinned right. */}
							<span className={SIDEBAR_GROUP_COUNT_CLASS}>
								{rows.length + snoozedRows.length + prs.length}
							</span>
							{/* Urgent rows must not vanish into a closed band — a collapsed
							    header wears the count of rows waiting for input. */}
							{!open && urgent.length > 0 && (
								<span
									className="sidebar-repo-attn"
									aria-label={`${urgent.length} waiting for input`}
								>
									{urgent.length}
								</span>
							)}
							<IconChevronDown
								className={SIDEBAR_GROUP_CHEVRON_CLASS}
								size={22}
								style={{ transform: open ? "none" : "rotate(-90deg)" }}
							/>
							{/* Hover action at the far end: start a new session with this
							    repo already selected. role=button (not a nested <button>). */}
							<span
								role="button"
								tabIndex={0}
								className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-faint opacity-100 transition-[opacity,color,background] duration-150 hover:bg-hover hover:text-fg focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
								title={`New session in ${repoLabel(repo)}`}
								onClick={(e) => {
									e.stopPropagation();
									onNewSessionInRepo(repo);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.stopPropagation();
										onNewSessionInRepo(repo);
									}
								}}
							>
								<IconPlus size={24} />
							</span>
						</button>
						{open ? (
							<div className="sidebar-repo-lanes">
								{mode === "status"
									? renderStatusLanes(
											rows,
											`repo:${repo}::`,
											snoozedRows,
											repo,
											prs,
										)
									: mode === "inbox"
									? renderInboxBands(rows, `repo:${repo}::`, snoozedRows, prs)
									: [
											...ordered.map(renderWsRow),
											// Flat mode has no lane headings: PR rows keep
											// the lane ordering after the workspace rows.
											...[...prs]
												.sort(
													(a, b) =>
														laneRank(prItemLane(a)) -
														laneRank(prItemLane(b)),
												)
												.map(renderPrRow),
										]}
							</div>
						) : (
							(selectedRows.length > 0 || selectedPrs.length > 0) && (
								<div className="sidebar-repo-lanes">
									{selectedRows.map(renderWsRow)}
									{selectedPrs.map(renderPrRow)}
								</div>
							)
						)}
					</div>
				);
				})}
			</div>
		);
	}

	// ── Plain (support) as a project ────────────────────────────────────────
	// The Plain TODO queue rendered as a sibling of the repo bands: a project
	// whose lanes are priorities (Urgent/High/Normal/Low) instead of statuses.
	// Hidden while a repo filter narrows the list — tickets belong to no repo.
	const plainFeedDesc = visibleFeeds.find((f) => f.id === "plain");
	const plainThreadsInView =
		filter.repo === "all" && plainFeedDesc
			? applyFeedFilters(plainFeedDesc, feedItems.plain || []).map(
					(i) => i.meta as unknown as SupportThread,
				)
			: [];

	// The priority lanes, shared by the Plain project band (nested under it)
	// and the flat "Group by: Status" view (appended after the status lanes).
	function renderSupportLanes(threads: SupportThread[]) {
		return SUPPORT_PRIORITY_GROUPS.map((group) => {
			const items = threads.filter((t) => (t.priority ?? 2) === group.p);
			if (items.length === 0) return null;
			const gkey = `support:prio:${group.p}`;
			const groupIsOpen = isOpen(gkey);
			return (
				<div
					className="sidebar-status-group sidebar-lane-group"
					key={`support-prio-${group.p}`}
				>
					<button
						className={SIDEBAR_GROUP_HEADER_CLASS}
						onClick={() => toggleGroup(gkey)}
					>
						<span
							className={`sidebar-group-name ${group.p <= 1 ? group.cls : ""}`}
						>
							{group.label}
						</span>
						<span className={`sidebar-group-count ${group.cls}`}>
							{items.length}
						</span>
						<IconChevronDown
							className={SIDEBAR_GROUP_CHEVRON_CLASS}
							size={20}
							style={{
								transform: groupIsOpen ? "none" : "rotate(-90deg)",
							}}
						/>
					</button>
					{items
						.filter((t) => groupIsOpen || supportThreadActive(t))
						.map(renderSupportRow)}
				</div>
			);
		});
	}

	// The Plain queue filter (assignee / label / has-session) — rides the
	// project band's header as a span-rendered menu trigger (the header itself
	// is a button, so a nested <button> trigger is off the table). Free text
	// rides the sidebar-wide search box.
	// Is a feed item's workspace (or its linked session) the open surface?
	function feedItemActive(feed: FeedDescriptor, item: FeedItem) {
		if (selectedWorkspaceId) {
			const ws = projects.find((p) => p.id === selectedWorkspaceId);
			if (
				ws?.externalRefs?.some(
					(r) => r.kind === feed.refKind && r.id === item.id,
				)
			)
				return true;
		}
		const session = feedSessionByRef.get(`${feed.refKind}:${item.id}`);
		return !!session && session.id === selectedId;
	}

	// A generic feed band (Tella videos, …) styled like the Plain project band:
	// brand tile + name + count, newest-first rows nested under
	// (the feeds design). Hidden while a repo filter is active, like Plain.
	function renderFeedBand(feed: FeedDescriptor, withLanes = false) {
		const isPlain = feed.id === "plain";
		const sortSel =
			(feedFilters[feed.id] || {}).__sort ||
			feed.sortOptions?.[0]?.value ||
			"recent";
		const metaSortPath = sortSel.startsWith("meta:")
			? sortSel.slice(5)
			: null;
		const items = applyFeedFilters(feed, feedItems[feed.id] || []).sort(
			(a, b) =>
				metaSortPath
					? (Number(dget(b.meta, metaSortPath)) || 0) -
						(Number(dget(a.meta, metaSortPath)) || 0)
					: sortSel === "title"
						? a.title.localeCompare(b.title)
						: sortSel === "oldest"
							? (a.ts || 0) - (b.ts || 0)
							: (b.ts || 0) - (a.ts || 0),
		);
		// Plain rows render through the bespoke SupportRow pipeline (hover
		// card, mark-done, filters) inside this generic band container; the
		// filtered thread list is the source of truth for it.
		const plainThreads = isPlain ? plainThreadsInView : null;
		const count = isPlain ? plainThreads!.length : items.length;
		// An active filter (or search) must never hide the band — zero matches
		// with no visible filter menu is a trap you can't click out of. Only a
		// genuinely empty feed (no raw items, nothing filtered away) hides.
		const vals = feedFilters[feed.id] || {};
		const hasActiveFilter =
			Object.entries(vals).some(([k, v]) => v && k !== "__sort") ||
			!!search.trim();
		const rawCount = (feedItems[feed.id] || []).length;
		if ((count === 0 && rawCount === 0 && !hasActiveFilter) || filter.repo !== "all")
			return null;
		const gkey = isPlain ? "project:plain" : `project:feed-${feed.id}`;
		const open = isOpen(gkey);
		const renderRow = (item: FeedItem) => {
			const pinKey = `feed:${feed.refKind}:${item.id}`;
			const linked = feedSessionByRef.get(`${feed.refKind}:${item.id}`) || null;
			return (
				<FeedRow
					key={`${feed.id}:${item.id}`}
					feed={feed}
					item={item}
					session={linked}
					active={feedItemActive(feed, item)}
					pinned={pins.includes(pinKey)}
					onTogglePin={() => setPins(togglePin(pinKey))}
					onOpen={() => onOpenFeedItem(feed, item)}
					onSetStatus={
						linked ? (status) => onSetStatus([linked], status) : undefined
					}
				/>
			);
		};
		// Collapsed band still surfaces the active item/ticket (same rule as
		// the repo bands' selected rows).
		const activeItems = open
			? []
			: items.filter((i) => feedItemActive(feed, i));
		const activeThreads =
			open || !isPlain ? [] : plainThreads!.filter(supportThreadActive);
		// Attention badge on a collapsed band (e.g. Plain's Urgent lane).
		const attentionCount = feed.attentionLane
			? isPlain
				? plainThreads!.filter((t) => (t.priority ?? 2) === 0).length
				: items.filter((i) => i.lane === feed.attentionLane).length
			: 0;
		const noMatches = (
			<div className="px-3 py-2 text-label text-faint">
				No items match the filters
			</div>
		);
		const openBody = isPlain ? (
			<div className="sidebar-repo-lanes">
				{count === 0
					? noMatches
					: withLanes
						? renderSupportLanes(plainThreads!)
						: [...plainThreads!]
								.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))
								.map(renderSupportRow)}
			</div>
		) : (
			<div className="sidebar-repo-lanes">
				{count === 0 ? noMatches : items.map(renderRow)}
			</div>
		);
		const collapsedBody = isPlain
			? activeThreads.length > 0 && (
					<div className="sidebar-repo-lanes">
						{activeThreads.map(renderSupportRow)}
					</div>
				)
			: activeItems.length > 0 && (
					<div className="sidebar-repo-lanes">
						{activeItems.map(renderRow)}
					</div>
				);
		return (
			<div className="sidebar-repo-group" key={gkey}>
				<ContextMenu.Root>
					<ContextMenu.Trigger
						render={
							<button
								className={`${SIDEBAR_GROUP_HEADER_CLASS} sidebar-repo-head`}
								onClick={() => toggleGroup(gkey)}
							/>
						}
					>
						<span className={SIDEBAR_RAIL_CLASS}>
							<RepoTile name={feed.id} />
						</span>
						<span className={SIDEBAR_GROUP_NAME_CLASS}>{feed.title}</span>
						<span className={SIDEBAR_GROUP_COUNT_CLASS}>{count}</span>
						{!open && attentionCount > 0 && (
							<span
								className="sidebar-repo-attn"
								aria-label={`${attentionCount} urgent`}
							>
								{attentionCount}
							</span>
						)}
						<IconChevronDown
							className={SIDEBAR_GROUP_CHEVRON_CLASS}
							size={22}
							style={{ transform: open ? "none" : "rotate(-90deg)" }}
						/>
						<FeedFilterMenu
							feed={feed}
							values={feedFilters[feed.id] || {}}
							rawItems={feedItems[feed.id] || []}
							currentUser={currentUser}
							onSet={(k, v) => setFeedFilter(feed, k, v)}
							onHide={() => setSidebarFeedVisible(feed.id, false)}
						/>
					</ContextMenu.Trigger>
					<ContextMenu.Popup>
						<ContextMenu.Item
							onClick={() => setSidebarFeedVisible(feed.id, false)}
						>
							Hide from sidebar
						</ContextMenu.Item>
					</ContextMenu.Popup>
				</ContextMenu.Root>
				{open ? openBody : collapsedBody}
			</div>
		);
	}

	return (
		<div
			className="sidebar flex min-h-0 w-full flex-1 flex-col overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[720px]:pt-[var(--header-h)] max-[720px]:pb-[max(24px,env(safe-area-inset-bottom))]"
			ref={sidebarScrollRef}
			onDragOver={handleRepoAutoScroll}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null))
					stopRepoAutoScroll();
			}}
		>
			{localMode && cloudUnreachable && (
				<div
					className="mx-2 mt-2 flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-2 text-[11px] text-dim"
					role="status"
					title="Local sessions are still available"
				>
					<IconGlobe size={15} className="shrink-0 text-faint" />
					<span>Cloud temporarily unavailable</span>
				</div>
			)}
			<div
				className="sidebar-sticky-section sidebar-tools-section block min-w-0 max-w-full shrink-0"
				style={{ order: 0 }}
			>
			{!isPhone && visibleTools.length > 0 && (
				<div className="sidebar-band-label sidebar-tools-head sidebar-sticky-head">
					<div className="group flex min-h-[30px] w-full items-center rounded-md hover:bg-hover hover:text-dim">
						<button
							className="sidebar-band-toggle w-auto flex-1 hover:bg-transparent"
							onClick={() => toggleBand("tools")}
							aria-expanded={toolsOpen}
							title={toolsOpen ? "Collapse tools" : "Expand tools"}
						>
							<span className="sidebar-band-name">Tools</span>
							<IconChevronDown
								className="sidebar-band-chevron"
								size={18}
								style={{
									transform: toolsOpen ? "none" : "rotate(-90deg)",
								}}
							/>
						</button>
						<Menu.Root>
							<Menu.Trigger
								type="button"
								className="invisible mr-1 ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-dim group-hover:visible hover:bg-hover hover:text-fg data-[popup-open]:visible data-[popup-open]:text-dim"
								aria-label="Choose toolbar tools"
								title="Choose toolbar tools"
							>
								<IconDotsHorizontal size={22} />
							</Menu.Trigger>
							<Menu.Popup side="bottom" align="end" sideOffset={4}>
								<Menu.Group>
									<Menu.GroupLabel>Show in toolbar</Menu.GroupLabel>
									{tools.map((tool) => (
										<Menu.CheckboxItem
											key={tool.id}
											checked={!hiddenTools.has(tool.id)}
											onCheckedChange={(checked) =>
												setToolVisible(tool.id, checked)
											}
										>
											<span className="flex size-4 shrink-0 items-center justify-center rounded-xs border border-line-strong text-fg">
												{!hiddenTools.has(tool.id) && <IconCheck size={12} />}
											</span>
											<span className="text-fg">{tool.label}</span>
										</Menu.CheckboxItem>
									))}
								</Menu.Group>
								<Menu.Separator />
								<Menu.Item onClick={hideAllSidebarTools}>
									Hide tools from sidebar
								</Menu.Item>
							</Menu.Popup>
						</Menu.Root>
					</div>
				</div>
			)}
			{visibleTools.length > 0 && (isPhone || toolsOpen) && (
				<nav className="sidebar-nav">
					{visibleTools.map((tool) => {
						const rowClass = cn(
							// The desktop look lives in these utilities and MUST stay
							// desktop-only: utilities win cascade ties against the phone
							// card adapter CSS (@media), so an unconditional w-full/
							// py-* here is exactly the "full-width Home card on mobile"
							// bug. Phones render the Slack-home style 132px card strip
							// purely from .sidebar-nav-item's media rules.
							"sidebar-nav-item group flex text-left transition-colors",
							// `active` is what the phone card CSS keys its selected state
							// off (.sidebar-nav-item.active in the adapter's @media block);
							// the desktop selected look comes from the utilities below.
							// Dropping it in the Tailwind migration left the phone cards
							// with no "you are here".
							tool.active && "active",
							// Desktop-only for the same reason as the block below: a bare
							// items-center wins the cascade tie against the phone rule's
							// align-items:flex-start (media queries add no specificity),
							// which centers the Slack-home cards instead of left-aligning
							// their icon + label.
							!isPhone && "items-center",
							!isPhone &&
								// Compact rows use control-label type and tight padding, with glyphs
								// matching the sidebar's standard 22px leading rail.
								// the utility strip reads lighter than the work lists.
								// Landed in ffd11ffc (2026-07-24). That commit's comment
								// credited a "wayyy too big" complaint, but no such
								// request exists in the session record — don't treat the
								// current numbers as a stated preference.
								"w-full gap-[9px] rounded-lg bg-transparent px-[calc(var(--sidebar-icon-left)-var(--sidebar-nav-x))] py-[3px] text-control-label font-medium text-dim hover:bg-hover hover:text-fg",
							!isPhone && tool.active && "bg-active text-fg",
						);
						const rowBody = (
							<>
								<span
									className={cn(
										"sidebar-nav-icon inline-flex",
										!isPhone && "text-faint [&_svg]:size-[22px]",
										!isPhone && tool.active && "text-dim",
										!isPhone && !tool.active && "group-hover:text-dim",
									)}
								>
									{tool.icon}
								</span>
								{tool.label}
								{!!tool.count && (
									<span className="sidebar-nav-count">{tool.count}</span>
								)}
							</>
						);
						// Right-click drops a tool from the strip — the same gesture the
						// feed headers use to hide themselves, and undone from the band's
						// ••• menu or Settings. Desktop only: phones have no right-click,
						// and the ••• menu that puts a tool back is itself desktop-only,
						// so a stray long-press there would only be recoverable from
						// Settings.
						const row = isPhone ? (
							<button
								key={tool.id}
								className={rowClass}
								onClick={tool.onClick}
								title={tool.title}
							>
								{rowBody}
							</button>
						) : (
							<ContextMenu.Root key={tool.id}>
								<ContextMenu.Trigger
									render={
										<button
											className={rowClass}
											onClick={tool.onClick}
											title={tool.title}
										/>
									}
								>
									{rowBody}
								</ContextMenu.Trigger>
								<ContextMenu.Popup>
									<ContextMenu.Item
										onClick={() => setToolVisible(tool.id, false)}
									>
										Remove from toolbar
									</ContextMenu.Item>
								</ContextMenu.Popup>
							</ContextMenu.Root>
						);
						// Home carries the team at its right edge — who's around, who's
						// working, and one click away, what each of them is on. It has to
						// be a sibling of the row, not a child: a button can't nest one.
						// Phones render the tools as a card strip, where there's no room.
						if (tool.id !== "home" || isPhone || team.length === 0) return row;
						return (
							<div key={tool.id} className="relative">
								{row}
								<TeamPresencePopover
									members={team}
									onOpenSession={onSelect}
									// The faces ring themselves in whatever the row is
									// painted with, so the pile separates on both states.
									ring={tool.active ? "var(--bg-active)" : "var(--bg-raised)"}
									className="absolute right-2.5 top-1/2 -translate-y-1/2"
								/>
							</div>
						);
					})}
				</nav>
			)}
			</div>

			<div
				className="sidebar-sticky-section"
				style={{ order: sectionOrder("workspaces") }}
			>
			<div
				className="sidebar-workspace sidebar-sticky-head mt-1 px-[16px] pb-0.5 pr-[7px] pt-3"
			>
				<div className="sidebar-workspace-head flex min-w-0 items-center gap-1.5" ref={headRef}>
					<button
						className="sidebar-workspace-toggle flex min-w-0 items-center gap-[5px]"
						onClick={() => toggleBand("workspaces")}
						aria-expanded={workspacesOpen}
						title={workspacesOpen ? "Collapse workspaces" : "Expand workspaces"}
					>
						<span className="sidebar-workspace-title shrink-0 text-label font-semibold tracking-[-0.01em] text-faint" ref={titleRef}>
							{filter.person === "me"
								? "Workspaces"
								: filter.person === "unassigned"
									? "Unassigned workspaces"
									: filter.person === "everyone"
										? "All workspaces"
										: `${people.find((p) => p.key === filter.person)?.label || filter.person}'s workspaces`}
						</span>
						<IconChevronDown
							className="sidebar-band-chevron"
							size={18}
							style={{
								transform: workspacesOpen ? "none" : "rotate(-90deg)",
							}}
						/>
					</button>
					{/* Repo filter chip, inline behind the title when it fits. */}
					{filter.repo !== "all" && repoInline && (
						<RepoFilterChip
							repo={filter.repo}
							repos={repos}
							onClear={() => setFilter({ repo: "all" })}
							onSelect={(v) => setFilter({ repo: v })}
							variant="inline"
						/>
					)}
					<div className="min-w-0 flex-1" />
					<div className="sidebar-workspace-actions" ref={actionsRef}>
						<Tooltip label="Group, filter & sort">
						<button
							ref={filterBtnRef}
							className={`sidebar-new-btn sidebar-filter-btn${
								filterOpen ? " active" : ""
							}${
								filter.groupBy !== DEFAULT_GROUP_BY ||
								filter.repo !== "all" ||
								filter.person !== "me" ||
								filter.prs !== "default"
									? " has-filter"
									: ""
							}`}
							onClick={() => setFilterOpen((o) => !o)}
						>
							<IconFilter size={24} />
						</button>
						</Tooltip>
						<Tooltip
							label="New session"
							shortcut={
								/Mac|iPhone|iPad|iPod/.test(navigator.platform)
									? ["⌘", "N"]
									: ["Ctrl", "N"]
							}
						>
						<button
							className="sidebar-new-btn inline-flex items-center justify-center"
							onClick={onNewSession}
						>
							<IconPlus size={24} />
						</button>
						</Tooltip>
					</div>
					{/* Off-layout probe: measures the chip's natural width so the effect
					    above can decide whether it fits inline (never rendered visibly). */}
					{filter.repo !== "all" && (
						<RepoFilterChip repo={filter.repo} variant="probe" ref={probeRef} />
					)}
				</div>
			</div>

				{/* Fallback row: only when the chip doesn't fit inline. */}
				{filter.repo !== "all" && !repoInline && (
					<div className="sidebar-repo-row sidebar-workspace-fallback mx-4 mb-2 mt-[-2px] flex min-w-0 md:mr-2 md:ml-4">
						<RepoFilterChip
							repo={filter.repo}
							repos={repos}
							onClear={() => setFilter({ repo: "all" })}
							onSelect={(v) => setFilter({ repo: v })}
							variant="row"
						/>
					</div>
				)}

			{/* On phones the filter button lives in the top bar (next to Search);
			    its popover anchors there. Desktop keeps it in the header. */}
			{isPhone &&
				headerActionsEl &&
				createPortal(
					<>
						<button
							ref={mobileFilterBtnRef}
							className={`mobile-filter-btn${filterOpen ? " active" : ""}${
								filter.groupBy !== DEFAULT_GROUP_BY ||
								filter.repo !== "all" ||
								filter.person !== "me" ||
								filter.prs !== "default"
									? " has-filter"
									: ""
							}`}
							onClick={() => setFilterOpen((o) => !o)}
							aria-label="Group, filter & sort"
						>
							<IconFilter size={22} />
						</button>
					</>,
					headerActionsEl,
				)}

			{filterOpen && (
				<FilterPopover
					anchor={
						isPhone
							? mobileFilterBtnRef.current
							: filterBtnRef.current
					}
					filter={filter}
					repos={repos}
					people={people}
					currentUser={currentUser}
					onChange={setFilter}
					onClose={() => setFilterOpen(false)}
				/>
			)}

			{projectMenu &&
				(() => {
					// The menu id is a real workspace id, or a row key for a
					// workspace-less row (solo chat / shared-worktree group).
					const ws = projects.find((p) => p.id === projectMenu.id);
					const menuRow = wsRows.find((r) =>
						ws ? r.workspace?.id === ws.id : r.key === projectMenu.id,
					);
					const chats = menuRow?.chats ?? [];
					const first = chats[0];
					const pinKey = ws ? `workspace:${ws.id}` : projectMenu.id;
					// A row can be pinned via its own key or a legacy pin on any member
					// chat (incl. alias ids) — unpin clears all of them.
					const pinnedKeys = [
						pinKey,
						...(menuRow
							? [
									menuRow.key,
									...menuRow.chats.flatMap((c) => [
										c.id,
										...(c.aliasIds || []),
									]),
								]
							: []),
					].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
					const pinned = pinnedKeys.length > 0;
					const togglePinNow = () => {
						if (pinned) {
							let next = pins;
							for (const k of pinnedKeys) next = togglePin(k);
							setPins(next);
						} else {
							setPins(togglePin(pinKey));
						}
					};
					const anyManual = chats.some((c) => pinnedLane(c));
					const sharedManual =
						anyManual &&
						chats.every((c) => pinnedLane(c) === pinnedLane(chats[0]))
							? (pinnedLane(chats[0]) ?? null)
							: null;

					const entries: CtxEntry[] = [];
					// Offer the move you can actually make: a row with unread
					// activity reads, an already-read one goes back to unread.
					const rowUnread = menuRow?.unread ?? false;
					if (chats.length > 0)
						entries.push({
							kind: "item",
							icon: <IconMail size={20} />,
							label: rowUnread ? "Mark as read" : "Mark as unread",
							onClick: () =>
								chats.forEach((c) =>
									rowUnread
										? markRead(c.id, c.lastActivity)
										: markUnread(c.id),
								),
						});
					// Claim someone else's work — an automation run, a teammate's
					// workspace — into your own lanes, where it then behaves like
					// your sessions do (In progress while running, Backlog when
					// idle). Rows you started are already there, so they don't
					// offer it; the full lane picker stays in the flyout below.
					const rowClaimed = chats.some((c) => isClaimed(c));
					const rowMine = chats.some((c) => ownedBy(c, currentUser));
					if (chats.length > 0 && (!rowMine || rowClaimed))
						entries.push({
							kind: "item",
							icon: <IconInbox size={20} />,
							label: rowClaimed
								? "Remove from my workspaces"
								: "Add to my workspaces",
							onClick: () =>
								onSetStatus(chats, rowClaimed ? null : "mine"),
						});
					entries.push({
						kind: "item",
						icon: (
							<IconPin size={20} fill={pinned ? "currentColor" : "none"} />
						),
						label: pinned ? "Unpin" : "Pin",
						onClick: togglePinNow,
					});
					if (chats.length > 0)
						entries.push({
							kind: "status",
							current: sharedManual,
							// Applies the pin to every chat so the aggregated row lands
							// in the chosen lane; "Auto" clears it back to the derived one.
							onPick: (s) => onSetStatus(chats, s),
						});
					if (menuRow && chats.length > 0)
						entries.push({
							kind: "snooze",
							until: activeSnoozeKeys.has(menuRow.key)
								? (snoozes[menuRow.key] ?? null)
								: null,
							// Parks the row in the Snoozed section until the chosen time;
							// null unsnoozes it back to its derived lane.
							onPick: (until) =>
								until
									? setSnooze(menuRow.key, until)
									: clearSnooze(menuRow.key),
						});
					if (ws)
						entries.push({
							kind: "item",
							icon: <IconPencil size={20} />,
							label: "Rename",
							onClick: () => {
								setProjectDraft(ws.name);
								setEditingProjectId(ws.id);
							},
						});
					else if (first)
						entries.push({
							kind: "item",
							icon: <IconPencil size={20} />,
							label: "Rename",
							onClick: () => startChatRename(first),
						});
					if (first)
						entries.push({
							kind: "item",
							icon: <IconLink size={20} />,
							label: "Copy link",
							shortcut: "⌘⇧C",
							onClick: () =>
								copyToClipboard(absoluteLink(chatPath(first)), () =>
									onToast?.("Link copied"),
								),
						});
					// A chat that owns a worktree/branch (and thus a PR/diff) can open
					// its Review tab here — it's off by default in the viewer.
					if (first && (first.worktreeDir || first.branch))
						entries.push({
							kind: "item",
							icon: <IconEye size={20} />,
							label: "Open review",
							onClick: () => onOpenReview(first),
						});
					// Archive is the removal action here (a chat/workspace is finished
					// by archiving, never inferred-deleted). A chatless workspace has
					// nothing to archive, so it keeps Delete as its only removal.
					if (menuRow && chats.length > 0) {
						entries.push({ kind: "sep" });
						// Hide sits above Archive as the gentler removal: Archive is
						// global (it ends the work for the whole team), Hide only
						// clears it off your own sidebar while a teammate keeps
						// working in it. On an already-hidden row — which you can
						// only be looking at because you searched for it — the same
						// slot offers the way back, since there's no Hidden band.
						const rowHidden = hiddenRowKeys.has(menuRow.key);
						entries.push({
							kind: "item",
							icon: rowHidden ? <IconEye size={20} /> : <IconEyeOff size={20} />,
							label: rowHidden
								? "Restore to my sidebar"
								: "Hide from my sidebar",
							onClick: () =>
								rowHidden ? clearHides([menuRow.key]) : hideRow(menuRow),
						});
						entries.push({
							kind: "item",
							icon: <IconArchive size={20} />,
							label: "Archive",
							onClick: () => archiveWorkspaceWithNext(menuRow),
						});
					} else if (ws) {
						entries.push({ kind: "sep" });
						entries.push({
							kind: "item",
							icon: <IconTrash size={20} />,
							danger: true,
							label: "Delete workspace",
							onClick: () => {
								if (
									window.confirm(
										`Delete workspace "${ws.name}"? Its chats become standalone.`,
									)
								)
									onDeleteProject(ws.id);
							},
						});
					}

					return (
						<SidebarCtxMenu
							x={projectMenu.x}
							y={projectMenu.y}
							entries={entries}
							onClose={() => setProjectMenu(null)}
						/>
					);
				})()}
			{workspacesOpen && (
				<div className="sidebar-list">
				{workspaceListEmpty && (
					<div className="mx-4 my-7 text-center text-[13px] leading-[1.4] text-faint">
						{hasWorkspaceFilter
							? "No matching workspaces"
							: "No workspaces yet"}
					</div>
				)}

				{/* ── Needs review: everything waiting on YOUR review — sessions a
				    teammate asked you to look at (the info panel's Reviewer picker)
				    and GitHub PRs that requested you. Both are the same ask, so they
				    share one band; it rides above everything, like a blocked
				    question. PRs already covered by a workspace row in view are
				    filtered out of prRowItems, so nothing appears twice. ── */}
				{(needsReviewRows.length > 0 || requestedPrItems.length > 0) &&
					(() => {
						const open = isOpen("needsreview");
						return (
							<div className="sidebar-group sidebar-group--review">
								<button
									className="sidebar-group-header"
									onClick={() => toggleGroup("needsreview")}
								>
									<IconBell
										className="sidebar-group-icon"
										style={{ color: "var(--accent)" }}
									/>
									<span className="sidebar-group-name">Needs review</span>
									<span className="sidebar-group-count">
										{needsReviewRows.length + requestedPrItems.length}
									</span>
									<IconChevronDown
										className="sidebar-group-chevron"
										size={22}
										style={{ transform: open ? "none" : "rotate(-90deg)" }}
									/>
								</button>
								{needsReviewRows
									.filter(
										(r) => open || r.chats.some((c) => c.id === selectedId),
									)
									.map(renderWsRow)}
								{requestedPrItems
									.filter((item) => open || prRowSelected(item))
									.map(renderPrRow)}
							</div>
						);
					})()}

				{/* ── Awaiting review: sessions YOU asked a teammate to review (the
				    mirror of Needs review). Grouped here so a session you've sent out
				    for review moves out of the status lanes into one place. ── */}
				{awaitingReviewRows.length > 0 &&
					(() => {
						const open = isOpen("awaitingreview");
						return (
							<div className="sidebar-group sidebar-group--review">
								<button
									className="sidebar-group-header"
									onClick={() => toggleGroup("awaitingreview")}
								>
									<IconEye
										className="sidebar-group-icon"
										style={{ color: "var(--yellow)" }}
									/>
									<span className="sidebar-group-name">Awaiting review</span>
									<span className="sidebar-group-count">
										{awaitingReviewRows.length}
									</span>
									<IconChevronDown
										className="sidebar-group-chevron"
										size={22}
										style={{ transform: open ? "none" : "rotate(-90deg)" }}
									/>
								</button>
								{awaitingReviewRows
									.filter(
										(r) => open || r.chats.some((c) => c.id === selectedId),
									)
									.map(renderWsRow)}
							</div>
						);
					})()}

				{/* ── Pinned (workspaces + notes, mixed) ── */}
				{(() => {
					const pinnedRows = pinnedWsRows;
					// Pinned chats that don't map to a workspace row (automation runs).
					const rowChatIds = new Set(
						wsRows.flatMap((r) => r.chats.map((c) => c.id)),
					);
					const pinnedLoose = pins
						.filter((e) => !e.startsWith("note:") && !e.startsWith("workspace:"))
						.filter((id) => !rowChatIds.has(id))
						.map((id) =>
							sessions.find(
								(s) => s.id === id || s.aliasIds?.includes(id),
							),
						)
						// An archived chat must never surface in Pinned — its pin is
						// stale (archiving drops it server-side, but a resurrected or
						// legacy pin can still point at it). Skip it so it can't render
						// as an un-archivable ghost row.
						.filter((s): s is UnifiedSession => !!s && !s.archived)
						// Honor the repo filter — a pinned chat from another repo
						// shouldn't leak into a repo-scoped view (workspace pins
						// already drop out via wsRows/filtered).
						.filter(
							(s) => filter.repo === "all" || sessionRepo(s) === filter.repo,
						);
					const pinnedNotes = pins
						.filter((e) => e.startsWith("note:"))
						.map((e) => notes.find((n) => n.id === e.slice(5)))
						.filter((n): n is { id: string; title: string } => !!n);
					// Pinned Plain tickets and PRs — resolved against the live
					// queues, so a done ticket / closed PR just stops rendering
					// (its stale pin key is harmless, like an archived chat's).
					const pinnedTickets = pins
						.filter((e) => e.startsWith("support:"))
						.map((e) =>
							(supportThreads || []).find((t) => t.id === e.slice(8)),
						)
						.filter((t): t is SupportThread => !!t);
					// Pinned feed items (Tella videos, PostHog dashboards) —
					// resolved against the live feed items like tickets are.
					const pinnedFeedItems = pins
						.filter((e) => e.startsWith("feed:"))
						.map((e) => {
							const [, refKind, ...idParts] = e.split(":");
							const id = idParts.join(":");
							const feed = feeds.find((f) => f.refKind === refKind);
							const item = feed
								? (feedItems[feed.id] || []).find((i) => i.id === id)
								: undefined;
							return feed && item ? { feed, item } : null;
						})
						.filter(
							(x): x is { feed: FeedDescriptor; item: FeedItem } => !!x,
						);
					const pinnedPrs = pins
						.filter((e) => e.startsWith("pr:"))
						.map((e) =>
							reviewQueueItems.find((i) => i.pr.url === e.slice(3)),
						)
						.filter((i): i is ReviewQueueItem => !!i);
					if (
						!pinnedRows.length &&
						!pinnedLoose.length &&
						!pinnedNotes.length &&
						!pinnedTickets.length &&
						!pinnedFeedItems.length &&
						!pinnedPrs.length
					)
						return null;
					const pinnedOpen = isOpen("pinned");

					// One flat drag-to-reorder list: every pinned thing (workspace row,
					// loose chat, note) becomes an entry slotted by its first key's
					// position in the pins array, so reordering is just rewriting that
					// array (reorderPins). `pinKeys` is everything in `pins` that maps
					// to the entry — a workspace can be pinned via its own key AND
					// legacy member-chat pins — so a drop moves them as one unit.
					type PinEntry = {
						key: string;
						pinKeys: string[];
						/** Lane-drop payload: the sessions a lane drop re-lanes (empty
						    = not droppable, e.g. notes) + the entry's repo for the
						    same-repo rule under per-repo lanes. */
						repo: string | null;
						chats: UnifiedSession[];
						node: React.ReactNode;
					};
					const pinIdx = new Map(pins.map((p, i) => [p, i] as const));
					const entries: PinEntry[] = [];
					for (const row of pinnedRows) {
						entries.push({
							key: `ws:${row.key}`,
							pinKeys: [row.key, ...row.chats.map((c) => c.id)].filter((k) =>
								pinIdx.has(k),
							),
							repo: wsRowRepo(row),
							chats: row.chats,
							node: renderWsRow(row),
						});
					}
					const seenLoose = new Set<string>();
					for (const s of pinnedLoose) {
						// A chat pinned via both its id and an alias maps to the same
						// session twice — render (and reorder) it once.
						if (seenLoose.has(s.id)) continue;
						seenLoose.add(s.id);
						const pin = sessionPinState(s);
						entries.push({
							key: `chat:${s.id}`,
							pinKeys: [s.id, ...(s.aliasIds ?? [])].filter((k) =>
								pinIdx.has(k),
							),
							repo: sessionRepo(s),
							chats: [s],
							node: (
								<SidebarItem
									session={s}
									localMode={localMode}
									selected={s.id === selectedId}
									unread={
										s.id !== selectedId &&
										isUnread(s.id, s.lastActivity, reads)
									}
									mine={
										!!s.startedBy &&
										!s.automation &&
										s.startedBy.toLowerCase() === currentUser.toLowerCase()
									}
									onClick={() => onSelect(s)}
									onArchive={() => archiveWithNext(s)}
									pinned={pin.pinned}
									onTogglePin={pin.toggle}
									onRename={(title) => onRename(s, title)}
									onSetStatus={(st) => onSetStatus([s], st)}
								/>
							),
						});
					}
					for (const n of pinnedNotes) {
						entries.push({
							key: `note:${n.id}`,
							pinKeys: [`note:${n.id}`],
							repo: null,
							chats: [],
							node: (
								<button
									className={`sidebar-item ${n.id === activeNoteId ? "sidebar-item-selected" : ""}`}
									onClick={() => onOpenNote(n.id)}
									title={n.title}
								>
									<span className="sidebar-item-top">
										<span className="sidebar-rail" style={{ opacity: 0.9 }}>
											📝
										</span>
										<span className="sidebar-item-title">{n.title}</span>
									</span>
								</button>
							),
						});
					}
					for (const t of pinnedTickets) {
						entries.push({
							key: `support:${t.id}`,
							pinKeys: [`support:${t.id}`],
							repo: null,
							chats: [],
							node: renderSupportRow(t),
						});
					}
					for (const { feed, item } of pinnedFeedItems) {
						const pinKey = `feed:${feed.refKind}:${item.id}`;
						const linked =
							feedSessionByRef.get(`${feed.refKind}:${item.id}`) || null;
						entries.push({
							key: pinKey,
							pinKeys: [pinKey],
							repo: null,
							chats: [],
							node: (
								<FeedRow
									key={pinKey}
									feed={feed}
									item={item}
									session={linked}
									active={feedItemActive(feed, item)}
									pinned
									onTogglePin={() => setPins(togglePin(pinKey))}
									onOpen={() => onOpenFeedItem(feed, item)}
									onSetStatus={
										linked
											? (status) => onSetStatus([linked], status)
											: undefined
									}
								/>
							),
						});
					}
					for (const item of pinnedPrs) {
						entries.push({
							key: `pr:${item.pr.url}`,
							pinKeys: [`pr:${item.pr.url}`],
							repo: null,
							chats: [],
							node: renderPrRow(item),
						});
					}
					const firstIdx = (e: PinEntry) =>
						e.pinKeys.length
							? Math.min(...e.pinKeys.map((k) => pinIdx.get(k)!))
							: Infinity;
					entries.sort((a, b) => firstIdx(a) - firstIdx(b));
					// Mid-drag, Motion's in-flight order wins until the drop commits it.
					if (pinOrderDraft) {
						const draftIdx = new Map(
							pinOrderDraft.map((k, i) => [k, i] as const),
						);
						entries.sort(
							(a, b) =>
								(draftIdx.get(a.key) ?? Infinity) -
								(draftIdx.get(b.key) ?? Infinity),
						);
					}
					const entryMap = new Map(entries.map((e) => [e.key, e] as const));
					// Whole-row y-drag would fight touch scrolling and the swipe
					// gestures, so drag reorder is desktop-only; the order itself is
					// per-user server state, so a desktop reorder shows up on the phone.
					// (>0, not >1: even a lone pinned row can be dragged into a lane.)
					const canDragPins = !isPhone && entries.length > 0;
					const commitPinReorder = () => {
						setPinDragKey(null);
						pinJustDragged.current = true;
						// The drop's click fires synchronously after pointerup; clear the
						// swallow flag right after so the next real click works.
						setTimeout(() => {
							pinJustDragged.current = false;
						}, 0);
						// A drop onto a status lane wins over the reorder: lane-pin the
						// row's chats there and unpin it — dragging OUT of Pinned reads
						// as a move, unlike right-click Set-status which keeps the pin
						// (the row shows in both the Pinned band and its lane).
						const laneDrop = laneDropHoverRef.current;
						const dragMeta = pinDragMetaRef.current;
						pinDragMetaRef.current = null;
						setPinDragMeta(null);
						laneDropHoverRef.current = null;
						setLaneDropHover(null);
						if (laneDrop && dragMeta && dragMeta.chats.length > 0) {
							pinOrderPending.current = null;
							setPinOrderDraft(null);
							setPins(unpin(dragMeta.pinKeys));
							onSetStatus(dragMeta.chats, laneDrop.lane);
							return;
						}
						const orderKeys = pinOrderPending.current;
						pinOrderPending.current = null;
						setPinOrderDraft(null);
						if (!orderKeys) return;
						// New pins array: the visible entries' keys take the slots that
						// visible keys already occupy (in the new order), so pins hidden
						// from the band (archived, repo-filtered, review-band rows) keep
						// their exact positions instead of getting shoved to the end.
						const flat = orderKeys.flatMap(
							(k) => entryMap.get(k)?.pinKeys ?? [],
						);
						const visible = new Set(flat);
						const queue = [...flat];
						setPins(
							reorderPins(
								pins.map((p) => (visible.has(p) ? (queue.shift() ?? p) : p)),
							),
						);
					};
					const pinnedCount = entries.length;
					return (
						<div className="sidebar-group sidebar-group--pinned">
							{/* Same header treatment as the status lanes below. */}
							<button
								className="sidebar-group-header"
								onClick={() => toggleGroup("pinned")}
							>
								<IconPin
									className="sidebar-group-icon"
									style={{ color: "var(--text-faint)" }}
								/>
								<span className="sidebar-group-name">Pinned</span>
								<span className="sidebar-group-count">{pinnedCount}</span>
								<IconChevronDown
									className="sidebar-group-chevron"
									size={22}
									style={{ transform: pinnedOpen ? "none" : "rotate(-90deg)" }}
								/>
							</button>
							{pinnedOpen && (
								<Reorder.Group
									as="div"
									axis="y"
									className={`sidebar-pin-list${pinDragKey ? " is-drag-active" : ""}`}
									values={entries.map((e) => e.key)}
									onReorder={(keys: string[]) => {
										pinOrderPending.current = keys;
										setPinOrderDraft(keys);
									}}
								>
									{entries.map((e) => (
										<Reorder.Item
											as="div"
											key={e.key}
											value={e.key}
											dragListener={canDragPins}
											transition={{ duration: 0 }}
											onDragStart={() => {
												setPinDragKey(e.key);
												const meta = {
													repo: e.repo,
													chats: e.chats,
													pinKeys: e.pinKeys,
												};
												pinDragMetaRef.current = meta;
												setPinDragMeta(meta);
											}}
											onDrag={(
												ev: MouseEvent | TouchEvent | PointerEvent,
											) => {
												if ("clientX" in ev)
													updateLaneDropHover(ev.clientX, ev.clientY);
											}}
											onDragEnd={commitPinReorder}
											whileDrag={{ scale: 1.01 }}
											className={`sidebar-pin-entry${pinDragKey === e.key ? " is-reordering" : ""}`}
											onClickCapture={(ev: React.MouseEvent) => {
												// Swallow the click that lands on the row when a drag
												// is dropped — it would open the session under the
												// cursor.
												if (pinJustDragged.current) {
													ev.preventDefault();
													ev.stopPropagation();
												}
											}}
										>
											{e.node}
										</Reorder.Item>
									))}
								</Reorder.Group>
							)}
						</div>
					);
				})()}

				{/* ── Workspaces: status lanes live directly under the Workspaces
				    header above (which carries the filter, new-workspace and
				    new-session actions) — no second in-list heading. ── */}
				<div className="sidebar-group">
					{/* Status groups over the focus person's workspaces. The Person
					    filter defaults to you; picking a teammate shows all their groups,
					    "Unassigned" shows every Backlog, and "Everyone" shows all workspaces.
					    "Group by: Repo" shows one band per repo holding a flat
					    Conductor-style row list; "Repo and status" nests the labeled
					    status lanes under each repo band instead. Empty lanes/bands
					    are hidden — only groups with sessions render. */}
					{/* Snoozed rows sit out of focusWsRows, so each mode places them
					    itself: "Project and status" / "Project and inbox" give every
					    repo band its own Snoozed group (renderRepoGroups), while flat
					    "Project" — which has no lanes — renders one global Snoozed
					    group after the bands, and the plain status mode slots it above
					    Backlog via renderStatusLanes. */}
					{/* Plain (support tickets) renders as one more project: a band
					    beside the repos with priority lanes nested under it — or,
					    in the flat status view, its priority lanes appended after
					    the status lanes so everything reads as one list. */}
					{/* Inbox: one flat activity-ranked list (no repo/status
					    grouping), then the Snoozed group and the feed bands as
					    usual. Session-less PR rows sit this mode out — it ranks
					    sessions by activity, which a bare PR doesn't have. Plain
					    and the other feeds keep the banded (repo-mode) shape:
					    their items aren't the activity-ranked sessions this mode
					    orders, so they stay grouped apart, lanes nested. */}
					{filter.groupBy === "inbox"
						? [
								...renderInboxBands(focusWsRows),
								...renderStatusLanes([], "", snoozedWsRows),
								...visibleFeeds.map((d) => renderFeedBand(d, true)),
							]
						: filter.groupBy === "repo" ||
							filter.groupBy === "repo-status" ||
							filter.groupBy === "repo-inbox"
						? (
								<>
									{renderRepoGroups(
										filter.groupBy === "repo-status"
											? "status"
											: filter.groupBy === "repo-inbox"
												? "inbox"
												: "flat",
									)}
									{filter.groupBy === "repo" &&
										renderStatusLanes([], "", snoozedWsRows)}
									{visibleFeeds.map((d) =>
										renderFeedBand(d, filter.groupBy !== "repo"),
									)}
								</>
							)
						: [
								...renderStatusLanes(
									focusWsRows,
									"",
									snoozedWsRows,
									undefined,
									lanePrItems,
								),
								// Flat status view: Plain's priority lanes stay inlined
								// after the status lanes (one continuous list); other
								// feeds render as bands below.
								...renderSupportLanes(plainThreadsInView),
								...visibleFeeds
									.filter((d) => d.id !== "plain")
									.map((d) => renderFeedBand(d, false)),
							]}
				</div>

				{archivedBand && (
					<div className="sidebar-group">{archivedBand}</div>
				)}
				</div>
			)}
			</div>

				{/* ── Automations (one collapsible band, one group per automation) ── */}
				{groups.length > 0 && (
					<div
						className="sidebar-independent-section sidebar-group--automations mt-2"
						style={{ order: sectionOrder("automations") }}
					>
						<div className="sidebar-band-label sidebar-sticky-head">
							<button
								className="sidebar-band-toggle"
								onClick={() => toggleBand("automations")}
								title={
									automationsOpen
										? "Collapse automations"
										: "Expand automations"
								}
							>
								<span className="sidebar-band-name">Automations</span>
								<span className="sidebar-group-count">{groups.reduce((n, g) => n + g.items.length, 0)}</span>
								<IconChevronDown
									className="sidebar-band-chevron"
									size={18}
									style={{ transform: automationsOpen ? "none" : "rotate(-90deg)" }}
								/>
							</button>
						</div>
						{visibleAutomationGroups.length > 0 && (
							<div className="sidebar-independent-scroll">
								{visibleAutomationGroups.map((group) => {
									const open = isOpen(group.key);
									return (
									<React.Fragment key={group.key}>
										<button
											className="sidebar-group-header"
											onClick={() => toggleGroup(group.key)}
										>
											{/* The dot is 7px but the header's leading column is a
											    rail, so its name lands where every other one does. */}
											<span className="sidebar-rail">
												{group.dotColor && (
													<span
														className="sidebar-group-dot"
														style={{ backgroundColor: group.dotColor }}
													/>
												)}
											</span>
											<span className="sidebar-group-name">{group.label}</span>
											<IconChevronDown
												className="sidebar-group-chevron"
												size={22}
												style={{
													transform: open ? "none" : "rotate(-90deg)",
												}}
											/>
											<span className="sidebar-group-count">
												{group.items.length}
											</span>
											{/* Hover swaps the count for a cog that jumps to this
											    automation in Settings (span, not button — we're
											    inside the header button). */}
											<span
												role="button"
												className="sidebar-auto-cog"
												title="Automation settings"
												onClick={(e) => {
													e.stopPropagation();
													onOpenAutomation(group.label);
												}}
											>
												<IconGear size={17} />
											</span>
										</button>
										{/* When collapsed, still surface the actively selected
										    session so it never disappears behind a closed header. */}
										{group.items
											.filter((s) => open || s.id === selectedId)
											.map((s) => {
												const pin = sessionPinState(s);
												return (
													<SidebarItem
														key={s.id}
														session={s}
														localMode={localMode}
														selected={s.id === selectedId}
														unread={
															s.id !== selectedId &&
															isUnread(s.id, s.lastActivity, reads)
														}
														mine={
															!!s.startedBy &&
															!s.automation &&
															s.startedBy.toLowerCase() ===
																currentUser.toLowerCase()
														}
														onClick={() => onSelect(s)}
														onArchive={() => archiveWithNext(s)}
														pinned={pin.pinned}
														onTogglePin={pin.toggle}
														onRename={(title) => onRename(s, title)}
														onSetStatus={(st) => onSetStatus([s], st)}
													/>
												);
											})}
									</React.Fragment>
									);
								})}
							</div>
						)}
					</div>
				)}
			{/* ── People: the whole team, always on — live viewers first. Click a
			    person to view their workspace lanes (backlog / in progress). ── */}
			{(() => {
				const others = roster.filter(
					(p) => p.name.toLowerCase() !== currentUser.toLowerCase(),
				);
				if (others.length === 0) return null;
				const open = bandOpen("people");
				const viewingBy = new Map(
					teamViewing.map((v) => [v.user.toLowerCase(), v.sessionId]),
				);
				const titleFor = (id: string) =>
					sessions.find((s) => s.id === id)?.title || id;
				const rows = [...others].sort((a, b) => {
					const aLive = viewingBy.has(a.name.toLowerCase()) ? 0 : 1;
					const bLive = viewingBy.has(b.name.toLowerCase()) ? 0 : 1;
					if (aLive !== bLive) return aLive - bLive;
					const aAct = personActivity.get(a.name.toLowerCase())?.last || "";
					const bAct = personActivity.get(b.name.toLowerCase())?.last || "";
					return bAct.localeCompare(aAct);
				});
				return (
					<div
						className="sidebar-independent-section mt-2"
						style={{ order: sectionOrder("people") }}
					>
						<div className="sidebar-band-label sidebar-sticky-head">
							<button
								className="sidebar-band-toggle pl-[10px]"
								onClick={() => toggleBand("people")}
								title={open ? "Collapse people" : "Expand people"}
							>
								<span className="sidebar-band-name">People</span>
								<span className="sidebar-group-count">{rows.length}</span>
								<IconChevronDown
									className="sidebar-band-chevron"
									size={18}
									style={{ transform: open ? "none" : "rotate(-90deg)" }}
								/>
							</button>
						</div>
						{open && (
							<div className="sidebar-independent-scroll">
								{rows.map((p) => {
									const key = p.name.toLowerCase();
									const liveId = viewingBy.get(key);
									const act = personActivity.get(key);
									const selected = filter.person === key;
									const localTime = p.timezone
										? new Intl.DateTimeFormat([], {
												hour: "2-digit",
												minute: "2-digit",
												timeZone: p.timezone,
											}).format(new Date())
										: null;
									return (
										<button
											key={p.name}
											className={`sidebar-people-row flex items-center gap-[9px] w-full min-w-0 text-left border-0 cursor-pointer rounded-lg pl-[12px] pr-2 py-[5px] max-[720px]:py-2 ${
												selected
													? "bg-active"
													: "bg-transparent hover:bg-hover"
											}`}
											onClick={() => {
												// First click: filter to their lanes AND open the
												// session the row shows — going back lands on their
												// workspaces. Second click (or the row's ✕): undo
												// the filter, back to your own.
												if (selected) {
													setFilter({ person: "me" });
													return;
												}
												setFilter({ person: key });
												const targetId = liveId || act?.id;
												const target = targetId
													? sessions.find((s) => s.id === targetId)
													: undefined;
												if (target) onSelect(target);
											}}
											title={
												selected
													? "Back to your workspaces"
													: liveId || act?.title
														? `Open “${liveId ? titleFor(liveId) : act?.title}” · ${p.name}'s workspaces`
														: `${p.name}'s workspaces`
											}
										>
											{/* The name lives on the avatar (tooltip) — the row's
											    width belongs to the workspace/session title. */}
											<Tooltip
												label={`${p.fullName}${localTime ? ` · ${localTime}` : ""}${liveId ? " · viewing now" : ""}`}
											>
												<span className="relative shrink-0">
													<UserAvatar name={p.name} size={22} />
												</span>
											</Tooltip>
											<span
												className={`sidebar-item-title flex-1${
													selected ? " !text-fg font-semibold" : ""
												}`}
											>
												{liveId ? titleFor(liveId) : act?.title || p.name}
											</span>
											{selected && (
												// The undo affordance — the whole row is the target
												// (second click clears the filter), this just says so.
												<span
													className="ml-auto flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-dim"
													aria-hidden="true"
												>
													<IconX size={14} />
												</span>
											)}
										</button>
									);
								})}
							</div>
						)}
					</div>
				);
			})()}
			{/* One card for the whole workspace list: the rows come out of a plain
			    render function, not a component, so they can't each own a popover.
			    The hovered row is the anchor instead — same shell, same card. */}
			<Popover.Root
				open={!!wsHover}
				onOpenChange={(open) => {
					if (!open) closeWsHover();
				}}
			>
				{wsHover && (
					<RowCardPopup anchor={wsHover.el}>
						<div
							onMouseEnter={cancelWsHoverTimers}
							onMouseLeave={scheduleWsHoverClose}
						>
							<WsCardBody
								row={wsHover.row}
								onArchive={() => {
									closeWsHover();
									archiveWorkspaceWithNext(wsHover.row);
								}}
								onOpen={(chat) => {
									closeWsHover();
									onSelect(chat);
								}}
							/>
						</div>
					</RowCardPopup>
				)}
			</Popover.Root>
			{wsSheet &&
				(() => {
					const row = wsSheet;
					const ws = row.workspace;
					// Same pin resolution as the row's star and the right-click menu: a
					// row can be pinned via its own key or a legacy pin on any member
					// chat (incl. alias ids) — unpin must clear all of them.
					const pinKey = ws ? `workspace:${ws.id}` : row.key;
					const pinnedKeys = [
						pinKey,
						row.key,
						...row.chats.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
					].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
					const pinned = pinnedKeys.length > 0;
					return (
						<WsMobileSheet
							row={row}
							pinned={pinned}
							onTogglePin={() => {
								if (pinned) {
									let next = pins;
									for (const k of pinnedKeys) next = togglePin(k);
									setPins(next);
								} else {
									setPins(togglePin(pinKey));
								}
							}}
							onClose={() => setWsSheet(null)}
							onArchive={() => archiveWorkspaceWithNext(row)}
							onSetStatus={(status) => onSetStatus(row.chats, status)}
							snoozeUntil={
								activeSnoozeKeys.has(row.key)
									? (snoozes[row.key] ?? null)
									: null
							}
							onSnooze={(until) =>
								until ? setSnooze(row.key, until) : clearSnooze(row.key)
							}
							onOpen={(chat) => onSelect(chat)}
							onRename={() => {
								if (ws) {
									setProjectDraft(ws.name);
									setEditingProjectId(ws.id);
								} else if (row.chats[0]) {
									// Solo chat rows rename the chat itself.
									startChatRename(row.chats[0]);
								}
							}}
							claimed={
								row.chats.length === 0
									? null
									: row.chats.some((c) => isClaimed(c))
										? true
										: row.chats.some((c) => ownedBy(c, currentUser))
											? null
											: false
							}
							unread={row.unread}
							onToggleRead={
								row.chats.length > 0
									? () =>
											row.chats.forEach((c) =>
												row.unread
													? markRead(c.id, c.lastActivity)
													: markUnread(c.id),
											)
									: null
							}
							onCopyLink={
								row.chats[0]
									? () =>
											copyToClipboard(
												absoluteLink(chatPath(row.chats[0])),
												() => onToast?.("Link copied"),
											)
									: null
							}
							onDelete={
								ws
									? () => {
											if (
												window.confirm(
													`Delete workspace "${ws.name}"? Its chats become standalone.`,
												)
											)
												onDeleteProject(ws.id);
										}
									: null
							}
						/>
					);
				})()}
		</div>
	);
});

// ── Filter popover ─────────────────────────────────────────────────────────
// A small floating panel (anchored under the filter button) with three controls:
// Group by (Status / Repo), Repo (All repos + one per repo), and Sort by
// (Updated / Created). Rendered in a portal so it can overflow the narrow sidebar.

interface SelectOption {
	value: string;
	label: string;
	icon?: React.ReactNode;
}

function FilterPopover({
	anchor,
	filter,
	repos,
	people,
	currentUser,
	onChange,
	onClose,
}: {
	anchor: HTMLElement | null;
	filter: FilterState;
	repos: string[];
	people: Array<{ key: string; label: string }>;
	currentUser: string;
	onChange: (patch: Partial<FilterState>) => void;
	onClose: () => void;
}) {
	if (!anchor) return null;
	const r = anchor.getBoundingClientRect();
	const width = 290;
	const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
	const top = r.bottom + 6;

	const repoOptions: SelectOption[] = [
		{ value: "all", label: "All repos" },
		...repos.map((name) => ({
			value: name,
			label: repoLabel(name),
			icon: <RepoTile name={name} />,
		})),
	];

	// You first (the default), then teammates, the aggregate Backlog lens, and
	// "Everyone" last. Owner-focused views retain their own Backlog rows.
	const meKey = currentUser.toLowerCase();
	const personAvatar = (name: string) => <UserAvatar name={name} size={16} />;
	const personOptions: SelectOption[] = [
		{ value: "me", label: `${currentUser} (you)`, icon: personAvatar(currentUser) },
		...people
			.filter(({ key }) => key !== meKey)
			.map(({ key, label }) => ({
				value: key,
				label,
				icon: personAvatar(label),
			})),
		{ value: "unassigned", label: "Unassigned" },
		{ value: "everyone", label: "Everyone" },
	];

	return createPortal(
		<>
			<div className="menu-backdrop" onClick={onClose} />
			<div className="filter-popover" style={{ left, top, width }}>
				<div className="filter-row">
					<span className="filter-row-label">Group by</span>
					<MiniSelect
						value={filter.groupBy}
						options={[
							{ value: "status", label: "Status" },
							{ value: "repo", label: "Project" },
							{ value: "repo-status", label: "Project and status" },
							{ value: "repo-inbox", label: "Project and inbox" },
							{ value: "inbox", label: "Inbox" },
						]}
						onSelect={(v) => onChange({ groupBy: v as GroupBy })}
					/>
				</div>
				<div className="filter-row">
					<span className="filter-row-label">Repo</span>
					<MiniSelect
						value={filter.repo}
						options={repoOptions}
						onSelect={(v) => onChange({ repo: v })}
					/>
				</div>
				<div className="filter-row">
					<span className="filter-row-label">Person</span>
					<MiniSelect
						value={filter.person}
						options={personOptions}
						onSelect={(v) => onChange({ person: v })}
					/>
				</div>
				{/* Session-less PR rows in the project lanes (the dissolved PR
				    band): whose PRs surface. */}
				<div className="filter-row">
					<span className="filter-row-label">Pull requests</span>
					<MiniSelect
						value={filter.prs}
						options={[
							{ value: "default", label: "Mine + requested" },
							{ value: "all", label: "Everyone's" },
							{ value: "none", label: "Hidden" },
						]}
						onSelect={(v) => onChange({ prs: v as PrsFilter })}
					/>
				</div>
				<div className="filter-row">
					<span className="filter-row-label">Sort by</span>
					<MiniSelect
						value={filter.sort}
						options={[
							{ value: "updated", label: "Updated" },
							{ value: "created", label: "Created" },
						]}
						onSelect={(v) => onChange({ sort: v as SortBy })}
					/>
				</div>
			</div>
		</>,
		document.body,
	);
}

// A styled dropdown used by the filter popover. Its menu is portaled so it can
// escape both the popover and the sidebar; a transparent backdrop closes it.
function MiniSelect({
	value,
	options,
	onSelect,
}: {
	value: string;
	options: SelectOption[];
	onSelect: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);
	const current = options.find((o) => o.value === value);
	const r = open && btnRef.current ? btnRef.current.getBoundingClientRect() : null;

	let menu: React.ReactNode = null;
	if (open && r) {
		const menuW = Math.max(r.width, 150);
		const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
		menu = createPortal(
			<>
				<div
					className="menu-backdrop menu-backdrop--nested"
					onClick={() => setOpen(false)}
				/>
				<div
					className="mini-select-menu"
					style={{ left, top: r.bottom + 4, minWidth: menuW }}
				>
					{options.map((o) => (
						<button
							key={o.value}
							className={`mini-select-item${o.value === value ? " selected" : ""}`}
							onClick={() => {
								onSelect(o.value);
								setOpen(false);
							}}
						>
							{o.icon}
							<span className="mini-select-item-text">{o.label}</span>
							{o.value === value && (
								<svg
									className="mini-select-check"
									width="17"
									height="17"
									viewBox="0 0 16 16"
									fill="none"
								>
									<path
										d="M3.5 8.5l3 3 6-7"
										stroke="currentColor"
										strokeWidth="1.6"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
							)}
						</button>
					))}
				</div>
			</>,
			document.body,
		);
	}

	return (
		<div className="mini-select-wrap">
			<button
				ref={btnRef}
				className="mini-select"
				onClick={() => setOpen((o) => !o)}
			>
				<span className="mini-select-value">
					{current?.icon}
					<span className="mini-select-text">{current?.label ?? value}</span>
				</span>
				<svg
					className="mini-select-caret"
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
				>
					<path
						d="M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{menu}
		</div>
	);
}

// The removable "active repo filter" chip. Rendered in three variants:
// "inline" (in the header, behind the title), "row" (its own line under the
// header) and "probe" (an off-layout copy used only to measure natural width —
// non-interactive and hidden from a11y).
const RepoFilterChip = React.forwardRef<
	HTMLSpanElement,
	{
		repo: string;
		repos?: string[];
		onClear?: () => void;
		onSelect?: (repo: string) => void;
		variant: "inline" | "row" | "probe";
	}
>(function RepoFilterChip({ repo, repos = [], onClear, onSelect, variant }, ref) {
	const probe = variant === "probe";
	const [open, setOpen] = useState(false);
	const bodyRef = useRef<HTMLButtonElement>(null);
	const r = open && bodyRef.current ? bodyRef.current.getBoundingClientRect() : null;

	// Repo dropdown, opened straight off the chip body (no detour through the
	// filter popover). "All repos" clears the filter; reuses the MiniSelect menu.
	let menu: React.ReactNode = null;
	if (open && r) {
		const options: SelectOption[] = [
			{ value: "all", label: "All repos" },
			...repos.map((name) => ({
				value: name,
				label: repoLabel(name),
				icon: <RepoTile name={name} />,
			})),
		];
		const menuW = Math.max(r.width, 170);
		const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
		menu = createPortal(
			<>
				<div className="menu-backdrop" onClick={() => setOpen(false)} />
				<div
					className="mini-select-menu"
					style={{ left, top: r.bottom + 5, minWidth: menuW }}
				>
					{options.map((o) => (
						<button
							key={o.value}
							className={`mini-select-item${o.value === repo ? " selected" : ""}`}
							onClick={() => {
								onSelect?.(o.value);
								setOpen(false);
							}}
						>
							{o.icon}
							<span className="mini-select-item-text">{o.label}</span>
							{o.value === repo && (
								<svg
									className="mini-select-check"
									width="17"
									height="17"
									viewBox="0 0 16 16"
									fill="none"
								>
									<path
										d="M3.5 8.5l3 3 6-7"
										stroke="currentColor"
										strokeWidth="1.6"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
							)}
						</button>
					))}
				</div>
			</>,
			document.body,
		);
	}

	return (
		<span
			ref={ref}
			className={cn(
				"sidebar-repo-chip inline-flex min-w-0 max-w-full items-center gap-px rounded-full border border-line bg-panel px-1 py-[3px] text-[13px] leading-[1.15]",
				variant === "inline" && "shrink-0 max-w-none",
				variant === "probe" && "pointer-events-none absolute left-[-9999px] top-0 max-w-none invisible",
				variant === "inline" && "sidebar-repo-chip--inline",
				variant === "probe" && "sidebar-repo-chip--probe",
			)}
			aria-hidden={probe || undefined}
		>
			{/* Body opens the repo dropdown; the × clears the filter. */}
			<button
				type="button"
				ref={bodyRef}
				className="sidebar-repo-chip-open inline-flex min-w-0 items-center gap-[7px] rounded-full px-[3px] py-0.5 hover:bg-hover"
				title="Switch repo"
				tabIndex={probe ? -1 : undefined}
				onClick={probe ? undefined : () => setOpen((o) => !o)}
			>
				<RepoTile name={repo} />
				<span className="min-w-0 truncate text-dim">{repoLabel(repo)}</span>
			</button>
			<button
				type="button"
				className="sidebar-repo-chip-x inline-flex size-[19px] shrink-0 items-center justify-center rounded-full text-[14px] leading-none text-faint hover:bg-hover hover:text-fg"
				title="Clear repo filter"
				tabIndex={probe ? -1 : undefined}
				onClick={probe ? undefined : onClear}
			>
				×
			</button>
			{menu}
		</span>
	);
});

function SidebarItem({
	session,
	localMode,
	selected,
	unread,
	mine,
	onClick,
	onArchive,
	pinned,
	onTogglePin,
	onRename,
	onSetStatus,
}: {
	session: UnifiedSession;
	localMode: boolean;
	selected: boolean;
	/** New activity since this session was last opened — brightens and bolds the
	    title, like an unread Slack conversation. */
	unread: boolean;
	/** The current user's own session — the owner name is redundant, so it's
	    dropped and the timestamp moves up onto the title line. */
	mine: boolean;
	onClick: () => void;
	onArchive: () => void;
	pinned: boolean;
	onTogglePin: () => void;
	onRename: (title: string) => void;
	/** Pin this session into a sidebar lane (null = back to derived). Present on
	    automation rows — it's how an automation run graduates into your lanes. */
	onSetStatus?: (status: LaneChoice | null) => void;
}) {
	const isPhone = useIsPhone();
	const waiting = !!session.waitingForInput || runNeedsAttention(session);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Desktop right-click menu (mobile long-press opens the action sheet).
	const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
	useEffect(() => {
		if (!ctxMenu) return;
		const close = () => setCtxMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [ctxMenu]);

	// Hover card: after a short dwell, the row's detail card — the same one
	// every other sidebar row raises. Held back while renaming (the input the
	// row turns into owns the interaction).
	const btnRef = useRef<HTMLButtonElement>(null);
	const card = useRowHoverCard(editing);
	const closeHover = card.close;

	// Mobile long-press → action sheet, and — importantly — the *tap* to open a
	// session is driven from `touchend`, not the synthesized `click`. `.sidebar-item`
	// has `:hover` styles (the reveal-on-hover X, the hover background), and iOS
	// treats the first tap on a hover-styled element as a hover-in, swallowing the
	// click — so a click-driven open needs a second tap ("first tap doesn't work").
	// Firing on touchend sidesteps that entirely. A hold that stays roughly in
	// place for LONG_PRESS_MS opens the sheet instead; any real finger travel (a
	// scroll) cancels both.
	const [sheetOpen, setSheetOpen] = useState(false);
	const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pressOrigin = useRef<{ x: number; y: number } | null>(null);
	const longPressed = useRef(false);
	const moved = useRef(false);
	const swipeOrigin = useRef<{ x: number; y: number; width: number } | null>(
		null,
	);
	const swiping = useRef(false);
	const swipeOffsetRef = useRef(0);
	const [dragging, setDragging] = useState(false);
	const [swipeAction, setSwipeAction] = useState<SwipeAction | null>(null);
	const [swipeOffset, setSwipeOffset] = useState(0);
	useEffect(() => {
		if (selected || !isPhone) {
			setSwipeOffset(0);
			swipeOffsetRef.current = 0;
			setSwipeAction(null);
			setDragging(false);
		}
	}, [isPhone, selected]);

	function clearPress() {
		if (pressTimer.current) clearTimeout(pressTimer.current);
		pressTimer.current = null;
		pressOrigin.current = null;
	}
	function onTouchStart(e: React.TouchEvent) {
		if (editing || e.touches.length !== 1) return;
		const t = e.touches[0];
		longPressed.current = false;
		moved.current = false;
		swiping.current = false;
		clearPress();
		// After clearPress (which nulls it) so it survives to onTouchMove/onTouchEnd.
		pressOrigin.current = { x: t.clientX, y: t.clientY };
		swipeOrigin.current = {
			x: t.clientX - swipeOffset,
			y: t.clientY,
			width: e.currentTarget.clientWidth,
		};
		setSwipeAction(null);
		pressTimer.current = setTimeout(() => {
			longPressed.current = true;
			closeHover();
			navigator.vibrate?.(10);
			setSheetOpen(true);
		}, LONG_PRESS_MS);
	}
	function onTouchMove(e: React.TouchEvent) {
		if (e.touches.length !== 1) return;
		const t = e.touches[0];
		const swipeO = swipeOrigin.current;
		if (swipeO && !longPressed.current) {
			const dx = t.clientX - swipeO.x;
			const dy = t.clientY - swipeO.y;
			if (
				swiping.current ||
				(Math.abs(dx) > SWIPE_AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy))
			) {
				swiping.current = true;
				moved.current = true;
				setDragging(true);
				clearPress();
				e.preventDefault();
				const offset = clampSwipe(dx, swipeO.width);
				swipeOffsetRef.current = offset;
				setSwipeOffset(offset);
				return;
			}
		}
		const o = pressOrigin.current;
		if (!o) return;
		if (
			Math.abs(t.clientX - o.x) > LONG_PRESS_SLOP ||
			Math.abs(t.clientY - o.y) > LONG_PRESS_SLOP
		) {
			moved.current = true;
			clearPress();
		}
	}
	function onTouchEnd(e: React.TouchEvent) {
		const hadOrigin = pressOrigin.current !== null;
		const wasSwiping = swiping.current;
		const rowWidth = swipeOrigin.current?.width ?? e.currentTarget.clientWidth;
		const currentOffset = swipeOffsetRef.current;
		clearPress();
		swipeOrigin.current = null;
		swiping.current = false;
		setDragging(false);
		if (editing) return;
		if (wasSwiping) {
			e.preventDefault();
			if (Math.abs(currentOffset) >= fullSwipeThreshold(rowWidth)) {
				const action: SwipeAction = currentOffset < 0 ? "archive" : "star";
				setSwipeAction(action);
				setSwipeOffset(swipeCommitOffset(action, rowWidth));
				window.setTimeout(() => {
					if (action === "archive") onArchive();
					else {
						onTogglePin();
						setSwipeOffset(0);
						window.setTimeout(() => setSwipeAction(null), SWIPE_COMMIT_MS);
					}
					swipeOffsetRef.current = 0;
				}, SWIPE_COMMIT_MS);
				return;
			}
			const snapped =
				Math.abs(currentOffset) > SWIPE_OPEN_THRESHOLD
					? currentOffset > 0
						? SWIPE_REVEAL_PX
						: -SWIPE_REVEAL_PX
					: 0;
			swipeOffsetRef.current = snapped;
			setSwipeOffset(snapped);
			return;
		}
		// A clean tap: it started on this row, never became a long-press, and
		// never turned into a scroll. Open now and swallow the ghost click iOS
		// would fire ~300ms later (which the :hover heuristic may drop anyway).
		if (hadOrigin && !longPressed.current && !moved.current) {
			e.preventDefault();
			if (swipeOffset !== 0) {
				setSwipeOffset(0);
				swipeOffsetRef.current = 0;
				return;
			}
			onClick();
		}
	}

	function commitRename() {
		onRename(draft.trim());
		setEditing(false);
	}

	const metaParts: React.ReactNode[] = [];
	// In "My sessions" the owner is always the current user, so hide it.
	if (!mine && session.startedBy && !session.automation) {
		metaParts.push(<span key="u">{session.startedBy}</span>);
	}
	// No idle "time since" here — times only appear while a run is live (the
	// hovercard/details still carry last activity).
	if (session.linearIssue) {
		metaParts.push(
			<span key="lin" className="sidebar-meta-linear">
				{session.linearIssue.identifier}
			</span>,
		);
	}

	const visibleSwipeOffset = isPhone ? swipeOffset : 0;

	return (
		<Popover.Root {...card.rootProps}>
		<div
			className={`sidebar-swipe-row${
				swipeAction === "archive" || visibleSwipeOffset < 0
					? " is-open is-swipe-archive"
					: swipeAction === "star" || visibleSwipeOffset > 0
						? " is-open is-swipe-star"
						: ""
			}${dragging ? " is-dragging" : ""}`}
			style={
				visibleSwipeOffset
					? ({
							"--swipe-action-w": `${Math.max(
								SWIPE_REVEAL_PX,
								Math.abs(visibleSwipeOffset),
							)}px`,
						} as React.CSSProperties)
					: undefined
			}
		>
			{isPhone && (
				<button
					className="sidebar-swipe-action sidebar-swipe-action--archive"
					onClick={(e) => {
						e.stopPropagation();
						setSwipeOffset(0);
						onArchive();
					}}
					title="Archive session"
				>
					<IconArchive size={22} />
					<span>Archive</span>
				</button>
			)}
			{isPhone && (
				<button
					className={`sidebar-swipe-action sidebar-swipe-action--star${pinned ? " is-on" : ""}`}
					onClick={(e) => {
						e.stopPropagation();
						setSwipeOffset(0);
						onTogglePin();
					}}
					title={pinned ? "Unpin session" : "Pin session"}
				>
					<IconPin size={22} fill={pinned ? "currentColor" : "none"} />
					<span>{pinned ? "Unpin" : "Pin"}</span>
				</button>
			)}
		<Popover.Trigger
			{...card.triggerProps}
			render={
				<button
					ref={btnRef}
					className={cn(
						SIDEBAR_ITEM_CLASS,
						"group",
						!mine && "sidebar-item--twoline py-[7px]",
						selected && "sidebar-item-selected !bg-hover-strong",
						waiting && "sidebar-item-waiting !bg-blue-soft",
						unread && "sidebar-item-unread",
					)}
					style={
						visibleSwipeOffset
							? ({ "--swipe-x": `${visibleSwipeOffset}px` } as React.CSSProperties)
							: undefined
					}
					onClick={(e) => {
						// Touch taps are handled on touchend (and their ghost click is
						// preventDefault'd), so this path is the mouse/desktop one. Still
						// swallow a click that ends a long-press, as a belt-and-suspenders.
						if (longPressed.current) {
							longPressed.current = false;
							e.preventDefault();
							return;
						}
						onClick();
					}}
					onTouchStart={onTouchStart}
					onTouchMove={onTouchMove}
					onTouchEnd={onTouchEnd}
					onTouchCancel={() => {
						clearPress();
						swipeOrigin.current = null;
						swiping.current = false;
						setDragging(false);
					}}
					onContextMenu={(e) => {
						// On touch this is the long-press callout: the action sheet
						// owns that gesture, so suppress the native text-selection
						// callout rather than stacking both.
						if (longPressed.current || pressOrigin.current) {
							e.preventDefault();
							return;
						}
						e.preventDefault();
						closeHover();
						setCtxMenu({ x: e.clientX, y: e.clientY });
					}}
				/>
			}
		>
			<div className="sidebar-item-top flex min-w-0 items-center gap-[9px]">
				{/* Match workspace rows: the rail holds the PR glyph alone — a blocked
				    chat reads from its accent wash and bold title, not from a second
				    dot wedged in beside it — and merged PRs keep the glyph itself
				    purple instead of adding metadata. */}
				<span className={SIDEBAR_RAIL_CLASS}>
					{waiting && <span className="sr-only">Needs your attention</span>}
					{session.isRunning ? (
						<PixelSpinner className="text-yellow sidebar-spinner" />
					) : (
						<WsPrStatusMark chats={[session]} size={18} />
					)}
				</span>
				{editing ? (
					<input
						className="sidebar-item-rename min-w-0 flex-1 rounded-md border border-[var(--accent,#6b8afd)] bg-bg px-[3px] text-item-title font-medium text-inherit outline-none max-[720px]:text-[16px]"
						value={draft}
						autoFocus
						onChange={(e) => setDraft(e.target.value)}
						onClick={(e) => e.stopPropagation()}
						onMouseDown={(e) => e.stopPropagation()}
						onDoubleClick={(e) => e.stopPropagation()}
						onBlur={commitRename}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
							else if (e.key === "Escape") setEditing(false);
							e.stopPropagation();
						}}
					/>
				) : (
					<span
						className={cn(SIDEBAR_TITLE_CLASS, unread && "font-semibold text-fg", waiting && "font-semibold text-fg")}
						onDoubleClick={(e) => {
							e.stopPropagation();
							setDraft(session.title);
							setEditing(true);
						}}
					>
						{stripPrTitlePrefix(session.title)}
					</span>
				)}
				{localMode && session.local && !editing && (
					<span className="shrink-0 rounded-full border border-line px-1.5 py-px text-meta font-medium tracking-wide text-faint">
						local
					</span>
				)}
				{mine && !editing && metaParts.length > 0 && (
					<span className="sidebar-item-inline-meta ml-auto flex min-w-[40px] shrink-0 items-center justify-end gap-1 pl-2.5 text-meta text-faint max-[720px]:text-[13px]">
						{metaParts.map((part, i) => (
							<React.Fragment key={i}>
								{i > 0 && <span className="sidebar-meta-sep">·</span>}
								{part}
							</React.Fragment>
						))}
					</span>
				)}
				{!editing && hasDraft(`chat:${session.id}`) && (
					<span
						className="sidebar-ws-draft"
						aria-label="Unsent draft. Return to finish it."
					>
						<IconPencil size={20} />
					</span>
				)}
			</div>
			{!mine && (
				<div className="sidebar-item-meta mt-[3px] flex items-center gap-1 overflow-hidden whitespace-nowrap pl-7 text-meta text-faint max-[720px]:text-[13px]">
					{metaParts.map((part, i) => (
						<React.Fragment key={i}>
							{i > 0 && <span className="sidebar-meta-sep">·</span>}
							{part}
						</React.Fragment>
					))}
				</div>
			)}
			<Tooltip
				label={pinned ? "Unpin session" : "Pin session"}
				shortcut={selected ? PIN_SHORTCUT_KEYS : undefined}
			>
				<span
					className={cn("sidebar-item-pin absolute right-[35px] top-1/2 hidden size-[26px] -translate-y-1/2 items-center justify-center rounded-md bg-hover text-faint shadow-[-6px_0_5px_-2px_var(--bg-hover)] [@media(hover:hover)]:group-hover:flex hover:bg-active hover:text-fg", pinned && "is-on text-accent")}
					role="button"
					aria-label={pinned ? "Unpin session" : "Pin session"}
					onMouseEnter={closeHover}
					onClick={(e) => {
						e.stopPropagation();
						onTogglePin();
					}}
				>
					<IconPin size={19} fill={pinned ? "currentColor" : "none"} />
				</span>
			</Tooltip>
			<Tooltip
				label="Archive session"
				shortcut={selected ? ARCHIVE_SHORTCUT_KEYS : undefined}
			>
				<span
					className="sidebar-item-x absolute right-[7px] top-1/2 hidden size-[26px] -translate-y-1/2 items-center justify-center rounded-md bg-hover text-faint shadow-[-6px_0_5px_-2px_var(--bg-hover)] [@media(hover:hover)]:group-hover:flex hover:bg-active hover:text-fg"
					role="button"
					aria-label="Archive session"
					onMouseEnter={closeHover}
					onClick={(e) => {
						e.stopPropagation();
						onArchive();
					}}
				>
					<svg
						width="20"
						height="20"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					>
						<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
						<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
						<path d="M6.5 8.5h3" strokeLinecap="round" />
					</svg>
				</span>
			</Tooltip>
		</Popover.Trigger>
		</div>
		<RowCardPopup>
			<SessionCardBody session={session} />
		</RowCardPopup>
			{sheetOpen && (
				<MobileActionSheet
					session={session}
					mine={mine}
					onRename={() => {
						setDraft(session.title);
						setEditing(true);
					}}
					onArchive={onArchive}
					onSetStatus={onSetStatus}
					onClose={() => setSheetOpen(false)}
				/>
			)}
			{ctxMenu && (
				<SidebarCtxMenu
					x={ctxMenu.x}
					y={ctxMenu.y}
					onClose={() => setCtxMenu(null)}
					entries={[
						{
							kind: "item",
							icon: <IconMail size={20} />,
							// Offer the move you can actually make, not both directions.
							label: unread ? "Mark as read" : "Mark as unread",
							onClick: () =>
								unread
									? markRead(session.id, session.lastActivity)
									: markUnread(session.id),
						},
						{
							kind: "item",
							icon: (
								<IconPin size={20} fill={pinned ? "currentColor" : "none"} />
							),
							label: pinned ? "Unpin" : "Pin",
							onClick: onTogglePin,
						},
						...(onSetStatus
							? [
									// Claim this run into your own lanes (per-user — it
									// moves only in YOUR sidebar), where it then follows
									// its live state instead of staying parked in the
									// Automations band. Your own sessions are already
									// there, so they don't offer it.
									...(!mine || isClaimed(session)
										? [
												{
													kind: "item",
													icon: <IconInbox size={20} />,
													label: isClaimed(session)
														? "Remove from my workspaces"
														: "Add to my workspaces",
													onClick: () =>
														onSetStatus(isClaimed(session) ? null : "mine"),
												} as const,
											]
										: []),
									{
										kind: "status",
										current: pinnedLane(session) ?? null,
										onPick: onSetStatus,
									} as const,
								]
							: []),
						{
							kind: "item",
							icon: <IconPencil size={20} />,
							label: "Rename",
							onClick: () => {
								setDraft(session.title);
								setEditing(true);
							},
						},
						{ kind: "sep" },
						{
							kind: "item",
							icon: <IconArchive size={20} />,
							label: "Archive",
							onClick: onArchive,
						},
					]}
				/>
			)}
		</Popover.Root>
	);
}

// Swipe-down-to-dismiss for the bottom sheets: dragging anywhere on the sheet
// pulls it down with the finger; past the threshold it closes on release,
// otherwise it snaps back. A plain tap never moves it, so button taps are
// unaffected.
function useSheetDismiss(onClose: () => void) {
	const [dy, setDy] = useState(0);
	const startY = useRef<number | null>(null);
	const end = () => {
		const passed = dy > 80;
		startY.current = null;
		setDy(0);
		if (passed) onClose();
	};
	return {
		handlers: {
			onTouchStart: (e: React.TouchEvent) => {
				startY.current = e.touches[0].clientY;
			},
			onTouchMove: (e: React.TouchEvent) => {
				if (startY.current === null) return;
				setDy(Math.max(0, e.touches[0].clientY - startY.current));
			},
			onTouchEnd: end,
			onTouchCancel: end,
		},
		style: dy
			? ({
					transform: `translateY(${dy}px)`,
					transition: "none",
				} as React.CSSProperties)
			: undefined,
	};
}

// The bottom sheet raised by long-pressing a session row on touch. It gathers
// the per-session actions (rename, archive) into thumb-sized rows. Rendered in
// a portal over a dimmed, tap-to-dismiss backdrop.
function MobileActionSheet({
	session,
	mine,
	onRename,
	onArchive,
	onSetStatus,
	onClose,
}: {
	session: UnifiedSession;
	/** Your own session — it's already in your lanes, so no claim action. */
	mine: boolean;
	onRename: () => void;
	onArchive: () => void;
	/** Pin the session into a lane (see SidebarItem) — automation rows only. */
	onSetStatus?: (status: LaneChoice | null) => void;
	onClose: () => void;
}) {
	const drag = useSheetDismiss(onClose);
	// Lock the page behind the sheet so a scroll drags the list, not the page.
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);
	return createPortal(
		<div className="mobile-action-sheet-backdrop fixed inset-0 z-[4000] bg-black/40" onClick={onClose}>
			<div
				className="mobile-action-sheet fixed inset-x-0 bottom-0 z-[4001] rounded-t-[16px] bg-panel px-2.5 pt-1.5 pb-[calc(14px+env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(0,0,0,0.4)]"
				style={drag.style}
				{...drag.handlers}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mobile-sheet-grip mx-auto my-2 h-1 w-9 rounded-sm bg-line-strong" />
				<div className="mobile-sheet-title truncate px-3 py-1.5 pb-2 text-control-label text-faint">{session.title}</div>
				<button
					className={MOBILE_SHEET_ITEM_CLASS}
					onClick={() => {
						onRename();
						onClose();
					}}
				>
					<svg
						width="20"
						height="20"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					>
						<path d="M10.5 2.5l3 3L6 13l-3.5.5L3 10z" />
					</svg>
					Rename
				</button>
				{/* Claim this run into your own lanes, where it follows its live
				    state — the phone twin of the row's right-click action. */}
				{onSetStatus && (!mine || isClaimed(session)) && (
					<button
						className={MOBILE_SHEET_ITEM_CLASS}
						onClick={() => {
							onSetStatus(isClaimed(session) ? null : "mine");
							onClose();
						}}
					>
						<IconInbox size={22} />
						{isClaimed(session)
							? "Remove from my workspaces"
							: "Add to my workspaces"}
					</button>
				)}
				{/* Same lane chips as the workspace sheet — forcing a specific lane
				    for a run from a phone. Lanes are per-user: the move happens in
				    YOUR sidebar only. */}
				{onSetStatus && (
					<div className="px-4 py-2">
						<div className="mb-1.5 text-label font-semibold text-faint">
							Move to lane
						</div>
						<div className="flex flex-wrap gap-1.5">
							{MINE_STATUS_META.map((m) => {
								const on = pinnedLane(session) === m.key;
								return (
									<Button
										variant="ghost"
										size="xs"
										key={m.key}
										type="button"
										className="gap-1.5 whitespace-normal px-2 text-control-label"
										style={{
											borderColor: on ? m.dotColor : "var(--border)",
											color: on ? "var(--text)" : "var(--text-dim)",
										}}
										onClick={() => {
											onSetStatus(on ? null : m.key);
											onClose();
										}}
									>
										<span
											style={{
												width: 8,
												height: 8,
												borderRadius: "50%",
												background: m.dotColor,
												flexShrink: 0,
											}}
										/>
										{m.label}
									</Button>
								);
							})}
							<Button
										variant="ghost"
										size="xs"
								type="button"
								className="whitespace-normal px-2 text-control-label"
								style={{
									borderColor: !pinnedLane(session)
										? "var(--text-dim)"
										: "var(--border)",
									color: !pinnedLane(session)
										? "var(--text)"
										: "var(--text-dim)",
								}}
								onClick={() => {
									onSetStatus(null);
									onClose();
								}}
							>
								Auto
							</Button>
						</div>
					</div>
				)}
				<div className="mobile-sheet-sep mx-2.5 my-1.5 h-px bg-line" />
				<button
					className={`${MOBILE_SHEET_ITEM_CLASS} mobile-sheet-item--danger text-red [&_svg]:text-red`}
					onClick={() => {
						onArchive();
						onClose();
					}}
				>
					<svg
						width="20"
						height="20"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					>
						<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
						<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
						<path d="M6.5 8.5h3" strokeLinecap="round" />
					</svg>
					Archive
				</button>
			</div>
		</div>,
		document.body,
	);
}

// The chat row's card body. Content is state-dependent: the prominent status
// line and the rows that render depend on whether the session is
// waiting/running/merged/etc. and which of its optional facets (PR, Linear
// issue, goal, loop, extra repos) are populated. Everything comes off the
// already-loaded UnifiedSession — the card fetches nothing.
function SessionCardBody({ session: s }: { session: UnifiedSession }) {
	const state = hoverState(s);
	const rows: Array<[string, React.ReactNode]> = [];

	const owner = s.automation || s.startedBy;
	if (owner) rows.push([s.automation ? "Automation" : "Started by", owner]);
	if (s.model) rows.push(["Model", s.model]);
	if (s.mode) rows.push(["Mode", s.mode]);

	const repoName = repoLabel(s.repo || DEFAULT_REPO_ID);
	const extra = s.attachedRepos?.length || 0;
	rows.push(["Repo", extra ? `${repoName} +${extra} more` : repoName]);
	if (s.branch)
		rows.push([
			"Branch",
			<span className="hovercard-mono">{s.branch}</span>,
		]);

	if (s.linearIssue)
		rows.push([
			"Linear",
			<span>
				<span className="hovercard-mono">{s.linearIssue.identifier}</span>{" "}
				{s.linearIssue.title}
			</span>,
		]);
	if (s.goal) rows.push(["Goal", "Autonomous goal session"]);
	if (s.loop)
		rows.push(["Loop", `Every ${s.loop.intervalMinutes} min`]);

	// The PR facts go in rows, worded exactly as the PR row's card words them —
	// the state itself is already the card's status line, so it isn't repeated.
	if (s.prReviewDecision) rows.push(["Review", prettyReview(s.prReviewDecision)]);
	const checks = checksLabel(s.prChecks);
	if (checks) rows.push(["Checks", checks]);

	rows.push(["Created", relativeTime(s.createdAt)]);

	return (
		<>
			<div className={HOVERCARD_HEAD_CLASS}>
				<span
					className={`sidebar-item-status hovercard-dot ${state.dotClass}`}
				/>
				<span className={HOVERCARD_BRANCH_CLASS}>
					{s.branch || s.title}
				</span>
				{s.prAdditions != null && s.prDeletions != null && (
					<span className="hovercard-diff">
						<span className="hovercard-add">
							+{compactNum(s.prAdditions)}
						</span>{" "}
						<span className="hovercard-del">
							-{compactNum(s.prDeletions)}
						</span>
					</span>
				)}
			</div>

			<div className={HOVERCARD_TITLE_CLASS}>{s.title}</div>

			<div className={`hovercard-state mt-[3px] text-meta font-medium hovercard-state-${state.tone}`}>
				{state.label}
			</div>

			{s.waitingForInput && (
				<div className={HOVERCARD_CALLOUT_CLASS}>
					Blocked on a question — open the session to answer.
				</div>
			)}
			{!s.waitingForInput && runNeedsAttention(s) && (
				<div className={HOVERCARD_CALLOUT_CLASS}>
					Run failed: {s.lastRunError!.message.slice(0, 200)}
				</div>
			)}
			{!s.waitingForInput && (s.queuedCount ?? 0) > 0 && (
				<div className={HOVERCARD_CALLOUT_CLASS}>
					{s.queuedCount} prompt{s.queuedCount === 1 ? "" : "s"} queued.
				</div>
			)}

			<div className={HOVERCARD_ROWS_CLASS}>
				{rows.map(([label, value], i) => (
					<div className={HOVERCARD_ROW_CLASS} key={i}>
						<span className="hovercard-label w-[74px] shrink-0 text-faint">{label}</span>
						<span className="hovercard-value min-w-0 truncate text-dim">{value}</span>
					</div>
				))}
			</div>

			<CardFooter
				time={`Updated ${relativeTime(s.lastActivity)}`}
				timeTitle={new Date(s.lastActivity).toLocaleString()}
			>
				{s.prUrl && (
					<CardLink
						href={s.prUrl}
						title={`Open on ${providerFromUrl(s.prUrl).name}`}
					>
						<span className="hovercard-mono">
							{s.prNumber ? `#${s.prNumber}` : "PR"}
						</span>{" "}
						↗
					</CardLink>
				)}
			</CardFooter>
		</>
	);
}

// The single prominent status line + its dot/tone. Ordering mirrors how a person
// triages: a blocked question first, then live activity, then PR/lifecycle.
function hoverState(s: UnifiedSession): {
	label: string;
	tone: "accent" | "blue" | "green" | "purple" | "yellow" | "dim";
	dotClass: string;
} {
	if (s.waitingForInput)
		return {
			label: "Waiting for your input",
			tone: "blue",
			dotClass: "sidebar-status-waiting",
		};
	if (runNeedsAttention(s))
		return {
			label: "Last run failed. Needs attention.",
			tone: "accent",
			dotClass: "sidebar-status-waiting",
		};
	if (s.isRunning)
		return {
			label: "Running",
			tone: "green",
			dotClass: "sidebar-status-running",
		};
	if (s.prState === "MERGED")
		return { label: "Merged", tone: "purple", dotClass: "hovercard-dot-purple" };
	if (s.prState === "CLOSED")
		return { label: "PR closed", tone: "dim", dotClass: "hovercard-dot-red" };
	if (s.prState === "OPEN")
		return {
			label: s.prIsDraft ? "Draft PR — in review" : "In review",
			tone: "green",
			dotClass: "hovercard-dot-green",
		};
	return { label: "Idle", tone: "dim", dotClass: "hovercard-dot-dim" };
}

function prTone(s: UnifiedSession): string {
	if (s.prState === "MERGED") return "merged";
	if (s.prState === "CLOSED") return "closed";
	return "open";
}
function prettyReview(d: string): string {
	if (d === "APPROVED") return "approved";
	if (d === "CHANGES_REQUESTED") return "changes requested";
	if (d === "REVIEW_REQUIRED") return "review required";
	return d.toLowerCase().replace(/_/g, " ");
}
function compactNum(n: number): string {
	if (n >= 10000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

// ── Workspace hover card ────────────────────────────────────────────────────
// Structural subset of WsRow (declared inside Sidebar) that the card reads.
interface WsCardRow {
	key: string;
	workspace: Project | null;
	name: string;
	chats: UnifiedSession[];
	status: MineStatus;
	lastActivity: string;
	running: boolean;
}

// Leading status mark for a workspace, Conductor-style: live states
// (blocked question, running) keep their animated form, then the PR lifecycle
// gets an icon — open PR (green, faint while still a draft) or merged
// (purple). Backlog rows get a quiet gray idle dot. Shared by
// the sidebar row and the hover card head so they always read the same.
// Live "in progress" ticker: counts up from when the run started, in the
// in-progress color (yellow). Ticks once a second, isolated to this tiny node
// so the whole sidebar doesn't re-render every second. `startMs` is the earliest
// running chat's start (see runStartMs) — the workspace's been busy for that long.
function RunTicker({ startMs }: { startMs: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	return (
		<span className="sidebar-ws-ticker" title="How long this run has been working">
			{elapsedClock(startMs, now)}
		</span>
	);
}

// Countdown badge for a snoozed row: time until it wakes ("57m", "14h").
// Isolated 30s ticker (RunTicker-style) so the sidebar doesn't re-render
// for the countdown.
function SnoozeBadge({ until }: { until: string }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(t);
	}, []);
	return (
		<span
			className="sidebar-ws-snooze"
			title={`Snoozed until ${new Date(until).toLocaleString()}`}
		>
			<IconMoon size={20} />
			{formatRemaining(until, now)}
		</span>
	);
}

// Workspaces adopted from a PR inherit names like "PR #3662: Rehome setup
// controls" — in the sidebar the PR icon already carries that identity, so the
// row shows just the human title. Display-only: the tooltip, rename field and
// hovercard keep the full name (and the PR number lives there + in the PR tab).
function stripPrTitlePrefix(name: string): string {
	return name.replace(/^PR\s*#\d+(:|\s*[—–-])\s*/i, "");
}

function frontingPrChat(chats: UnifiedSession[]): UnifiedSession | undefined {
	return [...chats]
		.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""))
		.find((chat) => chat.prUrl);
}

function WsPrStatusMark({
	chats,
	size,
	workspace,
}: {
	chats: UnifiedSession[];
	size: number;
	workspace?: { branch?: string | null; prNumber?: number } | null;
}) {
	const chat = frontingPrChat(chats);
	if (!chat) {
		// Rows that can never have a PR — feed/scratch workspaces (repo-less
		// chats, no workspace branch/PR) — get an empty alignment slot, not a
		// misleading git glyph.
		const canPr =
			chats.some((c) => c.branch || c.prUrl || c.repo) ||
			!!workspace?.branch ||
			workspace?.prNumber !== undefined;
		if (!canPr)
			return (
				<span
					className="flex shrink-0 items-center justify-center"
					style={{ width: size, height: size }}
				/>
			);
		return (
			<span title="No pull request">
				<IconPullRequest size={size} className="text-faint" />
			</span>
		);
	}
	if (chat.prState === "MERGED") {
		return (
			<span title="PR merged">
				<IconPullRequest size={size} className="text-purple" />
			</span>
		);
	}
	const failed = (chat.prChecks?.failed || 0) > 0;
	const pending = (chat.prChecks?.pending || 0) > 0;
	const changesRequested = chat.prReviewDecision === "CHANGES_REQUESTED";
	const className =
		chat.prState === "CLOSED" || failed || changesRequested
			? "text-red"
			: pending
				? "text-yellow"
				: chat.prIsDraft
					? "text-faint"
					: "text-green";
	const label =
		chat.prState === "CLOSED"
			? "PR closed"
			: changesRequested
				? "PR changes requested"
				: failed
					? "PR checks failing"
					: pending
						? "PR checks running"
						: chat.prIsDraft
							? "Draft PR"
							: chat.prReviewDecision === "APPROVED"
								? "PR approved"
								: "PR open";
	return (
		<span title={label}>
			<IconPullRequest size={size} className={className} />
		</span>
	);
}

function WsStatusMark({
	row,
	size = 20,
}: {
	row: { status: MineStatus; running: boolean; chats: UnifiedSession[] };
	size?: number;
}) {
	// Every mark rides in the same `size`-wide (20px) flex slot so #number/title
	// line up at one x whichever mark the row carries. It also gives the icons a
	// real CSS box: an SVG sized only by its width/height *attributes* collapses
	// to a 0 flex-basis in iOS Safari and paints on top of the title — the slot's
	// inline-styled span dodges that (the dots were always immune for this reason).
	const slot = (child: React.ReactNode) => (
		<span
			className="flex shrink-0 items-center justify-center"
			style={{ width: size, height: size }}
		>
			{child}
		</span>
	);
	const dot = (cls: string) => slot(<span className={`sidebar-item-status ${cls}`} />);
	if (row.status === "needsinput") return dot("sidebar-status-waiting");
	if (row.running)
		return slot(<PixelSpinner className="text-yellow sidebar-spinner" />);
	if (row.status === "review") {
		const open = row.chats.filter((c) => c.prState === "OPEN");
		const allDraft = open.length > 0 && open.every((c) => c.prIsDraft);
		return slot(
			<IconPullRequest
				size={size}
				className={allDraft ? "text-faint" : "text-green"}
			/>,
		);
	}
	if (row.status === "merged")
		return slot(<IconGitMerge size={size} className="text-purple" />);
	// Lanes never infer "merged" (archiving is explicit — see mineStatus), so an
	// idle row whose latest PR landed still sits in Backlog. Its mark should
	// carry the PR lifecycle anyway, like the lane-grouped view's
	// WsPrStatusMark does — a grey idle dot on a merged row reads as "no PR".
	const prChat = frontingPrChat(row.chats);
	if (row.status === "pending" && prChat && sessionPrMerged(prChat))
		return slot(<IconGitMerge size={size} className="text-purple" />);
	return dot("sidebar-status-idle");
}

// Footer action button base — the color variant carries the status meaning
// (green = ready to merge, purple = merged/archive, accent = needs an answer).
const WS_ACTION =
	"flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-control-label font-medium no-underline";

// Overview (description + thumbnails) for a workspace row. Same cache (and
// key) as the right panel's WorkspaceInfo block, so a workspace that's been
// opened paints instantly and vice versa. Shared by the hover card (desktop)
// and the long-press sheet (mobile).
function useWsOverview(row: WsCardRow): WorkspaceOverview | null {
	const cacheKey =
		row.workspace?.id || `chats:${row.chats.map((c) => c.id).join(",")}`;
	const activityKey = row.lastActivity || row.chats.map((c) => c.lastActivity).join(",");
	const [ov, setOv] = useState<WorkspaceOverview | null>(
		() => overviewCache.get(cacheKey)?.data ?? null,
	);
	useEffect(() => {
		let alive = true;
		const cached = overviewCache.get(cacheKey);
		setOv(cached?.data ?? null);
		if (row.chats.length === 0) return;
		const activityAt = activityKey ? new Date(activityKey).getTime() : 0;
		if (
			cached &&
			Date.now() - cached.at < 30_000 &&
			(!activityAt || cached.at >= activityAt)
		)
			return;
		loadOverview(
			cacheKey,
			row.workspace?.id ?? null,
			row.chats.map((c) => ({
				id: c.id,
				title: c.title,
				createdAt: c.createdAt,
				lastActivity: c.lastActivity,
			})),
		)
			.then((d) => {
				if (alive) setOv(d);
			})
			.catch(() => {
				// The view just stays without a description/thumbnails.
			});
		return () => {
			alive = false;
		};
	}, [cacheKey, activityKey]);
	return ov;
}

// The PR that fronts the workspace (the newest chat that has one) and how to
// present it: "basically ready to be merged" (open, not draft, checks green,
// no changes requested) turns the main action green; the status bits spell
// out draft/merged/closed, the review decision, and a checks summary.
function wsPrInfo(row: WsCardRow) {
	const newestFirst = [...row.chats].sort((a, b) =>
		(b.lastActivity || "").localeCompare(a.lastActivity || ""),
	);
	const prChat = newestFirst.find((c) => c.prUrl);
	const branch = prChat?.branch || newestFirst.find((c) => c.branch)?.branch;
	const prReady =
		!!prChat &&
		prChat.prState === "OPEN" &&
		!prChat.prIsDraft &&
		prChat.prReviewDecision !== "CHANGES_REQUESTED" &&
		(!prChat.prChecks ||
			prChat.prChecks.total === 0 ||
			(prChat.prChecks.failed === 0 && prChat.prChecks.pending === 0));
	const prStatusBits = prChat
		? [
				prChat.prState === "OPEN" && prChat.prIsDraft ? "draft" : null,
				prChat.prState === "MERGED" ? "merged" : null,
				prChat.prState === "CLOSED" ? "closed" : null,
				prChat.prReviewDecision
					? prettyReview(prChat.prReviewDecision)
					: null,
				prChat.prChecks && prChat.prChecks.total > 0
					? prChat.prChecks.failed > 0
						? `${prChat.prChecks.failed} failing`
						: prChat.prChecks.pending > 0
							? `${prChat.prChecks.pending} pending`
							: "checks pass"
					: null,
			].filter((b): b is string => !!b)
		: [];
	return { prChat, branch, prReady, prStatusBits };
}

/** Stills rendered in the hover card's filmstrip. The strip scrolls, so this
 *  is only a bound on how many images a hover preview loads; the rest are a
 *  "+N" away in the lightbox. */
const MAX_HOVERCARD_MEDIA = 8;

// The info half of the workspace card: branch + diff + status mark, title,
// blocked-question callout, latest-message description, media thumbnails.
// Rendered inside the hover card (desktop) and the long-press sheet (mobile).
function WsOverviewInfo({
	row,
	ov,
}: {
	row: WsCardRow;
	ov: WorkspaceOverview | null;
}) {
	const { prChat, branch } = wsPrInfo(row);
	const meta = MINE_STATUS_META.find((m) => m.key === row.status);
	const desc = (ov?.lastMessage?.content || ov?.prompt?.content || "")
		.replace(/\s+/g, " ")
		.trim();
	const media = ov?.media || [];
	return (
		<>
			<div className={HOVERCARD_HEAD_CLASS}>
				<span className={HOVERCARD_BRANCH_CLASS}>
					{branch || repoLabel(row.chats[0]?.repo || DEFAULT_REPO_ID)}
				</span>
				{prChat?.prAdditions != null && prChat?.prDeletions != null && (
					<span className="hovercard-diff">
						<span className="hovercard-add">
							+{compactNum(prChat.prAdditions)}
						</span>{" "}
						<span className="hovercard-del">
							-{compactNum(prChat.prDeletions)}
						</span>
					</span>
				)}
				<span className="flex shrink-0 items-center" title={meta?.label}>
					<WsStatusMark row={row} size={22} />
				</span>
			</div>

			<div className={HOVERCARD_TITLE_CLASS}>{row.name}</div>

			{/* What os-review made of this PR — the question a Ready-to-merge row
			    raises, answered without opening GitHub. */}
			{prChat?.prOsReview && (
				<div className="hovercard-state">
					<span className="text-faint">OS review </span>
					{osReviewLabel(prChat.prOsReview)}
				</div>
			)}

			{row.status === "needsinput" &&
				(row.chats.some((c) => c.waitingForInput) ? (
					<div className={HOVERCARD_CALLOUT_CLASS}>
						Blocked on a question — open to answer.
					</div>
				) : (
					<div className={HOVERCARD_CALLOUT_CLASS}>
						Run failed:{" "}
						{row.chats
							.find((c) => runNeedsAttention(c))
							?.lastRunError?.message.slice(0, 200) || "needs attention"}
					</div>
				))}

			{desc && (
				<div className="selectable mt-1 text-meta leading-snug text-dim line-clamp-2">
					{desc}
				</div>
			)}

			{media.length > 0 && (
				// A filmstrip, like the info panel's screenshots: a 62px square
				// crop of a 1440px screenshot is a grey band of text, not a
				// picture of anything. Whole frames, scrolled sideways — and
				// everything is reachable instead of hidden behind a "+3".
				<div className="mt-2 flex snap-x snap-mandatory gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					{media.slice(0, MAX_HOVERCARD_MEDIA).map((m, i) => (
						<button
							key={`${m.sessionId}:${m.at}:${i}`}
							type="button"
							onClick={() => openLightbox(media, i)}
							className="relative block aspect-video w-[124px] shrink-0 snap-start overflow-hidden rounded-sm border border-line bg-surface p-0"
							title={[m.chatTitle, new Date(m.at).toLocaleString()]
								.filter(Boolean)
								.join(" · ")}
						>
							{m.kind === "image" ? (
								<img
									src={m.src}
									alt=""
									loading="lazy"
									className="h-full w-full object-contain"
								/>
							) : (
								<>
									<video
										src={m.src}
										muted
										playsInline
										preload="metadata"
										className="h-full w-full object-contain"
									/>
									<span className="pointer-events-none absolute inset-0 grid place-items-center text-item-title text-white drop-shadow">
										▶
									</span>
								</>
							)}
							{i === MAX_HOVERCARD_MEDIA - 1 &&
								media.length > MAX_HOVERCARD_MEDIA && (
									<span className="absolute inset-0 grid place-items-center bg-black/55 text-label font-semibold text-white">
										+{media.length - MAX_HOVERCARD_MEDIA + 1}
									</span>
								)}
						</button>
					))}
				</div>
			)}
		</>
	);
}

// The workspace counterpart of SessionCardBody: branch + diff stats + status
// at a glance, the latest assistant message as a "where things stand" line,
// screenshot thumbnails from the workspace's chats, and quick actions
// (Archive, PR link) — the only card body that carries controls, which is why
// its shell is the one the pointer can travel into.
function WsCardBody({
	row,
	onArchive,
	onOpen,
}: {
	row: WsCardRow;
	onArchive: () => void;
	/** Open a chat (the "Answer" action jumps to the blocked one). */
	onOpen: (chat: UnifiedSession) => void;
}) {
	const ov = useWsOverview(row);
	const { prChat, prReady, prStatusBits } = wsPrInfo(row);

	return (
		<>
			<WsOverviewInfo row={row} ov={ov} />

			<CardFooter
				time={`Updated ${relativeTime(row.lastActivity)}`}
				timeTitle={new Date(row.lastActivity).toLocaleString()}
			>
				{/* The single main action, colored by what the workspace needs next:
				    answer the blocked question (accent), merge the ready PR (green),
				    review the not-ready PR (neutral), or archive merged work (purple). */}
				{row.status === "needsinput" && row.chats.length > 0 ? (
					<button
						className={`${WS_ACTION} bg-accent text-white hover:opacity-90`}
						onClick={() =>
							onOpen(
								row.chats.find((c) => c.waitingForInput) ||
									row.chats.find((c) => runNeedsAttention(c)) ||
									row.chats[0],
							)
						}
					>
						{row.chats.some((c) => c.waitingForInput) ? "Answer" : "Open"}
					</button>
				) : row.status === "merged" ? (
					<button
						className={`${WS_ACTION} bg-purple text-white hover:opacity-90`}
						onClick={onArchive}
					>
						<svg
							width="15"
							height="15"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
						>
							<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
							<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
							<path d="M6.5 8.5h3" strokeLinecap="round" />
						</svg>
						Archive
					</button>
				) : row.status === "review" && prChat?.prUrl ? (
					<a
						href={prChat.prUrl}
						target="_blank"
						rel="noopener noreferrer"
						className={
							prReady
								? `${WS_ACTION} bg-green text-white hover:opacity-90`
								: `${WS_ACTION} border border-line bg-surface text-dim hover:bg-hover hover:text-fg`
						}
					>
						{prReady ? "Merge" : "Review"} ↗
					</a>
				) : null}
				{prChat?.prUrl && (
					<CardLink
						href={prChat.prUrl}
						title={`Open on ${providerFromUrl(prChat.prUrl).name}`}
					>
						<span className="hovercard-mono">
							{prChat.prNumber ? `#${prChat.prNumber}` : "PR"}
						</span>{" "}
						↗
					</CardLink>
				)}
				{prStatusBits.length > 0 && (
					<span className="min-w-0 truncate text-meta text-faint">
						{prStatusBits.join(" · ")}
					</span>
				)}
			</CardFooter>
		</>
	);
}

// The touch counterpart of the workspace card: long-pressing a row raises
// a bottom sheet with the same overview block (branch + diff + status, title,
// latest message, thumbnails) followed by thumb-sized action rows — the
// status-colored main action first (answer / merge / review / archive), then
// the workspace chores that live behind right-click on desktop (pin, rename,
// color, archive, delete). Replaces the old long-press → context-menu path.
function WsMobileSheet({
	row,
	pinned,
	onTogglePin,
	onClose,
	onArchive,
	onSetStatus,
	snoozeUntil,
	onSnooze,
	onOpen,
	onRename,
	unread,
	claimed,
	onToggleRead,
	onCopyLink,
	onDelete,
}: {
	row: WsCardRow;
	pinned: boolean;
	onTogglePin: () => void;
	onClose: () => void;
	onArchive: () => void;
	/** Pin the workspace into a lane, or clear back to derived with `null`. */
	onSetStatus: (status: LaneChoice | null) => void;
	/** Active snooze expiry (ISO), or null when not snoozed. */
	snoozeUntil: string | null;
	/** Snooze until the given ISO time, or unsnooze with `null`. */
	onSnooze: (until: string | null) => void;
	onOpen: (chat: UnifiedSession) => void;
	onRename: () => void;
	/** Whether the row has unread activity — picks the read/unread direction. */
	unread: boolean;
	/** In your lanes already (true), claimable (false), or your own row with
	    nothing to claim (null — the action is hidden). */
	claimed: boolean | null;
	/** Flip every chat in the row read or unread; null for chatless rows. */
	onToggleRead: (() => void) | null;
	/** Copy a link to the row's first chat; null for chatless rows. */
	onCopyLink: (() => void) | null;
	onDelete: (() => void) | null;
}) {
	const ov = useWsOverview(row);
	const { prChat, prReady, prStatusBits } = wsPrInfo(row);
	const drag = useSheetDismiss(onClose);
	// Lock the page behind the sheet so a scroll drags the list, not the page.
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);
	const closing = (fn: () => void) => () => {
		fn();
		onClose();
	};
	const archiveGlyph = (
		<svg
			width="20"
			height="20"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.4"
		>
			<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
			<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
			<path d="M6.5 8.5h3" strokeLinecap="round" />
		</svg>
	);
	return createPortal(
		<div className="mobile-action-sheet-backdrop fixed inset-0 z-[4000] bg-black/40" onClick={onClose}>
			<div
				className="mobile-action-sheet fixed inset-x-0 bottom-0 z-[4001] rounded-t-[16px] bg-panel px-2.5 pt-1.5 pb-[calc(14px+env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(0,0,0,0.4)]"
				style={drag.style}
				{...drag.handlers}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mobile-sheet-grip mx-auto my-2 h-1 w-9 rounded-sm bg-line-strong" />
				<div className="px-2 pb-2.5 pt-1">
					<WsOverviewInfo row={row} ov={ov} />
					{(prStatusBits.length > 0 || row.lastActivity) && (
						<div className="mt-2 flex min-w-0 items-center gap-2 text-meta text-faint">
							{prChat?.prNumber != null && (
								<span
									className={`hovercard-mono shrink-0 hovercard-pr-${prTone(prChat)}`}
								>
									#{prChat.prNumber}
								</span>
							)}
							{prStatusBits.length > 0 && (
								<span className="min-w-0 truncate">
									{prStatusBits.join(" · ")}
								</span>
							)}
							{row.lastActivity && (
								<span className="ml-auto shrink-0">
									{relativeTime(row.lastActivity)}
								</span>
							)}
						</div>
					)}
				</div>
				<div className="mobile-sheet-sep mx-2.5 my-1.5 h-px bg-line" />
				{/* Main action, colored by what the workspace needs next. */}
				{row.status === "needsinput" && row.chats.length > 0 && (
					<button
						className={MOBILE_SHEET_ITEM_CLASS}
						style={{ color: "var(--accent)", fontWeight: 600 }}
						onClick={closing(() =>
							onOpen(
								row.chats.find((c) => c.waitingForInput) ||
									row.chats.find((c) => runNeedsAttention(c)) ||
									row.chats[0],
							),
						)}
					>
						<WsStatusMark row={row} size={22} />
						{row.chats.some((c) => c.waitingForInput)
							? "Answer question"
							: "Check failed run"}
					</button>
				)}
				{row.status === "review" && prChat?.prUrl && (
					<button
						className={MOBILE_SHEET_ITEM_CLASS}
						style={
							prReady ? { color: "var(--green)", fontWeight: 600 } : undefined
						}
						onClick={closing(() =>
							window.open(prChat.prUrl, "_blank", "noopener"),
						)}
					>
						<IconPullRequest size={22} />
						{prReady ? `Merge on ${providerFromUrl(prChat.prUrl).name}` : "Review PR"}
						{prChat.prNumber != null && ` #${prChat.prNumber}`}
					</button>
				)}
				{row.status === "merged" && row.chats.length > 0 && (
					<button
						className={MOBILE_SHEET_ITEM_CLASS}
						style={{ color: "var(--purple)", fontWeight: 600 }}
						onClick={closing(onArchive)}
					>
						{archiveGlyph}
						Archive workspace
					</button>
				)}
				{prChat?.prUrl && row.status !== "review" && (
					<button
						className={MOBILE_SHEET_ITEM_CLASS}
						onClick={closing(() =>
							window.open(prChat.prUrl, "_blank", "noopener"),
						)}
					>
						<IconPullRequest size={22} />
						Open PR{prChat.prNumber != null ? ` #${prChat.prNumber}` : ""}
					</button>
				)}
				{claimed !== null && (
					<button
						className={MOBILE_SHEET_ITEM_CLASS}
						onClick={closing(() => onSetStatus(claimed ? null : "mine"))}
					>
						<IconInbox size={22} />
						{claimed
							? "Remove from my workspaces"
							: "Add to my workspaces"}
					</button>
				)}
				{onToggleRead && (
					<button
						className={MOBILE_SHEET_ITEM_CLASS}
						onClick={closing(onToggleRead)}
					>
						<IconMail size={22} />
						{unread ? "Mark as read" : "Mark as unread"}
					</button>
				)}
				<button className={MOBILE_SHEET_ITEM_CLASS} onClick={closing(onTogglePin)}>
					<IconPin size={22} fill={pinned ? "currentColor" : "none"} />
					{pinned ? "Unpin" : "Pin"}
				</button>
				<button className={MOBILE_SHEET_ITEM_CLASS} onClick={closing(onRename)}>
					<svg
						width="20"
						height="20"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					>
						<path d="M10.5 2.5l3 3L6 13l-3.5.5L3 10z" />
					</svg>
					Rename
				</button>
				{onCopyLink && (
					<button className={MOBILE_SHEET_ITEM_CLASS} onClick={closing(onCopyLink)}>
						<IconLink size={22} />
						Copy link
					</button>
				)}
				{/* Pin the workspace into a lane manually — tap a chip to move it there
				    (tap the active one, or Auto, to release it back to the derived lane). */}
				{row.chats.length > 0 &&
					(() => {
						const anyManual = row.chats.some((c) => pinnedLane(c));
						const sharedManual =
							anyManual &&
							row.chats.every(
								(c) => pinnedLane(c) === pinnedLane(row.chats[0]),
							)
								? (pinnedLane(row.chats[0]) ?? null)
								: null;
						return (
							<div className="px-4 py-2">
								<div className="mb-1.5 text-[11px] font-semibold text-faint">
									Move to lane
								</div>
								<div className="flex flex-wrap gap-1.5">
									{MINE_STATUS_META.map((m) => {
										const on = sharedManual === m.key;
										return (
											<Button
										variant="ghost"
										size="xs"
												key={m.key}
												type="button"
												className="gap-1.5 whitespace-normal px-2 text-control-label"
												style={{
													borderColor: on ? m.dotColor : "var(--border)",
													color: on ? "var(--text)" : "var(--text-dim)",
													background: on
														? "color-mix(in srgb, var(--bg-panel), transparent)"
														: "transparent",
												}}
												onClick={closing(() =>
													onSetStatus(on ? null : m.key),
												)}
											>
												<span
													style={{
														width: 8,
														height: 8,
														borderRadius: "50%",
														background: m.dotColor,
														flexShrink: 0,
													}}
												/>
												{m.label}
											</Button>
										);
									})}
									<Button
										variant="ghost"
										size="xs"
										type="button"
										className="whitespace-normal px-2 text-control-label"
										style={{
											borderColor: !anyManual
												? "var(--text-dim)"
												: "var(--border)",
											color: !anyManual ? "var(--text)" : "var(--text-dim)",
										}}
										onClick={closing(() => onSetStatus(null))}
									>
										Auto
									</Button>
								</div>
							</div>
						);
					})()}
				{/* Snooze chips — the mobile stand-in for the right-click Snooze
				    flyout. Tapping a preset parks the row in the Snoozed section
				    until the resolved time. */}
				{row.chats.length > 0 && (
					<div className="px-4 py-2">
						<div className="mb-1.5 text-[11px] font-semibold text-faint">
							{snoozeUntil
								? `Snoozed — wakes in ${formatRemaining(snoozeUntil)}`
								: "Snooze"}
						</div>
						<div className="flex flex-wrap gap-1.5">
							{snoozePresets().map((p) => (
								<Button
										variant="ghost"
										size="xs"
									key={p.label}
									type="button"
									className="whitespace-normal px-2 text-control-label"
									style={{
										borderColor: "var(--border)",
										color: "var(--text-dim)",
									}}
									onClick={() => {
										onSnooze(p.until.toISOString());
										onClose();
									}}
								>
									{p.label}
								</Button>
							))}
							{snoozeUntil && (
								<Button
										variant="ghost"
										size="xs"
									type="button"
									className="whitespace-normal px-2 text-control-label"
									style={{
										borderColor: "var(--text-dim)",
										color: "var(--text)",
									}}
									onClick={() => {
										onSnooze(null);
										onClose();
									}}
								>
									Unsnooze
								</Button>
							)}
						</div>
					</div>
				)}
				{((row.status !== "merged" && row.chats.length > 0) || onDelete) && (
					<div className="mobile-sheet-sep" />
				)}
				{/* Archiving stays reachable pre-merge from the explicit menu — the
				    status coloring only governs which action gets top billing. */}
				{row.status !== "merged" && row.chats.length > 0 && (
					<button
						className="mobile-sheet-item mobile-sheet-item--danger"
						onClick={closing(onArchive)}
					>
						{archiveGlyph}
						Archive
					</button>
				)}
				{onDelete && (
					<button
						className="mobile-sheet-item mobile-sheet-item--danger"
						onClick={closing(onDelete)}
					>
						<svg
							width="20"
							height="20"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
						>
							<path d="M3 4.5h10M6.5 4.5V3.25a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1V4.5M4.25 4.5l.6 8.25a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93l.6-8.25" />
						</svg>
						Delete workspace
					</button>
				)}
			</div>
		</div>,
		document.body,
	);
}
