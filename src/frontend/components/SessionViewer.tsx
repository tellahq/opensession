import { BASE_PATH } from "../lib/base";
import React, {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { Reorder } from "motion/react";
import { suppressLayoutAnimations } from "../ui/motion";
import { renderMarkdown } from "../lib/markdown";
import { LiveTurnStore } from "../lib/live-turn-store";
import { isTimelineOnlyRunnerNotice } from "../lib/runner-events";
import { noticeTone } from "../lib/notice-tone";
import { TranscriptViewStore } from "../lib/transcript-view-store";
import {
	measureChatPerf,
	recordChatPerf,
} from "../lib/chat-performance";
import { AGENT_NAME, DEFAULT_DOC_TITLE, PLAIN_WORKSPACE_ID } from "../lib/brand";
import {
	isGitHubAttribution,
	parseHumanReply,
	parseSessionNotice,
	parseWorkerReport,
	parseWorkflowNotice,
} from "../lib/humanReply";
import type {
	UnifiedSession,
	TranscriptEntry,
	WSServerMessage,
	AskQuestion,
	ChatMessage,
} from "../lib/types";
import {
	mergeTranscriptEntries,
	orderTranscriptEntries,
} from "../lib/transcript-state";
import { TranscriptBlocks } from "./TranscriptBlocks";
import {
	LiveSubagentsProvider,
	ToolPathRootsProvider,
	type LiveSubagent,
} from "./ToolCallBlock";
import { MarkdownBody } from "./MarkdownBody";
import { SubagentPane, type SubagentRef } from "./SubagentPane";
import { ShellPanel } from "./TerminalPanel";
import { getCurrentUser, useCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { peopleMentionMatches } from "../lib/people";
import {
	deleteSessionApi,
	archiveSessionApi,
	fetchModels,
	fetchProviderAccounts,
	fetchFileMentions,
	fetchSkillMentions,
	fetchSessionSubagents,
	fetchRepos,
	promoteChatApi,
	fetchPr,
	fetchPreview,
	fetchChatMessagesApi,
	postChatMessageApi,
	type WorkspaceMediaItem,
	type ModelOption,
	type ProviderAccountOption,
	type SessionSubagentSnapshot,
	type PreviewStatus,
} from "../lib/api";
import {
	pollWhileVisible,
	PR_WEBHOOK_FALLBACK_POLL_MS,
} from "../lib/poll";
import { sessionPrPresentation } from "../lib/session-prs";
import { useBackSwipe } from "../hooks/useBackSwipe";
import { personKey, prReviewCompletion } from "../lib/review-queue";
import { Composer } from "./Composer";
import { ComposerAgents } from "./ComposerAgents";
import { UsageMeter } from "./UsageMeter";
import { SchedulePromptButton } from "./SchedulePrompt";
import type { FileAttachment } from "../lib/images";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { unhideForChat } from "../lib/hides";
import { withPreviewPath } from "../lib/preview-url";
import { DiffPanel, useSessionDiff } from "./DiffPanel";
import { RepoBar } from "./RepoBar";
import { RepoTile } from "./RepoTile";
import { SandboxBadge } from "./SandboxBadge";
import { ModelMenuRow } from "./ModelMenuRow";
import {
	EFFORTS,
	friendlyModelSlug,
	opencodeModelParts,
} from "./ModelEffortSelect";
import { AskCard } from "./AskCard";
import { PrPanel } from "./PrPanel";
import { PrStatusBar } from "./PrStatusBar";

import { ConversationPane } from "./ConversationPane";
import { FeedWebPane, type RefWebPanel } from "./FeedWebPane";
import { SlackChannelPane } from "./SlackChannelPane";
import { feedForRefKind } from "../lib/feeds-meta";
import { WorkflowPanel } from "./WorkflowPanel";
import { AssetsPanel, useSessionAssets } from "./AssetsPanel";
import {
	SessionReportsPanel,
	useSessionReports,
} from "./SessionReportsPanel";
import type { NewSessionPrefill } from "../lib/new-session-link";
import type { WorkflowRunSnapshot } from "../../server/workflow-types";
import { PreviewButton } from "./PreviewButton";
import { PreviewPane } from "./PreviewPane";
import { StagingLink } from "./StagingLink";
import { WorkspaceInfo } from "./WorkspaceInfo";
import { SpinOffMenu } from "./SpinOffMenu";
import {
	IconSidebarRight,
	IconTrash,
	IconArchive,
	IconCheck,
	IconChevronDown,
	IconPlus,
	IconPencil,
	IconArrowDown,
	IconArrowUp,
	IconArrowUpToLine,
	IconCrosshair,
	IconDotsHorizontal,
	IconEye,
	IconInbox,
	IconPin,
	IconPullRequest,
	IconLink,
	IconSparkle,
	IconTerminal,
	IconCopy,
	IconFile,
	IconGlobe,
	IconArrowUpRight,
} from "./icons";
import { SessionRelations, type RelatedSession } from "./SessionRelations";
import { PixelSpinner } from "./PixelSpinner";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { CopyCheck, useCopy } from "../ui/copy";
import { toast } from "../ui/toast";
import { copySessionTranscript } from "../lib/transcript-copy";
import { MoveToCloudDialog } from "./MoveToCloudDialog";
import { isPinned, togglePin, onPinsChanged } from "../lib/pins";
import { getLane, onLanesChanged, type Lane } from "../lib/lanes";
import { useChatScroll } from "../hooks/useChatScroll";
import { sessionHasWorkspace } from "../lib/session-workspace";
import {
	getSessionPanelTab,
	saveSessionPanelTab,
} from "../lib/session-panel-tab";

type QueueReceipt = {
	id?: string;
	content: string;
	user?: string;
	images?: string[];
	files?: unknown;
};

interface Props {
	session: UnifiedSession;
	/** Only the focused pane in a desktop tab split owns global shortcuts/title. */
	focused?: boolean;
	/** The unfocused half of a split keeps its conversation chrome-free. */
	hideHeader?: boolean;
	hideRightPanel?: boolean;
	/** True only when auth/status identifies this SPA as the local profile. */
	localMode: boolean;
	onBack: () => void;
	/** Archive through the sidebar so the nearest visible row becomes active. */
	onArchive?: () => void;
	/** Called after a successful archive (not unarchive), with whether archiving
	    gracefully stopped an in-flight owned turn — so the parent can toast. */
	onArchived?: (stoppedRun: boolean) => void;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
	connected: boolean;
	/** Opening prompt shown while a just-created session is still catching up
	    through the session poll. Reconciles away when the transcript arrives. */
	initialPending?: {
		content: string;
		user: string;
		sentAt: number;
		images?: string[];
	};
	/** App-level top-bar node above the tab strip; when present the header renders
	    there (name-on-top layout) instead of inline. */
	topbarEl?: HTMLElement | null;
	/** Right-side slot inside the mobile top bar (next to the centered title).
	    On phones the header actions portal there — a single iOS-style nav bar —
	    instead of rendering as their own row. Desktop ignores it. */
	headerActionsEl?: HTMLElement | null;
	/** Centered slot under the mobile top-bar title. On phones the composer's
	    model pill is hidden, so a compact tap-to-switch model selector portals
	    here instead. Desktop ignores it. */
	headerModelEl?: HTMLElement | null;
	/** Leading slot inside the mobile top-bar title pill. The repo tile portals
	    here so it sits in front of the title (Slack-header style), rather than
	    inline in the metadata line below. Desktop ignores it. */
	headerRepoEl?: HTMLElement | null;
	/** App-level right-column node (sibling of the left sidebar); when present the
	    workspace/sub-agent panel portals here so it spans the full height from the
	    top, instead of opening only below the chat. */
	rightPanelEl?: HTMLElement | null;
	/** Bumped by the tab-bar + to start a fresh chat in this same session: clears
	    the composer and jumps to the live edge. A visual reset — same thread. */
	newChatSeq?: number;
	/** One-shot pulse set when this session was opened by picking its workspace
	    in the sidebar — focus the composer on open so you can type right away.
	    Ignored on phones (would pop the keyboard over the chat). */
	autoFocusComposer?: boolean;
	/** One-shot draft text appended from another surface, such as Checks. */
	composerPrefillExternal?: { seq: number; text: string } | null;
	onComposerPrefillConsumed?: (seq: number) => void;
	/** Rename this session (double-click the header title); empty resets it to
	    the derived title. Same handler the tab strip and sidebar use. */
	onRename?: (id: string, title: string) => void;
	/**
	 * The workspace this chat belongs to. When set, the header titles the
	 * WORKSPACE (every sibling chat shows the same name — per-chat titles live
	 * on the tabs) and double-click renames the workspace, not the chat.
	 */
	workspaceName?: string;
	onRenameWorkspace?: (name: string) => void;
	/** Sibling chats in this chat's workspace (the tab strip's list, oldest
	    first) — feeds the floating overview panel's cross-chat media. */
	workspaceChats?: UnifiedSession[];
	/** Claim this workspace into your own per-user sidebar lanes ("mine"), or
	    release it (null) — the ⋯ menu's twin of the sidebar row's action. */
	onSetStatus?: (chats: UnifiedSession[], status: Lane | null) => void;
	/** Every session — powers the Chat tab's @-session tagging. */
	allSessions?: UnifiedSession[];
	/** Workspace names — lets the Chat tab's @-search match workspaces too. */
	allProjects?: Array<{ id: string; name: string }>;
	/** Start a new chat in this workspace — surfaced in the ⋯ menu so it's
	    reachable on a phone, where the tab strip's + button is hidden. */
	onNewChat?: (mode: "share" | "stack" | "ask") => void;
	/** True when the tab strip is on screen (2+ chats, an open view tab, or a
	    split). The strip carries its own "+", so the header one stands down
	    rather than showing a second plus a few pixels above it. */
	tabStripVisible?: boolean;
	/** Orchestrator this session was delegated from (when it's a worker
	    sub-session), and the worker sessions it in turn spawned. Powers the
	    header relationship chips. */
	parentSession?: RelatedSession | null;
	workerSessions?: RelatedSession[];
	/** Navigate to another session (used by the relationship chips). `created` is
	    the server's copy of a chat the panel just made (Auto-fix), so the app can
	    open it without a loading placeholder. */
	onOpenSession?: (id: string, created?: UnifiedSession | null) => void;
	onOpenNewSession: (prefill: NewSessionPrefill) => void;
	/** Mirror live run state into the app-level session list for sidebar rows. */
	onRunningChange?: (id: string, isRunning: boolean) => void;
	/** Mirror a reviewer pick / sign-off into the app-level session list so the
	    sidebar's review bands flip immediately instead of waiting for a poll. */
	onReviewChange?: (
		id: string,
		req: { to: string; by: string; at: string; accepted?: { by: string; at: string } } | null,
	) => void;
	/**
	 * Whether the Review pane is foregrounded — driven by the top tab strip's
	 * Review view-tab (App state), replacing the old inline Chat|Review toggle.
	 * When false, the chat transcript shows.
	 */
	showReview?: boolean;
	/** Open/foreground this session's Review view-tab (PR/review triggers). */
	onOpenReview?: () => void;
	/**
	 * Whether the Preview environment pane (the PR's Vercel preview, full-width) is
	 * foregrounded — driven by the top tab strip's Preview environment view-tab (App state).
	 */
	showStaging?: boolean;
	/** Open/foreground this session's Preview environment view-tab. */
	onOpenStaging?: () => void;
	/** Close this session's Preview environment view-tab (the deploy vanished, e.g. PR merged). */
	onCloseStaging?: () => void;
	/**
	 * Whether the Assets pane (the session's scratch artifacts, full-width) is
	 * foregrounded — driven by the top tab strip's Assets view-tab (App state).
	 */
	showAssets?: boolean;
	/** Open/foreground this session's Assets view-tab (the Info panel's Assets button). */
	onOpenAssets?: () => void;
	/** Close this session's Assets view-tab (its last asset was deleted). */
	onCloseAssets?: () => void;
	/**
	 * Whether the Conversation pane (the workspace's Plain support-ticket
	 * thread, full-width) is foregrounded — driven by the top tab strip's
	 * Conversation view-tab (App state).
	 */
	showConversation?: boolean;
	/** The Plain thread the Conversation pane renders (workspace or session). */
	conversationThreadId?: string | null;
	/** Whether the feed web panel (Video view-tab) is foregrounded (App state). */
	showVideo?: boolean;
	/** The web panel spec of the workspace's feed-item ref (the feeds design). */
	videoPanel?: RefWebPanel | null;
	/** The feed item's title (pane header). */
	videoTitle?: string | null;
	/** Foregrounded full-width local-dev Preview view-tab (App state). */
	showPreviewTab?: boolean;
	/** Open/foreground the Preview view-tab (header Preview button). */
	onOpenPreviewTab?: () => void;
	/** Open another PR in the review panel (stack map layer links). */
	onOpenPr?: (repo: string, branch: string) => void;
	/** Close the Preview view-tab (its Stop button / tab close). */
	onClosePreviewTab?: () => void;
	/** Return from a view-tab (Review/Preview environment/Assets) to this workspace's active chat. */
	onOpenWorkspace?: () => void;
	/**
	 * Whether the sub-agent pane (a Task drill-in from this chat's transcript,
	 * full-width) is foregrounded — driven by the top tab strip's sub-agent
	 * view-tab (App state).
	 */
	showSubagent?: boolean;
	/** Breadcrumb of opened sub-agents; the last entry is the one shown. */
	subagentStack?: SubagentRef[];
	/** Open/foreground a sub-agent (a Task call's "Watch" affordance). */
	onOpenSubagent?: (sessionId: string, agentId: string, label: string) => void;
	/** Pop back to the sub-agent that spawned the current one. */
	onSubagentBack?: (sessionId: string) => void;
}

// Stable identity for "no sub-agent open", so the default prop doesn't hand
// the memoized transcript a fresh array on every render.
const NO_SUBAGENTS: SubagentRef[] = [];

type PanelTab =
	| "info"
	| "changes"
	| "shell"
	| "pr"
	| "workflows"
	| "assets"
	| "reports";

const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const isChromium = /Chrome|Chromium|CriOS|Edg|OPR/.test(navigator.userAgent);
const archiveShortcutLabel = isChromium
	? isApple
		? "⌘⇧A"
		: "Ctrl+Shift+A"
	: isApple
		? "⌘E"
		: "Ctrl+E";

// Hidden for at least this long, returning to the tab is a "reopen" — jump to
// the live edge even if nothing new arrived. Shorter absences (glancing at a
// notification) keep the reader's place unless the transcript grew meanwhile.
const HIDDEN_REOPEN_MS = 30_000;
// After becoming visible again, keep watching this long for growth that lands
// late: on the iOS PWA the WebSocket only reconnects after visibility, so what
// streamed while backgrounded arrives moments after the visibilitychange.
const RESUME_GROWTH_WINDOW_MS = 8_000;
// "Jump to the start of the session" walks the backlog a page at a time rather
// than asking for it in one frame: a multi-thousand-entry transcript would be a
// tens-of-MB payload and one giant reconciliation. Fat pages keep the number of
// round trips (and whole-transcript re-renders) in single digits; the ceiling
// stops a runaway walk on a session nobody should be rendering whole — when it
// trips, the pill stays put so the reader can keep going deliberately.
const JUMP_PAGE_ENTRIES = 400;
const JUMP_MAX_ENTRIES = 4_000;

/** Deep link into the Plain app (the "jump into Plain" link), or "" when the
 *  instance has no configured Plain workspace id — the link hides. */
function plainThreadUrl(threadId: string): string {
	return PLAIN_WORKSPACE_ID
		? `https://app.plain.com/workspace/${PLAIN_WORKSPACE_ID}/thread/${threadId}/`
		: "";
}

function modelIsCodex(id: string, models: ModelOption[]): boolean {
	const found = models.find((m) => m.id === id);
	if (found) return found.provider === "codex";
	return id.startsWith("gpt") || id.startsWith("codex");
}

// Friendly "<name> · <engine>" for the model-switch divider, so a cross-provider
// switch reads unmistakably as e.g. "Sonnet · Claude → GPT-5.5 · Codex". Pure
// (no models list needed) so it works in the transcript_init weave before the
// models endpoint has loaded.
const MODEL_NAMES: Record<string, string> = {
	"claude-fable-5": "Fable",
	"claude-opus-5": "Opus 5",
	"claude-opus-4-8": "Opus 4.8",
	"claude-sonnet-5": "Sonnet",
	"claude-haiku-4-5-20251001": "Haiku",
	"gpt-5.5": "GPT-5.5",
	"gpt-5": "GPT-5",
	codex: "Codex",
};
function prettyModel(id: string): string {
	// Opencode ids get their friendly name with no engine suffix — the engine
	// is an implementation detail ("Sonnet 5", not "… · OpenCode").
	const oc = opencodeModelParts(id);
	if (oc) return friendlyModelSlug(oc.model);
	const isCodex = id.startsWith("gpt") || id.startsWith("codex");
	const name = MODEL_NAMES[id] || id;
	return `${name} · ${isCodex ? "Codex" : "Claude"}`;
}
/** Model label for the header/info metadata lines: the registry label, but
 * opencode ids always take the pure friendly-name path (the server's labels
 * for them only refresh on restart). */
function metadataModelLabel(effectiveModel: string, models: ModelOption[]): string {
	if (opencodeModelParts(effectiveModel)) return prettyModel(effectiveModel);
	return models.find((m) => m.id === effectiveModel)?.label || prettyModel(effectiveModel);
}
function switchDividerText(model: string, from?: string, by?: string): string {
	const head = from
		? `Switched ${prettyModel(from)} → ${prettyModel(model)}`
		: `Switched to ${prettyModel(model)}`;
	return by ? `${head} · ${by}` : head;
}

type CachedTranscriptView = {
	entries: TranscriptEntry[];
	cursor: { sessionId: string; rev: string; offset: number } | null;
	/** Transcript v2 seq-mode state (null = legacy mode), so a session
	 *  switch-back resumes with sinceSeq instead of re-snapshotting. */
	seq: {
		sessionId: string;
		lastSeq: number;
		firstSeq: number | null;
		lastChangeSeq: number;
	} | null;
	historyTruncated: boolean;
	historyStart: number | null;
	scrollTop: number;
	following: boolean;
	anchorEid: string | null;
	anchorTop: number | null;
};

// SessionViewer remounts on navigation. Keep a small LRU of the expensive
// transcript view state so moving between nearby sessions is instant without
// retaining an unbounded workday's worth of conversations in the browser.
const transcriptViewCache = new Map<string, CachedTranscriptView>();
const TRANSCRIPT_VIEW_CACHE_MAX = 6;

function cachedTranscriptView(sessionId: string): CachedTranscriptView | null {
	const hit = transcriptViewCache.get(sessionId);
	if (!hit) return null;
	transcriptViewCache.delete(sessionId);
	transcriptViewCache.set(sessionId, hit);
	return hit;
}

function peekCachedTranscriptView(sessionId: string): CachedTranscriptView | null {
	return transcriptViewCache.get(sessionId) ?? null;
}

function cacheTranscriptView(sessionId: string, view: CachedTranscriptView) {
	transcriptViewCache.delete(sessionId);
	transcriptViewCache.set(sessionId, view);
	while (transcriptViewCache.size > TRANSCRIPT_VIEW_CACHE_MAX) {
		const oldest = transcriptViewCache.keys().next().value;
		if (oldest === undefined) break;
		transcriptViewCache.delete(oldest);
	}
}

function withModelSwitches(
	entries: TranscriptEntry[],
	history: UnifiedSession["modelHistory"],
): TranscriptEntry[] {
	const switches: TranscriptEntry[] = (history || []).map((h) => ({
		id: `model-switch-${h.at}`,
		type: "system" as const,
		content: switchDividerText(h.model, h.from, h.by),
		timestamp: h.at,
	}));
	if (switches.length === 0) return entries;
	const persistedContent = new Set(switches.map((entry) => entry.content));
	const base = entries.filter(
		(entry) =>
			!entry.id.startsWith("model-switch-live-") ||
			!persistedContent.has(entry.content),
	);
	const current = new Map(base.map((entry) => [entry.id, entry] as const));
	if (
		base.length === entries.length &&
		switches.every((entry) => {
			const existing = current.get(entry.id);
			return (
				existing?.content === entry.content &&
				existing.timestamp === entry.timestamp
			);
		})
	)
		return entries;
	return orderTranscriptEntries(mergeTranscriptEntries(base, switches));
}

// The element whose position the history hold keeps stable: the first
// entry-level node ([data-eid]: bubbles, tool rows, turn notes — turn-block
// roots too) at or straddling the transcript viewport's top edge, preferring
// the deepest qualifying descendant. Depth matters: anchoring a turn-block
// ROOT is useless against a history page merging into that turn — the merged
// rows land inside it above the reader while the root's own top never moves.
// Anchoring the visible row inside it compensates exactly. (A collapsed turn
// has no row nodes, so its root is the anchor — correct, since merged rows
// stay hidden inside the fold.)
function pickScrollAnchor(el: HTMLElement): HTMLElement | null {
	const cTop = el.getBoundingClientRect().top;
	const all = el.querySelectorAll<HTMLElement>("[data-eid]");
	let anchor: HTMLElement | null = null;
	for (const n of Array.from(all)) {
		const r = n.getBoundingClientRect();
		if (r.height <= 0 || r.bottom <= cTop + 1) continue;
		if (!anchor) {
			anchor = n;
			continue;
		}
		// Doc order puts a block's interior rows right after the block root:
		// keep descending while the qualifying node is inside the current pick;
		// the first non-descendant qualifying node ends the search.
		if (anchor.contains(n)) anchor = n;
		else break;
	}
	return anchor;
}

/** Did the run that died already say so in the transcript?
 *
 * Every terminal failure is persisted as a red system chip at the point it
 * happens (run-session.ts / opencode-runner.ts), so the header banner would
 * just repeat, out of place and in different words, what the last line of the
 * conversation already says. It earns its place only when nothing inline
 * recorded the failure — a run that died before its engine session existed
 * (sandbox launch, first-turn auth) writes no transcript line at all.
 *
 * Scans the tail: the failure is always the last thing a dead run wrote. */
function runErrorIsInTranscript(entries: TranscriptEntry[]): boolean {
	for (let i = entries.length - 1; i >= 0 && i >= entries.length - 12; i--) {
		const e = entries[i];
		if (e.type === "system" && noticeTone(e.content) === "error") return true;
	}
	return false;
}

export function SessionViewer({
	session,
	focused = true,
	hideHeader = false,
	hideRightPanel = false,
	localMode,
	onBack,
	onArchive,
	onArchived,
	send,
	addHandler,
	connected,
	initialPending,
	topbarEl,
	headerRepoEl,
	headerActionsEl,
	headerModelEl,
	rightPanelEl,
	newChatSeq,
	autoFocusComposer,
	composerPrefillExternal,
	onComposerPrefillConsumed,
	onRename,
	workspaceName,
	onRenameWorkspace,
	workspaceChats,
	onSetStatus,
	allSessions,
	allProjects,
	onNewChat,
	tabStripVisible,
	parentSession,
	workerSessions,
	onOpenSession,
	onOpenNewSession,
	onRunningChange,
	onReviewChange,
	showReview = false,
	onOpenReview,
	showStaging = false,
	onOpenStaging,
	onCloseStaging,
	showAssets = false,
	showConversation = false,
	conversationThreadId = null,
	showVideo = false,
	videoPanel = null,
	videoTitle = null,
	showPreviewTab = false,
	onOpenPreviewTab,
	onOpenPr,
	onClosePreviewTab,
	onOpenAssets,
	onCloseAssets,
	onOpenWorkspace,
	showSubagent = false,
	subagentStack = NO_SUBAGENTS,
	onOpenSubagent,
	onSubagentBack,
}: Props) {
	const [localRepos, setLocalRepos] = useState<
		Awaited<ReturnType<typeof fetchRepos>> | null | undefined
	>(() => (localMode && session.local ? undefined : null));
	useEffect(() => {
		if (!localMode || !session.local) return;
		let live = true;
		setLocalRepos(undefined);
		fetchRepos()
			.then((repos) => {
				if (live) setLocalRepos(repos);
			})
			.catch(() => {
				if (live) setLocalRepos(null);
			});
		return () => {
			live = false;
		};
	}, [localMode, session.local]);
	const localRepoCapabilityLoading =
		localMode && session.local && localRepos === undefined;
	const reviewRepos = [
		{ repo: session.repo || "repository", primary: true },
		...(session.attachedRepos || []).map((repo) => ({
			repo: repo.repo,
			primary: false,
		})),
	];
	const prPresentation = useMemo(
		() => sessionPrPresentation(session.prs),
		[session.prs],
	);
	const promotedPr =
		prPresentation.primary?.source !== "primary"
			? prPresentation.primary
			: undefined;
	// PRs the server matched to this session through their body's attribution
	// footer — opened on a branch the session doesn't own, so they'd otherwise
	// have no Review tab of their own.
	const discoveredPrs = useMemo(
		() =>
			(session.prs || [])
				.filter((ref) => ref.source === "discovered")
				.map((ref) => ({
					repo: ref.repo,
					branch: ref.branch,
					number: ref.number,
					url: ref.url,
					title: ref.title,
				})),
		[session.prs],
	);
	// Which PR the Review tab should open on, set by the PR chips in the
	// Workspace strip (seq lets the same chip re-focus after a manual switch).
	const [reviewFocus, setReviewFocus] = useState<
		{ repo?: string; branch?: string; view?: "checks"; seq: number } | undefined
	>(undefined);
	const focusPrInReview = useCallback(
		(ref?: { repo: string; branch: string }, view?: "checks") => {
			if (ref || view)
				setReviewFocus((prev) => ({ ...ref, view, seq: (prev?.seq ?? 0) + 1 }));
			onOpenReview?.();
		},
		[onOpenReview],
	);
	// Worktree roots for the transcript's tool rows: paths inside them render
	// repo-relative instead of as a long absolute path (see tidyPath).
	const toolPathRoots = useMemo(
		() =>
			[
				{ dir: session.worktreeDir || "" },
				...(session.attachedRepos || []).map((repo) => ({
					dir: repo.dir,
					label: repo.repo,
				})),
			].filter((root) => Boolean(root.dir)),
		[session.worktreeDir, session.attachedRepos],
	);
	const githubReviewRepos =
		localMode && session.local && Array.isArray(localRepos)
			? reviewRepos.filter(
					(target) => localRepos.find((repo) => repo.id === target.repo)?.ghRepo,
				)
			: reviewRepos;
	const panelReviewRepos = promotedPr ? [] : githubReviewRepos;
	const localRepoHasNoGitHubRemote =
		localMode &&
		session.local &&
		Array.isArray(localRepos) &&
		githubReviewRepos.length === 0 &&
		!session.linkedPrs?.length;
	const shellTimingRef = useRef({
		sessionId: session.id,
		startedAt: performance.now(),
		recorded: false,
	});
	if (shellTimingRef.current.sessionId !== session.id) {
		shellTimingRef.current = {
			sessionId: session.id,
			startedAt: performance.now(),
			recorded: false,
		};
	}
	// A full-width view-tab (Review, Staging, Assets, a sub-agent) takes over the
	// chat column, so the chat DOM isn't mounted while any is up — the scroll /
	// history / scroll-restore effects below must bail in all cases.
	const subagentOpen = showSubagent && subagentStack.length > 0;
	const chatHidden =
		showReview ||
		showStaging ||
		showAssets ||
		showPreviewTab ||
		subagentOpen ||
		(showConversation && !!conversationThreadId) ||
		(showVideo && !!videoPanel);
	const [cachedTranscript] = useState(() => peekCachedTranscriptView(session.id));
	const transcriptViewStore = useMemo(
		() =>
			new TranscriptViewStore(
				withModelSwitches(
					peekCachedTranscriptView(session.id)?.entries ?? [],
					session.modelHistory,
				),
			),
		[session.id],
	);
	const entries = useSyncExternalStore(
		transcriptViewStore.subscribe,
		transcriptViewStore.getSnapshot,
		transcriptViewStore.getServerSnapshot,
	);
	const setEntries = useCallback(
		(
			update:
				| TranscriptEntry[]
				| ((previous: TranscriptEntry[]) => TranscriptEntry[]),
		) => transcriptViewStore.update(update),
		[transcriptViewStore],
	);
	const liveTurnStore = useMemo(() => new LiveTurnStore(), [session.id]);
	const transcriptCommitCount = useRef(0);
	const onTranscriptRender = useCallback(
		(
			_: string,
			phase: "mount" | "update" | "nested-update",
			actualDuration: number,
		) => {
			recordChatPerf("react_transcript_commit_ms", actualDuration, {
				phase,
				entries: transcriptViewStore.getSnapshot().length,
			});
			transcriptCommitCount.current++;
			if (phase === "mount" || transcriptCommitCount.current % 20 === 0) {
				recordChatPerf(
					"transcript_dom_nodes",
					document.querySelectorAll(".viewer-messages [data-eid]").length,
				);
			}
		},
		[transcriptViewStore],
	);
	// Initial scrolling must wait for this session's transcript_init. During a
	// session switch, entries from the previous session remain rendered until the
	// WebSocket response arrives and must not consume the new session's scroll.
	const transcriptReadySessionRef = useRef<string | null>(
		cachedTranscript ? session.id : null,
	);
	// Reconnect resume cursor: endOffset/rev of the last transcript frame the
	// server sent (transcript_init/append). On a re-watch of the SAME session
	// with entries still mounted, it rides the watch message as
	// sinceOffset/sinceRev so the server replays only the gap from the mirror
	// jsonl instead of replacing the whole tail.
	const transcriptCursorRef = useRef<{
		sessionId: string;
		rev: string;
		offset: number;
	} | null>(cachedTranscript?.cursor ?? null);
	// Transcript v2 seq mode (docs/transcripts.md): when init/append
	// frames carry seq fields the server is serving from the owned store —
	// resume watches with sinceSeq, page older history with beforeSeq, and
	// ignore offset/rev cursors while in this mode. null = legacy mode (old
	// server or ineligible session): behavior byte-identical to pre-v2.
	// lastSeq tracks the newest seq seen (max — upsert republishes reuse old
	// seqs); firstSeq the earliest loaded (the "load earlier" cursor).
	const transcriptSeqRef = useRef<{
		sessionId: string;
		lastSeq: number;
		firstSeq: number | null;
		lastChangeSeq: number;
	} | null>(cachedTranscript?.seq ?? null);
	// Existing engine-backed sessions can load from the owned transcript store even
	// when no mirror file exists. Fresh chats have none of these identifiers, so
	// they still render the empty canvas without flashing a loader.
	const [loading, setLoading] = useState(
		!cachedTranscript &&
			!!(
				session.transcriptPath ||
				session.claudeSessionId ||
				session.codexThreadId
			),
	);
	// The initial transcript is the tail only when the file is large; these drive
	// the "load earlier history" affordance at the top of the conversation.
	const [historyTruncated, setHistoryTruncated] = useState(
		cachedTranscript?.historyTruncated ?? false,
	);
	const [loadingHistory, setLoadingHistory] = useState(false);
	// "Jump to the start" — the second segment of the load-earlier control, for
	// readers who'd otherwise click their way back through a hundred pages. The
	// walk is driven from the transcript_history handler (each page schedules
	// the next), so its state lives in a ref; `loaded` enforces the ceiling and
	// `cursor` catches a backlog that stops receding (a transcript whose
	// earliest surviving entry isn't seq 1 reports "truncated" forever).
	const jumpRef = useRef<{
		sessionId: string;
		loaded: number;
		cursor: number | null;
	} | null>(null);
	const [jumpingToStart, setJumpingToStart] = useState(false);
	// Set when the walk lands: the final page's entries render with the commit
	// that follows, so the scroll itself happens in a layout effect below.
	const scrollToTopRef = useRef(false);
	// Byte offset the loaded history begins at — the "load earlier" pagination
	// cursor (server: parseTranscriptTail/parseTranscriptWindow startOffset).
	// null = unknown (old server) → load_history falls back to the full resend.
	const historyStartRef = useRef<number | null>(
		cachedTranscript?.historyStart ?? null,
	);
	// Scroll anchor for "Load earlier history":
	// older entries prepend above the viewport, so keep the reader on the same
	// content. See startHistoryHold below — a DOM-element anchor plus a short
	// rAF hold, because a one-shot scrollTop restore breaks in three ways:
	// bottom growth (streaming) skews scrollHeight math, prepended bubbles
	// enter at their content-visibility estimate (80px) and re-size as they
	// render, and Safari has no native scroll anchoring to compensate.
	const historyHoldRef = useRef<{
		node: HTMLElement;
		top: number;
		eid: string | null;
		eidTop: number | null;
		until: number;
		raf: number;
		fallback: { height: number; top: number } | null;
	} | null>(null);
	// The composer draft lives INSIDE Composer (uncontrolled mode) so keystrokes
	// don't re-render this whole component; the text arrives via handleSend.
	// Same fix as the CommentableDiff draft-text gotcha.
	// Text + attachments persist in the draft store (keyed per chat) so
	// switching to another chat/workspace — which remounts this component —
	// doesn't lose typed work. Text rides Composer's `draftKey`; the staged
	// images/files live here, seeded from and mirrored into the same draft.
	const draftKey = `chat:${session.id}`;
	const [images, setImages] = useState<string[]>(() => loadDraft(draftKey).images);
	const [files, setFiles] = useState<FileAttachment[]>(() => loadDraft(draftKey).files);
	useEffect(() => {
		saveDraft(draftKey, { images, files });
	}, [draftKey, images, files]);
	// When set, the next send forks a new session branching from this message
	// instead of continuing this one.
	const [forkFrom, setForkFrom] = useState<string | null>(null);
	const [isStreaming, setIsStreaming] = useState(false);
	const [isRunningLive, setIsRunningLive] = useState(session.isRunning);
	// Bumped on git pushes and matching GitHub webhook events so every mounted PR
	// surface revalidates immediately.
	const [gitRefreshTick, setGitRefreshTick] = useState(0);
	const sessionPrTargetsRef = useRef<Set<string>>(new Set());
	sessionPrTargetsRef.current = new Set([
		`${session.repo || "repository"}\0${session.branch}`,
		...(session.attachedRepos || []).map((r) => `${r.repo}\0${r.branch}`),
		...(session.prs || []).map((r) => `${r.repo}\0${r.branch}`),
	]);
	const [viewers, setViewers] = useState<string[]>([]);
	// The create run is still preparing this session's worktree (new workspaces
	// announce the session before the slow git work). While true the transcript
	// and workspace panels show "Waiting for workspace" and sends hold in the
	// queue flap. Flipped off by the workspace_status event, kept in sync with
	// the sessions poll otherwise.
	const [workspacePreparing, setWorkspacePreparing] = useState(
		!!session.workspacePreparing,
	);
	useEffect(() => {
		setWorkspacePreparing(!!session.workspacePreparing);
	}, [session.workspacePreparing]);
	const [queued, setQueued] = useState<QueueReceipt[]>([]);
	// Drag-to-reorder bookkeeping. onReorder fires continuously during a drag, so
	// we only reorder locally then flush the final order to the server on drop —
	// broadcasting mid-drag would swap the item references out from under Motion
	// and drop the gesture. draggingQueueRef gates the incoming queue_update the
	// same way, so an unrelated broadcast can't yank the list while dragging.
	const draggingQueueRef = useRef(false);
	const pendingReorderRef = useRef<QueueReceipt[] | null>(null);
	// Steered messages routed into the live run — shown as a steering receipt
	// until their turn writes to the transcript (then reconciled away below).
	const [steered, setSteered] = useState<QueueReceipt[]>([]);
	// One-shot draft injection into the Composer (bump seq to apply) — how
	// "edit queued message" puts the text back into the input.
	const [composerPrefill, setComposerPrefill] = useState<{
		seq: number;
		text: string;
	} | null>(null);
	// Optimistic just-sent messages, shown instantly and reconciled once the real
	// turn lands (transcript) or the server confirms it as queued (busy path).
	// `busyMode` marks a send made while the run was busy: it renders inside the
	// queue flap (as "Queueing…") instead of as a transcript bubble.
	const [pending, setPending] = useState<
		Array<{
			id: string;
			content: string;
			user: string;
			sentAt: number;
			images?: string[];
			busyMode?: "queue" | "steer";
		}>
	>(() =>
		initialPending
			? [{ id: `pending-initial-${session.id}`, ...initialPending }]
			: [],
	);
	useEffect(() => {
		if (!initialPending) return;
		const content = initialPending.content.trim();
		setPending((prev) => {
			if (prev.some((p) => p.id === `pending-initial-${session.id}`))
				return prev;
			if (
				entries.some(
					(e) => e.type === "user" && (!content || e.content.trim() === content),
				)
			) {
				return prev;
			}
			return [
				...prev,
				{
					id: `pending-initial-${session.id}`,
					...initialPending,
				},
			];
		});
	}, [entries, initialPending, session.id]);
	const [ask, setAsk] = useState<{
		questionId: string;
		questions: AskQuestion[];
	} | null>(null);
	const { copied, share: shareLink } = useCopy();
	// Inline rename of the header title (double-click), mirroring the tab strip.
	// `null` = not editing; a string = the working draft.
	const [renameDraft, setRenameDraft] = useState<string | null>(null);
	const [pinned, setPinned] = useState(() => isPinned(session.id));
	// Restore this session's own last-picked tab first, so coming back to a
	// session lands on the tab it was left on; a session never visited on this
	// device falls back to the last tab picked anywhere (the legacy global
	// key). Either way a tab only restores when this session actually has it.
	// "shell" is deliberately never restorable (it would spawn a PTY on every
	// load) and the global fallback stays info/changes-only.
	const [panelTab, setPanelTab] = useState<PanelTab>(() => {
		const workspace = sessionHasWorkspace(session);
		const remembered = getSessionPanelTab(session.id);
		if (remembered && (remembered === "info" || workspace)) return remembered;
		const stored = localStorage.getItem("opensession-panel-tab");
		const restorable: PanelTab[] = ["info", "changes"];
		const tab: PanelTab | null = restorable.includes(stored as PanelTab)
			? (stored as PanelTab)
			: stored
				? "info"
				: null;
		if (tab) {
			const available = tab === "info" || workspace;
			if (available) return tab;
		}
		return "info";
	});
	function selectPanelTab(tab: PanelTab) {
		setPanelTab(tab);
		localStorage.setItem("opensession-panel-tab", tab);
		saveSessionPanelTab(session.id, tab);
	}
	// The Shell panel stays mounted (hidden) once opened so switching side-panel
	// tabs doesn't kill its PTYs — this latches on first open, and resets per
	// session so a new session never inherits another's shells.
	const [shellOpened, setShellOpened] = useState(false);
	useEffect(() => {
		if (panelTab === "shell") setShellOpened(true);
	}, [panelTab]);
	useEffect(() => {
		setShellOpened(false);
	}, [session.id]);
	// Main chat-area view: the transcript+composer vs. the full-width PR review
	// that takes over the whole chat column. Which one shows is now owned by App
	// (the top tab strip's Review view-tab) and passed in as `showReview`; the
	// open triggers call onOpenReview. Only meaningful on a code session
	// (hasWorkspace) — App only offers the Review tab there.
	// Sub-agents open as their own view-tab (App owns the breadcrumb stack, like
	// every other tab) — a sub-agent run is a conversation, so it gets the chat
	// column rather than the right sidebar.
	// Phones fold the desktop Workspace panel into the title-opened detail page.
	// Keeping this state near panelOpen lets the shared diff poll serve either
	// surface without mounting a second copy of the data hook.
	const [infoPageOpen, setInfoPageOpen] = useState(false);
	const [infoPageScrolled, setInfoPageScrolled] = useState(false);
	// Stable identity so the memoized TranscriptBlocks bails out on unrelated
	// re-renders (e.g. toggling the workspace panel) instead of re-rendering the
	// whole transcript.
	const openSubagent = useCallback(
		(agentId: string, label: string) =>
			onOpenSubagent?.(session.id, agentId, label),
		[onOpenSubagent, session.id],
	);
	// The agent-published walkthrough, rendered inline in the chat as well as in
	// the Review tab. Keyed on its contents so the object identity only changes
	// when the walkthrough actually does — the sessions poll hands back a fresh
	// session object every tick, and an unstable prop here would re-render the
	// whole (expensive) transcript each time.
	const walkthroughKey = session.walkthrough
		? [
				session.walkthrough.publishedAt,
				session.walkthrough.video || "",
				session.walkthrough.summary.length,
				session.walkthrough.shots?.length || 0,
			].join("|")
		: "";
	const chatWalkthrough = useMemo(
		() => session.walkthrough,
		[walkthroughKey], // eslint-disable-line react-hooks/exhaustive-deps
	);
	// Remembered per browser; on phones the panel overlays the chat, so default closed there
	const [panelOpen, setPanelOpenState] = useState(() => {
		const stored = localStorage.getItem("opensession-panel-open");
		if (stored !== null) return stored === "true" && window.innerWidth > 920;
		return window.innerWidth > 920;
	});

	function setPanelOpen(open: boolean) {
		setPanelOpenState(open);
		localStorage.setItem("opensession-panel-open", String(open));
	}
	// Right-panel width (px), drag-resizable from its left edge and persisted
	// per browser; 0 = the CSS default (44%). Mirrors the left sidebar's resize.
	// Shared by the Workspace and sub-agent panels via the --panel-w var.
	const [panelW, setPanelW] = useState<number>(() => {
		const v = Number(localStorage.getItem("opensession-panel-w"));
		return v >= 320 && v <= 2400 ? v : 0;
	});
	const panelWRef = useRef(panelW);
	panelWRef.current = panelW;
	function startPanelResize(e: React.MouseEvent) {
		e.preventDefault();
		// The panel is the rightmost column, so its right edge tracks the pointer's
		// distance from the container's right side.
		const right =
			(e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect()
				.right ?? window.innerWidth;
		document.body.classList.add("resizing-panel");
		// Snap Motion layout morphs while dragging — the composer re-measures on
		// every step, so springing it reads as funky text (mirrors the sidebar).
		const restoreMotion = suppressLayoutAnimations();
		const onMove = (ev: MouseEvent) => {
			// Wide enough to review code side-by-side: only reserve room for the
			// left sidebar + a readable chat column instead of a fixed 900px cap.
			const max = Math.max(480, Math.round(window.innerWidth - 620));
			const w = Math.min(max, Math.max(320, Math.round(right - ev.clientX)));
			panelWRef.current = w;
			setPanelW(w);
		};
		const onUp = () => {
			document.body.classList.remove("resizing-panel");
			restoreMotion();
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			localStorage.setItem(
				"opensession-panel-w",
				String(Math.round(panelWRef.current)),
			);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}
	const panelStyle = panelW
		? ({ "--panel-w": `${panelW}px` } as React.CSSProperties)
		: undefined;
	// Session scratch assets (Assets tab): fetched once per session + on
	// assets_changed broadcasts; the tab only appears once files exist.
	const { files: assetFiles, refresh: refreshAssets } = useSessionAssets(
		session.id,
		addHandler,
	);
	// Which asset the main-area Assets view-tab previews — set when an asset row
	// in the Info panel is clicked (the main-tab tree is hidden, so the Info-panel
	// list is the navigator).
	const [selectedAssetPath, setSelectedAssetPath] = useState<string | null>(
		null,
	);
	const sessionReports = useSessionReports(session.id, addHandler);
	// Team notes — the session's chat channel (`session:<id>`), interleaved
	// into the transcript as NoteBubbles. Human-to-human; the agent never sees
	// them. Posted from the composer's note mode (⌘N).
	const [notes, setNotes] = useState<ChatMessage[]>([]);
	const [noteMode, setNoteMode] = useState(false);
	useEffect(() => {
		setNotes([]);
		setNoteMode(false);
		let cancelled = false;
		fetchChatMessagesApi(`session:${session.id}`)
			.then((msgs) => {
				if (!cancelled && msgs.length) setNotes(msgs);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [session.id]);
	useEffect(
		() =>
			addHandler((msg) => {
				if (
					(msg.type !== "chat_message" &&
						msg.type !== "chat_message_updated") ||
					msg.channel !== `session:${session.id}`
				)
					return;
				setNotes((prev) => {
					const i = prev.findIndex((m) => m.id === msg.message.id);
					if (i >= 0) {
						const next = [...prev];
						next[i] = msg.message;
						return next;
					}
					return [...prev, msg.message];
				});
			}),
		[addHandler, session.id],
	);
	// Viewing the session marks its notes read (the sidebar unread dot keys off
	// this stamp).
	useEffect(() => {
		if (!notes.length) return;
		localStorage.setItem(
			`opensession-note-read:${session.id}`,
			String(notes[notes.length - 1].ts),
		);
		window.dispatchEvent(new Event("opensession-note-read-changed"));
	}, [notes, session.id]);
	const panelResizeHandle = (
		<div
			className="panel-resize absolute -left-[3px] top-0 z-[6] h-full w-[7px] cursor-col-resize after:absolute after:left-[3px] after:top-0 after:h-full after:w-0.5 after:bg-transparent after:transition-colors hover:after:bg-line-strong max-[720px]:hidden"
			onMouseDown={startPanelResize}
			aria-hidden="true"
		/>
	);
	// Intent-aware scrolling: stick to the live edge only while the reader is there,
	// pin new turns near the top, and surface a "Jump to latest" affordance.
	const {
		containerRef: messagesRef,
		spacerRef,
		followingLive,
		following,
		newBelow,
		showScrollToBottom,
		scrollToLatest,
		leaveLatest,
		endTurn,
		relayout,
		onScroll,
	} = useChatScroll(cachedTranscript?.following ?? true);

	// Keep the cached snapshot current as live frames and history pages land.
	// Scroll position is updated synchronously in handleMessagesScroll below.
	useEffect(() => {
		if (transcriptReadySessionRef.current !== session.id) return;
		const previous = cachedTranscriptView(session.id);
		const el = messagesRef.current;
		const anchor = el ? pickScrollAnchor(el) : null;
		cacheTranscriptView(session.id, {
			entries,
			cursor: transcriptCursorRef.current,
			seq: transcriptSeqRef.current,
			historyTruncated,
			historyStart: historyStartRef.current,
			scrollTop: el?.scrollTop ?? previous?.scrollTop ?? 0,
			following,
			anchorEid: anchor?.dataset.eid ?? previous?.anchorEid ?? null,
			anchorTop:
				anchor && el
					? anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
					: previous?.anchorTop ?? null,
		});
	}, [entries, following, historyTruncated, messagesRef, session.id]);
	useEffect(() => {
		setEntries((prev) => withModelSwitches(prev, session.modelHistory));
	}, [session.modelHistory]);

	// The hold: keep an anchor element at a stable content offset while history
	// prepends above it and the new bubbles' heights settle (content-visibility
	// estimates resolve to real sizes as they render). `overflow-anchor: none`
	// for the duration so Chrome's native scroll anchoring doesn't compensate
	// the same shift twice; Safari has no native anchoring, so without this
	// hold it loses the reader's position outright. Content-space offsets
	// (rect relative to container + scrollTop) are scroll-invariant, so the
	// reader's own scrolling composes cleanly with the compensation.
	const stopHistoryHold = useCallback(() => {
		const h = historyHoldRef.current;
		if (!h) return;
		cancelAnimationFrame(h.raf);
		historyHoldRef.current = null;
		const el = messagesRef.current;
		if (el) el.style.overflowAnchor = "";
	}, [messagesRef]);
	const startHistoryHold = useCallback(
		(
			node: HTMLElement,
			ms: number,
			fallback: { height: number; top: number } | null,
		) => {
			const el = messagesRef.current;
			if (!el) return;
			stopHistoryHold();
			el.style.overflowAnchor = "none";
			const contentTopOf = (n: HTMLElement, c: HTMLElement) =>
				n.getBoundingClientRect().top -
				c.getBoundingClientRect().top +
				c.scrollTop;
			// Two anchor layers: the tight node for frame-to-frame deltas, and its
			// nearest [data-eid] ancestor as a *recovery identity* — when a prepend
			// merges into the anchor's turn block the whole block remounts (its key
			// is its first item id) and every DOM node dies, but the same entry
			// re-renders under the same data-eid.
			const idEl = (node.closest?.("[data-eid]") as HTMLElement | null) ?? null;
			const hold = {
				node,
				top: contentTopOf(node, el),
				eid: idEl?.dataset.eid ?? null,
				eidTop: idEl ? contentTopOf(idEl, el) : null,
				until: performance.now() + ms,
				raf: 0,
				fallback,
			};
			historyHoldRef.current = hold;
			const tick = () => {
				const h = historyHoldRef.current;
				const c = messagesRef.current;
				if (!h || h !== hold || !c) return;
				if (performance.now() > h.until || followingLive.current) {
					stopHistoryHold();
					return;
				}
				if (h.node.isConnected) {
					const t = contentTopOf(h.node, c);
					const d = t - h.top;
					if (d !== 0) c.scrollTop += d;
					h.top = t;
					// Keep the recovery identity fresh: cheap ancestor walk, and the
					// content offset re-measured so a later remount recovers to the
					// reader's latest position, not the hold's starting one.
					const id2 = h.node.closest?.("[data-eid]") as HTMLElement | null;
					h.eid = id2?.dataset.eid ?? h.eid;
					h.eidTop = id2 ? contentTopOf(id2, c) : h.eidTop;
				} else {
					// Anchor DOM died (block remount). Recover through the entry id:
					// same content, new nodes — shift by how far it moved.
					const revived =
						h.eid && typeof CSS !== "undefined"
							? c.querySelector<HTMLElement>(
									`[data-eid="${CSS.escape(h.eid)}"]`,
								)
							: null;
					if (revived && h.eidTop !== null) {
						const d = contentTopOf(revived, c) - h.eidTop;
						if (d !== 0) c.scrollTop += d;
					} else if (h.fallback) {
						// Last resort: height math. Skewed by content-visibility
						// estimate resets, but better than staying at a raw offset.
						c.scrollTop = c.scrollHeight - h.fallback.height + h.fallback.top;
					}
					h.fallback = null;
					const next = revived ?? pickScrollAnchor(c);
					if (!next) {
						stopHistoryHold();
						return;
					}
					const nid = (next.closest?.("[data-eid]") as HTMLElement | null) ?? null;
					h.node = next;
					h.top = contentTopOf(next, c);
					h.eid = nid?.dataset.eid ?? null;
					h.eidTop = nid ? contentTopOf(nid, c) : null;
				}
				h.raf = requestAnimationFrame(tick);
			};
			hold.raf = requestAnimationFrame(tick);
		},
		[messagesRef, stopHistoryHold, followingLive],
	);
	// A page's worth of settling outlives its arrival, not the request: slow
	// fetches shouldn't burn the hold window, so extend it when a load lands.
	useEffect(() => {
		if (loadingHistory) return;
		const h = historyHoldRef.current;
		if (h) h.until = Math.max(h.until, performance.now() + 2500);
	}, [loadingHistory]);
	useEffect(() => stopHistoryHold, [session.id, stopHistoryHold]);
	// Switching sessions abandons an in-flight jump-to-start walk (its pages are
	// session-guarded anyway) — without this the flag would outlive it and keep
	// the control stuck in its loading state.
	useEffect(() => {
		return () => {
			jumpRef.current = null;
			scrollToTopRef.current = false;
			setJumpingToStart(false);
		};
	}, [session.id]);

	// Immersive reading on phones (Safari-style): scrolling down through the
	// transcript slides the top bar, docked tabs and composer off-screen to
	// maximize the reading area; scrolling back up — or reaching the very top or
	// the live edge — brings them back. Toggles body.chrome-collapsed, which the
	// mobile CSS animates with transforms (inert on desktop / when unscrollable).
	useEffect(() => {
		const el = messagesRef.current;
		if (!el) return;
		const mq = window.matchMedia("(max-width: 720px)");
		let lastY = el.scrollTop;
		let collapsed = false;
		let ticking = false;
		const set = (v: boolean) => {
			if (v === collapsed) return;
			collapsed = v;
			document.body.classList.toggle("chrome-collapsed", v);
		};
		const onDir = () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				ticking = false;
				if (!mq.matches) {
					set(false);
					lastY = el.scrollTop;
					return;
				}
				const y = el.scrollTop;
				const max = el.scrollHeight - el.clientHeight;
				const dy = y - lastY;
				lastY = y;
				// Keep the chrome up near the top and the live edge so the controls
				// stay reachable; otherwise follow the scroll direction (with a small
				// dead-zone so tiny jitters don't flip it).
				if (y < 48 || max - y < 64) set(false);
				else if (dy > 6) set(true);
				else if (dy < -6) set(false);
			});
		};
		el.addEventListener("scroll", onDir, { passive: true });
		return () => {
			el.removeEventListener("scroll", onDir);
			document.body.classList.remove("chrome-collapsed");
		};
	}, [messagesRef, session.id]);

	// Per-session model (switchable from the composer; "" = default)
	const [model, setModel] = useState(session.model || "");
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	// Pinnable Claude/Codex accounts + this session's pin ("" = auto pool).
	const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
	const [accountId, setAccountId] = useState(session.accountId || "");
	// Live token/cost accounting — seeded from the session, updated per run via
	// the `usage_update` broadcast. Powers the composer cost/context pill.
	const [usage, setUsage] = useState(session.usage);
	// Reasoning effort — a composer control mirroring the new-session palette.
	// Persisted on the session server-side and enforced per run (Claude effort /
	// Codex modelReasoningEffort), so seed from the session's stored value.
	const [effort, setEffort] = useState(session.effort || "high");
	const [fastMode, setFastMode] = useState(session.fastMode || false);
	// Optimistic goal: reflects a just-set/cleared goal instantly (the /goal
	// command persists server-side but doesn't broadcast a live session update).
	// `undefined` = defer to session.goal; a string/null = the pending override.
	const [goalOverride, setGoalOverride] = useState<string | null | undefined>(
		undefined,
	);
	// Drop the override once the server-side session catches up (or we switch).
	useEffect(() => setGoalOverride(undefined), [session.id, session.goal]);
	const currentGoal =
		goalOverride !== undefined ? goalOverride : session.goal ?? null;
	useEffect(() => {
		fetchModels()
			.then((m) => {
				setModels(m.models);
				setDefaultModel(m.default);
			})
			.catch(() => {});
		fetchProviderAccounts()
			.then(setAccounts)
			.catch(() => {});
	}, []);
	useEffect(() => {
		setModel(session.model || "");
	}, [session.id, session.model]);
	useEffect(() => {
		setAccountId(session.accountId || "");
	}, [session.id, session.accountId]);
	useEffect(() => {
		setEffort(session.effort || "high");
	}, [session.id, session.effort]);
	useEffect(() => {
		setFastMode(session.fastMode || false);
	}, [session.id, session.fastMode]);
	useEffect(() => {
		setUsage(session.usage);
	}, [session.id, session.usage]);

	// Dynamic workflow runs (opensession-workflows MCP): seeded by a fetch on
	// open/session switch, then kept live by workflow_update broadcasts. Powers
	// the Agents tab — hidden entirely while empty.
	const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSnapshot[]>([]);
	// True once the seed fetch for the current session has settled — the
	// runs-vanished fallback below must not flip tabs off an empty [] mid-fetch.
	const [workflowsLoaded, setWorkflowsLoaded] = useState(false);
	useEffect(() => {
		let stale = false;
		setWorkflowRuns([]);
		setWorkflowsLoaded(false);
		fetch(`${BASE_PATH}/api/sessions/${encodeURIComponent(session.id)}/workflows`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (stale) return;
				if (Array.isArray(d?.runs)) {
					const fetched = d.runs as WorkflowRunSnapshot[];
					// WS upserts may have landed while the fetch was in flight — those
					// snapshots are newer than the seed, so keep them and only add
					// fetched runs we don't have yet (the panel re-sorts by startedAt).
					setWorkflowRuns((prev) => {
						const have = new Set(prev.map((r) => r.runId));
						const added = fetched.filter((r) => !have.has(r.runId));
						return added.length ? [...prev, ...added] : prev;
					});
				}
				setWorkflowsLoaded(true);
			})
			.catch(() => {
				if (!stale) setWorkflowsLoaded(true);
			});
		return () => {
			stale = true;
		};
	}, [session.id]);
	function cancelWorkflowRun(runId: string) {
		// Fire-and-forget: the workflow_update echo flips the card to cancelled.
		fetch(`${BASE_PATH}/api/workflows/${encodeURIComponent(runId)}/cancel`, {
			method: "POST",
		}).catch(() => {});
	}

	// Sub-agents the session spawned directly (opencode task-tool children /
	// SDK Task agents) — shown in the Agents tab next to workflow runs. Seeded
	// here; the polling effect below (after isBusy exists) keeps them live.
	const [subagents, setSubagents] = useState<SessionSubagentSnapshot[]>([]);
	useEffect(() => setSubagents([]), [session.id]);

	// Keep the pin star in sync with the store (changes can come from the tab bar
	// or the Home screen) and reset when switching sessions.
	useEffect(() => setPinned(isPinned(session.id)), [session.id]);
	useEffect(
		() => onPinsChanged(() => setPinned(isPinned(session.id))),
		[session.id],
	);

	// Claimed into your own sidebar lanes (lib/lanes.ts) — the whole workspace,
	// since that's the unit the sidebar row claims. Lanes live in a module cache
	// like pins, so mirror it into state and re-read on every change.
	const claimChats = workspaceChats?.length ? workspaceChats : [session];
	const claimIds = claimChats.map((c) => c.id).join(",");
	const claimedGlobally = claimChats.some((c) => !!c.manualStatus);
	const [claimedLane, setClaimedLane] = useState(false);
	useEffect(() => {
		const read = () =>
			setClaimedLane(claimIds.split(",").some((id) => !!getLane(id)));
		read();
		return onLanesChanged(read);
	}, [claimIds]);
	const claimed = claimedLane || claimedGlobally;
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (
				!focused ||
				e.defaultPrevented ||
				!(e.metaKey || e.ctrlKey) ||
				e.altKey ||
				e.shiftKey ||
				(e.key.toLowerCase() !== "p" && e.code !== "KeyP") ||
				document.querySelector(
					".palette-backdrop, .composer-schedule-modal-backdrop, .session-delete-overlay",
				)
			) {
				return;
			}
			e.preventDefault();
			togglePin(session.id);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [focused, session.id]);

	const isAsk = session.mode === "ask";
	const hasWorkspace = sessionHasWorkspace(session);
	// The Agents tab stays available on any session with a workspace (it shows
	// an empty state that teaches the feature), so only fall back to Info when
	// the tab itself is gone — a session that can't run workflows AND has no
	// runs to show.
	useEffect(() => {
		if (
			workflowsLoaded &&
			panelTab === "workflows" &&
			workflowRuns.length === 0 &&
			subagents.length === 0 &&
			!hasWorkspace
		)
			setPanelTab("info");
	}, [workflowsLoaded, panelTab, workflowRuns.length, subagents.length, hasWorkspace]);

	// Ask→code promotion: creates a worktree and flips the chat to code mode.
	// The 5s session poll picks up the mode change and re-renders with the full
	// code affordances (diff/PR tabs, RepoBar).
	const [promoting, setPromoting] = useState(false);
	// `onDone` closes the composer menu the action was picked from — called on
	// both paths, so a failure returns you to a usable menu instead of a row
	// stuck on "Switching to code…".
	async function handlePromote(onDone?: () => void) {
		if (promoting) return;
		setPromoting(true);
		try {
			const { branch } = await promoteChatApi(session.id);
			// The session poll flips the header, tabs and RepoBar a beat later;
			// say what happened now, and name the branch — the chat may have
			// adopted the tree it was already reading rather than cutting a new
			// one, and that difference matters before the first edit.
			toast(branch ? `Code mode on ${branch}` : "Switched to code mode");
		} catch (e) {
			toast(e instanceof Error ? e.message : "Could not switch to code mode");
			setPromoting(false);
		}
		onDone?.();
	}
	// A linked Plain thread gets a read-only conversation sidebar (+ jump-to-Plain),
	// available even for ask-mode sessions that have no code workspace.
	const hasPlain = Boolean(session.plainThreadId);
	const plainUrl = session.plainThreadId
		? plainThreadUrl(session.plainThreadId)
		: "";
	// Feed-item link (Tella video, PostHog dashboard, …): the same
	// jump-out affordance Plain has, generic over the session's externalRefs.
	const feedRef = (session.externalRefs || []).find((r) => r.url);
	const feedRefLabel = feedRef
		? feedForRefKind(feedRef.kind)?.title ||
			feedRef.kind.charAt(0).toUpperCase() + feedRef.kind.slice(1)
		: "";
	// Workflow runs open the panel too: ask-mode sessions without a workspace
	// or Plain thread still need somewhere to show the Agents tab.
	const panelAvailable =
		!hideRightPanel &&
		(hasWorkspace ||
			hasPlain ||
			workflowRuns.length > 0 ||
			subagents.length > 0 ||
			sessionReports.length > 0);
	useEffect(() => {
		if (panelTab === "reports" && sessionReports.length === 0)
			setPanelTab("info");
	}, [panelTab, sessionReports.length]);
	const isBusy = isRunningLive || isStreaming;
	// The header banner is the fallback voice for a dead run, not its main one:
	// it speaks only when the transcript didn't already report the failure in
	// place (see runErrorIsInTranscript). Hidden while a retry runs, and while
	// the transcript is still loading — with no entries to check yet it would
	// otherwise flash on open and then retract.
	const runErrorBanner =
		session.lastRunError && !isBusy && !loading && !runErrorIsInTranscript(entries)
			? session.lastRunError
			: null;
	// Sub-agent list: fetch on open, then re-poll while the session runs so
	// live task-tool spawns appear/settle. Keyed on isBusy too: a run starting
	// after mount restarts the poll loop, and the flip back to idle lands one
	// final fetch that settles statuses.
	useEffect(() => {
		let stale = false;
		let timer: number | undefined;
		const load = async () => {
			try {
				const d = await fetchSessionSubagents(session.id);
				if (stale) return;
				// Keep the previous array when nothing changed: downstream memos
				// (and the LiveSubagents context feeding every ToolCallBlock)
				// only re-render on real updates, not on every 4s poll tick.
				setSubagents((prev) =>
					JSON.stringify(prev) === JSON.stringify(d.subagents)
						? prev
						: d.subagents,
				);
				if (d.sessionRunning) timer = window.setTimeout(load, 4000);
			} catch {
				// Transient (auth refresh, reload) — the next poll or session
				// switch retries.
			}
		};
		load();
		return () => {
			stale = true;
			if (timer) window.clearTimeout(timer);
		};
	}, [session.id, isBusy]);
	// Task rows learn their child session id from this map while the call is
	// still running (the result text that normally carries it doesn't exist
	// yet), enabling the mid-run "Watch ↗" drill-in.
	const liveSubagents = useMemo(() => {
		const m = new Map<string, LiveSubagent>();
		for (const s of subagents)
			if (s.toolUseId) m.set(s.toolUseId, { id: s.id, status: s.status });
		return m;
	}, [subagents]);
	// Derived, not the raw flag: transcript content or streaming text means the
	// opening run already started, so the worktree is done — this guards against
	// a stale sessions poll re-asserting the flag after the workspace_status
	// event already cleared it.
	const waitingForWorkspace =
		workspacePreparing && entries.length === 0 && !liveTurnStore.hasText();

	// Live worktree diff, shared between the Changes-tab file-count badge and the
	// DiffPanel (passed in as `diff=` below so they poll once, not twice). Parked
	// unless either workspace surface is open on a code session.
	const diffState = useSessionDiff(session.id, {
		enabled: hasWorkspace && panelOpen,
		isRunning: isBusy,
	});
	const changesFileCount = React.useMemo(
		() =>
			diffState.repos
				? diffState.repos.reduce(
						(n, r) => n + (r.diff.files?.length || 0),
						0,
					)
				: null,
		[diffState.repos],
	);

	// Anchor for the agent-working elapsed timer. A run that starts
	// while we're watching anchors to now; opening a session mid-run anchors to
	// the server's journaled run start (runStartedAt — survives switches and
	// refreshes), falling back to the turn's user prompt in the transcript, so
	// the timer shows the run's real age, not time-since-I-opened-the-tab. The
	// ref tracks which case we're in: it stays true until we've observed the
	// session idle.
	const [busySince, setBusySince] = useState<number | null>(null);
	const anchorFromTranscript = useRef(session.isRunning);
	useEffect(() => {
		anchorFromTranscript.current = true;
		setBusySince(null);
	}, [session.id]);
	useEffect(() => {
		if (!isBusy) {
			anchorFromTranscript.current = false;
			setBusySince(null);
			return;
		}
		// The journaled run start is authoritative whenever we have it — for a
		// run that starts while watching it's ~now anyway (App stamps it on the
		// status flip), and mid-run it's the real start even when a stale
		// isRunning=false at mount already flipped the anchor ref.
		if (session.runStartedAt) {
			const t = Date.parse(session.runStartedAt);
			if (Number.isFinite(t)) {
				setBusySince((prev) => prev ?? t);
				return;
			}
		}
		// Mid-run open: wait for the transcript so we can find the turn's prompt.
		if (anchorFromTranscript.current && loading) return;
		setBusySince((prev) => {
			if (prev != null) return prev;
			if (anchorFromTranscript.current) {
				for (let i = entries.length - 1; i >= 0; i--) {
					if (entries[i].type !== "user") continue;
					const t = new Date(entries[i].timestamp).getTime();
					if (Number.isFinite(t)) return t;
					break;
				}
			}
			return Date.now();
		});
	}, [isBusy, loading, entries, session.runStartedAt]);

	// Ctrl+R focuses the composer (overrides browser reload while in a session)
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (!focused) return;
			if (
				e.key.toLowerCase() === "r" &&
				e.ctrlKey &&
				!e.metaKey &&
				!e.altKey &&
				!e.shiftKey
			) {
				e.preventDefault();
				composerRef.current?.focus();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [focused]);

	// ⌘⌥↑/⌘⌥↓ step the reasoning effort through the current model's supported
	// levels (up = more thinking), wrapping at the ends. Resolves the same
	// effective effort as the ModelEffortSelect pill (stored value when the
	// model offers it, else "high", else the model's first level), so the step
	// always starts from what the pill displays. Fires with the composer
	// focused too — the Alt modifier keeps it clear of plain ⌘↑/⌘↓ (workspace
	// cycling in the Sidebar, and caret start/end moves in the textarea).
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (!focused) return;
			// Match e.code too: with Option held, some layouts/browsers alter
			// e.key; the physical-key code never changes.
			const arrow =
				e.key === "ArrowUp" || e.code === "ArrowUp"
					? "ArrowUp"
					: e.key === "ArrowDown" || e.code === "ArrowDown"
						? "ArrowDown"
						: null;
			if (
				e.defaultPrevented ||
				!arrow ||
				!(e.metaKey || e.ctrlKey) ||
				!e.altKey ||
				e.shiftKey
			)
				return;
			const effectiveModel = model || defaultModel;
			const supportedIds =
				models.find((m) => m.id === effectiveModel)?.efforts ?? [];
			const supported = EFFORTS.filter((ef) => supportedIds.includes(ef.id));
			if (supported.length < 2) return;
			const effective = supportedIds.includes(effort)
				? effort
				: supportedIds.includes("high")
					? "high"
					: supported[0].id;
			const idx = supported.findIndex((ef) => ef.id === effective);
			const dir = arrow === "ArrowUp" ? 1 : -1;
			const next =
				supported[(idx + dir + supported.length) % supported.length];
			if (!next) return;
			e.preventDefault();
			setEffort(next.id);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [focused, models, defaultModel, model, effort]);

	// ⌃⇧↑/⌃⇧↓ page the transcript up/down — keyboard scrolling that works while
	// the composer is focused. A programmatic scroll carries no reader gesture,
	// so useChatScroll won't re-engage auto-follow from it: a Down that would
	// land at the live edge goes through scrollToLatest, which resumes following.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (!focused) return;
			const arrow =
				e.key === "ArrowUp" || e.code === "ArrowUp"
					? "ArrowUp"
					: e.key === "ArrowDown" || e.code === "ArrowDown"
						? "ArrowDown"
						: null;
			if (
				e.defaultPrevented ||
				!arrow ||
				!e.ctrlKey ||
				!e.shiftKey ||
				e.metaKey ||
				e.altKey
			)
				return;
			const el = messagesRef.current;
			if (!el) return;
			e.preventDefault();
			const delta = Math.max(120, el.clientHeight * 0.8);
			if (arrow === "ArrowDown") {
				const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
				if (remaining - delta < 48) {
					scrollToLatest();
					return;
				}
			}
			el.scrollBy({
				top: arrow === "ArrowUp" ? -delta : delta,
				behavior: "smooth",
			});
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [focused, messagesRef, scrollToLatest]);

	// A "new tab" while this session is open is a fresh chat *in this session*:
	// clear the composer and jump to the live edge. We skip the first run (and
	// session switches, which remount this with whatever the counter's at) and
	// only react to real bumps from the tab-bar +.
	const lastNewChatSeq = useRef(newChatSeq);
	// Drop the persisted draft during render, before the key={newChatSeq}
	// remount below re-reads it — in an effect the fresh Composer's state
	// initializer would already have restored the old text. Idempotent, so
	// running on the renders between the bump and the effect below is fine.
	if (newChatSeq !== lastNewChatSeq.current) clearDraft(draftKey);
	useEffect(() => {
		if (newChatSeq === lastNewChatSeq.current) return;
		lastNewChatSeq.current = newChatSeq;
		// The composer's text draft resets via its key={newChatSeq} remount.
		setImages([]);
		setFiles([]);
		setForkFrom(null);
		scrollToLatest("smooth");
		composerRef.current?.focus();
	}, [newChatSeq, scrollToLatest]);

	// Browser tab title follows the session
	useEffect(() => {
		if (!focused) return;
		document.title = session.title || DEFAULT_DOC_TITLE;
		return () => {
			document.title = DEFAULT_DOC_TITLE;
		};
	}, [focused, session.title]);

	// Subscribe to WebSocket messages
	useEffect(() => {
		if (!connected) return;

		// Resume rather than re-snapshot when this exact session's transcript is
		// still mounted (a reconnect blip, not a session switch) and we hold a
		// cursor from a previous frame. Seq mode (transcript v2) resumes with
		// sinceSeq; legacy with the byte cursor. supportsSeq advertises the
		// capability — old servers ignore it and behave exactly as before.
		const cursor = transcriptCursorRef.current;
		const seqState = transcriptSeqRef.current;
		const ready = transcriptReadySessionRef.current === session.id;
		const resume =
			ready && seqState?.sessionId === session.id
				? {
						sinceSeq: seqState.lastSeq,
						sinceChangeSeq: seqState.lastChangeSeq,
					}
				: ready && cursor?.sessionId === session.id
					? { sinceOffset: cursor.offset, sinceRev: cursor.rev }
					: {};
		send({
			type: "watch",
			sessionId: session.id,
			user: getCurrentUser(),
			supportsSeq: true,
			supportsChangeSeq: true,
			...resume,
		});

		const unsubscribe = addHandler((msg) => {
			// Session-scoped messages carry the session id — drop anything meant
			// for a different chat. Without this, a socket race (or a lingering
			// creator-side direct send from a chat you navigated away from) bleeds
			// another session's stream into this view. Messages without a
			// sessionId (direct replies like slash-command notices) pass through.
			if (
				"sessionId" in msg &&
				msg.sessionId &&
				msg.sessionId !== session.id
			) {
				return;
			}
			switch (msg.type) {
				case "workflow_update": {
					// Dynamic workflows: upsert the live run snapshot (already
					// session-filtered by the sessionId gate above).
					const run = msg.run;
					setWorkflowRuns((prev) =>
						prev.some((r) => r.runId === run.runId)
							? prev.map((r) => (r.runId === run.runId ? run : r))
							: [run, ...prev],
					);
					break;
				}
				case "transcript_init": {
					// Weave persisted model switches into the conversation as dividers.
					const merged = withModelSwitches(msg.entries, session.modelHistory);
					transcriptReadySessionRef.current = session.id;
					// Mode detection (transcript v2): an init carrying seq fields
					// switches this session into seq mode; one without switches it
					// back to legacy (e.g. the flag was turned off — the resume
					// falls back to a full legacy snapshot). Init frames are
					// authoritative for the mode.
					const v2 = msg.v2 === true && typeof msg.lastSeq === "number";
					if (v2) {
						transcriptSeqRef.current = {
							sessionId: session.id,
							lastSeq: msg.lastSeq!,
							firstSeq:
								typeof msg.firstSeq === "number" && msg.firstSeq > 0
									? msg.firstSeq
									: null,
							lastChangeSeq:
								typeof msg.lastChangeSeq === "number"
									? msg.lastChangeSeq
									: msg.lastSeq!,
						};
						// Seq mode ignores offset/rev cursors entirely.
						transcriptCursorRef.current = null;
					} else {
						transcriptSeqRef.current = null;
						if (typeof msg.endOffset === "number" && msg.rev) {
							transcriptCursorRef.current = {
								sessionId: session.id,
								rev: msg.rev,
								offset: msg.endOffset,
							};
						} else {
							transcriptCursorRef.current = null;
						}
					}
					transcriptViewStore.replace(merged, true, v2);
					setHistoryTruncated(!!msg.truncated);
					setLoadingHistory(false);
					setLoading(false);
					// A jump-to-start walk ends here when the server answers with the
					// whole transcript — the legacy path's only way to serve a backlog,
					// and the seq path's fallback when a store read fails. A TRUNCATED
					// init is a re-snapshot of the tail instead (a reconnect landing
					// mid-walk), so cancel that quietly rather than parking the reader
					// at the top of a tail they didn't ask for.
					if (jumpRef.current?.sessionId === session.id) {
						if (msg.truncated) {
							jumpRef.current = null;
							setJumpingToStart(false);
						} else {
							finishJumpToStart();
						}
					}
					if (!shellTimingRef.current.recorded) {
						shellTimingRef.current.recorded = true;
						measureChatPerf(
							"shell_to_transcript_ms",
							shellTimingRef.current.startedAt,
						);
					}
					// Pagination cursor for "load earlier" (the byte offset the shipped
					// tail begins at). Each history page arrives as transcript_history
					// below. Seq mode pages with
					// beforeSeq instead, so the byte cursor stays untouched there.
					if (!v2 && typeof msg.startOffset === "number") {
						historyStartRef.current = msg.startOffset;
					}
					break;
				}
				case "transcript_history": {
					// Older entries from a "load earlier" page: merge by id and re-sort
					// by time — mergeEntries
					// appends, which is wrong for content older than what's shown.
					transcriptViewStore.prepend(msg.entries, msg.v2 === true);
					setHistoryTruncated(!!msg.truncated);
					const seqState = transcriptSeqRef.current;
					const inSeqMode = seqState?.sessionId === session.id;
					if (
						inSeqMode &&
						msg.v2 === true &&
						typeof msg.firstSeq === "number" &&
						msg.firstSeq > 0
					) {
						// Older-page cursor: earliest seq loaded so far (min).
						seqState.firstSeq =
							seqState.firstSeq === null
								? msg.firstSeq
								: Math.min(seqState.firstSeq, msg.firstSeq);
					} else if (!inSeqMode && typeof msg.startOffset === "number") {
						historyStartRef.current =
							historyStartRef.current === null
								? msg.startOffset
								: Math.min(historyStartRef.current, msg.startOffset);
					}
					// Jump to the start: this page's cursor is now in place, so ask
					// for the next one straight from here — leaving loadingHistory
					// true across the gap. Stop on a whole transcript, an empty page,
					// a cursor that stopped receding, or the ceiling.
					const jump = jumpRef.current;
					if (jump && jump.sessionId === session.id) {
						jump.loaded += msg.entries.length;
						const cursor = inSeqMode
							? seqState.firstSeq
							: historyStartRef.current;
						if (
							msg.truncated &&
							msg.entries.length > 0 &&
							cursor !== null &&
							cursor !== jump.cursor &&
							jump.loaded < JUMP_MAX_ENTRIES
						) {
							jump.cursor = cursor;
							requestHistoryPage(true);
							break;
						}
						finishJumpToStart();
					}
					setLoadingHistory(false);
					break;
				}
				case "transcript_append": {
					const seqState = transcriptSeqRef.current;
					const inSeqMode = seqState?.sessionId === session.id;
					if (inSeqMode) {
						// Seq mode: track the resume cursor as a max — upsert
						// republishes reuse the entry's ORIGINAL seq, so a frame's
						// lastSeq can sit below what we already hold. Offset/rev
						// fields (if any) are ignored while in this mode.
						if (
							msg.v2 === true &&
							typeof msg.lastSeq === "number" &&
							msg.lastSeq > 0
						) {
							seqState.lastSeq = Math.max(seqState.lastSeq, msg.lastSeq);
						}
						if (typeof msg.lastChangeSeq === "number") {
							seqState.lastChangeSeq = Math.max(
								seqState.lastChangeSeq,
								msg.lastChangeSeq,
							);
						}
					} else if (typeof msg.endOffset === "number" && msg.rev) {
						transcriptCursorRef.current = {
							sessionId: session.id,
							rev: msg.rev,
							offset: msg.endOffset,
						};
					}
					transcriptViewStore.merge(msg.entries, inSeqMode);
					// The live stream and the transcript tail both carry assistant text.
					// stream_text accumulates whole blocks until stream_done (end of the
					// run), so a mid-run text block would otherwise show twice: as the
					// persisted entry above later tool steps AND in the streaming bubble
					// at the bottom. Once a block lands as an entry, drop it from the
					// stream buffer.
					const landed = msg.entries.filter(
						(e) => e.type === "assistant" && e.content,
					);
					if (landed.length) {
						liveTurnStore.land(landed.map((e) => e.content));
					}
					break;
				}
				case "presence":
					if (msg.sessionId === session.id) setViewers(msg.viewers);
					break;
				case "queue_update":
					if (msg.sessionId === session.id) {
						// Don't let a broadcast rewrite the list mid-drag (see
						// draggingQueueRef) — the drop will send our order and the
						// server's echo reconciles it right after.
						if (!draggingQueueRef.current) setQueued(msg.queued);
						setSteered(msg.steered || []);
					}
					break;
				case "ask_question":
					if (msg.sessionId === session.id) {
						setAsk({ questionId: msg.questionId, questions: msg.questions });
					}
					break;
				case "ask_resolved":
					if (msg.sessionId === session.id) {
						setAsk((prev) =>
							prev?.questionId === msg.questionId ? null : prev,
						);
					}
					break;
				case "session_status":
					setIsRunningLive(msg.isRunning);
					onRunningChange?.(session.id, msg.isRunning);
					break;
				case "git_pushed":
					if (msg.sessionId === session.id) setGitRefreshTick((t) => t + 1);
					break;
				case "pr_updated":
					// Include PR-backed workspace branches: legacy review chats keep a
					// synthetic checkout branch that differs from the real PR head.
					if (sessionPrTargetsRef.current.has(`${msg.repo}\0${msg.branch}`))
						setGitRefreshTick((t) => t + 1);
					break;
				case "workspace_status":
					if (msg.sessionId === session.id)
						setWorkspacePreparing(!msg.ready);
					break;
				case "stream_start":
					setIsStreaming(true);
					liveTurnStore.start(msg.by);
					break;
				case "stream_text": {
					if (isTimelineOnlyRunnerNotice(msg.text)) break;
					liveTurnStore.append(msg.text);
					break;
				}
				case "stream_tool_use":
				case "stream_tool_result":
					transcriptViewStore.merge([msg.entry]);
					break;
				case "stream_done": {
					setIsStreaming(false);
					liveTurnStore.finish();
					break;
				}
				case "model_changed":
					if (msg.sessionId !== session.id) break;
					setModel(msg.model);
					if (msg.by && msg.by !== getCurrentUser()) {
						setEntries((prev) => [
							...prev,
							{
								id: `model-switch-live-${Date.now()}`,
								type: "system",
								content: switchDividerText(msg.model, msg.from, msg.by),
								timestamp: new Date().toISOString(),
							},
						]);
					}
					break;
				case "subscription_changed":
					// Keep every viewer's Subscription submenu in sync; the /sub
					// notice in the transcript carries the human-readable detail.
					if (msg.sessionId !== session.id) break;
					setAccountId(msg.accountId || "");
					break;
				case "usage_update":
					if (msg.sessionId !== session.id) break;
					setUsage(msg.usage);
					break;
				case "cache_warning":
					if (msg.sessionId !== session.id) break;
					toast("Prompt cache missed; this turn reprocessed the full context.", {
						duration: 6000,
					});
					break;
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
				case "error":
					setIsStreaming(false);
					liveTurnStore.finish();
					// Show the failure where the reply would have been — otherwise a
					// failed run looks like a send that silently went nowhere.
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
			// Tell the server we stopped watching, so it can drop the transcript
			// stream and our presence entry (otherwise we linger as a ghost viewer).
			// send() is a no-op unless the socket is OPEN, so a dropped connection
			// (the usual reason this effect re-runs) never throws here.
			send({ type: "unwatch", sessionId: session.id });
		};
		// transcriptPath in deps: new sessions start without a transcript file —
		// re-watch once it appears so the live tail attaches
	}, [session.id, connected, session.transcriptPath, liveTurnStore]);

	// Drop optimistic bubbles once their real turn shows up. Each pending message
	// is claimed (one-to-one) either by a transcript user entry recorded around or
	// after we sent it, or by a server-confirmed queued entry (the busy path).
	// A long-unmatched bubble is dropped so a dead send never sticks as "sending…".
	useEffect(() => {
		setPending((prev) => {
			if (prev.length === 0) return prev;
			const userPool = entries
				.filter((e) => e.type === "user")
				.map((e) => ({
					c: e.content.trim(),
					t: new Date(e.timestamp).getTime(),
				}));
			// A just-sent message is confirmed by a queued echo, a steer receipt
			// (busy/fold-in path), or a real transcript user entry.
			const echoPool = [...queued, ...steered].map((q) => q.content.trim());
			const remaining = prev.filter((p) => {
				const c = p.content.trim();
				const qi = echoPool.indexOf(c);
				if (qi >= 0) {
					echoPool.splice(qi, 1);
					return false;
				}
				// Interrupt/steer-path sends land in the transcript with a "[user] "
				// attribution prefix (added server-side), while the optimistic bubble
				// holds the raw text — accept either form so a redirected message's
				// bubble reconciles instead of sticking as "redirecting…".
				const attributed = p.user ? `[${p.user}] ${c}` : c;
				const ui = userPool.findIndex(
					(u) => (u.c === c || u.c === attributed) && u.t >= p.sentAt - 30_000,
				);
				if (ui >= 0) {
					userPool.splice(ui, 1);
					return false;
				}
				// Steers pending at the same turn boundary get joined into ONE user
				// turn ("\n\n"-separated, each with its attribution prefix), possibly
				// alongside a harness nudge — so the exact match above never fires.
				// The "[user] " prefix is distinctive enough to claim by containment.
				// Don't splice: the same joined entry may cover other bubbles too.
				if (
					p.user &&
					userPool.some(
						(u) => u.c.includes(attributed) && u.t >= p.sentAt - 30_000,
					)
				) {
					return false;
				}
				return Date.now() - p.sentAt < 120_000;
			});
			return remaining.length === prev.length ? prev : remaining;
		});
	}, [entries, queued, steered]);

	// A steer receipt is reconciled away once its message lands in the transcript
	// (its turn started) — until then it's the only visible record of the fold-in.
	const visibleSteered = useMemo(() => {
		if (steered.length === 0) return steered;
		const userPool = entries
			.filter((e) => e.type === "user")
			.map((e) => e.content.trim());
		return steered.filter((s) => {
			const raw = s.content.trim();
			// Same attribution prefix as the transcript entry — match either form.
			const attributed = s.user ? `[${s.user}] ${raw}` : raw;
			const i = userPool.findIndex((u) => u === raw || u === attributed);
			if (i >= 0) {
				userPool.splice(i, 1);
				return false;
			}
			// Same composite case as the pending reconcile: co-released steers land
			// joined in one user turn — claim by containment (no splice; one joined
			// entry can cover several receipts).
			if (s.user && userPool.some((u) => u.includes(attributed))) return false;
			return true;
		});
	}, [steered, entries]);

	// Forget optimistic bubbles and any leftover stream state when switching
	// sessions — the component isn't remounted per session, so a streaming
	// bubble (now kept alive briefly past stream_done) would otherwise bleed
	// into the next session's view.
	useEffect(() => {
		setPending(
			initialPending
				? [{ id: `pending-initial-${session.id}`, ...initialPending }]
				: [],
		);
		liveTurnStore.clear();
		setIsStreaming(false);
	}, [session.id, liveTurnStore]);

	// Every session opens at the live edge. Do this in a layout effect so the
	// transcript never paints at scrollTop 0 before moving to the end.
	const initiallyScrolledSessionRef = useRef<string | null>(
		cachedTranscript ? session.id : null,
	);
	const [initialScrollSession, setInitialScrollSession] = useState<string | null>(
		null,
	);
	const restoredCachedScrollRef = useRef(false);
	useLayoutEffect(() => {
		if (!cachedTranscript || restoredCachedScrollRef.current || chatHidden) return;
		const el = messagesRef.current;
		if (!el) return;
		restoredCachedScrollRef.current = true;
		if (cachedTranscript.following) {
			el.scrollTop = el.scrollHeight;
			setInitialScrollSession(session.id);
			return;
		}
		el.scrollTop = Math.min(
			cachedTranscript.scrollTop,
			Math.max(0, el.scrollHeight - el.clientHeight),
		);
		const anchor = cachedTranscript.anchorEid
			? el.querySelector<HTMLElement>(
					`[data-eid="${CSS.escape(cachedTranscript.anchorEid)}"]`,
				)
			: null;
		if (anchor && cachedTranscript.anchorTop !== null) {
			const containerTop = el.getBoundingClientRect().top;
			// Restore by content identity first: raw scrollTop came from intrinsic
			// estimates, while the entry id survives remounts and settling heights.
			el.scrollTop +=
				anchor.getBoundingClientRect().top -
				containerTop -
				cachedTranscript.anchorTop;
			startHistoryHold(anchor, 3000, null);
			return;
		}
		const fallback = pickScrollAnchor(el);
		if (fallback) startHistoryHold(fallback, 3000, null);
	}, [
		cachedTranscript,
		entries,
		messagesRef,
		session.id,
		chatHidden,
		startHistoryHold,
	]);
	useLayoutEffect(() => {
		const el = messagesRef.current;
		if (
			!el ||
			transcriptReadySessionRef.current !== session.id ||
			initiallyScrolledSessionRef.current === session.id ||
			entries.length === 0
		)
			return;
		initiallyScrolledSessionRef.current = session.id;
		scrollToLatest("auto");
		setInitialScrollSession(session.id);
	}, [entries, session.id, chatHidden, scrollToLatest, messagesRef]);
	// Message blocks use content-visibility with estimated heights. Those estimates
	// resolve after the first scroll calculation without a React update, growing the
	// transcript above the viewport. Hold the bottom through that initial browser
	// layout pass, but release immediately if the reader touches the transcript.
	useLayoutEffect(() => {
		if (initialScrollSession !== session.id) return;
		const el = messagesRef.current;
		if (!el) return;

		let stopped = false;
		const keepAtLatest = () => {
			if (!stopped) el.scrollTop = el.scrollHeight;
		};
		const sizes = new ResizeObserver(keepAtLatest);
		const observeChildren = () => {
			for (const child of el.children) sizes.observe(child);
		};
		const children = new MutationObserver(() => {
			observeChildren();
			keepAtLatest();
		});
		let expiry: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			sizes.disconnect();
			children.disconnect();
			if (expiry) clearTimeout(expiry);
			el.removeEventListener("wheel", stop);
			el.removeEventListener("touchstart", stop);
			el.removeEventListener("pointerdown", stop);
			window.removeEventListener("keydown", stopForScrollKey);
		};
		const stopForScrollKey = (event: KeyboardEvent) => {
			if (!focused) return;
			if (
				["PageUp", "PageDown", "Home", "End"].includes(event.key) ||
				(event.ctrlKey &&
					event.shiftKey &&
					(event.key === "ArrowUp" || event.key === "ArrowDown"))
			)
				stop();
		};

		observeChildren();
		children.observe(el, { childList: true });
		el.addEventListener("wheel", stop, { passive: true });
		el.addEventListener("touchstart", stop, { passive: true });
		el.addEventListener("pointerdown", stop, { passive: true });
		window.addEventListener("keydown", stopForScrollKey);
		expiry = setTimeout(stop, 3000);
		keepAtLatest();
		return stop;
	}, [initialScrollSession, session.id, chatHidden, messagesRef]);

	// Returning to the app reads like reopening the session, not resuming a
	// paused one. On the iOS PWA the page survives backgrounding with the scroll
	// parked wherever it was; on desktop a hidden tab keeps streaming below the
	// fold. So when the tab turns visible again, jump to the live edge if the
	// transcript grew while hidden — or if we were away long enough that this is
	// a reopen, not a glance at another app. Growth often only lands moments
	// AFTER visibility (the PWA's WebSocket reconnects first, then backfills),
	// so a short watch window catches late arrivals. A real reader gesture
	// cancels the pending jump — their hands on the transcript always win.
	const lastEntryIdRef = useRef<string | null>(null);
	lastEntryIdRef.current =
		entries.length > 0 ? entries[entries.length - 1].id : null;
	const streamLenRef = useRef(0);
	streamLenRef.current = liveTurnStore.textLength();
	const hiddenSnapRef = useRef<{
		at: number;
		lastEntryId: string | null;
		streamLen: number;
	} | null>(null);
	const resumeWatchRef = useRef<{
		until: number;
		lastEntryId: string | null;
		streamLen: number;
	} | null>(null);
	useEffect(() => {
		hiddenSnapRef.current = null;
		resumeWatchRef.current = null;
	}, [session.id]);
	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState === "hidden") {
				hiddenSnapRef.current = {
					at: Date.now(),
					lastEntryId: lastEntryIdRef.current,
					streamLen: streamLenRef.current,
				};
				resumeWatchRef.current = null;
				return;
			}
			const snap = hiddenSnapRef.current;
			hiddenSnapRef.current = null;
			if (!snap) return;
			const grew =
				lastEntryIdRef.current !== snap.lastEntryId ||
				streamLenRef.current > snap.streamLen;
			if (grew || Date.now() - snap.at >= HIDDEN_REOPEN_MS) {
				scrollToLatest("auto");
			} else {
				resumeWatchRef.current = {
					until: performance.now() + RESUME_GROWTH_WINDOW_MS,
					lastEntryId: snap.lastEntryId,
					streamLen: snap.streamLen,
				};
			}
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () =>
			document.removeEventListener("visibilitychange", onVisibility);
	}, [scrollToLatest]);
	// The late-arrival half of the resume jump: growth landing inside the watch
	// window (WS backfill after a PWA resume) completes the jump to the edge.
	useEffect(() => {
		const watch = resumeWatchRef.current;
		if (!watch) return;
		if (performance.now() > watch.until) {
			resumeWatchRef.current = null;
			return;
		}
		if (lastEntryIdRef.current !== watch.lastEntryId) {
			resumeWatchRef.current = null;
			scrollToLatest("auto");
		}
	}, [entries, scrollToLatest]);
	useEffect(
		() =>
			liveTurnStore.subscribe(() => {
				streamLenRef.current = liveTurnStore.textLength();
				const watch = resumeWatchRef.current;
				if (
					watch &&
					performance.now() <= watch.until &&
					streamLenRef.current > watch.streamLen
				) {
					resumeWatchRef.current = null;
					scrollToLatest("auto");
				}
				relayout();
			}),
		[liveTurnStore, relayout, scrollToLatest],
	);
	useEffect(() => {
		const el = messagesRef.current;
		if (!el) return;
		const cancelResumeJump = () => {
			resumeWatchRef.current = null;
		};
		el.addEventListener("touchstart", cancelResumeJump, { passive: true });
		el.addEventListener("wheel", cancelResumeJump, { passive: true });
		return () => {
			el.removeEventListener("touchstart", cancelResumeJump);
			el.removeEventListener("wheel", cancelResumeJump);
		};
	}, [messagesRef]);

	// After any content change: keep a following reader at the live edge, or maintain
	// the pinned-turn spacer for a turn streaming into the space below (principles 4–6).
	// Layout effect so the adjustment happens before the browser paints — no flicker.
	useLayoutEffect(() => {
		relayout();
	}, [entries, queued, visibleSteered, pending, relayout]);

	// The landing half of "jump to the start": the walk's last page arrives with
	// this commit, so the scroll has to wait for it. After relayout (source order
	// = effect order) so nothing re-pins the reader afterwards.
	useLayoutEffect(() => {
		if (!scrollToTopRef.current) return;
		scrollToTopRef.current = false;
		const el = messagesRef.current;
		if (el) el.scrollTop = 0;
	}, [entries, messagesRef]);


	// Ref mirror keeps rapid clicks from sending duplicate history requests
	// before React re-renders with the disabled button.
	const loadingHistoryRef = useRef(false);
	useEffect(() => {
		loadingHistoryRef.current = loadingHistory;
	}, [loadingHistory]);
	// One page request. `whole` is the jump-to-start variant: a fat page in seq
	// mode, and in legacy mode the deliberately cursor-less request the server
	// answers with the entire transcript in one transcript_init — byte-window
	// paging has no cheap way to walk a backlog, and that full resend has always
	// been its fallback.
	const requestHistoryPage = useCallback(
		(whole = false) => {
			const seqState = transcriptSeqRef.current;
			if (seqState?.sessionId === session.id) {
				// Seq mode (transcript v2): page backwards from the earliest seq we
				// hold. Without a usable cursor the server falls back to a full
				// legacy resend, same as the legacy no-offset case below.
				send({
					type: "load_history",
					sessionId: session.id,
					...(seqState.firstSeq !== null && seqState.firstSeq > 1
						? { beforeSeq: seqState.firstSeq }
						: {}),
					...(whole ? { limit: JUMP_PAGE_ENTRIES } : {}),
				});
				return;
			}
			const cursor = transcriptCursorRef.current;
			send({
				type: "load_history",
				sessionId: session.id,
				...(!whole &&
				historyStartRef.current !== null &&
				historyStartRef.current > 0
					? {
							beforeOffset: historyStartRef.current,
							beforeRev:
								cursor?.sessionId === session.id ? cursor.rev : undefined,
						}
					: {}),
			});
		},
		[send, session.id],
	);
	// Shared preamble: stop tracking the live edge, and pin the reader to the
	// content they're on while the page prepends above it.
	const beginHistoryLoad = useCallback(() => {
		leaveLatest();
		const el = messagesRef.current;
		if (el) {
			// Anchor on the tightest element at the viewport top — it sits below
			// everything the prepend inserts, so its content offset shifts by
			// exactly the added height (what native scroll anchoring would pick).
			const node = pickScrollAnchor(el);
			if (node)
				startHistoryHold(node, 8000, {
					height: el.scrollHeight,
					top: el.scrollTop,
				});
		}
		setLoadingHistory(true);
	}, [leaveLatest, messagesRef, startHistoryHold]);
	const loadEarlierHistory = useCallback(() => {
		if (!historyTruncated || loadingHistoryRef.current) return;
		loadingHistoryRef.current = true;
		beginHistoryLoad();
		requestHistoryPage();
	}, [beginHistoryLoad, historyTruncated, requestHistoryPage]);
	// The whole backlog, one click: each page's arrival schedules the next (see
	// the transcript_history handler). `loadingHistory` deliberately stays true
	// across the gaps, which is what keeps the auto-load sentinel and a second
	// click from interleaving requests of their own.
	const jumpToStart = useCallback(() => {
		if (!historyTruncated || loadingHistoryRef.current) return;
		loadingHistoryRef.current = true;
		jumpRef.current = { sessionId: session.id, loaded: 0, cursor: null };
		setJumpingToStart(true);
		beginHistoryLoad();
		requestHistoryPage(true);
	}, [beginHistoryLoad, historyTruncated, requestHistoryPage, session.id]);
	// Landing. The hold's whole job is keeping the reader where they were, which
	// is precisely what we're overriding, so drop it first. scrollTop 0 is the
	// one position that survives the fresh bubbles' content-visibility estimates
	// settling — everything that resizes does so below it.
	const finishJumpToStart = useCallback(() => {
		if (!jumpRef.current) return;
		jumpRef.current = null;
		setJumpingToStart(false);
		stopHistoryHold();
		scrollToTopRef.current = true;
		const el = messagesRef.current;
		if (el) el.scrollTop = 0;
	}, [messagesRef, stopHistoryHold]);

	// Auto-load is driven by upward reader intent, never by viewport geometry
	// alone. That keeps initial hydration and programmatic bottom settling from
	// fetching history while still preloading a page as the reader approaches it.
	const historyGestureUntilRef = useRef(0);
	const historyGestureConsumedRef = useRef(true);
	const lastHistoryWheelAtRef = useRef(0);
	const lastHistoryScrollTopRef = useRef(0);
	const handleMessagesScroll = useCallback(() => {
		const el = messagesRef.current;
		const previous = lastHistoryScrollTopRef.current;
		const current = el?.scrollTop ?? previous;
		lastHistoryScrollTopRef.current = current;
		onScroll();
		const cached = transcriptViewCache.get(session.id);
		if (el && cached) {
			const anchor = pickScrollAnchor(el);
			cacheTranscriptView(session.id, {
				...cached,
				scrollTop: current,
				following: followingLive.current,
				anchorEid: anchor?.dataset.eid ?? null,
				anchorTop: anchor
					? anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
					: null,
			});
		}
		if (
			el &&
			current < previous - 1 &&
			current <= 600 &&
			!historyGestureConsumedRef.current &&
			performance.now() <= historyGestureUntilRef.current
		) {
			historyGestureConsumedRef.current = true;
			historyGestureUntilRef.current = 0;
			loadEarlierHistory();
		}
	}, [followingLive, loadEarlierHistory, messagesRef, onScroll, session.id]);
	useEffect(() => {
		const el = messagesRef.current;
		if (!el || chatHidden) return;
		historyGestureUntilRef.current = 0;
		historyGestureConsumedRef.current = true;
		lastHistoryWheelAtRef.current = 0;
		lastHistoryScrollTopRef.current = el.scrollTop;
		let touchY: number | null = null;
		const nearHistory = () => {
			if (historyGestureConsumedRef.current || el.scrollTop > 600) return;
			historyGestureConsumedRef.current = true;
			historyGestureUntilRef.current = 0;
			loadEarlierHistory();
		};
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY >= 0) return;
			const now = performance.now();
			if (now - lastHistoryWheelAtRef.current > 200)
				historyGestureConsumedRef.current = false;
			lastHistoryWheelAtRef.current = now;
			historyGestureUntilRef.current = now + 1200;
			nearHistory();
		};
		const onTouchStart = (event: TouchEvent) => {
			touchY = event.touches[0]?.clientY ?? null;
			historyGestureConsumedRef.current = false;
		};
		const onTouchMove = (event: TouchEvent) => {
			const y = event.touches[0]?.clientY;
			if (y === undefined || touchY === null) return;
			if (y > touchY + 1) {
				historyGestureUntilRef.current = performance.now() + 6000;
				nearHistory();
			}
			touchY = y;
		};
		const onPointerDown = (event: PointerEvent) => {
			// Classic scrollbar drags hit the container beyond its content box.
			if (
				event.target === el &&
				(event.offsetX >= el.clientWidth || event.offsetY >= el.clientHeight)
			) {
				historyGestureConsumedRef.current = false;
				historyGestureUntilRef.current = performance.now() + 1500;
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (!focused) return;
			const upward =
				event.ctrlKey &&
				event.shiftKey &&
				!event.metaKey &&
				!event.altKey &&
				event.key === "ArrowUp";
			if (!upward) return;
			historyGestureConsumedRef.current = false;
			historyGestureUntilRef.current = performance.now() + 1200;
			nearHistory();
		};
		el.addEventListener("wheel", onWheel, { passive: true });
		el.addEventListener("touchstart", onTouchStart, { passive: true });
		el.addEventListener("touchmove", onTouchMove, { passive: true });
		el.addEventListener("pointerdown", onPointerDown, { passive: true });
		window.addEventListener("keydown", onKeyDown);
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("touchstart", onTouchStart);
			el.removeEventListener("touchmove", onTouchMove);
			el.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [focused, session.id, chatHidden, loadEarlierHistory, messagesRef]);

	// When a turn finishes, release the spacer so the layout settles back.
	const wasBusyRef = useRef(false);
	useEffect(() => {
		if (wasBusyRef.current && !isBusy) endTurn();
		wasBusyRef.current = isBusy;
	});

	// Codex-model sessions start fresh threads server-side; only Claude-model
	// sessions need an existing claude session id to resume.
	const effectiveModel = model || defaultModel;
	const isCodexModel = modelIsCodex(effectiveModel, models);
	// A backstage chat with no engine ids is a *fresh* chat (e.g. a new sibling
	// from the tab strip's +): the composer stays enabled — its first prompt
	// starts a new engine conversation server-side (see runSessionPrompt). Only
	// non-backstage sources with no engine to resume stay read-only.
	const noEngine =
		!isCodexModel &&
		!session.claudeSessionId &&
		!session.codexThreadId &&
		session.source !== "backstage";
	const busySendLabel = `Queue — ${AGENT_NAME} sees it after fully finishing this run`;
	// Exact engine-state forks use Claude's SDK forkSession. Other backends can
	// still fork as a new sibling with a transcript handoff.
	const canForkSession =
		session.source === "backstage" &&
		!!(session.claudeSessionId || session.codexThreadId || session.transcriptPath);

	const handleFork = useCallback((messageId: string) => {
		setForkFrom(messageId);
	}, []);

	// Session-id links navigate on a delegated click — e.g. jump from an
	// orchestrator into the worker it spawned. Delegated because markdown.ts
	// renders its session chips into message/tool HTML via
	// dangerouslySetInnerHTML, where they can't carry React handlers; anything
	// else in the transcript opts in the same way, by carrying data-session-id.
	const handleMessagesClick = useCallback(
		(e: React.MouseEvent) => {
			const el = (e.target as HTMLElement).closest?.(
				"[data-session-id]",
			) as HTMLElement | null;
			const id = el?.dataset.sessionId;
			if (!id || !onOpenSession) return;
			// Modified clicks on href-carrying chips (markdown links to session
			// URLs) keep native browser behavior (open in new tab, etc.).
			if ((e.metaKey || e.ctrlKey || e.shiftKey) && el?.getAttribute("href"))
				return;
			e.preventDefault();
			onOpenSession(id);
		},
		[onOpenSession],
	);

	// "Add chat transcripts" chips on a fresh chat's blank canvas: sibling
	// workspace chats the user can attach as context — selected ids ride the
	// first send as `contextChats` and the server inlines a fenced transcript
	// digest of each. One-shot: cleared once a send consumes them.
	const [contextChats, setContextChats] = useState<string[]>([]);
	const [showAllContextChats, setShowAllContextChats] = useState(false);
	const contextChatOptions = useMemo(() => {
		// Whole workspace, archived chats included — the common case is exactly a
		// closed (archived-after-merge) sibling whose context the new chat needs.
		// workspaceChats (the live tab strip) is the fallback when the chat has no
		// workspace id of its own.
		const siblings = session.projectId
			? (allSessions || []).filter((c) => c.projectId === session.projectId)
			: workspaceChats || [];
		return siblings
			.filter(
				(c) =>
					c.id !== session.id &&
					// Legacy hidden sessions are not valid workspace context options.
					!c.sideChatOf &&
					// Only chats with something to hand over — a transcript or at
					// least a started engine thread.
					(c.transcriptPath || c.claudeSessionId || c.codexThreadId),
			)
			.sort((a, b) =>
				(b.lastActivity || "").localeCompare(a.lastActivity || ""),
			);
	}, [allSessions, workspaceChats, session.id, session.projectId]);
	useEffect(() => {
		setContextChats([]);
		setShowAllContextChats(false);
	}, [session.id]);

	const currentUser = useCurrentUser();
	// The review request is stored per chat, but the sidebar's "Awaiting/Needs
	// review" bands group by workspace — so a request set on a sibling chat lit
	// the band while the open chat's Reviewer chip read empty. Surface the
	// workspace's request in the chip: the open chat's own if it has one, else a
	// sibling's, carrying the owner id so clear/re-assign target the right chat.
	// GitHub's own review requests ride alongside: the sidebar's "Needs review"
	// band lights up for those too (review-queue's `requested` source), so the
	// chip has to know about them or a PR waiting on you reads as an empty
	// "Request review". Person keys, workspace-wide, author already dropped
	// server-side; GitHub clears the set once the reviewer submits. Open PRs
	// only — the cached reviewer list outlives a close/merge, and the sidebar's
	// band (built from the open-PR list) drops those rows the moment they land.
	const effectiveReview = useMemo(() => {
		const owner = session.reviewRequest
			? session
			: (workspaceChats || []).find((c) => c.reviewRequest);
		const request = owner?.reviewRequest ?? null;
		const completion =
			owner && request ? prReviewCompletion(request, owner) : null;
		const githubPending = [
			...new Set(
				[session, ...(workspaceChats || [])]
					.filter((c) => c.prState === "OPEN")
					.flatMap((c) =>
						(c.prReviewRequested || []).map((person) => person.toLowerCase()),
					),
			),
		];
		return {
			req: request
				? completion
					? { ...request, accepted: completion }
					: request
				: null,
			ownerId: owner?.id ?? session.id,
			acceptedFromPr: !!completion,
			githubPending,
			myReviewNeeded: githubPending.includes(personKey(currentUser)),
		};
	}, [
		session.reviewRequest,
		session.id,
		session.prReviewedBy,
		session.prReviewRequested,
		session.prUpdatedAt,
		session.prState,
		workspaceChats,
		currentUser,
	]);

	// Returns true when the message was consumed, so the (uncontrolled)
	// Composer knows to clear its draft; false keeps it for a retry.
	function handleSend(raw: string, opts?: { steer?: boolean }): boolean {
		const sendStartedAt = performance.now();
		const text = raw.trim();
		const imgs = images;
		const fls = files;
		if (!text && imgs.length === 0 && fls.length === 0) return false;
		if (!connected) return false;

		// Note mode: post a team note to the session's chat channel — never a
		// prompt. The broadcast echoes it back into `notes` for every viewer.
		if (noteMode) {
			if (!text) return false;
			postChatMessageApi(`session:${session.id}`, text, getCurrentUser()).catch(
				() => toast("Failed to add note"),
			);
			return true;
		}

		const user = getCurrentUser();
		// Prefer the staged disk path (HTTP upload); fall back to inline dataUrl.
		const filePayload = fls.map((f) =>
			f.path ? { name: f.name, path: f.path } : { name: f.name, dataUrl: f.dataUrl },
		);

		// Fork mode: branch a brand-new session from the selected message, keeping
		// the real conversation history. App navigates into it on session_created.
		if (forkFrom) {
			send({
				type: "create_session",
				branch: "",
				prompt: text || "Continue from here.",
				user,
				forkFrom: { sourceId: session.id, messageId: forkFrom },
				...(imgs.length ? { images: imgs } : {}),
				...(fls.length ? { files: filePayload } : {}),
			});
			setForkFrom(null);
			setImages([]);
			setFiles([]);
			return true;
		}

		if (noEngine) return false;
		// Two follow-up behaviors while busy: plain send QUEUES (parked until
		// the run FULLY finishes — including any auto-continue turns the server
		// holds the queue behind), and the steer button / ⌘Ctrl+Enter STEERS
		// (folds into the LIVE run at its next step boundary — busyMode:"steer",
		// real in-band steering since 2026-07-12; the server falls back to the
		// queue when nothing is steerable or files are attached). The turn keeps
		// running on both paths: no abort, no lost work. Idle: just run it.
		// Attachments ride along on every path — images fold into the run as
		// content blocks; files route to the queue server-side.
		const steerNow = isBusy && !!opts?.steer;
		send(
			isBusy
				? steerNow
					? {
							type: "prompt" as const,
							sessionId: session.id,
							content: text,
							user,
							effort,
							fastMode,
							busyMode: "steer" as const,
							...(imgs.length ? { images: imgs } : {}),
							...(fls.length ? { files: filePayload } : {}),
						}
					: {
							type: "prompt" as const,
							sessionId: session.id,
							content: text,
							user,
							effort,
							fastMode,
							busyMode: "queue" as const,
							...(imgs.length ? { images: imgs } : {}),
							...(fls.length ? { files: filePayload } : {}),
						}
				: {
						type: "prompt" as const,
						sessionId: session.id,
						content: text,
						user,
						effort,
						fastMode,
						...(imgs.length ? { images: imgs } : {}),
						...(fls.length ? { files: filePayload } : {}),
						// Attached sibling-chat transcripts (fresh chats are idle, so the
						// chips' selection always leaves through this branch).
						...(contextChats.length ? { contextChats } : {}),
					},
		);
		// Prompting in a chat you'd hidden from your sidebar brings its row back
		// — you're working in it again (see lib/hides.ts).
		unhideForChat(session);
		if (!isBusy) {
			setIsRunningLive(true);
			onRunningChange?.(session.id, true);
			// Show it immediately; it reconciles away when the real transcript entry
			// arrives (or the queue echo, if the server turns out to be busy).
			setPending((p) => [
				...p,
				{
					id: `pending-${crypto.randomUUID()}`,
					content: text,
					user,
					sentAt: Date.now(),
					images: imgs.length ? imgs : undefined,
				},
			]);
			requestAnimationFrame(() =>
				measureChatPerf("send_to_optimistic_paint_ms", sendStartedAt),
			);
		} else {
			// Busy send: show it in the queue flap right away (no transcript
			// bubble — a steer folds into the RUNNING turn) — the
			// server's queue_update / steer-receipt echo replaces it.
			setPending((p) => [
				...p,
				{
					id: `pending-${crypto.randomUUID()}`,
					content: text,
					user,
					sentAt: Date.now(),
					images: imgs.length ? imgs : undefined,
					busyMode: steerNow ? ("steer" as const) : ("queue" as const),
				},
			]);
		}
		// Your own send always lands in view. relayout's glue only runs while
		// `following`, so once the reader has scrolled up into history the
		// optimistic bubble arrives below the fold with nothing moving — and a
		// send is unambiguous intent to watch this turn. Instant, not smooth: the
		// glue that follows sets scrollTop directly and would fight an animation.
		scrollToLatest("auto");
		setImages([]);
		setFiles([]);
		setContextChats([]);
		measureChatPerf("send_handler_ms", sendStartedAt);
		return true;
	}

	function queueHasFiles(item: QueueReceipt): boolean {
		return Array.isArray(item.files) && item.files.length > 0;
	}

	function renderQueueContent(
		item: QueueReceipt,
		opts: { human?: ReturnType<typeof parseHumanReply>; github?: boolean },
	) {
		const firstImage = item.images?.[0];
		const extraImages = Math.max(0, (item.images?.length ?? 0) - 1);
		// An agent-to-agent delivery (worker report, finished-workflow nudge)
		// carries a sentinel the human should never see — strip it here too, so a
		// message in flight reads the same as the card it becomes.
		const worker = opts.human ? null : parseWorkerReport(item.content);
		const workflow = opts.human || worker ? null : parseWorkflowNotice(item.content);
		const sessionNotice =
			opts.human || worker || workflow ? null : parseSessionNotice(item.content);
		const body = opts.human
			? opts.human.body
			: (worker?.body ?? workflow?.body ?? sessionNotice?.body ?? item.content);
		return (
			<div className="composer-queue-content flex min-w-0 items-start gap-2 pr-28">
				{firstImage && (
					<div className="composer-queue-image relative mt-px h-[34px] w-[46px] shrink-0">
						<img className="block size-full rounded-md border border-line object-cover" src={firstImage} alt="" />
						{extraImages > 0 && (
							<span className="composer-queue-image-count absolute -bottom-1 -right-1 h-[18px] min-w-[18px] rounded-full border border-line bg-raised px-1 text-center text-meta font-bold leading-4 text-dim">+{extraImages}</span>
						)}
					</div>
				)}
				<div className={cn("composer-queue-body min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-control-label leading-[1.45] text-fg", opts.human && "text-[color-mix(in_srgb,var(--text)_88%,#1f9e8a)]", opts.github && "text-dim")}>
					{opts.human && (
						<span className="composer-queue-from">💬 {opts.human.name}</span>
					)}
					{opts.github && <span className="composer-queue-from">GitHub</span>}
					{worker && <span className="composer-queue-from">🤖 Worker report</span>}
					{workflow && <span className="composer-queue-from">⚙️ Workflow</span>}
					{sessionNotice && (
						<span className="composer-queue-from">System message</span>
					)}
					{body}
				</div>
			</div>
		);
	}

	// "Edit" pulls the message back into the composer: drop it from the queue
	// and hand its parts (text, images, files) to the draft — sending simply
	// re-queues the edited version.
	function editQueuedInComposer(q: QueueReceipt, index: number) {
		send({
			type: "delete_queued_prompt",
			sessionId: session.id,
			queueId: q.id,
			queueIndex: index,
		});
		if (q.images?.length) {
			const imgs = q.images;
			setImages((prev) => [...prev, ...imgs]);
		}
		if (Array.isArray(q.files) && q.files.length > 0) {
			const fls = q.files as FileAttachment[];
			setFiles((prev) => [...prev, ...fls]);
		}
		setComposerPrefill((p) => ({ seq: (p?.seq ?? 0) + 1, text: q.content }));
	}

	function handleQueueReorder(next: QueueReceipt[]) {
		pendingReorderRef.current = next;
		setQueued(next);
	}

	function commitQueueReorder() {
		draggingQueueRef.current = false;
		const next = pendingReorderRef.current;
		pendingReorderRef.current = null;
		if (!next) return;
		const order = next
			.map((q) => q.id)
			.filter((id): id is string => typeof id === "string");
		if (order.length > 1) {
			send({ type: "reorder_queued_prompt", sessionId: session.id, order });
		}
	}

	// Busy sends live in the flap from the moment of the send; idle sends are
	// optimistic transcript bubbles. Both reconcile through the same effect.
	// While the worktree is still being prepared, everything holds in the flap —
	// including the create's own first message — until the workspace is ready.
	const pendingQueue = pending.filter((p) => p.busyMode || waitingForWorkspace);
	const pendingBubbles = pending.filter(
		(p) => !p.busyMode && !waitingForWorkspace,
	);
	const hasLiveConversation =
		pendingBubbles.length > 0 || liveTurnStore.hasText() || isBusy || !!ask;

	const queueCount = queued.length + visibleSteered.length + pendingQueue.length;
	// Steered receipts are NOT queued — they're already delivered into the
	// running turn and only shown here until it ends. Calling them "queued"
	// read as "my message didn't go through" (three times, 2026-07-19).
	const queuedOnlyCount = queued.length + pendingQueue.length;
	const queueTitle = waitingForWorkspace
		? `Waiting for workspace · ${queueCount} queued`
		: queuedOnlyCount === 0
			? `${visibleSteered.length} steered into the current turn`
			: visibleSteered.length === 0
				? `${queuedOnlyCount} queued ${queuedOnlyCount === 1 ? "message" : "messages"}`
				: `${queuedOnlyCount} queued · ${visibleSteered.length} steered`;
	const attachedQueue =
		queueCount > 0 ? (
			<div className="composer-queue relative -mb-3.5 mx-[18px] flex flex-col gap-2 rounded-t-lg border border-b-0 border-line bg-[color-mix(in_srgb,var(--bg-panel)_70%,var(--control-surface))] px-4 pb-[26px] pt-2.5" aria-label="Queued and steered messages">
				<div className="composer-queue-title text-label font-semibold text-faint">{queueTitle}</div>
				{visibleSteered.map((s, i) => {
					const hr = parseHumanReply(s.content);
					return (
						<div
							key={`steered-${i}`}
							className={cn("composer-queue-item composer-queue-steered relative min-h-[18.85px]", hr && "is-human")}
						>
							<div className="composer-queue-actions absolute -top-2 right-0 z-[1] inline-flex items-center gap-0.5">
								<Tooltip label="Already delivered into the running turn — shown here until the turn finishes">
									<span className="composer-queue-pill inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-transparent bg-accent-soft px-[13px] text-control-label font-semibold text-accent">
										<IconCrosshair size={20} />
										Steered
									</span>
								</Tooltip>
								{s.id && (
									<Tooltip label="Dismiss — the run keeps going; this message won't be re-sent">
										<button
											type="button"
											className="composer-queue-action danger"
											onClick={() =>
												send({
													type: "delete_queued_prompt",
													sessionId: session.id,
													queueId: s.id,
												})
											}
										>
											<IconTrash size={24} />
										</button>
									</Tooltip>
								)}
							</div>
							{renderQueueContent(s, { human: hr })}
						</div>
					);
				})}

				<Reorder.Group
					as="div"
					axis="y"
					values={queued}
					onReorder={handleQueueReorder}
					className="composer-queue-list flex flex-col gap-2"
				>
				{queued.map((q, i) => {
					const hr = parseHumanReply(q.content);
					const isGitHub = isGitHubAttribution(q.user);
					const id = q.id;
					const key = id || `queued-${i}`;
					const canSteer = !isGitHub && !queueHasFiles(q);
					// A one-item queue has nothing to reorder — leave drag off so the
					// lone message still selects/clicks normally.
					const canReorder = queued.length > 1;
					return (
						<Reorder.Item
							as="div"
							key={key}
							value={q}
							dragListener={canReorder}
							onDragStart={() => {
								draggingQueueRef.current = true;
							}}
							onDragEnd={commitQueueReorder}
							whileDrag={{ scale: 1.01, zIndex: 2 }}
							className={cn("composer-queue-item relative min-h-[18.85px]", canReorder && "is-draggable cursor-grab touch-none active:cursor-grabbing", hr && "is-human", isGitHub && "is-github")}
						>
							<div className="composer-queue-actions absolute -top-2 right-0 z-[1] inline-flex items-center gap-0.5">
								{isGitHub ? (
									<span className="composer-queue-pill composer-queue-pill-github inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised px-[13px] text-control-label font-semibold text-dim">
										<IconPullRequest size={20} />
										FYI
									</span>
								) : (
									<>
										<Tooltip label="Edit — puts the message back into the composer">
											<button
												type="button"
												className="composer-queue-action"
												onClick={() => editQueuedInComposer(q, i)}
											>
												<IconPencil size={24} />
											</button>
										</Tooltip>
									</>
								)}
								<Tooltip label="Delete queued message">
									<button
										type="button"
										className="composer-queue-action danger"
										onClick={() =>
											send({
												type: "delete_queued_prompt",
												sessionId: session.id,
												queueId: id,
												queueIndex: i,
											})
										}
									>
										<IconTrash size={24} />
									</button>
								</Tooltip>
								{!isGitHub && (
									<Tooltip
										label={
											canSteer
												? "Steer — fold into the running turn now, without stopping it"
												: "Messages with files cannot be steered"
										}
									>
										<button
											type="button"
											className="composer-queue-action composer-queue-steer"
											aria-label="Steer into the running turn"
											disabled={!canSteer}
											onClick={() =>
												send({
													type: "steer_queued_prompt",
													sessionId: session.id,
													queueId: id,
													queueIndex: i,
												})
											}
										>
											<IconArrowUp size={24} />
										</button>
									</Tooltip>
								)}
							</div>
							{renderQueueContent(q, { human: hr, github: isGitHub })}
						</Reorder.Item>
					);
				})}
				</Reorder.Group>

				{/* Just-sent while busy: already visually in the queue, awaiting the
				    server's echo (which swaps in the real item with actions). */}
				{pendingQueue.map((p) => (
					<div key={p.id} className="composer-queue-item composer-queue-sending relative min-h-[18.85px]">
						<div className="composer-queue-actions absolute -top-2 right-0 z-[1] inline-flex items-center gap-0.5">
							<span className="composer-queue-pill composer-queue-pill-sending inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised px-[13px] text-control-label font-semibold text-faint">
								{waitingForWorkspace ? "Queued" : "Queueing…"}
							</span>
						</div>
						{renderQueueContent(p, {})}
					</div>
				))}
			</div>
		) : null;

	function handleCancel() {
		send({ type: "cancel" });
	}

	function handleShare() {
		// Match the canonical URL App maintains: workspace-scoped when the chat
		// belongs to one, legacy /session/<id> only for workspace-less chats.
		const path = session.projectId
			? `${BASE_PATH}/workspace/${encodeURIComponent(session.projectId)}/chat/${encodeURIComponent(session.id)}`
			: `${BASE_PATH}/session/${encodeURIComponent(session.id)}`;
		const link = `${location.origin}${path}`;
		// Phone: native share sheet. Desktop: copy, with the inline check on
		// the button + a floating "Link copied" toast.
		shareLink(link, { toast: "Link copied", title: session.title || undefined });
	}

	function commitRename() {
		if (renameDraft !== null) {
			// When the header titles the workspace, renaming edits the workspace —
			// every sibling chat picks the new name up. Chat titles live on tabs.
			if (workspaceName && onRenameWorkspace)
				onRenameWorkspace(renameDraft.trim());
			else onRename?.(session.id, renameDraft.trim());
		}
		setRenameDraft(null);
	}

	// Drop an in-progress rename when switching sessions so the draft never bleeds
	// into the next session's header.
	useEffect(() => setRenameDraft(null), [session.id]);

	function handleModelChange(next: string) {
		const target = next || defaultModel;
		if (!target || target === (model || defaultModel)) return;
		setModel(next);
		// Routed through the /model slash command so it persists, notices, and
		// broadcasts to other viewers.
		send({
			type: "prompt",
			sessionId: session.id,
			content: `/model ${target}`,
			user: getCurrentUser(),
		});
	}

	// Pin (or clear, "" = auto) the current provider account for this session.
	// Same shape as the model switch: /account persists, notices,
	// and broadcasts subscription_changed to every viewer.
	function handleAccountChange(next: string) {
		if (next === (accountId || "")) return;
		setAccountId(next);
		const target = next ? accounts.find((a) => a.id === next) : null;
		if (target?.kind === "api_key") setFastMode(false);
		send({
			type: "prompt",
			sessionId: session.id,
			// The name reads better in the transcript; the command matches by
			// id first, then case-insensitive name, so either form works.
			content: next ? `/account ${target?.id || next}` : "/account auto",
			user: getCurrentUser(),
		});
	}

	// Pin or clear the session goal from the composer's Goal button. Routed
	// through the /goal slash command (handled backstage-side, not a real turn);
	// optimistically reflected via goalOverride until the session file catches up.
	function handleSetGoal(goal: string | null) {
		setGoalOverride(goal);
		send({
			type: "prompt",
			sessionId: session.id,
			content: goal ? `/goal ${goal}` : "/goal clear",
			user: getCurrentUser(),
		});
	}

	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [moveToCloudOpen, setMoveToCloudOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [archiving, setArchiving] = useState(false);
	const [deleteLabel, setDeleteLabel] = useState("");

	// Responsive header: when the top bar gets narrow (small window, sidebar +
	// workspace panel both open), the title truncates first (CSS), then the
	// Share button collapses into the ⋯ menu so it never overlaps the title.
	// (Pin stays inline beside Preview on desktop; Spin off lives in the ⋯ menu.) Measured on the
	// header element itself so it tracks the real available width regardless
	// of the surrounding chrome.
	const headerRef = useRef<HTMLDivElement>(null);
	const [headerW, setHeaderW] = useState(0);
	useLayoutEffect(() => {
		const el = headerRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) setHeaderW(e.contentRect.width);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [topbarEl]);
	// Collapse before the inline row can overrun: the title's non-shrinkable
	// floor (source chip + Working pill) plus the inline actions (facepile,
	// links, Share) needs ~740px, so below that Share moves into the ⋯ menu.
	const compactHeader = headerW > 0 && headerW < 740;

	// Phone layout (same 720px breakpoint as the CSS page-stack): the header
	// actions portal into the top bar next to the centered title, and every
	// secondary action folds into the ⋯ menu so the bar holds just ⋯ + Workspace.
	const [isPhone, setIsPhone] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(max-width: 720px)").matches,
	);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 720px)");
		const onChange = () => setIsPhone(mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	// Compact "agents running" flap above the composer — phone-only. On desktop
	// the Agents panel tab (with its pulsing dot) is always visible; on a phone
	// the right panel overlays the chat and is closed by default, so a running
	// workflow fan-out has no glance. ComposerAgents is the tappable
	// pill → mini-card → full-panel progression. Reuses the queue flap's
	// tuck-under styling.
	const runningWorkflowRuns = workflowRuns.filter((r) => r.status === "running");
	// Sub-agents ride along only while one is live, so a finished batch doesn't
	// pad a later workflow's tallies (their statuses clamp to done once the
	// session's run ends, so the flap can't stick around stale either).
	const anySubagentRunning = subagents.some((s) => s.status === "running");
	const agentBubble =
		isPhone && (runningWorkflowRuns.length > 0 || anySubagentRunning) ? (
			<ComposerAgents
				runs={runningWorkflowRuns}
				subagents={anySubagentRunning ? subagents : undefined}
				onOpenPanel={() => {
					selectPanelTab("workflows");
					setInfoPageOpen(true);
				}}
			/>
		) : null;

	// The composer takes a single `attached` node; stack the agents flap above
	// the queue flap when both are live.
	const attachedComposer =
		agentBubble || attachedQueue ? (
			<>
				{agentBubble}
				{attachedQueue}
			</>
		) : null;

	// Opened by picking this session's workspace in the sidebar: focus the
	// composer so you can start typing immediately. Runs on mount (a new session
	// remounts this component) and when the pulse re-fires for the already-open
	// session. Skipped on phones so we don't shove the keyboard over the chat.
	useEffect(() => {
		if (autoFocusComposer && !isPhone) composerRef.current?.focus();
	}, [autoFocusComposer, isPhone]);

	useEffect(() => {
		if (!composerPrefillExternal) return;
		setComposerPrefill(composerPrefillExternal);
		onComposerPrefillConsumed?.(composerPrefillExternal.seq);
		if (!isPhone) composerRef.current?.focus();
	}, [composerPrefillExternal, onComposerPrefillConsumed, isPhone]);

	const [overflowOpen, setOverflowOpen] = useState(false);
	// Left-edge swipe on phones pops the topmost overlay before the page stack:
	// the info page registers as a higher-priority back-swipe layer, so the
	// gesture closes it instead of popping the whole session back to the
	// sidebar (App's layer, priority 0).
	const infoPageRef = useRef<HTMLDivElement | null>(null);
	const infoHeroNameRef = useRef<HTMLDivElement | null>(null);
	useBackSwipe({
		active: isPhone && infoPageOpen,
		onBack: () => setInfoPageOpen(false),
		paneRef: infoPageRef,
		priority: 2,
	});
	useEffect(() => {
		if (!infoPageOpen) {
			setInfoPageScrolled(false);
			return;
		}
		const root = infoPageRef.current;
		const title = infoHeroNameRef.current;
		if (!root || !title) return;
		const topbar = root.querySelector<HTMLElement>(".session-info-topbar");
		const topInset = Math.ceil(topbar?.getBoundingClientRect().height || 52);
		const observer = new IntersectionObserver(
			([entry]) => setInfoPageScrolled(!entry.isIntersecting),
			{
				root,
				rootMargin: `-${topInset}px 0px 0px`,
				threshold: 0,
			},
		);
		observer.observe(title);
		return () => observer.disconnect();
	}, [infoPageOpen, isPhone]);
	useEffect(() => {
		if (!infoPageOpen) return;
		const app = document.querySelector<HTMLElement>(".app");
		app?.setAttribute("inert", "");
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setInfoPageOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			app?.removeAttribute("inert");
		};
	}, [infoPageOpen]);
	// The mobile top-bar title (rendered by App, outside this component) opens the
	// same settings menu — it toggles via a window event so it doesn't need a prop
	// thread through App's render.
	useEffect(() => {
		const toggle = () =>
			setInfoPageOpen((open) => {
				if (!open) {
					setInfoPageScrolled(false);
				}
				return !open;
			});
		window.addEventListener("backstage:toggle-session-settings", toggle);
		return () =>
			window.removeEventListener("backstage:toggle-session-settings", toggle);
	}, [session.id]);
	// Closing the menu disarms a half-finished delete confirm — reopening it
	// later shouldn't present the destructive choices without a fresh click.
	useEffect(() => {
		if (!overflowOpen && !infoPageOpen) setShowDeleteConfirm(false);
	}, [overflowOpen, infoPageOpen]);
	// The menu's contents change across the breakpoint — don't leave it stuck open.
	useEffect(() => {
		setOverflowOpen(false);
		setInfoPageOpen(false);
	}, [compactHeader]);

	const me = getCurrentUser();

	// Media items in the live transcript — bumping this refreshes the floating
	// overview panel as new screenshots land during a run.
	const liveMediaCount = useMemo(
		() =>
			entries.reduce(
				(n, e) => n + (e.images?.length || 0) + (e.videos?.length || 0),
				0,
			),
		[entries],
	);
	const liveOverviewMedia = useMemo<WorkspaceMediaItem[]>(() => {
		const fromImages = (
			items: Array<{ images?: string[]; sentAt?: number }>,
		): WorkspaceMediaItem[] =>
			items.flatMap((item) =>
				(item.images || []).map((src, i) => ({
					kind: "image" as const,
					src,
					sessionId: session.id,
					chatTitle: session.title,
					at: new Date((item.sentAt || Date.now()) + i).toISOString(),
				})),
			);
		return [
			...fromImages(pending),
			...fromImages(queued),
			...fromImages(visibleSteered),
		];
	}, [pending, queued, visibleSteered, session.id, session.title]);

	async function handleDelete(cleanWorktree: boolean) {
		setDeleteLabel(
			cleanWorktree ? "Deleting session and worktree…" : "Deleting session…",
		);
		setDeleting(true);
		try {
			await deleteSessionApi(session.id, cleanWorktree);
			// Leave the overlay up through the navigation so it never flashes back to
			// the (now-deleted) session view.
			onBack();
		} catch (e: any) {
			alert(`Delete failed: ${e.message}`);
			setDeleting(false);
			setShowDeleteConfirm(false);
		}
	}

	// Archive is the reversible "I'm done with this" — unlike delete it keeps the
	// session (and worktree) and just tucks it into the Archived view, so no
	// confirm step. Unarchiving from here keeps the session selected as it moves
	// back into the live sidebar.
	const handleArchive = useCallback(async () => {
		const next = !session.archived;
		setArchiving(true);
		setOverflowOpen(false);
		if (next && onArchive) {
			onArchive();
			return;
		}
		try {
			const { stoppedRun } = await archiveSessionApi(session.id, next);
			if (next) {
				onArchived?.(stoppedRun);
				onBack();
			}
		} catch (e: any) {
			alert(`${next ? "Archive" : "Unarchive"} failed: ${e.message}`);
			setArchiving(false);
		}
	}, [onArchive, onArchived, onBack, session.archived, session.id]);

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (!focused) return;
			if (
				e.defaultPrevented ||
				document.querySelector(
					".palette-backdrop, .composer-schedule-modal-backdrop, .session-delete-overlay",
				)
			) {
				return;
			}
			// Same composer exemption as the sidebar's archive chords: the
			// composer autofocuses, so an unconditional editable-focus bail
			// would leave ⌘E dead almost always. Other inputs keep the guard.
			const target = e.target as HTMLElement | null;
			const editable = target?.closest(
				"input, textarea, select, [contenteditable='true'], [contenteditable='']",
			);
			if (editable && !editable.classList.contains("composer-textarea")) {
				return;
			}
			// The sidebar handles live sessions when it can, because it knows which
			// visible row comes next. Keep this listener as the route-level fallback:
			// the viewer remains mounted even when the sidebar cannot handle the open
			// session. `defaultPrevented` above ensures only one handler fires.
			const k = e.key.toLowerCase();
			const archiveChord =
				(e.metaKey || e.ctrlKey) &&
				!e.altKey &&
				(((k === "e" || e.code === "KeyE") && !e.shiftKey) ||
					((k === "a" || e.code === "KeyA") && e.shiftKey));
			if (archiveChord && !archiving) {
				e.preventDefault();
				void handleArchive();
			}
		}
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [focused, archiving, handleArchive, session.archived]);

	// Preview environment for the ⌘O chord — mirrors StagingLink's poll (same
	// relevance gate; the server caches PR details for 30s, so the duplicate
	// fetch stays cheap). Kept here because StagingLink mounts per layout
	// variant, so a window listener inside it would register multiple times.
	const stagingRelevant =
		!!session.prUrl &&
		session.prState === "OPEN";
	const [staging, setStaging] = useState<{
		url: string;
		status: string;
		embeddable?: boolean;
	} | null>(null);
	// True once the PR fetch has resolved at least once for this session — lets us
	// tell "staging genuinely absent" from "not loaded yet" (the fetch starts null
	// and fills in async), so the Preview environment view-tab auto-closes only on the former
	// rather than flicker-closing during load.
	const [stagingSettled, setStagingSettled] = useState(false);
	useEffect(() => {
		setStagingSettled(false);
		if (!stagingRelevant) {
			setStaging(null);
			setStagingSettled(true);
			return;
		}
		let alive = true;
		const load = () =>
			fetchPr(session.id)
				.then((pr) => {
					if (alive) {
						setStaging(pr?.staging ?? null);
						setStagingSettled(true);
					}
				})
				.catch(() => {});
		load();
		const stop = pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
		return () => {
			alive = false;
			stop();
		};
	}, [session.id, stagingRelevant, gitRefreshTick]);
	const stagingUrl = staging
		? withPreviewPath(staging.url, session.previewPath)
		: null;
	// The Preview environment pane is a top-strip view-tab now (App owns whether it's
	// foregrounded). If the deploy vanishes while its tab is open+active — PR
	// merged/closed, so `stagingRelevant` drops and the fetch settles with no
	// staging — close the tab rather than leave it pointing at nothing.
	useEffect(() => {
		if (showStaging && stagingSettled && !stagingUrl) onCloseStaging?.();
	}, [showStaging, stagingSettled, stagingUrl, onCloseStaging]);
	// The Assets pane is a top-strip view-tab too (App owns whether it's
	// foregrounded). If the last asset is deleted while its tab is up, close it
	// rather than leave an empty pane pointing at nothing.
	useEffect(() => {
		if (showAssets && assetFiles.length === 0) onCloseAssets?.();
	}, [showAssets, assetFiles.length, onCloseAssets]);
	const [previewStatus, setPreviewStatus] = useState<PreviewStatus | null>(null);
	useEffect(() => setPreviewStatus(null), [session.id]);
	// The header preview control used to keep this status warm. Now that the
	// launcher lives in the overflow menu, poll only while its view tab is open.
	useEffect(() => {
		if (!showPreviewTab || !session.worktreeDir) return;
		let alive = true;
		const load = () =>
			fetchPreview(session.id)
				.then((status) => {
					if (alive) setPreviewStatus(status);
				})
				.catch(() => {});
		load();
		const stop = pollWhileVisible(load, 3000);
		return () => {
			alive = false;
			stop();
		};
	}, [showPreviewTab, session.id, session.worktreeDir]);

	// ⌘O opens the PR's preview environment (the Vercel preview StagingLink's globe
	// points at); ⌘G opens its GitHub PR. Chords without a target (no staging
	// deploy / no PR) fall through to the browser.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (!focused) return;
			if (
				e.defaultPrevented ||
				!(e.metaKey || e.ctrlKey) ||
				e.altKey ||
				e.shiftKey ||
				document.querySelector(
					".palette-backdrop, .composer-schedule-modal-backdrop, .session-delete-overlay",
				)
			) {
				return;
			}
			// Same composer exemption as the archive chords above: the composer
			// autofocuses, so an unconditional editable-focus bail would leave
			// these dead almost always. Other inputs keep the guard.
			const target = e.target as HTMLElement | null;
			const editable = target?.closest(
				"input, textarea, select, [contenteditable='true'], [contenteditable='']",
			);
			if (editable && !editable.classList.contains("composer-textarea")) {
				return;
			}
			const k = e.key.toLowerCase();
			if (k === "g") {
				// Primary branch's PR, falling back to the first attached/linked
				// repo PR on multi-repo sessions.
				const prUrl = session.prUrl ?? session.prs?.find((p) => p.url)?.url;
				if (!prUrl) return;
				e.preventDefault();
				window.open(prUrl, "_blank", "noopener");
			} else if (k === "o" && staging) {
				e.preventDefault();
				// Match the globe's click semantics: before the first deploy goes
				// Ready the branch alias 404s, so swallow the chord with the same
				// explanatory toast instead of opening a dead link. (A rebuild
				// after a push keeps status Ready and stays openable — the alias
				// serves the previous deploy until the new one lands.)
				if (staging.status !== "Ready") {
					toast(
						`Preview environment is ${staging.status.toLowerCase()} — the link goes live once the first deploy finishes`,
					);
					return;
				}
				window.open(
					withPreviewPath(staging.url, session.previewPath),
					"_blank",
					"noopener",
				);
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [focused, session.prUrl, session.prs, session.previewPath, staging]);


	return (
		<div className="session-viewer relative flex h-full min-h-0 flex-col">
			{localMode && session.local && (
				<MoveToCloudDialog
					open={moveToCloudOpen}
					sessionId={session.id}
					onOpenChange={setMoveToCloudOpen}
				/>
			)}
			{deleting && (
				<div
					className="session-delete-overlay absolute inset-0 z-30 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_72%,transparent)] backdrop-blur-[2px]"
					role="status"
					aria-live="polite"
				>
					<div className="flex flex-col items-center gap-[14px] rounded-xl border border-line bg-panel px-8 py-[26px] shadow-[0_8px_30px_rgba(0,0,0,0.35)]">
						<div className="restart-spinner" />
						<span className="session-delete-label">{deleteLabel}</span>
					</div>
				</div>
			)}
			{!hideHeader && (() => {
				// Share rides inline on a wide header but tucks into the ⋯ overflow
				// menu when it gets narrow. Both spellings use the link glyph, since
				// the action copies a link rather than opening a share sheet. Inline
				// it's icon-only (the header is dense, and the glyph carries it); in
				// the menu it keeps a label so it lines up with the other rows. The
				// copied confirmation is CopyCheck's green checkmark in both.
				const shareAction = (inMenu: boolean) =>
					inMenu ? (
						<Menu.Item onClick={handleShare} title="Copy a link to this session">
							<CopyCheck copied={copied} idle={<IconLink size={20} />} size={20} />
							<span className="grow">{copied ? "Copied" : "Share"}</span>
						</Menu.Item>
					) : (
						<Button
							size="md"
							variant="ghost"
							// 22 = the icon scale's "standard standalone" step, so it reads
							// level with the ⋯ and side-panel glyphs beside it.
							icon={<CopyCheck copied={copied} idle={<IconLink size={22} />} size={22} />}
							onClick={handleShare}
							title="Copy a link to this session"
							aria-label="Share"
						/>
					);
				// New chat in this workspace — phone-only, since desktop has the
				// always-visible + in the tab strip. On a phone the strip (and its
				// hover-revealed +) is hidden, so the ⋯ menu is the only way to add a
				// sibling chat. Shares the workspace worktree, like the + default.
				const newChatAction = isPhone && onNewChat && (
					<Menu.Item
						onClick={() => {
							setOverflowOpen(false);
							onNewChat("share");
						}}
						title="Start a new chat in this workspace"
					>
						<IconPlus size={22} />
						<span className="grow">New chat in workspace</span>
					</Menu.Item>
				);
				// Copy transcript. These normally live on a tab's right-click menu,
				// but a lone-chat workspace has no tab strip (and phones hide it at
				// every count), so the only place to grab this chat's full text is the
				// ⋯ menu — surface both modes here when the strip isn't offering them.
				const showTranscriptActions =
					isPhone || (workspaceChats?.length ?? 1) <= 1;
				const transcriptActions = showTranscriptActions && (
					<>
						<Menu.Item
							onClick={() => {
								setOverflowOpen(false);
								void copySessionTranscript(session, "concise", toast);
							}}
							title="Copy a trimmed transcript of this chat"
						>
							<IconCopy size={20} />
							<span className="grow">Copy concise transcript</span>
							<span className="ml-auto text-[11px] font-semibold tracking-normal text-faint">
								{isApple ? "⌘⌥C" : "Ctrl+Alt+C"}
							</span>
						</Menu.Item>
						<Menu.Item
							onClick={() => {
								setOverflowOpen(false);
								void copySessionTranscript(session, "full", toast);
							}}
							title="Copy the complete transcript of this chat"
						>
							<IconFile size={20} />
							<span className="grow">Copy full transcript</span>
						</Menu.Item>
					</>
				);
				// Pin and Spin off live here at every width alongside the other
				// session-level actions, keeping the visible header focused on status.
				const overflowActions = (
					<>
						<Menu.Item
							className={pinned ? "text-yellow" : undefined}
							onClick={() => {
								setOverflowOpen(false);
								togglePin(session.id);
							}}
							aria-pressed={pinned}
						>
							<IconPin size={20} fill={pinned ? "currentColor" : "none"} />
							<span className="grow">{pinned ? "Unpin tab" : "Pin as tab"}</span>
							<span className="ml-auto text-[11px] font-semibold tracking-normal text-faint">
								{isApple ? "⌘P" : "Ctrl+P"}
							</span>
						</Menu.Item>
						{/* Claim this workspace into your own sidebar lanes — the twin of
						    the sidebar row's right-click action, for when you're already
						    reading the chat (an automation run, a teammate's workspace)
						    and want it in your own list. Per-user: it moves nothing for
						    anyone else. */}
						{onSetStatus && (
							<Menu.Item
								onClick={() => {
									setOverflowOpen(false);
									onSetStatus(claimChats, claimed ? null : "mine");
								}}
								title={
									claimed
										? "Drop this workspace from your sidebar lanes"
										: "Keep this workspace in your own sidebar lanes"
								}
							>
								<IconInbox size={20} />
								<span className="grow">
									{claimed
										? "Remove from my workspaces"
										: "Add to my workspaces"}
								</span>
							</Menu.Item>
						)}
						<SpinOffMenu
							session={session}
							entries={entries}
							send={send}
							connected={connected}
						/>
						{localMode && session.local && (
							<Menu.Item
								onClick={() => {
									setOverflowOpen(false);
									setMoveToCloudOpen(true);
								}}
							>
								<IconGlobe size={20} />
								<span className="grow">Move to cloud</span>
							</Menu.Item>
						)}
					</>
				);
				// Archive is the reversible primary "done with this" action — it sits
				// above Delete in the menu so the safe choice reads first. When the
				// session is already archived this becomes Unarchive.
				const archiveAction = (
					<Menu.Item
						onClick={handleArchive}
						disabled={archiving}
						title={
							session.archived
								? `Unarchive session (${archiveShortcutLabel})`
								: `Archive session (${archiveShortcutLabel})`
						}
					>
						<IconArchive size={22} />
						<span className="grow">
							{archiving
								? session.archived
									? "Unarchiving…"
									: "Archiving…"
								: session.archived
									? "Unarchive session"
									: "Archive session"}
						</span>
						<span className="ml-auto text-[11px] font-semibold tracking-normal text-faint">
							{archiveShortcutLabel}
						</span>
					</Menu.Item>
				);
				// Delete is destructive, so it never rides in the visible action bar —
				// it always lives inside the ⋯ menu, one deliberate hop away.
				const deleteAction = !showDeleteConfirm ? (
					<Menu.Item
						closeOnClick={false}
						className="text-dim data-[highlighted]:bg-red-soft data-[highlighted]:text-red"
						onClick={() => setShowDeleteConfirm(true)}
						title="Delete session"
					>
						<IconTrash size={22} />
						<span className="grow">Delete session</span>
					</Menu.Item>
				) : (
					<div className="viewer-delete-confirm">
						{session.worktreeDir && !isAsk && (
							<Button
								variant="danger"
								size="sm"
								className="min-h-0 px-3 py-[5px] text-[13px]"
								onClick={() => handleDelete(true)}
								disabled={deleting}
							>
								{deleting ? "…" : "+ Worktree"}
							</Button>
						)}
						<Button
							variant="warning"
							size="sm"
							className="min-h-0 px-3 py-[5px] text-[13px]"
							onClick={() => handleDelete(false)}
							disabled={deleting}
						>
							{deleting ? "…" : "Session"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="min-h-0 border-line-strong px-3 py-[5px] text-[13px] text-dim hover:bg-transparent hover:text-fg"
							onClick={() => setShowDeleteConfirm(false)}
							disabled={deleting}
						>
							Cancel
						</Button>
					</div>
				);
				// Scheduled automations title their chats "<automation> — <timestamp>",
				// so naming the automation again beside that title reads as the same
				// words twice. Fall back to the generic label there — the chip still
				// marks the chat as automated and still links to its settings.
				const automationLabel =
					session.automation &&
					(workspaceName || session.title || "")
						.trim()
						.toLowerCase()
						.startsWith(session.automation.trim().toLowerCase())
						? "Automation"
						: session.automation;
				// Secondary header controls (Linear/Plain links). Inline on desktop;
				// on phones they fold into the ⋯ menu so the single top bar holds only
				// ⋯ + the Workspace toggle beside the centered title. The code
				// affordances (Preview, Staging) sit as state-colored icons just left
				// of the panel toggle on desktop; PR status rides its own row.
				const secondaryActions = (inMenu: boolean) => (
					<>
						{/* The automation that produced this chat rides in the title row
						    beside the workspace name on desktop — it names the chat, it
						    isn't an action. .viewer-title is hidden on phones, so the ⋯
						    menu keeps carrying it there. */}
						{session.automation && inMenu && (
							<Menu.Item
								render={<a href={`${BASE_PATH}/automations/${encodeURIComponent(session.automationId || session.automation)}`} />}
							>
								<span className="grow">{automationLabel}</span>
							</Menu.Item>
						)}
						{session.linearIssue?.url && (inMenu ? (
							<Menu.Item
								render={<a href={session.linearIssue.url} target="_blank" rel="noopener" />}
							>
								<span className="grow">{session.linearIssue.identifier}</span>
							</Menu.Item>
						) : (
							<a
								href={session.linearIssue.url}
								target="_blank"
								rel="noopener"
								className="session-link session-link-linear"
							>
								{session.linearIssue.identifier}
							</a>
						))}
						{hasPlain && plainUrl && (inMenu ? (
							<Menu.Item render={<a href={plainUrl} target="_blank" rel="noopener" />}>
								<span className="grow">Plain ↗</span>
							</Menu.Item>
						) : (
							<a
								href={plainUrl}
								target="_blank"
								rel="noopener"
								className="session-link session-link-plain"
							>
								Plain ↗
							</a>
						))}
						{feedRef && (inMenu ? (
							<Menu.Item render={<a href={feedRef.url} target="_blank" rel="noopener" />}>
								<span className="grow">{feedRefLabel} ↗</span>
							</Menu.Item>
						) : (
							<a
								href={feedRef.url}
								target="_blank"
								rel="noopener"
								className="session-link session-link-plain"
							>
								{feedRefLabel} ↗
							</a>
						))}
					</>
				);
				const header = (
					<div
						className={`viewer-header flex h-[var(--desktop-header-h)] min-w-0 shrink-0 items-center justify-between gap-3 border-b border-line bg-bg px-4 ${compactHeader ? "viewer-header-compact" : ""}`}
						ref={headerRef}
					>
						<div className="viewer-title flex min-w-0 items-center gap-2.5 font-medium">
					{/* This slot says where a chat came FROM. Ask mode isn't an
					    origin — it's a mode you can change — so it rides the composer
					    toolbar next to the model pill instead, where the switch is one
					    click from where you're typing. "backstage" is the default
					    origin (web UI): as a chip it's noise, and for backstage-repo
					    sessions it read as the repo said twice. Only the unusual
					    origins (slack/linear/cli) surface here. */}
					{session.source !== "backstage" && (
						<span className={`source-chip source-${session.source} shrink-0 rounded-full px-2 py-0.5 text-meta font-bold tracking-[-0.01em] ${session.source === "slack" ? "bg-[rgba(74,21,75,0.55)] text-[#d9a8db]" : session.source === "linear" ? "bg-[rgba(94,106,210,0.25)] text-[#9da6ee]" : "bg-active text-dim"}`}>
							{session.source}
						</span>
					)}
					{session.worktreeDir &&
						hasWorkspace &&
						// Scratch sessions are repo-less: a static feed-kind tile
						// ("tella") instead of the repo switch/attach menu.
						(session.mode === "scratch" ? (
							<span className="flex min-w-0 items-center gap-1.5">
								<span
									className="flex min-w-0 items-center gap-1.5 text-control-label font-medium text-dim"
									title="Scratch session — no repo"
								>
									<RepoTile
										name={session.externalRefs?.[0]?.kind || "scratch"}
									/>
									<span className="truncate">
										{session.externalRefs?.[0]?.kind || "scratch"}
									</span>
								</span>
								<IconChevronDown
									size={18}
									className="shrink-0 -rotate-90 text-faint"
								/>
							</span>
						) : (
							<RepoBar
								sessionId={session.id}
								primaryRepo={session.repo || "repository"}
								branch={session.branch}
								initialAttached={session.attachedRepos || []}
							/>
						))}
					{renameDraft !== null ? (
						<input
							className="viewer-branch-rename"
							value={renameDraft}
							autoFocus
							onChange={(e) => setRenameDraft(e.target.value)}
							onFocus={(e) => e.target.select()}
							onBlur={commitRename}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitRename();
								else if (e.key === "Escape") setRenameDraft(null);
								e.stopPropagation();
							}}
						/>
					) : (
						<span
							className={`viewer-branch ${onRename ? "viewer-branch-editable" : ""}`}
							title={
								workspaceName
									? `${session.title} — double-click to rename the workspace`
									: onRename
										? "Double-click to rename"
										: session.title
							}
							onDoubleClick={
								onRename
									? () => setRenameDraft(workspaceName || session.title)
									: undefined
							}
						>
							{workspaceName || session.title}
						</span>
					)}
					{/* Which automation produced this chat, next to the name it produced
					    — the same slot the source chips claim, so origin always reads on
					    the left. Links to the automation's settings. The name is capped
					    and ellipsized because automation names run long ("App Changelog
					    Draft (Mac + Windows releases)") and the title matters more. */}
					{session.automation && (
						<a
							href={`${BASE_PATH}/automations/${encodeURIComponent(session.automationId || session.automation)}`}
							className="source-chip source-automation"
							title={`Automation — open ${session.automation} settings`}
						>
							{automationLabel}
						</a>
					)}
					{/* Sandbox badge: this session's runs execute inside an isolated
					    container (docker/daytona/e2b). Renders nothing for host sessions
					    — purely from session fields, no container polling. */}
					<SandboxBadge sandbox={session.sandbox} />
					{/* Lone-chat "+ New tab": with no tab strip on screen the affordance
					    to spawn a sibling chat lives here beside the title (⌘T does the
					    same). The moment the strip appears — a second chat, an open view
					    tab like Review, or a split — its own + takes over and this
					    disappears, so the two never stack. Phone uses the ⋯
					    menu's newChatAction instead. Square 30px chip: same height and
					    corner radius as the ⋯ and side-panel buttons at the other end of
					    the bar. Sized by padding it came out 37×33 — a wide rectangle
					    around a 13px cross, so the hover chip read larger than every
					    control beside it. */}
					{!isPhone &&
						onNewChat &&
						!tabStripVisible &&
						workspaceChats?.length === 1 && (
							<Tooltip
								label="New tab in this workspace"
								shortcut={isApple ? ["⌘", "T"] : ["Ctrl", "T"]}
							>
								<button
									type="button"
									className="flex-none inline-flex size-[30px] items-center justify-center rounded-control text-dim transition-colors hover:bg-hover hover:text-fg"
									onClick={() => onNewChat("share")}
									aria-label="New tab"
								>
									{/* 25, not the menu-row 22: the IconPlus path only fills ~52%
									    of its box (vs ~60% for the play/sidebar glyphs beside it),
									    so at 22 it read a touch small. 25 nudges it up without the
									    28 that read too big beside the compact ▶ play / ▐ panel
									    toggle — the thin full-box cross carries more optical width
									    than those glyphs at the same size. */}
									<IconPlus size={25} />
								</button>
							</Tooltip>
						)}
					{onOpenSession && (parentSession || (workerSessions && workerSessions.length > 0)) && (
						<SessionRelations
							parent={parentSession}
							workers={workerSessions}
							models={models}
							onOpen={onOpenSession}
						/>
					)}
					{session.archived && (
						<button
							type="button"
							className="source-chip source-cli archived-chip"
							onClick={handleArchive}
							disabled={archiving}
							title="Click to unarchive"
						>
							Archived
						</button>
					)}
				</div>
				<div className="viewer-header-actions">
					{!isPhone && secondaryActions(false)}
					{/* Everyone with the session open, Figma/Notion-style, right
					    before Share. You're always in it (rightmost); others stack
					    in front with their GitHub picture. */}
					{!isPhone && viewers.length > 0 && (
						<div className="presence" title={`Viewing: ${viewers.join(", ")}`}>
							{dedupeViewers(viewers, me).map((v) => (
								<UserAvatar
									key={v.name}
									name={v.name}
									size={24}
									className="presence-avatar"
								/>
							))}
						</div>
					)}
					{/* Share rides inline when there's room, else collapses behind ⋯
					    so it never crowds the title. It sits before Workspace so the
					    Workspace toggle stays rightmost. On phones the secondary
					    controls fold in too. The ⋯ menu is always present — Spin off
					    and Delete live only in there. */}
					{!compactHeader && !isPhone && shareAction(false)}
					<Menu.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
						<div className="viewer-overflow">
							<Menu.Trigger
								// Rendered AS the Button primitive rather than restyled to
								// look like one, so the box, radius, hover wash, transition
								// and press scale are identical to the share and side-panel
								// buttons by construction instead of by hand-matching.
								render={
									<Button
										variant="ghost"
										size="md"
										icon={<IconDotsHorizontal size={22} />}
									/>
								}
								className={cn(
									// The foundation turns on the squircle via
									// `[class*="rounded-"]:not([class*="rounded-full"])`. That
									// `:not` is a substring test on the whole class attribute,
									// so the mobile `rounded-full` below disqualifies this
									// element at EVERY width and it renders plain-round while
									// its neighbours are squircles. Set it back explicitly,
									// and keep a true circle on mobile.
									"[corner-shape:squircle] max-[720px]:[corner-shape:round]",
									"max-[720px]:h-10 max-[720px]:min-h-10 max-[720px]:w-10 max-[720px]:rounded-full max-[720px]:border-line max-[720px]:bg-bg max-[720px]:text-accent max-[720px]:shadow-[0_2px_12px_rgba(0,0,0,0.1)]",
									overflowOpen && "bg-hover text-fg max-[720px]:border-[color-mix(in_srgb,var(--accent)_12%,transparent)] max-[720px]:bg-accent-soft max-[720px]:text-accent",
								)}
								title="More actions"
								aria-label="More actions"
							/>
							<Menu.Popup
								align="end"
								sideOffset={6}
								className="min-w-[240px] max-w-[min(300px,calc(100vw-24px))]"
							>
								{/* Quick session actions use the same focus, spacing, collision,
								    and dismissal behavior as every other app menu. */}
								{isPhone && secondaryActions(true)}
								{(compactHeader || isPhone) && shareAction(true)}
								{newChatAction}
								<PreviewButton
									session={session}
									onAttachImage={(img) => setImages((prev) => [...prev, img])}
									onStatusChange={setPreviewStatus}
									onOpenTab={onOpenPreviewTab}
									variant="menu"
								/>
								{transcriptActions}
								{overflowActions}
								{archiveAction}
								{deleteAction}
							</Menu.Popup>
						</div>
					</Menu.Root>
					{/* Code-workspace testing affordances dock immediately left of the
					    side-panel toggle. The local preview launcher lives in the ⋯ menu;
					    the globe rides here only while the panel is closed —
					    once the panel opens the globe moves into the panel's PR row
					    (to the left of the PR), so it isn't shown twice. */}
					{!isPhone && !panelOpen && (
						<StagingLink
							session={session}
							variant="header"
							refreshTick={gitRefreshTick}
						/>
					)}
					{/* Panel closed → surface the PR chip + its primary action (Merge/
					    Push/Resolve) inline, grouped with the globe directly left of
					    the side-panel toggle, so the header still tells you where the
					    PR stands without opening the Workspace panel. */}
					{!isPhone && hasWorkspace && !panelOpen && (
						<PrStatusBar
							sessionId={session.id}
							repo={session.repo || undefined}
							archived={session.archived}
							prs={session.prs}
							send={connected ? send : undefined}
							onOpenPrTab={focusPrInReview}
							onOpenChecksTab={() => focusPrInReview(undefined, "checks")}
							onArchive={handleArchive}
							variant="header"
							running={isRunningLive}
							refreshTick={gitRefreshTick}
						/>
					)}
					{!isPhone && panelAvailable && (
						<Tooltip
							label={
								hasWorkspace
									? "Toggle side panel (changes, terminal, PR)"
									: "Toggle side panel (agents)"
							}
						>
							<Button
								variant="ghost"
								size="md"
								// No height/width overrides: the primitive's icon-only box is
								// already the 32px square the ⋯ and share buttons use.
								// text-dim, not text-faint: the share and ⋯ buttons beside it
								// are dim, and a lighter ink made this read as disabled.
								// No negative margin after the ⋯ either: that -4px pull dated
								// from when both were narrow padded controls, and now that all
								// three are equal squares it just made this gap 4px where the
								// share → ⋯ one is the row's 8px.
								className="rounded-control text-dim hover:bg-hover hover:text-fg max-[720px]:order-2 max-[720px]:h-[38px] max-[720px]:min-h-[38px] max-[720px]:w-[38px] max-[720px]:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] max-[720px]:text-accent"
								onClick={() => setPanelOpen(!panelOpen)}
								aria-label="Toggle side panel"
								// Iconic sidebar-right glyph — reads as "right side panel".
								// Passed as `icon` (not children) so the primitive uses its
								// icon-only square; as a child it counts as a label and gets
								// the text button's px-3, which made it 50px wide.
								icon={<IconSidebarRight size={22} />}
							/>
						</Tooltip>
					)}
				</div>
			</div>
				);
				// Phones: the whole header rides in the top bar's right slot (the
				// title row is CSS-hidden there — the centered bar title replaces
				// it), giving one iOS-style nav bar instead of a second chrome row.
				const phoneInfoPage =
					isPhone && infoPageOpen ? (
						createPortal(
							<div
								className="session-info-page"
								ref={infoPageRef}
								role="dialog"
								aria-modal="true"
								aria-label="Workspace details"
							>
								<div
									className={`session-info-topbar${
										infoPageScrolled ? " session-info-topbar-scrolled" : ""
									}`}
								>
									<button
										className="panel-back"
										onClick={() => setInfoPageOpen(false)}
										aria-label="Back to chat"
										autoFocus
									>
										<svg width="11" height="18" viewBox="0 0 11 18" fill="none">
											<path
												d="M9 1.5L2 9l7 7.5"
												stroke="currentColor"
												strokeWidth="2.25"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									</button>
									<div className="session-info-topbar-title">
										{workspaceName || session.title}
									</div>
								</div>
								<div className="session-info-hero">
									<RepoTile name={session.repo || "repository"} size={40} />
									<div className="session-info-name" ref={infoHeroNameRef}>
										{workspaceName || session.title}
									</div>
									<div className="session-info-sub">
										{[
											session.repo || "repository",
											models.length > 0
												? metadataModelLabel(effectiveModel, models)
												: null,
										]
										.filter(Boolean)
										.join("  ·  ")}
									</div>
								</div>
								{hasWorkspace && (
									<div className="session-info-status">
										<PrStatusBar
											sessionId={session.id}
											repo={session.repo || undefined}
											archived={session.archived}
											prs={session.prs}
											send={connected ? send : undefined}
											onOpenPrTab={(ref) => {
												setInfoPageOpen(false);
												focusPrInReview(ref);
											}}
											onOpenChecksTab={() => {
												setInfoPageOpen(false);
												focusPrInReview(undefined, "checks");
											}}
											onArchive={handleArchive}
											running={isRunningLive}
											refreshTick={gitRefreshTick}
											leading={
												<StagingLink
													session={session}
													variant="header"
													refreshTick={gitRefreshTick}
												/>
											}
										/>
									</div>
								)}
								<div className="session-info-content">
									<div className="session-info-list">
										{hasWorkspace && (
											<RepoBar
												sessionId={session.id}
												primaryRepo={session.repo || "repository"}
												branch={session.branch}
												initialAttached={session.attachedRepos || []}
												variant="menu-row"
											/>
										)}
										{session.source === "backstage" && models.length > 0 && (
											<ModelMenuRow
												models={models}
												model={model}
												defaultModel={defaultModel}
												onChange={handleModelChange}
												prettyLabel={prettyModel}
											/>
										)}
									</div>
									<div className="session-info-overview">
										<WorkspaceInfo
											sessionId={session.id}
											workspaceId={session.projectId || null}
											workspaceName={workspaceName}
											chats={(workspaceChats?.length ? workspaceChats : [session]).map(
												(s) => ({
													id: s.id,
													title: s.title,
													createdAt: s.createdAt || "",
													startedBy: s.startedBy,
												}),
											)}
											repo={hasWorkspace ? session.repo || "repository" : undefined}
											prState={hasWorkspace ? session.prState : undefined}
											refreshTick={gitRefreshTick}
											sandbox={session.sandbox}
											reviewRequest={effectiveReview?.req ?? null}
											reviewRequestSessionId={effectiveReview?.ownerId}
											reviewAcceptedFromPr={effectiveReview?.acceptedFromPr}
											reviewGithubPending={effectiveReview?.githubPending}
											reviewMyReviewNeeded={effectiveReview?.myReviewNeeded}
											onReviewChange={onReviewChange}
											onOpenChecks={() => {
												setInfoPageOpen(false);
												focusPrInReview(undefined, "checks");
											}}
											send={connected ? send : undefined}
											assets={assetFiles}
											onOpenAsset={(path) => {
												setInfoPageOpen(false);
												setSelectedAssetPath(path);
												onOpenAssets?.();
											}}
											onOpenTab={(tab) => {
												if (tab === "changes" || tab === "pr") {
													setInfoPageOpen(false);
													onOpenReview?.();
													return;
												}
												if (tab === "staging") {
													setInfoPageOpen(false);
													onOpenStaging?.();
													return;
												}
												if (tab === "assets") {
													setInfoPageOpen(false);
													onOpenAssets?.();
													return;
												}
												setInfoPageOpen(false);
												selectPanelTab(tab);
												setPanelOpen(true);
											}}
											onAddToInput={(text) => {
												setInfoPageOpen(false);
												setComposerPrefill((prev) => ({
													seq: (prev?.seq ?? 0) + 1,
													text,
												}));
											}}
											onOpenSession={(id, created) => {
												setInfoPageOpen(false);
												onOpenSession?.(id, created);
											}}
											liveMediaCount={liveMediaCount}
											liveMedia={liveOverviewMedia}
										/>
									</div>
									{(workflowRuns.length > 0 || subagents.length > 0) && (
										<div className="session-info-section">
											<WorkflowPanel
												sessionId={session.id}
												runs={workflowRuns}
												onCancel={cancelWorkflowRun}
												subagents={subagents}
												onOpenSubagent={(agentId, label) => {
													setInfoPageOpen(false);
													openSubagent(agentId, label);
												}}
											/>
										</div>
									)}
									{sessionReports.length > 0 && (
										<div className="session-info-section">
											<SessionReportsPanel
												reports={sessionReports}
												onOpenNewSession={onOpenNewSession}
											/>
										</div>
									)}
								</div>
							</div>,
							document.body,
						)
					) : null;
				const placedHeader =
					isPhone && headerActionsEl
						? createPortal(header, headerActionsEl)
						: topbarEl
							? createPortal(header, topbarEl)
							: header;
				return (
					<>
						{placedHeader}
						{phoneInfoPage}
					</>
				);
			})()}

			{/* Repo tile leads the mobile title pill (Slack-header style) — it
			    portals into the pill's leading slot in front of the name. */}
			{isPhone &&
				headerRepoEl &&
				hasWorkspace &&
				createPortal(
					<RepoTile name={session.repo || "repository"} size={18} round />,
					headerRepoEl,
				)}

			{/* Compact "chat bar" under the mobile top-bar title: it just *shows*
			    the session's model (no per-item dropdowns) — tapping it (or the
			    title above) opens the settings menu where they, and every other
			    workspace/chat setting, can be changed. */}
			{isPhone &&
				headerModelEl &&
				(hasWorkspace || models.length > 0) &&
				createPortal(
					<span
						className="header-chatbar session-settings-trigger"
						role="button"
						tabIndex={0}
						title="Workspace & chat settings"
						onClick={() =>
							// The metadata line is a React portal, so its clicks bubble
							// through this component's tree — not App's title button. Fire
							// the same event so tapping repo/model/cost opens the info page.
							window.dispatchEvent(
								new Event("backstage:toggle-session-settings"),
							)
						}
					>
						{/* The engine-running status dot rides the metadata line on
						    phones (it used to sit next to the title) so the name stays
						    steady and the working state reads alongside model · cost. */}
						{isRunningLive && <span className="working-dot" />}
						{/* Repo now leads the pill (portaled into headerRepoEl in front of
						    the title), so the metadata line is just model · cost. */}
						{models.length > 0 && (
							<span className="header-chatbar-model truncate">
								{/* Drop the "Claude " prefix — "Opus 4.8" reads fine in the
								    thin subtitle and leaves room for the cost meter. */}
								{metadataModelLabel(effectiveModel, models).replace(
									/^Claude[\s-]+/i,
									"",
								)}
							</span>
						)}
						{/* The composer's cost/context meter can't fit in the toolbar on
						    phones, so it rides here after the model. min-h-0 drops the
						    meter's toolbar-sized 32px touch box: as a subtitle it only
						    needs its own line, and the extra height was padding the gap
						    between the title and this line open. */}
						{usage && usage.turns > 0 && (
							<>
								<span className="header-chatbar-sep" aria-hidden="true">
									·
								</span>
								<UsageMeter
									usage={usage}
									className="chatbar-usage min-h-0"
									showCacheRate
								/>
							</>
						)}
					</span>,
					headerModelEl,
				)}

			{(session.goal || session.loop || runErrorBanner) && (
					<div className="session-banners flex flex-wrap gap-2 border-b border-line bg-raised px-4 py-[7px]">
					{/* The last run died on a terminal failure (usage limits/credits
					    exhausted, API errors) — say why the session stopped; the error
					    itself was only ever a transient toast. Hidden while a retry
					    runs, and when the transcript already carries the failure as a
					    red chip in its own place; cleared server-side by the next
					    clean run. */}
					{runErrorBanner && (
						<span
							className="session-banner text-red"
							title={runErrorBanner.message}
						>
							⚠ Last run failed: {runErrorBanner.message.slice(0, 160)}
							{runErrorBanner.message.length > 160 ? "…" : ""}
						</span>
					)}
					{session.goal && (
						<span
							className="inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-line bg-panel px-3 py-[3px] text-label text-dim"
							title="Cleared with /goal clear"
						>
							🎯 {session.goal}
						</span>
					)}
					{session.loop && (
						<span
							className="inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-line bg-panel px-3 py-[3px] text-label text-dim"
							title={`"${session.loop.prompt}" — stop with /loop stop`}
						>
							⟳ every {session.loop.intervalMinutes}m —{" "}
							{session.loop.prompt.slice(0, 60)}
							{session.loop.prompt.length > 60 ? "…" : ""}
						</span>
					)}
				</div>
			)}

			<div className="viewer-split flex min-h-0 flex-1">
				<div className="viewer-chat flex min-h-0 min-w-0 flex-1 flex-col [--chat-under:16px]">
					{showPreviewTab ? (
						<div className="viewer-review-main">
							<PreviewPane
								session={session}
								status={previewStatus}
								onClose={() => onClosePreviewTab?.()}
							/>
						</div>
					) : showStaging && stagingUrl ? (
						staging?.embeddable ? (
							// This deploy opts into being framed by os.tella.dev (its CSP
							// frame-ancestors names us — the tella-fusion preview change),
							// so we embed it inline. The STAGE session cookie is
							// Domain=.tella.dev; SameSite=None; Secure, so it rides into
							// this same-site (tella.dev) frame on every device, iOS
							// included — a logged-in reviewer sees the deploy directly. A
							// logged-OUT one gets a blank frame (staging redirects to
							// WorkOS AuthKit, which refuses framing), so the header keeps a
							// first-party "Open" break-out to log in, then come back.
							<div className="viewer-review-main">
								<div className="flex h-full flex-col">
									<div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs text-dim">
										<IconGlobe size={14} />
										<span className="truncate">
											Preview environment
											{staging.status !== "Ready"
												? ` — ${staging.status.toLowerCase()}…`
												: ""}
										</span>
										<div className="ml-auto flex items-center gap-3">
											<button
												type="button"
												onClick={() =>
													shareLink(stagingUrl, { toast: "Link copied" })
												}
												className="inline-flex items-center gap-1 transition-colors hover:text-fg"
											>
												<IconCopy size={13} />
												Copy link
											</button>
											<a
												href={stagingUrl}
												target="_blank"
												rel="noopener"
												title="Open first-party in a new tab — needed if the frame is blank because you aren't logged in to the preview environment yet"
												className="inline-flex items-center gap-1 transition-colors hover:text-fg"
											>
												Open
												<IconArrowUpRight size={13} />
											</a>
										</div>
									</div>
									<iframe
										key={stagingUrl}
										src={stagingUrl}
										title="Preview environment"
										className="min-h-0 flex-1 border-0 bg-surface"
										allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write"
									/>
								</div>
							</div>
						) : (
							// Deploy hasn't opted into being framed (older preview, or the
							// fusion CSP change hasn't reached it yet) — open it
							// first-party in a new tab rather than show a blocked frame.
							<div className="viewer-review-main">
								<div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
									<IconGlobe size={40} className="text-dim" />
									<div className="flex flex-col items-center gap-1">
										<div className="text-base font-medium text-fg">
											Preview environment
										</div>
										<div className="text-xs text-dim">
											{staging?.status === "Ready"
												? "Test this PR on real infra"
												: `Deploy is ${(staging?.status ?? "building").toLowerCase()}…`}
										</div>
									</div>
									<a
										href={stagingUrl}
										target="_blank"
										rel="noopener"
										className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-panel"
									>
										<IconGlobe size={16} />
										Open staging
										<IconArrowUpRight size={16} />
									</a>
									<button
										type="button"
										onClick={() =>
											shareLink(stagingUrl, { toast: "Link copied" })
										}
										className="inline-flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-fg"
									>
										<IconCopy size={14} />
										Copy link
									</button>
									<div className="max-w-xs text-xs leading-relaxed text-dim">
										Opens in a new tab — this deploy isn&apos;t set up to
										embed here yet.
									</div>
								</div>
							</div>
						)
					) : showAssets ? (
						// The session's scratch assets, full-width (same component
						// the Info panel's Assets button opens). AssetsPanel is
						// `h-full`, so the flex-column viewer-review-main gives it
						// height exactly like the Review PrPanel.
						<div className="viewer-review-main">
							<AssetsPanel
								sessionId={session.id}
								files={assetFiles}
								refresh={refreshAssets}
								selectedPath={selectedAssetPath}
								showTree={false}
								onOpenNewSession={onOpenNewSession}
							/>
						</div>
					) : subagentOpen ? (
						// A sub-agent's conversation, full-width like Review — it reads
						// as a conversation, so it gets the chat column instead of being
						// squeezed into the right sidebar. Nested Task calls push onto
						// the same tab's breadcrumb.
						<div className="viewer-review-main">
							<SubagentPane
								sessionId={session.id}
								stack={subagentStack}
								onOpenSubagent={openSubagent}
								onBack={() => onSubagentBack?.(session.id)}
							/>
						</div>
					) : showConversation && conversationThreadId ? (
						// The workspace's Plain ticket thread, full-width — same
						// ConversationPane the chat-less workspace route renders, so
						// the chat stays mounted underneath exactly like Review.
						<div className="viewer-review-main">
							<ConversationPane
								threadId={conversationThreadId}
								onOpenSession={() => {}}
								hideTriage
							/>
						</div>
					) : showVideo && videoPanel ? (
						// The workspace's feed panel — web embed (Tella) or a custom
						// component (Slack channel Conversation) via the panel
						// registry (the feeds design).
						<div className="viewer-review-main">
							{videoPanel.component === "slack-channel" ? (
								<SlackChannelPane channelId={videoPanel.refId} />
							) : (
								<FeedWebPane
									panel={videoPanel}
									title={videoTitle || undefined}
								/>
							)}
						</div>
					) : showReview && hasWorkspace ? (
						<div className="viewer-review-main">
							{localRepoCapabilityLoading ? (
								<div className="flex h-full items-center justify-center text-sm text-faint">
									Loading repository…
								</div>
							) : localRepoHasNoGitHubRemote ? (
								<div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
									<IconGlobe size={32} className="text-faint" />
									<div className="text-sm font-medium text-fg">No GitHub remote</div>
									<div className="max-w-xs text-xs leading-relaxed text-dim">
										This repository is not connected to GitHub, so pull request details are unavailable.
									</div>
								</div>
							) : (
								<PrPanel
									onOpenPr={onOpenPr}
									sessionId={session.id}
									send={send}
									addHandler={addHandler}
									sessions={allSessions || workspaceChats || []}
									onOpenSessionById={onOpenSession}
									reviewCanvas
									onOpenSession={onOpenWorkspace}
									onAddToInput={(text) =>
										setComposerPrefill((p) => ({
											seq: (p?.seq ?? 0) + 1,
											text,
										}))
									}
									repos={panelReviewRepos}
									linkedPrs={session.linkedPrs}
									discoveredPrs={discoveredPrs}
									focusTarget={reviewFocus}
									linkable
									walkthrough={session.walkthrough}
								/>
							)}
						</div>
					) : (
					<>
					<div className="viewer-messages-region relative min-h-0 flex-1">
						<div
							className="viewer-messages h-full min-h-0 overflow-y-auto px-4 pb-2 pt-[18px] max-[720px]:px-3 max-[720px]:pt-[calc(var(--pane-header-h)+var(--strip-clearance,0px)+8px)]"
							ref={messagesRef}
							onScroll={handleMessagesScroll}
							onClick={handleMessagesClick}
						>
							{loading ? (
								<ConversationLoading />
							) : waitingForWorkspace ? (
								// Worktree prep in flight — the first message waits in the
								// queue flap below and sends the moment this clears.
								<WorkspaceWaiting
									detail={
										session.branch
											? `Creating a worktree for ${session.branch} — queued messages send when it's ready.`
											: "Creating the worktree — queued messages send when it's ready."
									}
								/>
							) : entries.length === 0 && !session.transcriptPath ? (
								// A fresh chat with no run yet is just an empty conversation —
								// blank canvas, the composer below is the UI. Only a session
								// that *ran* but has no transcript file gets the notice. When
								// the workspace has sibling chats, the canvas offers their
								// transcripts as attachable context for the first message.
								session.claudeSessionId || session.codexThreadId ? (
									<div className="py-10 text-center text-faint">
										No transcript available for this session
									</div>
								) : !hasLiveConversation && contextChatOptions.length > 0 ? (
									// Simple centered empty state: the whole region centers the
									// heading + attachable-context chips so a fresh chat reads as a
									// calm blank canvas rather than a top-left form.
									<div className="min-h-full flex flex-col items-center justify-center text-center w-full max-w-[840px] mx-auto px-4">
										<div className="text-dim mb-4">
											New chat in{" "}
											<span className="text-fg font-medium">
												{workspaceName || session.branch || "this workspace"}
											</span>
											.
										</div>
										<div className="text-dim mb-3">Add chat transcripts</div>
										<div className="flex flex-wrap items-center justify-center gap-2">
											{(showAllContextChats
												? contextChatOptions
												: contextChatOptions.slice(0, 4)
											).map((c) => {
												const selected = contextChats.includes(c.id);
												const codex =
													(c.model || "").startsWith("gpt") ||
													(c.model || "").startsWith("codex");
												const ChipIcon = selected
													? IconCheck
													: codex
														? IconTerminal
														: IconSparkle;
												return (
													<Button
														key={c.id}
														icon={
															<ChipIcon
																size={16}
																className={selected ? "text-green" : undefined}
															/>
														}
														onClick={() =>
															setContextChats((prev) =>
																prev.includes(c.id)
																	? prev.filter((id) => id !== c.id)
																	: [...prev, c.id],
															)
														}
														title={
															selected
																? "Attached — its transcript rides along with your first message"
																: "Attach this chat's transcript as context"
														}
														className={
															selected
																? "border-line-strong bg-active text-fg"
																: undefined
														}
													>
														<span className="max-w-[200px] truncate">
															{c.title || "Untitled chat"}
														</span>
													</Button>
												);
											})}
											{!showAllContextChats && contextChatOptions.length > 4 && (
												<Button
													variant="ghost"
													onClick={() => setShowAllContextChats(true)}
												>
													+{contextChatOptions.length - 4} more
												</Button>
											)}
										</div>
									</div>
								) : null
							) : entries.length === 0 && !hasLiveConversation ? (
								<div className="py-10 text-center text-faint">Empty transcript</div>
							) : (
								<>
									{historyTruncated && (
										<div className="flex justify-center [overflow-anchor:none] px-0 pt-1 pb-3.5">
											{/* Segmented: a page at a time, or the whole backlog in
											    one go for readers who'd otherwise click a hundred
											    times to reach the first message. */}
											<div className="flex items-stretch overflow-hidden rounded-full border border-line bg-raised text-label text-dim">
												<button
													className="cursor-pointer px-3.5 py-[5px] transition-[background,color] hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
													disabled={loadingHistory}
													onClick={loadEarlierHistory}
												>
													{jumpingToStart
														? "Loading full history…"
														: loadingHistory
															? "Loading earlier history…"
															: "↑ Load earlier history"}
												</button>
												<span
													className="w-px shrink-0 self-stretch bg-line"
													aria-hidden
												/>
												<button
													className="flex cursor-pointer items-center px-2 transition-[background,color] hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
													disabled={loadingHistory}
													onClick={jumpToStart}
													title="Jump to the start of the session"
													aria-label="Jump to the start of the session"
												>
													<IconArrowUpToLine size={20} />
												</button>
											</div>
										</div>
									)}
									<React.Profiler
										id="transcript"
										onRender={onTranscriptRender}
									>
									<ToolPathRootsProvider value={toolPathRoots}>
									<LiveSubagentsProvider value={liveSubagents}>
										<TranscriptBlocks
											entries={entries}
											live={isBusy}
											sessionId={session.id}
											walkthrough={chatWalkthrough}
											notes={notes}
											onFork={canForkSession ? handleFork : undefined}
											onOpenSubagent={openSubagent}
											// For automation-owned sessions (e.g. a GitHub PR run), the
											// automation never *types* a user turn — humans steer them.
											// So don't credit un-attributed turns to the automation
											// ("GitHub (automation)"); leave the owner unset so they read
											// as "You" (explicit [Name] steers still show the teammate).
											owner={
												session.automation
													? undefined
													: session.startedBy || undefined
											}
										/>
									</LiveSubagentsProvider>
									</ToolPathRootsProvider>
									</React.Profiler>
								</>
							)}

							<StreamingMessage store={liveTurnStore} />

							{isBusy && !waitingForWorkspace && (
								<BusyInline
									since={busySince}
								/>
							)}

							{ask && (
								<AskCard
									key={ask.questionId}
									questions={ask.questions}
									onAnswer={(answers) =>
										send({
											type: "answer_question",
											sessionId: session.id,
											questionId: ask.questionId,
											answers,
										})
									}
								/>
							)}

								{pendingBubbles.map((p) => (
									<div key={p.id} className="msg msg-user msg-sending">
										{/* No name: the bubble is right-aligned, so authorship is
										    already clear — just the transient status. Busy sends
										    render in the queue flap, never as a bubble. */}
										<div className="msg-label msg-label-user">
											<span className="msg-label-status">Sending…</span>
										</div>
									{p.content && (
										<div className="msg-body msg-body-user">{p.content}</div>
									)}
									{p.images && p.images.length > 0 && (
										<div className="msg-images">
											{p.images.map((src, i) => (
												<img
													key={i}
													className="md-image"
													src={src}
													alt=""
													loading="lazy"
												/>
											))}
										</div>
									)}
								</div>
							))}

							{/* Reserves room so a freshly-sent turn can sit near the top while its
                reply streams into the space below; sized by the scroll hook. */}
							<div ref={spacerRef} className="turn-spacer" aria-hidden="true" />
						</div>

								{showScrollToBottom && entries.length > 0 && (
									<button
										/* The pill floats over the transcript, so the hover wash is
										   layered as an inset shadow over the opaque control surface —
										   `bg-hover` would *replace* that surface with translucent ink
										   and let the messages show through. */
										className={`group absolute left-1/2 bottom-6 z-[5] inline-flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-control px-3.5 py-2 text-label font-semibold shadow-[inset_0_0_0_999px_transparent,0_1px_6px_rgba(0,0,0,0.12)] transition-[color,box-shadow] hover:shadow-[inset_0_0_0_999px_var(--hover),0_2px_9px_rgba(0,0,0,0.16)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
											newBelow
												? "text-accent"
												: "text-dim hover:text-fg"
										}`}
										onClick={() => scrollToLatest("smooth")}
										title="Scroll to the bottom"
									>
										<IconArrowDown
											size={13}
											className="transition-transform group-hover:translate-y-px"
											aria-hidden
										/>
										{newBelow ? "New messages" : "Scroll to bottom"}
									</button>
								)}
							</div>

					<div className="viewer-input">
								{noEngine ? (
									<div className="mx-auto max-w-[var(--chat-col)] text-[13px] text-faint">
										No engine session to resume
									</div>
								) : (
									<>
										{forkFrom && (
											<div className="mb-2 flex items-center justify-between gap-3 rounded-control border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-3 py-[7px] text-supporting text-fg">
												<span>
													⑂ Forking a new session from the selected message — type
													the new direction.
												</span>
												<button
													className="cursor-pointer bg-transparent text-label text-dim hover:text-fg"
													onClick={() => setForkFrom(null)}
												>
											Cancel
										</button>
									</div>
								)}
								<Composer
									// Uncontrolled: the draft lives in the Composer (persisted
									// per chat via draftKey). Remount on the tab-bar +
									// (newChatSeq) to clear it for the fresh chat.
									key={newChatSeq ?? 0}
									draftKey={draftKey}
									onSend={handleSend}
									images={images}
									onImagesChange={setImages}
									files={files}
									onFilesChange={setFiles}
									placeholder={
										!connected
											? "Not connected"
											: forkFrom
												? "New direction…"
												: isBusy
													? "Queue for when it finishes…"
													: isAsk
														? `Ask ${AGENT_NAME} — read-only…`
														: `Ask ${AGENT_NAME}…`
									}
									disabled={!connected}
									sendDisabled={(text) =>
										noteMode
											? !text.trim()
											: !text.trim() &&
												images.length === 0 &&
												files.length === 0 &&
												!forkFrom
									}
									noteMode={noteMode}
									onNoteModeChange={setNoteMode}
									// Ask mode lost its chip when the toolbar collapsed into
									// the "+", so the writing surface carries the state
									// instead — tinted and hatched like plan mode.
									askMode={isAsk}
									busy={isBusy && !forkFrom}
									onStop={handleCancel}
									sendTitle={isBusy ? busySendLabel : undefined}
									// Leaving ask mode is a setting of this chat, so it sits in
									// the composer's "+" with the rest of them rather than as its
									// own chip. The row stays open reading "Switching to code…"
									// until the server answers — cutting a worktree isn't always
									// instant. Only backstage chats can promote (the server owns
									// that rule); elsewhere the row would be a dead end.
									menuExtra={
										isAsk && session.source === "backstage"
											? ({ close }) => (
													<button
														type="button"
														className="composer-menu-item"
														disabled={promoting}
														title="Ask mode — this chat can read the code but not change it"
														onClick={() => void handlePromote(close)}
													>
														<span className="composer-menu-icon">
															<IconEye size={22} />
														</span>
														{promoting
															? "Switching to code…"
															: "Switch to code"}
													</button>
												)
											: undefined
									}
									attached={attachedComposer}
									prefill={composerPrefill}
									models={models}
									defaultModel={defaultModel}
									model={model}
									onModelChange={handleModelChange}
									modelDisabled={
										session.source !== "backstage" &&
										session.source !== "slack"
									}
									modelTitle={
										session.source === "backstage" ||
										session.source === "slack"
											? "Switch the model for this session"
											: "Set the model from the owning agent (its session file is agent-owned)"
									}
									effort={effort}
									onEffortChange={setEffort}
									fastMode={fastMode}
									onFastModeChange={setFastMode}
									// Account pinning is a backstage-session affordance. The
									// picker filters the combined pool by the active model.
									accounts={
										session.source === "backstage"
											? accounts
											: undefined
									}
									accountId={accountId}
									onAccountChange={
										session.source === "backstage"
											? handleAccountChange
											: undefined
									}
									goal={currentGoal}
									onSetGoal={
										session.source === "backstage" ? handleSetGoal : undefined
									}
									usage={usage}
									mentionFetch={async (q) => [
										...peopleMentionMatches(q),
										...(await fetchFileMentions(q, session.id)),
									]}
									skillsFetch={(q) => fetchSkillMentions(q, session.id)}
									textareaRef={composerRef}
									sendMenu={
										session.source === "backstage"
											? ({ text, disabled, onScheduled }) => (
													<SchedulePromptButton
														sessionId={session.id}
														text={text}
														disabled={disabled}
														onScheduled={onScheduled}
														variant="menu-item"
													/>
												)
											: undefined
									}
								/>
							</>
						)}
					</div>
					</>
					)}
				</div>

				{/* Right region: the Workspace panel. Portaled to an app-level slot so
            it opens as a full-height column beside the left sidebar (not just
            below the chat header). */}
				{(() => {
				const rightRegion = (
					<>
				{!isPhone && panelAvailable && panelOpen && (
					<div className="panel-overlay" onClick={() => setPanelOpen(false)} />
				)}
				{!isPhone && panelAvailable && panelOpen ? (
					<div className="viewer-panel" style={panelStyle}>
						{panelResizeHandle}
						{/* Phones open this panel as a full-width bottom sheet, so it
						    carries one clean header row: chevron-back to the chat on the
						    left (the desktop toggle button is hidden there) and the
						    labelled Preview/Preview environment controls on the right — on desktop
						    those live in the session header as state-colored icons. */}
						{isPhone && (
							<div className="panel-sheet-head">
								<button
									className="panel-back"
									onClick={() => setPanelOpen(false)}
									aria-label="Back to chat"
								>
									<svg width="11" height="18" viewBox="0 0 11 18" fill="none">
										<path
											d="M9 1.5L2 9l7 7.5"
											stroke="currentColor"
											strokeWidth="2.25"
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
								</button>
								<div className="panel-sheet-actions">
									<PreviewButton
										session={session}
										onAttachImage={(img) =>
											setImages((prev) => [...prev, img])
										}
										onStatusChange={setPreviewStatus}
										onOpenTab={onOpenPreviewTab}
									/>
									<StagingLink session={session} refreshTick={gitRefreshTick} />
								</div>
							</div>
						)}
						{hasWorkspace && (
							<PrStatusBar
								sessionId={session.id}
								repo={session.repo || undefined}
								archived={session.archived}
								prs={session.prs}
								send={connected ? send : undefined}
							onOpenPrTab={focusPrInReview}
							onOpenChecksTab={() => focusPrInReview(undefined, "checks")}
							onArchive={handleArchive}
								running={isRunningLive}
								refreshTick={gitRefreshTick}
								// Globe (preview environment) rides inside the strip, left of the
								// PR chip, so it shares the strip's tone background — it's
								// pulled out of the header while the panel is open. On phones
								// the globe stays in the sheet-head row above.
								leading={
									!isPhone ? (
										<StagingLink
											session={session}
											variant="header"
											refreshTick={gitRefreshTick}
										/>
									) : undefined
								}
							/>
						)}
						<div className="panel-tabs flex items-center gap-0.5 overflow-x-auto px-2.5 pb-2 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
							<button
								className={`panel-tab ${panelTab === "info" ? "active" : ""}`}
								onClick={() => selectPanelTab("info")}
							>
								Info
							</button>
							{hasWorkspace && (
								<>
									<button
										className={`panel-tab ${panelTab === "changes" ? "active" : ""}`}
										onClick={() => selectPanelTab("changes")}
									>
										Changes
										{changesFileCount ? (
											<span className="panel-tab-count">
												{changesFileCount}
											</span>
										) : null}
									</button>
									<button
										className={`panel-tab ${panelTab === "shell" ? "active" : ""}`}
										onClick={() => selectPanelTab("shell")}
										title="Interactive terminal tabs in this session's workspace (inside its sandbox when sandboxed)"
									>
										Terminal
									</button>
								</>
							)}
							{/* Shown whenever the session CAN run workflows (it needs a
							    worktree for the agents' cwd), not only once a run exists —
							    a tab that only appears after the fact is undiscoverable.
							    The panel's empty state explains how to start one. */}
							{(hasWorkspace ||
								workflowRuns.length > 0 ||
								subagents.length > 0) && (
								<button
									className={`panel-tab ${panelTab === "workflows" ? "active" : ""}`}
									onClick={() => selectPanelTab("workflows")}
								>
									Agents
									{workflowRuns.some((r) => r.status === "running") ||
									subagents.some((s) => s.status === "running") ? (
										<span className="panel-tab-dot animate-pulse bg-green" />
									) : workflowRuns.length + subagents.length > 0 ? (
										<span className="panel-tab-count">
											{workflowRuns.length + subagents.length}
										</span>
									) : null}
								</button>
							)}
							{/* Assets are a full-width main-area view-tab now (opened
							    from the Info panel's Assets button), so there's no
							    sidebar assets tab — see the Assets view-tab in App.tsx. */}
							{sessionReports.length > 0 && (
								<button
									className={`panel-tab ${panelTab === "reports" ? "active" : ""}`}
									onClick={() => selectPanelTab("reports")}
								>
									Reports
									<span className="panel-tab-count">{sessionReports.length}</span>
								</button>
							)}
						</div>
						<div className="panel-body min-h-0 flex-1 overflow-y-auto">
							{/* Plain-only sessions (no code workspace) show just the timeline. */}
							{panelTab === "info" ? (
								<div className="px-1">
									<WorkspaceInfo
										sessionId={session.id}
										workspaceId={session.projectId || null}
										workspaceName={workspaceName}
										chats={(workspaceChats?.length ? workspaceChats : [session]).map(
											(s) => ({
												id: s.id,
												title: s.title,
												createdAt: s.createdAt || "",
												startedBy: s.startedBy,
											}),
										)}
										repo={
											hasWorkspace ? session.repo || "repository" : undefined
										}
										prState={hasWorkspace ? session.prState : undefined}
										refreshTick={gitRefreshTick}
										sandbox={session.sandbox}
										reviewRequest={effectiveReview?.req ?? null}
										reviewRequestSessionId={effectiveReview?.ownerId}
										reviewAcceptedFromPr={effectiveReview?.acceptedFromPr}
										reviewGithubPending={effectiveReview?.githubPending}
										reviewMyReviewNeeded={effectiveReview?.myReviewNeeded}
										onReviewChange={onReviewChange}
										onOpenChecks={() => focusPrInReview(undefined, "checks")}
										send={connected ? send : undefined}
										assets={assetFiles}
										onOpenAsset={(path) => {
											setSelectedAssetPath(path);
											onOpenAssets?.();
										}}
										onOpenTab={(tab) =>
											tab === "pr"
												? onOpenReview?.()
												: tab === "staging"
													? onOpenStaging?.()
													: tab === "assets"
														? onOpenAssets?.()
														: selectPanelTab(tab)
										}
										onAddToInput={(text) =>
											setComposerPrefill((p) => ({
												seq: (p?.seq ?? 0) + 1,
												text,
											}))
										}
										onOpenSession={(id, created) => onOpenSession?.(id, created)}
										liveMediaCount={liveMediaCount}
										liveMedia={liveOverviewMedia}
									/>
								</div>
							) : panelTab === "workflows" ? (
								// Before the Plain fallthrough: a Plain-only session's
								// Agents tab must win over its default timeline panel.
								// Renders with zero runs too — the panel's empty state is
								// how you discover workflows exist.
								<WorkflowPanel
									sessionId={session.id}
									runs={workflowRuns}
									onCancel={cancelWorkflowRun}
									subagents={subagents}
									onOpenSubagent={openSubagent}
								/>
							) : panelTab === "reports" ? (
								<SessionReportsPanel
									reports={sessionReports}
									onOpenNewSession={onOpenNewSession}
								/>
							) : waitingForWorkspace &&
							  (panelTab === "changes" || panelTab === "shell") ? (
								// These tabs all read the worktree — hold them behind the
								// waiting state until the create run finishes preparing it.
								<WorkspaceWaiting detail="Waiting for the workspace to be ready." />
							) : panelTab === "changes" ? (
								<DiffPanel
									sessionId={session.id}
									isRunning={isBusy}
									canSend={connected && !isBusy && !noEngine}
									send={send}
									diff={diffState}
								/>
							) : null}
							{/* Shell tabs keep their PTYs alive across side-panel tab
							    switches: mounted once opened, hidden while another tab
							    is active. They still die with the panel/socket. */}
							{hasWorkspace && !waitingForWorkspace && shellOpened ? (
								<div
									className={panelTab === "shell" ? "h-full min-h-0" : "hidden"}
								>
									<ShellPanel
										sessionId={session.id}
										send={send}
										addHandler={addHandler}
										visible={panelTab === "shell"}
									/>
								</div>
							) : null}
						</div>
					</div>
				) : null}
					</>
				);
				if (hideRightPanel) return null;
				return rightPanelEl ? createPortal(rightRegion, rightPanelEl) : rightRegion;
				})()}
			</div>
		</div>
	);
}

// Placeholder for regions that need the session's worktree while the create
// run is still preparing it (new-workspace creates announce the session before
// the slow git work — see create_session in backstage.ts).
function WorkspaceWaiting({ detail }: { detail: string }) {
	return (
		<div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center">
			<PixelSpinner className="mb-2 text-dim" />
			<div className="text-[14px] font-semibold text-fg">
				Waiting for workspace
			</div>
			<div className="max-w-[340px] text-[13px] font-medium leading-relaxed text-dim">
				{detail}
			</div>
		</div>
	);
}

function ConversationLoading() {
	return (
		<div
			className="flex min-h-full w-full flex-col items-center justify-center gap-3 px-6 text-center"
			role="status"
			aria-live="polite"
		>
			<PixelSpinner className="text-dim" />
			<div className="text-[13px] font-medium text-dim">Loading conversation</div>
		</div>
	);
}

// Ticking elapsed-time label for the busy dot row. Self-ticking
// so the 10Hz re-render stays inside this tiny span, not the whole viewer.
function BusyElapsed({ since }: { since: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(t);
	}, []);
	const s = Math.max(0, now - since) / 1000;
	let label: string;
	if (s < 60) label = `${s.toFixed(1)}s`;
	else if (s < 3600)
		label = `${Math.floor(s / 60)}m, ${(s % 60).toFixed(1)}s`;
	else label = `${Math.floor(s / 3600)}h, ${Math.floor((s % 3600) / 60)}m`;
	return <span className="busy-elapsed">{label}</span>;
}

function BusyInline({
	since,
}: {
	since: number | null;
}) {
	return (
		<div className="msg msg-busy-inline">
			<span className="pulse-dot" />
			{since != null && <BusyElapsed since={since} />}
		</div>
	);
}

function StreamingMessage({ store }: { store: LiveTurnStore }) {
	const snapshot = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getServerSnapshot,
	);
	const markdownText = snapshot.rapid ? "" : snapshot.text;
	const html = React.useMemo(
		() => (markdownText ? renderMarkdown(markdownText) : ""),
		[markdownText],
	);
	if (!snapshot.text) return null;

	return (
		<div className="msg msg-assistant msg-streaming">
			{snapshot.rapid ? (
				<div className="msg-body msg-body-assistant whitespace-pre-wrap">
					{snapshot.text}
				</div>
			) : (
				<MarkdownBody
					className="msg-body msg-body-assistant markdown"
					html={html}
				/>
			)}
		</div>
	);
}

function dedupeViewers(
	viewers: string[],
	me?: string,
): Array<{ name: string; count: number }> {
	const counts = new Map<string, number>();
	for (const v of viewers) counts.set(v, (counts.get(v) || 0) + 1);
	const list = Array.from(counts, ([name, count]) => ({ name, count }));
	// Others first, you last (nearest Share) — the Figma/Notion facepile order.
	if (me) list.sort((a, b) => Number(a.name === me) - Number(b.name === me));
	return list;
}
