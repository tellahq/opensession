import "./lib/storage-migrate"; // must run before any lib reads its pref keys
import { BASE_PATH, stripBasePath } from "./lib/base";
import { DEFAULT_REPO_ID } from "./lib/brand";
import { setSessionTitles } from "./lib/markdown";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar, type SidebarHandle } from "./components/Sidebar";
import { Tooltip, TooltipProvider } from "./ui/tooltip";
import { ToastHost, toast } from "./ui/toast";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { suppressLayoutAnimations } from "./ui/motion";
import { SessionViewer } from "./components/SessionViewer";
import { NewSession } from "./components/NewSession";
import type { NewSessionPrefill } from "./lib/new-session-link";
import {
	SessionSearch,
	type CommandPaletteAction,
} from "./components/SessionSearch";
import { Home } from "./components/Home";
import { CatchUpDeck } from "./components/CatchUpDeck";
import { PrTinder } from "./components/PrTinder";
import { SupportTinder } from "./components/SupportTinder";
import { Automations } from "./components/Automations";
import { Security } from "./components/Security";
import { Goals } from "./components/Goals";
import { Actions } from "./components/Actions";
import { Notes, type NotesSelection } from "./components/Notes";
import { Archived } from "./components/Archived";
import { Reviews } from "./components/Reviews";
import { PrQueuePreview } from "./components/PrQueuePreview";
import { SupportPreview } from "./components/SupportPreview";
import { WorkspacePane } from "./components/WorkspacePane";
import { Reports } from "./components/Reports";
import { Analytics } from "./components/Analytics";
import { Tasks } from "./components/Tasks";
import { UserGate, getCurrentUser, useAuthStatus } from "./components/UserPicker";
import { PreviewWait, matchPreviewWaitRoute } from "./components/PreviewWait";
import { SettingsMenu } from "./components/SettingsMenu";
import { TitleBar } from "./components/TitleBar";
import { Settings, type SettingsSectionKey } from "./components/Settings";
import { SessionTabs, type ViewTab } from "./components/SessionTabs";
import type { SubagentRef } from "./components/SubagentPane";
import { SessionSplit, type SplitSide } from "./components/SessionSplit";
import { RestartOverlay } from "./components/RestartOverlay";
import { MediaLightboxHost } from "./components/MediaLightbox";
import { UpdatePill } from "./components/UpdatePill";
import { DesktopUpdateToast } from "./components/DesktopUpdateToast";
import {
	IconArchive,
	IconUnarchive,
	IconBook,
	IconChart,
	IconCopy,
	IconDesk,
	IconFile,
	IconFlame,
	IconGear,
	IconGlobe,
	IconHome,
	IconInbox,
	IconListChecks,
	IconMoon,
	IconPencil,
	IconPlus,
	IconSearch,
	IconSidebarLeft,
	IconStack,
	IconWrench,
} from "./components/icons";
import { DeskOverlay } from "./components/DeskOverlay";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import { useBackSwipe } from "./hooks/useBackSwipe";
import { useIsPhone } from "./hooks/useIsPhone";
import { useInputAlerts } from "./hooks/useInputAlerts";
import { initAlerts } from "./lib/notify";
import { registerServiceWorker } from "./lib/push";
import {
	archiveSessionApi,
	deleteSessionApi,
	renameSessionApi,
	setSessionStatusApi,
	fetchNotes,
	fetchProjects,
	updateProjectApi,
	deleteProjectApi,
	newChatApi,
	fetchSessionNoteActivityApi,
	resolveWorkspaceApi,
	type NoteMeta,
	type OpenPr,
} from "./lib/api";
import {
	defaultChatWorkspaceView,
	mainChat,
	pickLandingChat,
} from "./lib/landing-chat";
import {
	getWorkspaceLastChat,
	saveWorkspaceLastChat,
} from "./lib/workspace-last-chat";
import { sessionHasWorkspace } from "./lib/session-workspace";
import type {
	Project,
	SupportThread,
	FeedDescriptor,
	FeedItem,
} from "./lib/types";
import { refWebPanel } from "./components/FeedWebPane";
import { ensureFeedMeta } from "./lib/feeds-meta";
import type { ReviewQueueItem } from "./lib/review-queue";
import { pushRecent } from "./lib/recents";
import { setLane, type Lane } from "./lib/lanes";
import { markRead } from "./lib/reads";
import {
	chatPath,
	prPath,
	absoluteLink,
	copyToClipboard,
} from "./lib/share-link";
import {
	getPins,
	togglePin,
	pin,
	unpin,
	reorderPins,
	onPinsChanged,
	getPinNewSessions,
	getPinNewWorkspaces,
	receivePins,
} from "./lib/pins";
import { applyTabOrder, saveTabOrder, onTabOrderChanged } from "./lib/tab-order";
import {
	clearTabSplit,
	getTabSplit,
	onTabSplitChanged,
	saveTabSplit,
	resolveSplit,
	type ResolvedSplit,
	type TabSplit,
} from "./lib/split-tabs";
import {
	getActiveViewTab,
	getActiveViewTabKeys,
	saveActiveViewTab,
	type ActiveViewTab,
} from "./lib/active-view-tab";
import {
	getTabColors,
	setTabColor,
	onTabColorsChanged,
} from "./lib/tab-colors";
import { copySessionTranscript } from "./lib/transcript-copy";
import { effectiveTheme, setThemePref } from "./lib/theme";
import type { UnifiedSession } from "./lib/types";

type Route =
	| { view: "home" }
	| { view: "new"; prompt?: string }
	| { view: "session"; id: string }
	// The workspace container without a chat selected: its view tabs (Review /
	// Conversation) and, when it has no chats, the first-chat composer. An
	// optional tab suffix picks the foregrounded pane on entry.
	| { view: "workspace"; id: string; tab?: "review" | "conversation" | "video" }
	// Session-less PR preview (a sidebar PR row with no chat yet).
	| { view: "pr"; repo: string; branch: string }
	// Session-less support-ticket preview (a Support row with no session yet).
	| { view: "support"; threadId: string }
	| { view: "reports"; automationId?: string; reportId?: string }
	// Analytics — sessions/tokens/models/PRs over a date range.
	| { view: "analytics" }
	| { view: "tasks" }
	| { view: "reviews"; id?: string }
	// PR Tinder — one-at-a-time swipe triage of the repo's open PRs.
	| { view: "prtinder" }
	// Support Tinder — the same swipe triage over the Plain Todo queue.
	| { view: "supporttinder" }
	// Tool surfaces (Automations/Security/Goals/Actions/Notes) render inside the
	// Settings chrome but keep their own routes, so old links stay deep-linkable.
	| { view: "automations"; id?: string }
	| { view: "security" }
	| { view: "goals"; id?: string }
	| { view: "actions"; id?: string }
	| { view: "notes"; sel: NotesSelection }
	| { view: "settings"; section?: SettingsSectionKey }
	| { view: "archived" }
	| { view: "catchup" };

// Stable empty stack, so a chat with no sub-agent open hands the same array
// identity down every render (the transcript memo compares props by identity).
const NO_SUBAGENTS: SubagentRef[] = [];

// Route views that render as a tool section inside the Settings surface.
const TOOL_VIEWS = [
	"automations",
	"security",
	"goals",
	"actions",
	"notes",
] as const;
type ToolView = (typeof TOOL_VIEWS)[number];
function isToolView(view: string): view is ToolView {
	return (TOOL_VIEWS as readonly string[]).includes(view);
}

// Non-tool settings sections, addressable as <base>/settings/<section>.
const SETTINGS_SECTIONS = new Set<SettingsSectionKey>([
	"notifications",
	"composer",
	"appearance",
	"personalPrompt",
	"myAccounts",
	"setup",
	"workspace",
	"model",
	"modelProviders",
	"connections",
	"memory",
	"warmPreviews",
	"previewPool",
	"papercuts",
	"audit",
]);

function parseRoute(pathname: string): Route {
	// Accept both prefixes: /opensession (primary) and /backstage (legacy alias).
	pathname = stripBasePath(pathname);
	// Canonical chat URL: <base>/workspace/<wsId>/chat/<chatId>. The chat id
	// alone identifies the session; the workspace segment makes the hierarchy
	// shareable/readable. Old <base>/session/<id> links keep working and get
	// canonicalized once the session (and its workspace) is known.
	const wsChatMatch = pathname.match(
		/^\/workspace\/[^/]+\/chat\/(.+)$/,
	);
	if (wsChatMatch)
		return { view: "session", id: decodeURIComponent(wsChatMatch[1]) };
	// The workspace container itself (no chat selected), optionally landing on
	// a specific view tab: <base>/workspace/<wsId>[/review|/conversation].
	const wsMatch = pathname.match(
		/^\/workspace\/([^/]+)(?:\/(review|conversation|video))?$/,
	);
	if (wsMatch)
		return {
			view: "workspace",
			id: decodeURIComponent(wsMatch[1]),
			tab: wsMatch[2] as "review" | "conversation" | "video" | undefined,
		};
	const sessionMatch = pathname.match(/^\/session\/(.+)$/);
	if (sessionMatch)
		return { view: "session", id: decodeURIComponent(sessionMatch[1]) };
	// PR preview: <base>/pr/<repo>/<branch> (branch is fully URI-encoded, so
	// slashes in branch names arrive as %2F and land in one segment).
	const prMatch = pathname.match(/^\/pr\/([^/]+)\/(.+)$/);
	if (prMatch)
		return {
			view: "pr",
			repo: decodeURIComponent(prMatch[1]),
			branch: decodeURIComponent(prMatch[2]),
		};
	// Support-ticket preview: <base>/support/<plain thread id>.
	const supportMatch = pathname.match(/^\/support\/(.+)$/);
	if (supportMatch)
		return { view: "support", threadId: decodeURIComponent(supportMatch[1]) };
	const reportsMatch = pathname.match(/^\/reports(?:\/([^/]+)(?:\/([^/]+))?)?$/);
	if (reportsMatch)
		return {
			view: "reports",
			automationId: reportsMatch[1] ? decodeURIComponent(reportsMatch[1]) : undefined,
			reportId: reportsMatch[2] ? decodeURIComponent(reportsMatch[2]) : undefined,
		};
	if (pathname === "/analytics") return { view: "analytics" };
	if (pathname === "/tasks") return { view: "tasks" };
	if (pathname === "/new") return { view: "new" };
	// <base>/automations/<id-or-name>: the automations page with one selected
	// (its detail drawer open). The segment accepts the automation id or name —
	// the sidebar only knows names.
	const autoMatch = pathname.match(/^\/automations(?:\/(.+))?$/);
	if (autoMatch)
		return {
			view: "automations",
			id: autoMatch[1] ? decodeURIComponent(autoMatch[1]) : undefined,
		};
	if (pathname === "/security") return { view: "security" };
	// Goals/Actions mirror /automations/:id — one selected opens its drawer.
	const goalsMatch = pathname.match(/^\/goals(?:\/(.+))?$/);
	if (goalsMatch)
		return {
			view: "goals",
			id: goalsMatch[1] ? decodeURIComponent(goalsMatch[1]) : undefined,
		};
	const actionsMatch = pathname.match(/^\/actions(?:\/(.+))?$/);
	if (actionsMatch)
		return {
			view: "actions",
			id: actionsMatch[1] ? decodeURIComponent(actionsMatch[1]) : undefined,
		};
	// Back-compat: Connections moved into Settings (a Workspace section).
	if (pathname === "/connections")
		return { view: "settings", section: "connections" };
	// <base>/settings/<section>: a settings section, or a legacy tool key.
	const settingsMatch = pathname.match(/^\/settings(?:\/(.+))?$/);
	if (settingsMatch) {
		const key = settingsMatch[1];
		if (key && isToolView(key))
			return key === "notes" ? { view: "notes", sel: null } : { view: key };
		if (key && SETTINGS_SECTIONS.has(key as SettingsSectionKey))
			return { view: "settings", section: key as SettingsSectionKey };
		return { view: "settings" };
	}
	if (pathname === "/archived") return { view: "archived" };
	if (pathname === "/catchup") return { view: "catchup" };
	if (pathname === "/pr-tinder") return { view: "prtinder" };
	if (pathname === "/support-tinder") return { view: "supporttinder" };
	const reviewsMatch = pathname.match(/^\/reviews(?:\/(.+))?$/);
	if (reviewsMatch)
		return {
			view: "reviews",
			id: reviewsMatch[1] ? decodeURIComponent(reviewsMatch[1]) : undefined,
		};
	const noteMatch = pathname.match(/^\/notes(?:\/(.+))?$/);
	if (noteMatch)
		return {
			view: "notes",
			sel: noteMatch[1]
				? { kind: "note", id: decodeURIComponent(noteMatch[1]) }
				: null,
		};
	const docMatch = pathname.match(/^\/docs\/(.+)$/);
	if (docMatch)
		return {
			view: "notes",
			sel: { kind: "doc", path: decodeURIComponent(docMatch[1]) },
		};
	// Back-compat: the old read-only Wiki lived at <base>/wiki/<path>.
	const wikiMatch = pathname.match(/^\/wiki(?:\/(.+))?$/);
	if (wikiMatch)
		return {
			view: "notes",
			sel: wikiMatch[1]
				? { kind: "doc", path: decodeURIComponent(wikiMatch[1]) }
				: null,
		};
	return { view: "home" };
}

function routePath(route: Route): string {
	switch (route.view) {
		case "session":
			return `${BASE_PATH}/session/${encodeURIComponent(route.id)}`;
		case "workspace":
			return `${BASE_PATH}/workspace/${encodeURIComponent(route.id)}${route.tab ? `/${route.tab}` : ""}`;
		case "pr":
			return `${BASE_PATH}/pr/${encodeURIComponent(route.repo)}/${encodeURIComponent(route.branch)}`;
		case "support":
			return `${BASE_PATH}/support/${encodeURIComponent(route.threadId)}`;
		case "reports":
			return route.automationId
				? `${BASE_PATH}/reports/${encodeURIComponent(route.automationId)}${route.reportId ? `/${encodeURIComponent(route.reportId)}` : ""}`
				: `${BASE_PATH}/reports`;
		case "analytics":
			return `${BASE_PATH}/analytics`;
		case "tasks":
			return `${BASE_PATH}/tasks`;
		case "new":
			return route.prompt
				? `${BASE_PATH}/new?prompt=${encodeURIComponent(route.prompt)}`
				: `${BASE_PATH}/new`;
		case "automations":
			return route.id
				? `${BASE_PATH}/automations/${encodeURIComponent(route.id)}`
				: `${BASE_PATH}/automations`;
		case "security":
			return `${BASE_PATH}/security`;
		case "goals":
			return route.id
				? `${BASE_PATH}/goals/${encodeURIComponent(route.id)}`
				: `${BASE_PATH}/goals`;
		case "actions":
			return route.id
				? `${BASE_PATH}/actions/${encodeURIComponent(route.id)}`
				: `${BASE_PATH}/actions`;
		case "settings":
			return route.section
				? `${BASE_PATH}/settings/${route.section}`
				: `${BASE_PATH}/settings`;
		case "archived":
			return `${BASE_PATH}/archived`;
		case "catchup":
			return `${BASE_PATH}/catchup`;
		case "prtinder":
			return `${BASE_PATH}/pr-tinder`;
		case "supporttinder":
			return `${BASE_PATH}/support-tinder`;
		case "reviews":
			return route.id
				? `${BASE_PATH}/reviews/${encodeURIComponent(route.id)}`
				: `${BASE_PATH}/reviews`;
		case "notes":
			if (route.sel?.kind === "note")
				return `${BASE_PATH}/notes/${encodeURIComponent(route.sel.id)}`;
			if (route.sel?.kind === "doc")
				return `${BASE_PATH}/docs/${route.sel.path.split("/").map(encodeURIComponent).join("/")}`;
			return `${BASE_PATH}/notes`;
		default:
			return `${BASE_PATH}/`;
	}
}

// How far the current history entry sits above the sidebar root: 0 is the root
// itself, N a panel with N entries between it and that root. It lives in
// `history.state` rather than a ref because the browser hands state back on
// popstate — so after a Back/Forward we still know where the root is. `null`
// means no root beneath us at all (cold-loaded straight into a panel), where
// Back synthesizes home instead of popping.
type NavState = { d: number } | null;
function entryDepth(): number | null {
	const s = history.state as NavState;
	return s && typeof s.d === "number" ? s.d : null;
}
function navState(depth: number | null): NavState {
	return depth === null ? null : { d: depth };
}

// Two routes address the same panel when they open the same thing. A tab or
// query tweak on the page you are already looking at (the workspace's
// Review↔Conversation tabs, say) refines it rather than opening a new page, so
// it replaces the entry instead of stacking another one.
function samePanel(a: Route, b: Route): boolean {
	if (a.view !== b.view) return false;
	const id = (r: Route) => ("id" in r ? r.id : undefined);
	return id(a) !== undefined && id(a) === id(b);
}

export function App({ serviceWorker = true }: { serviceWorker?: boolean } = {}) {
	const { sessions, loading, cloudUnreachable, refresh, inject, unstick, patch, remove } =
		useSessions();
	const auth = useAuthStatus();
	const localMode = auth?.local === true;
	const { connected, send, addHandler } = useWebSocket();
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;
	type PendingCreateDraft = {
		prompt: string;
		mode: "ask" | "code" | "scratch";
		repo: string;
		branch: string | null;
		projectId?: string;
		model?: string;
		images?: string[];
		startedAt: string;
		user: string;
	};
	const pendingCreateDraftRef = useRef<PendingCreateDraft | null>(null);
	const [pendingInitialPrompts, setPendingInitialPrompts] = useState<
		Record<
			string,
			{ content: string; user: string; sentAt: number; images?: string[] }
		>
	>({});
	// Transient toasts (e.g. "Link copied", "Archived · stopped the running
	// turn") route through the global toast store — stacked, animated, and
	// firable from anywhere without threading a prop. This wrapper keeps the
	// existing `onToast`/`showToast` call sites working.
	const showToast = useCallback((message: string) => {
		toast(message);
	}, []);
	// iOS evicts standalone PWAs from memory and relaunches them at the manifest
	// start_url — losing the session you had open. On a cold load
	// that lands on home, restore the last session so it isn't dropped. This only
	// runs on a fresh document load (never on in-app navigation, which uses
	// pushState), so tapping the logo to go home still works.
	const [route, setRoute] = useState<Route>(() => {
		const parsed = parseRoute(location.pathname);
		if (parsed.view === "home") {
			// Landing on the root: stamp it as the base of the page stack so panels
			// pushed over it can count their way back down.
			history.replaceState(navState(0), "", location.pathname);
			const lastId = localStorage.getItem("opensession-last-session");
			if (lastId) {
				const restored: Route = { view: "session", id: lastId };
				// Push rather than replace: the home entry we actually landed on stays
				// beneath as the root, so Back returns to it instead of out of the app.
				history.pushState(navState(1), "", routePath(restored));
				return restored;
			}
		}
		return parsed;
	});
	// Latest team note per session — the sidebar's unread-note dots.
	const [noteActivity, setNoteActivity] = useState<
		Record<string, { lastTs: number; lastUser: string }>
	>({});
	useEffect(() => {
		fetchSessionNoteActivityApi().then(setNoteActivity).catch(() => {});
	}, []);
	useEffect(
		() =>
			addHandler((msg) => {
				if (msg.type !== "chat_message" || !msg.channel.startsWith("session:"))
					return;
				const id = msg.channel.slice("session:".length);
				setNoteActivity((prev) => ({
					...prev,
					[id]: { lastTs: msg.message.ts, lastUser: msg.message.user },
				}));
			}),
		[addHandler],
	);
	// Session-reference chips in transcripts (`bks-…`) label themselves with the
	// referenced session's title. markdown.ts renders to an HTML string rather
	// than React nodes, so it can't read this from context — hand it the titles
	// we already poll. No-ops unless a title actually changed.
	useEffect(() => {
		setSessionTitles(sessions.map((s) => [s.id, s.title] as const));
	}, [sessions]);
	// Register the service worker at boot, not just when enabling push: it also
	// caches the app shell (sw.js), so a cold start on a flaky tailnet paints
	// the app instead of white-screening.
	useEffect(() => {
		if (serviceWorker) return registerServiceWorker();
	}, [serviceWorker]);
	// On phones the layout is an iOS-style page stack: the sidebar is the root
	// page and any non-home route is a page pushed over it. `mobileDetail` drives
	// that (see the `.mobile-detail` CSS and the back button below). It's inert on
	// desktop, where the sidebar + detail are a static split.
	const detailPaneRef = useRef<HTMLElement | null>(null);
	// Desktop-only: collapse the left sidebar entirely (persisted per browser). On
	// mobile the page-stack (mobileDetail) governs the sidebar instead; this hides
	// the static desktop column and swaps in a floating re-open control.
	const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
		() => localStorage.getItem("opensession-sidebar-collapsed") === "1",
	);
	function toggleSidebarCollapsed() {
		setSidebarCollapsed((v) => {
			const next = !v;
			localStorage.setItem("opensession-sidebar-collapsed", next ? "1" : "0");
			return next;
		});
	}
	// The top bar above the tab strip. The session viewer portals its header
	// (session name + actions, incl. the workspace-panel toggle) into this slot so
	// the layout reads name-on-top / tabs-below; other views render a plain title.
	const [topbarEl, setTopbarEl] = useState<HTMLDivElement | null>(null);
	// Centered under the mobile top-bar title: the composer's model pill is hidden
	// on phones, so the session viewer portals a compact tap-to-switch model
	// selector into this slot — the only place a session's model surfaces there.
	const [headerModelEl, setHeaderModelEl] = useState<HTMLElement | null>(null);
	// Leading slot of the mobile title pill: the session viewer portals the repo
	// tile here so it sits in front of the name (Slack-header style).
	const [headerRepoEl, setHeaderRepoEl] = useState<HTMLElement | null>(null);
	// Right slot of the mobile top bar. On phones the session viewer portals its
	// header actions here (single iOS-style nav bar); desktop hides the bar and
	// the actions render in the topbar slot above instead.
	const [headerActionsEl, setHeaderActionsEl] =
		useState<HTMLDivElement | null>(null);
	// Right-column slot (sibling of the left sidebar). The session viewer portals
	// its workspace/sub-agent panel here so it opens as a full-height column from
	// the very top, at the same level as the left sidebar (Conductor-style).
	const [rightPanelEl, setRightPanelEl] = useState<HTMLDivElement | null>(null);
	// Desktop sidebar width (px), drag-resizable and persisted per browser. The
	// mobile drawer keeps its own fixed width (CSS media query wins there), so
	// this only takes effect on the static desktop column.
	const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
		const v = Number(localStorage.getItem("opensession-sidebar-w"));
		return v >= 200 && v <= 480 ? v : 252;
	});
	const sidebarWidthRef = useRef(sidebarWidth);
	sidebarWidthRef.current = sidebarWidth;
	function startSidebarResize(e: React.MouseEvent) {
		e.preventDefault();
		document.body.classList.add("resizing-sidebar");
		// Snap Motion layout morphs while dragging — the composer + sidebar rows
		// re-measure on every step, so springing them reads as funky text.
		const restoreMotion = suppressLayoutAnimations();
		const onMove = (ev: MouseEvent) => {
			// The sidebar is the leftmost element, so the pointer's x is its width.
			const w = Math.min(480, Math.max(200, ev.clientX));
			sidebarWidthRef.current = w;
			setSidebarWidth(w);
		};
		const onUp = () => {
			document.body.classList.remove("resizing-sidebar");
			restoreMotion();
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			localStorage.setItem(
				"opensession-sidebar-w",
				String(Math.round(sidebarWidthRef.current)),
			);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}
	// A session we've just navigated to that may not be in the polled list yet
	// (create → navigate races the async refresh; the server persists the file
	// before session_created, so this window is just one list fetch). While
	// pending, the detail pane shows a "Starting…" state instead of flashing
	// "Session not found". pendingNewWorkspace words it for a brand-new
	// workspace vs. a chat added to an existing one.
	const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
	const [pendingNewWorkspace, setPendingNewWorkspace] = useState(false);
	// Who's viewing what, app-wide (from global_presence).
	const [teamViewing, setTeamViewing] = useState<
		Array<{ user: string; sessionId: string }>
	>([]);
	const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const [pins, setPins] = useState<string[]>(getPins);
	const [tabColors, setTabColors] =
		useState<Record<string, string>>(getTabColors);
	// Shared notes list — resolves note-tab titles and the Notes view sidebar.
	const [notes, setNotes] = useState<NoteMeta[]>([]);
	const refreshNotes = React.useCallback(() => {
		fetchNotes()
			.then(setNotes)
			.catch(() => {});
	}, []);
	useEffect(() => {
		refreshNotes();
		const onFocus = () => refreshNotes();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refreshNotes]);

	// Projects (folders that group chats) — powers the sidebar's Projects section
	// and the project-scoped tab strip. Refetched on focus and when sessions change
	// (a new PR chat can auto-create a folder server-side).
	const [projects, setProjects] = useState<Project[]>([]);
	const [projectsLoaded, setProjectsLoaded] = useState(false);
	const refreshProjects = React.useCallback(() => {
		fetchProjects()
			.then(setProjects)
			.catch(() => {})
			.finally(() => setProjectsLoaded(true));
	}, []);
	useEffect(() => {
		refreshProjects();
		const onFocus = () => refreshProjects();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refreshProjects]);

	// Subscribe to the per-user pin/color stores. Both hydrate async at module
	// load, and on a fast localhost that load() can resolve (and emit) before
	// this effect ever subscribes — so re-sync once here, or the initial empty
	// state sticks and pinned tabs vanish until the next change event.
	useEffect(() => {
		const unsub = onPinsChanged(() => setPins(getPins()));
		setPins(getPins());
		return unsub;
	}, []);

	// Drop the pins made stale by archiving `justArchived`, mirroring the
	// server's unpinArchivedSessions: each chat's own id + alias ids, plus a
	// `workspace:<id>` pin once none of that workspace's chats are live anymore.
	// The server already does this, but our pin cache is optimistic and never
	// hears about that write — without this a later savePinsApi re-uploads the
	// stale list and resurrects the archived pin as an unreachable ghost row.
	const dropStalePins = React.useCallback((justArchived: UnifiedSession[]) => {
		if (!justArchived.length) return;
		const archivedIds = new Set(justArchived.map((s) => s.id));
		const all = sessionsRef.current;
		const keys: string[] = [];
		const projectIds = new Set<string>();
		for (const s of justArchived) {
			keys.push(s.id, ...(s.aliasIds || []));
			if (s.projectId) projectIds.add(s.projectId);
		}
		for (const pid of projectIds) {
			const hasLive = all.some(
				(s) => s.projectId === pid && !s.archived && !archivedIds.has(s.id),
			);
			if (!hasLive) keys.push(`workspace:${pid}`);
		}
		setPins(unpin(keys));
	}, []);

	// Track the on-screen keyboard via input focus. It's the only reliable iOS
	// signal: in a standalone PWA visualViewport doesn't shrink, and
	// env(safe-area-inset-bottom) keeps reporting the home-indicator inset even
	// while the keyboard covers that area. A `kb-open` body class lets the
	// composer drop its safe-area bottom padding so it sits snug above the
	// keyboard instead of floating ~34px above it.
	useEffect(() => {
		const isText = (el: Element | null) =>
			!!el &&
			(el.tagName === "TEXTAREA" ||
				(el.tagName === "INPUT" &&
					!["button", "checkbox", "radio", "submit", "file", "range", "color"].includes(
						(el as HTMLInputElement).type,
					)) ||
				(el as HTMLElement).isContentEditable);
		const onIn = (e: FocusEvent) => {
			if (isText(e.target as Element)) document.body.classList.add("kb-open");
		};
		const onOut = () => {
			// activeElement updates a tick after focusout; defer so moving between
			// fields doesn't flicker the class off and back on.
			setTimeout(() => {
				if (!isText(document.activeElement)) document.body.classList.remove("kb-open");
			}, 0);
		};
		document.addEventListener("focusin", onIn);
		document.addEventListener("focusout", onOut);
		return () => {
			document.removeEventListener("focusin", onIn);
			document.removeEventListener("focusout", onOut);
		};
	}, []);
	useEffect(() => {
		const unsub = onTabColorsChanged(() => setTabColors(getTabColors()));
		setTabColors(getTabColors());
		return unsub;
	}, []);

	// Settings (and the tool surfaces it hosts) render as a full page on
	// desktop, but as a bottom sheet over the root list on phones.
	const settingsActive =
		route.view === "settings" ||
		(isToolView(route.view) && route.view !== "notes");
	const isPhone = useIsPhone();

	// A pushed detail page is showing (anything but the sidebar-root home view).
	// On phones, Settings is a sheet floating over the root page rather than a
	// pushed page — the bar keeps the brand and the sidebar stays underneath.
	const mobileDetail = route.view !== "home" && !(isPhone && settingsActive);

	// Keep the latest route readable from stable callbacks — `navigate` is
	// recreated each render, but effects/handlers can capture an older copy.
	const routeRef = useRef(route);
	const sidebarRef = useRef<SidebarHandle>(null);
	routeRef.current = route;
	// The mobile layout is an iOS-style navigation stack: the sidebar is the root
	// (depth 0) and each panel is pushed over it. Every entry carries its own
	// depth (see `entryDepth`), so opening one panel from another stacks a real
	// history entry — that is what makes the titlebar's Back/Forward carets (and
	// the browser/OS buttons) walk between the sessions you visited — while
	// `goBack` still returns to the sidebar in a single hop rather than reversing
	// panel by panel.

	// Navigate the detail panel. Opening a different panel pushes an entry;
	// re-navigating to the panel you are already on (or an explicit
	// `replace`) rewrites the current entry instead of duplicating it.
	function navigate(next: Route, opts?: { replace?: boolean }) {
		const path = routePath(next);
		const cur = routeRef.current;
		const toRoot = next.view === "home";
		// Compare on the route, not `location.pathname`: an open chat's URL gets
		// canonicalized to /workspace/<id>/chat/<id> below, so the raw path no
		// longer matches the /session/<id> we would build for the same session.
		const samePath =
			path === location.pathname ||
			routePath(cur) === path ||
			samePanel(cur, next);
		const replace = opts?.replace ?? samePath;
		const depth = entryDepth();
		if (replace) history.replaceState(navState(toRoot ? 0 : depth), "", path);
		else if (toRoot) history.pushState(navState(0), "", path);
		else history.pushState(navState(depth === null ? null : depth + 1), "", path);
		setRoute(next);
	}

	// Pop back to the sidebar root. With the root beneath us, one `history.go`
	// lands on it directly — keeping the browser/OS back button in lockstep
	// without walking back through every panel we pushed on the way. Cold-loaded
	// into a panel there is no root to pop to, so replace to home instead and the
	// stack never grows.
	function goBack() {
		const depth = entryDepth();
		if (depth !== null && depth > 0) history.go(-depth);
		else navigate({ view: "home" }, { replace: true });
	}

	// Leave a full-page deck (catch-up, PR, support) for wherever you came from,
	// rather than popping to the root the way `goBack` does. The root is the
	// useful destination on a phone — it's the sidebar you can't otherwise see —
	// but on desktop the sidebar never went away, so popping there reveals
	// nothing and costs you the chat you were reading before the detour.
	function leaveDeck() {
		const depth = entryDepth();
		if (depth !== null && depth > 0) history.back();
		else navigate({ view: "home" }, { replace: true });
	}

	// Edge-swipe-from-left pops the pushed page back to the sidebar on phones.
	useBackSwipe({
		active: mobileDetail,
		onBack: goBack,
		paneRef: detailPaneRef,
	});

	// Arm audio + request notification permission on the first user gesture.
	useEffect(() => initAlerts(), []);

	// Sound + desktop notification whenever one of *my* sessions newly flips into
	// "needs input" (blocked on a question). Scoped to the current user's own
	// non-automation sessions — the same set as the sidebar's "Needs input" bucket.
	useInputAlerts(sessions, {
		isMine: (s) => {
			const me = getCurrentUser().toLowerCase();
			return (
				!s.automation && !!s.startedBy && s.startedBy.toLowerCase() === me
			);
		},
		isMyReview: (s) =>
			s.reviewRequest?.to?.toLowerCase() === getCurrentUser().toLowerCase() &&
			!s.reviewRequest?.accepted,
		onOpen: (id) => navigate({ view: "session", id }),
		connected,
	});

	// The "new session" ⌘K palette. It's an overlay driven by its own state (not a
	// route), so it can open over any view; the <base>/new route still opens it
	// so old links keep working.
	const [palette, setPalette] = useState<{
		open: boolean;
		prompt?: string;
		// When starting a chat inside a project, prefill the folder + its shared repo
		// and worktree so the new chat lands next to its siblings by default.
		projectId?: string;
		repo?: string;
		branch?: string;
		mode?: "ask" | "code" | "scratch";
	}>(() =>
		route.view === "new" ? { open: true, prompt: route.prompt } : { open: false },
	);
	const paletteOpenRef = useRef(palette.open);
	paletteOpenRef.current = palette.open;
	const openPalette = React.useCallback((prompt?: string) => {
		setPalette({ open: true, prompt });
	}, []);
	const openPrefilledSession = React.useCallback((prefill: NewSessionPrefill) => {
		setPalette({ open: true, ...prefill });
	}, []);

	// A "new tab" while a session is open is a *new chat in that same session*, not
	// a whole new session — so it must NOT pop the new-session palette. It's a
	// visual fresh-start (one thread under the hood): bumping this counter tells the
	// open SessionViewer to clear its composer and scroll to the live edge. With no
	// session open there's nothing to stay in, so it falls back to the palette.
	const [newChatSeq, setNewChatSeq] = useState(0);
	// Which non-chat view-tab is foregrounded. A single field makes "both open
	// at once" unrepresentable; the show-flags derive from it. The selection is
	// restored per workspace below rather than leaking across workspaces.
	const [activeViewTab, setActiveViewTabState] =
		useState<ActiveViewTab>(null);
	const reviewActive = activeViewTab === "review";
	const conversationActive = activeViewTab === "conversation";
	const videoActive = activeViewTab === "video";
	const stagingActive = activeViewTab === "staging";
	const assetsActive = activeViewTab === "assets";
	const previewLiveActive = activeViewTab === "preview";
	const subagentSelected = activeViewTab === "subagent";
	// Workspaces whose Review / Conversation / Preview environment view-tab is
	// present in the strip; empty by default (a tab is added when its pane is
	// first opened).
	const [reviewOpen, setReviewOpen] = useState<Set<string>>(
		() => new Set(getActiveViewTabKeys("review")),
	);
	// PR-backed workspaces (adopted from a PR — the ghpr ones) show Review by
	// default even when you land straight in one of their chats; this tracks
	// their explicit closes, mirroring conversationClosed below.
	const [reviewClosed, setReviewClosed] = useState<Set<string>>(
		() => new Set(),
	);
	// Conversation is default-PRESENT on any workspace/chat linked to a Plain
	// thread (unlike Review, which is opened on demand) — so the state tracks
	// explicit closes, not opens.
	const [conversationClosed, setConversationClosed] = useState<Set<string>>(
		() => new Set(),
	);
	// The Video (feed web-panel) tab is likewise default-PRESENT on workspaces
	// carrying a web-panel ExternalRef (Tella videos) — track explicit closes.
	const [videoClosed, setVideoClosed] = useState<Set<string>>(() => new Set());
	const [stagingOpen, setStagingOpen] = useState<Set<string>>(
		() => new Set(getActiveViewTabKeys("staging")),
	);
	// Sessions whose local-dev Preview view-tab is open (full-width iframe of
	// the running dev server — sibling of Staging, which shows the PR deploy).
	const [previewTabOpen, setPreviewTabOpen] = useState<Set<string>>(
		() => new Set(getActiveViewTabKeys("preview")),
	);
	const [assetsOpen, setAssetsOpen] = useState<Set<string>>(
		() => new Set(getActiveViewTabKeys("assets")),
	);
	// Sub-agent drill-ins, keyed by the chat they were opened from (a sub-agent
	// belongs to one chat's run). The value is a breadcrumb stack — a Task call
	// inside a sub-agent pushes another entry. In-memory only, like the tab
	// itself: the transcript is re-fetched whenever it's reopened.
	const [subagentTabs, setSubagentTabs] = useState<Record<string, SubagentRef[]>>(
		{},
	);
	// Bumped when the per-workspace tab order changes (a drag-drop commit, or a
	// storage push from another tab) so the strip re-derives `projectChats` in
	// the new order. The order itself lives in localStorage (lib/tab-order).
	const [, setTabOrderRev] = useState(0);
	useEffect(
		() => onTabOrderChanged(() => setTabOrderRev((v) => v + 1)),
		[],
	);
	const [, setTabSplitRev] = useState(0);
	useEffect(
		() => onTabSplitChanged(() => setTabSplitRev((value) => value + 1)),
		[],
	);
	const [splitDropSide, setSplitDropSide] = useState<"left" | "right" | null>(
		null,
	);
	// One-shot: the session whose Review tab should foreground once it lands, set
	// when opening Review from the sidebar. Survives the session-change reset
	// below (a pulse consumed by the effect next to it), then cleared. (Staging
	// only opens from within the already-current session, so it needs no such
	// pending pulse.)
	const [pendingReviewOpen, setPendingReviewOpen] = useState<string | null>(null);
	// One-shot guard consumed by the workspace default-pane seeding effect (set
	// when closing a view tab replaces the workspace URL — see onCloseView).
	const suppressWsSeedRef = useRef(false);

	// Set for the render right after opening a workspace from the sidebar, so the
	// session it lands on autofocuses its composer (you picked the workspace to
	// type in it). Reset immediately after — a one-shot pulse, not a mode — so
	// sessions opened by any other means don't grab focus.
	const [focusComposerOnOpen, setFocusComposerOnOpen] = useState(false);
	const [sessionComposerPrefills, setSessionComposerPrefills] = useState<
		Record<string, { seq: number; text: string }>
	>({});
	const addToSessionInput = React.useCallback((sessionId: string, text: string) => {
		setSessionComposerPrefills((prev) => ({
			...prev,
			[sessionId]: { seq: (prev[sessionId]?.seq ?? 0) + 1, text },
		}));
		setFocusComposerOnOpen(true);
		navigate({ view: "session", id: sessionId });
	}, []);
	useEffect(() => {
		if (focusComposerOnOpen) setFocusComposerOnOpen(false);
	}, [focusComposerOnOpen]);

	// The ⌘K command palette. Sessions, PRs, and app actions share one overlay
	// driven by its own state so it can open over any view.
	const [searchOpen, setSearchOpen] = useState(false);
	// The Desk overlay (⌘J / the floating desk button): a standing concierge
	// session on top of whatever view is open.
	const [deskOpen, setDeskOpen] = useState(false);
	// Open-task count for the Tasks toolbar entry — refreshed on every
	// todos_changed broadcast (the Tasks page, agent tools, or another tab).
	const [taskCount, setTaskCount] = useState(0);
	useEffect(() => {
		let stale = false;
		const load = async () => {
			try {
				const res = await fetch(
					`${BASE_PATH}/api/todos?user=${encodeURIComponent(getCurrentUser())}`,
				);
				const data = (await res.json()) as { todos?: unknown[] };
				if (!stale) setTaskCount(data.todos?.length ?? 0);
			} catch {}
		};
		void load();
		const unsub = addHandler((msg) => {
			if (msg.type === "todos_changed") void load();
		});
		return () => {
			stale = true;
			unsub();
		};
	}, [addHandler]);
	const searchOpenRef = useRef(searchOpen);
	searchOpenRef.current = searchOpen;
	const closePalette = React.useCallback(() => {
		setPalette({ open: false });
		// A deep link left the URL on <base>/new — return home on close.
		if (stripBasePath(location.pathname) === "/new") goBack();
	}, []);

	useEffect(() => {
		const onPop = () => {
			// Depth travels with the entry (history.state), so there is nothing to
			// recompute here — just follow the URL we landed on.
			setRoute(parseRoute(location.pathname));
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	// Creator Micro macropad → client-side navigation. A local daemon on the
	// user's machine streams app route paths (e.g. "/workspace/<prj>/chat/<bks>")
	// over SSE; each message navigates in-app via the router — no reload.
	// Silently inert when the daemon isn't running / not on this machine.
	useEffect(() => {
		if (typeof window === "undefined" || typeof EventSource === "undefined")
			return;
		let es: EventSource | undefined;
		try {
			es = new EventSource("http://localhost:8766/nav");
			es.onmessage = (e) => {
				const path = typeof e.data === "string" ? e.data.trim() : "";
				if (!path.startsWith("/")) return;
				navigate(parseRoute(path));
			};
			es.onerror = () => {}; // daemon absent: EventSource retries quietly
		} catch {}
		return () => es?.close();
	}, []);

	// The link ⌘⇧C copies: the open chat/workspace, or the open PR preview.
	// Assigned during render (below, once currentSession is known); null when
	// the current view has nothing linkable.
	const copyLinkPathRef = useRef<string | null>(null);

	// ⌘K toggles the command palette; ⌘N the new-session palette; ⌘⇧C copies a
	// link to the open chat/PR. Esc closes whichever palette is open (search's
	// own input also handles Esc, but this covers the case where focus has left
	// it).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const k = e.key.toLowerCase();
			if ((e.metaKey || e.ctrlKey) && k === "k") {
				e.preventDefault();
				setSearchOpen((o) => !o);
				return;
			}
			if ((e.metaKey || e.ctrlKey) && k === "n") {
				e.preventDefault();
				paletteOpenRef.current ? closePalette() : openPalette();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && k === "j") {
				// Summon/dismiss the Desk overlay. Esc-close is handled by the
				// overlay itself (Base UI dialog / the bottom sheet).
				e.preventDefault();
				setDeskOpen((o) => !o);
				return;
			}
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && k === "b") {
				// Toggle the desktop left sidebar. ⌘B is the panel-toggle
				// convention (VS Code / Slack); ⌘S is left to the browser's Save.
				e.preventDefault();
				toggleSidebarCollapsed();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && k === "c") {
				// Let a real text selection copy normally; only hijack ⌘⇧C when
				// there's a linkable view and nothing is selected.
				if (window.getSelection?.()?.toString()) return;
				const path = copyLinkPathRef.current;
				if (!path) return;
				e.preventDefault();
				copyToClipboard(absoluteLink(path), () => showToast("Link copied"));
				return;
			}
			if (e.key === "Escape") {
				if (searchOpenRef.current) setSearchOpen(false);
				else if (paletteOpenRef.current) closePalette();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [openPalette, closePalette, showToast]);

	// Remember the last session so a cold relaunch can restore it (see above);
	// clear it when the user deliberately goes home so we don't force them back in.
	// Also feed the sidebar's "Recently opened" list.
	useEffect(() => {
		if (route.view === "session") {
			localStorage.setItem("opensession-last-session", route.id);
			pushRecent(route.id);
		} else if (route.view === "home") {
			localStorage.removeItem("opensession-last-session");
		}
	}, [route]);

	// Tear down the launch splash (rendered in index.html) once the app has mounted.
	useEffect(() => {
		const splash = document.getElementById("splash");
		if (!splash) return;
		splash.classList.add("splash-hide");
		const t = setTimeout(() => splash.remove(), 400);
		return () => clearTimeout(t);
	}, []);

	// When a session is created from the New Session form or Ask box, jump straight into it
	useEffect(() => {
		return addHandler((msg) => {
			if (msg.type === "pins_changed") {
				receivePins(msg.user, msg.pins);
				return;
			}
			if (msg.type === "global_presence") {
				setTeamViewing(msg.viewing);
				return;
			}
			if (msg.type === "session_created") {
				const draft = pendingCreateDraftRef.current;
				pendingCreateDraftRef.current = null;
				// Pin the just-created session for its creator (this WS reply is
				// creator-only, so it never pins a teammate's new chat onto my bar).
				// Per-browser prefs in Settings: new chats/sessions pin on by
				// default; new workspaces are heavier, so they have their own
				// pref that's off by default.
				const shouldPin = msg.newWorkspace
					? getPinNewWorkspaces()
					: getPinNewSessions();
				if (shouldPin) setPins(pin(msg.id));
				if (!sessionsRef.current.some((s) => s.id === msg.id)) {
					const now = new Date().toISOString();
					const user = draft?.user || getCurrentUser();
					const createdAt = draft?.startedAt || now;
					inject({
						id: msg.id,
						claudeSessionId: null,
						source: "backstage",
						branch: draft?.branch ?? null,
						worktreeDir: null,
						startedBy: user,
						title: msg.newWorkspace
							? "New workspace"
							: draft?.projectId
								? "New chat"
								: "New session",
						lastActivity: now,
						createdAt,
						isRunning: true,
						runStartedAt: now,
						transcriptPath: null,
						mode: draft?.mode,
						repo: draft?.repo,
						projectId: msg.workspaceId || draft?.projectId || null,
						model: draft?.model,
						archived: false,
						// Worktree prep still running server-side — the viewer opens
						// straight into its "Waiting for workspace" state.
						workspacePreparing: !!msg.preparingWorkspace,
						},
						// Keep the optimistic copy alive across polls until the server
						// registers it, so the new tab renders straight away instead of
						// flashing "Starting…" — matters most for a new workspace, whose
						// worktree prep can take several polls to land.
						{ sticky: true });
				}
				if (draft?.prompt || draft?.images?.length) {
					setPendingInitialPrompts((prev) => ({
						...prev,
						[msg.id]: {
							content: draft.prompt,
							user: draft.user,
							sentAt: new Date(draft.startedAt).getTime(),
							...(draft.images?.length ? { images: draft.images } : {}),
						},
					}));
					window.setTimeout(() => {
						setPendingInitialPrompts((prev) => {
							if (!prev[msg.id]) return prev;
							const next = { ...prev };
							delete next[msg.id];
							return next;
						});
					}, 120_000);
				}
				// Mark it pending so the viewer shows "Starting…" until the poll
				// catches up; a fallback timeout clears it so a failed create can't
				// stick — including dropping the sticky optimistic copy above.
				setPendingSessionId(msg.id);
				setPendingNewWorkspace(!!msg.newWorkspace);
				clearTimeout(pendingTimer.current);
				pendingTimer.current = setTimeout(() => {
					setPendingSessionId(null);
					unstick(msg.id);
				}, 30000);
				refresh();
				refreshProjects();
				navigate({ view: "session", id: msg.id });
			}
		});
	}, [addHandler, refresh, refreshProjects, unstick]);

	// Drop the pending flag once we've navigated away from the pending chat (its
	// fallback timeout clears it otherwise). We deliberately DON'T clear it the
	// instant the session first shows up in the list: a poll that predates the
	// create can momentarily drop the just-injected copy again, and clearing here
	// would flash "Session not found" in that gap. Keeping the flag set masks the
	// gap with the "Starting…" state until the next poll re-adds the session (or
	// the timeout fires on a genuinely failed create).
	useEffect(() => {
		if (
			pendingSessionId &&
			!(route.view === "session" && route.id === pendingSessionId)
		) {
			setPendingSessionId(null);
			clearTimeout(pendingTimer.current);
			// Drop its sticky status now that we've left (and cancelled the 30s
			// fallback). A real session is retained by the next poll; a phantom
			// from a failed create is reconciled away instead of lingering.
			unstick(pendingSessionId);
		}
	}, [route, pendingSessionId, unstick]);

	const currentSession: UnifiedSession | null =
		route.view === "session"
			? sessions.find(
					(s) => s.id === route.id || s.aliasIds?.includes(route.id),
				) || null
			: null;

	// The open chat, read by the mount-once tab-shortcut handler (⌘⌥C / ⌘W —
	// see the effect next to closeChat below).
	const currentSessionRef = useRef<UnifiedSession | null>(null);
	// Stable key the view-tab state (Review/Preview/Assets panes) is stored
	// under: the workspace id, the shared isolated worktree, or the lone chat
	// id — the same grouping rule as the tab strip (tabOrderKey below), so a
	// view tab opened in a workspace survives switching between sibling chats.
	const wsKeyFor = (s: UnifiedSession | null | undefined): string | null =>
		s
			? s.projectId ||
				(s.worktreeDir?.includes("/worktrees/")
					? s.worktreeDir
					: s.id)
			: null;
	// On the chat-less workspace route the key is the route's workspace id.
	const routeWorkspaceId = route.view === "workspace" ? route.id : null;
	const routeWorkspace: Project | null = routeWorkspaceId
		? projects.find((p) => p.id === routeWorkspaceId) || null
		: null;
	const wsKey = routeWorkspaceId ?? wsKeyFor(currentSession);
	const wsRecord =
		routeWorkspace ??
		(currentSession?.projectId
			? projects.find((p) => p.id === currentSession.projectId) || null
			: null);
	const reviewDismissed = !!wsKey && reviewClosed.has(wsKey);
	// Review only leads for a chat-less PR workspace; with chats, the main/last
	// chat is the landing surface and Review sits at the end of the strip.
	const wsHasLiveChat =
		!!currentSession ||
		(!!wsKey &&
			sessions.some(
				(s) => !s.archived && !s.sideChatOf && s.projectId === wsKey,
			));
	const defaultChatView = defaultChatWorkspaceView(
		wsRecord,
		reviewDismissed,
		wsHasLiveChat,
	);
	function setActiveViewTab(tab: ActiveViewTab) {
		setActiveViewTabState(tab);
		if (wsKey) saveActiveViewTab(wsKey, tab);
	}
	// Return each workspace to its last foregrounded tab. A workspace without a
	// saved selection still starts on its normal default surface. Switching chats
	// within a workspace records chat as the selection via the tab-strip handler.
	useEffect(() => {
		const remembered = wsKey ? getActiveViewTab(wsKey) : undefined;
		setActiveViewTabState(remembered === undefined ? defaultChatView : remembered);
	}, [wsKey, defaultChatView]);
	// ...unless we just opened Review for that workspace from the sidebar: once
	// it lands (this render or the one after navigation), foreground Review and
	// consume the pulse. Runs after the reset effect above, so it wins.
	useEffect(() => {
		if (pendingReviewOpen && pendingReviewOpen === wsKey) {
			setActiveViewTab("review");
			setPendingReviewOpen(null);
		}
	}, [wsKey, pendingReviewOpen]);
	// Landing on the workspace route: foreground its default pane. An explicit
	// /review or /conversation suffix wins; otherwise land in the remembered
	// chat (or the main chat on first visit). A chat-less PR workspace still
	// opens Review. Declared after the wsKey reset effect above so the landing
	// choice wins the same commit.
	useEffect(() => {
		if (route.view !== "workspace" || !projectsLoaded) return;
		// One-shot: closing the Review tab replaces the URL (dropping /review),
		// which re-runs this effect — without the suppress it would immediately
		// re-seed the default pane and reopen the tab just closed.
		if (suppressWsSeedRef.current) {
			suppressWsSeedRef.current = false;
			return;
		}
		const p = projects.find((x) => x.id === route.id) || null;
		// Default pane by workspace shape: ticket workspaces open on the
		// Conversation; everything else — PR-backed included — lands in its
		// main/last-open chat. A PR workspace only defaults to Review when it
		// has no chat to land in (the else branch below).
		// Default pane by workspace shape — but a workspace WITH chats always
		// lands in its main/last-open chat (same rule as PR workspaces); the
		// panel (Conversation/Video) is only the landing surface when there is
		// no chat to land in. Explicit /conversation-/video URLs still win.
		const hasChat = !!pickLandingChat(
			sessionsRef.current,
			route.id,
			getWorkspaceLastChat(route.id),
		);
		const tab =
			route.tab ??
			(hasChat
				? null
				: p?.plainThreadId
					? "conversation"
					: p?.externalRefs?.some((r) => refWebPanel(r))
						? "video"
						: null);
		const key = route.id;
		// Landing in the workspace's first chat keeps the full session chrome —
		// including the right sidebar — around the foregrounded pane (wsKey is
		// unchanged, so the view-tab reset effect doesn't fire). Chat-less
		// workspaces stay on WorkspacePane, which renders its own info panel.
		const firstChat = () =>
			pickLandingChat(sessionsRef.current, key, getWorkspaceLastChat(key));
		if (tab === "review") {
			setReviewOpen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
			setActiveViewTab("review");
			const first = firstChat();
			if (first) navigate({ view: "session", id: first.id }, { replace: true });
		} else if (tab === "conversation") {
			setConversationClosed((prev) => {
				if (!prev.has(key)) return prev;
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
			setActiveViewTab("conversation");
			const first = firstChat();
			if (first) navigate({ view: "session", id: first.id }, { replace: true });
		} else if (tab === "video") {
			setVideoClosed((prev) => {
				if (!prev.has(key)) return prev;
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
			setActiveViewTab("video");
			const first = firstChat();
			if (first) navigate({ view: "session", id: first.id }, { replace: true });
		} else {
			const first = firstChat();
			if (first) {
				// A bare workspace navigation means "open this workspace's chat",
				// even if Review was the last non-chat pane foregrounded here.
				setActiveViewTab(null);
				navigate({ view: "session", id: first.id }, { replace: true });
			} else if (p && (p.branch || p.prNumber !== undefined)) {
				// Chat-less PR/branch workspace: Review is the only meaningful
				// surface, so foreground it like an explicit /review landing.
				setReviewOpen((prev) =>
					prev.has(key) ? prev : new Set(prev).add(key),
				);
				setActiveViewTab("review");
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		route.view === "workspace" ? `${route.id}:${route.tab ?? ""}` : null,
		projectsLoaded,
	]);
	// Retired standalone pages (2026-07-24): /pr/…, /support/… and /reviews
	// deep links resolve into the workspace container and redirect (replace).
	// The old components keep rendering as the in-flight/failure fallback, so
	// a failed resolve degrades to the previous behavior instead of a dead
	// link. Bare /reviews goes home — the sidebar bands are the inbox now.
	useEffect(() => {
		let stale = false;
		const toWorkspace = (
			workspaceId: string,
			tab: "review" | "conversation",
		) => {
			if (stale) return;
			refreshProjects();
			navigate({ view: "workspace", id: workspaceId, tab }, { replace: true });
		};
		if (route.view === "pr") {
			resolveWorkspaceApi({ pr: { repo: route.repo, branch: route.branch } })
				.then(({ workspaceId }) => toWorkspace(workspaceId, "review"))
				.catch(() => {});
		} else if (route.view === "support") {
			resolveWorkspaceApi({ plainThreadId: route.threadId })
				.then(({ workspaceId }) => toWorkspace(workspaceId, "conversation"))
				.catch(() => {});
		} else if (route.view === "reviews") {
			if (!route.id) {
				navigate({ view: "home" }, { replace: true });
			} else {
				const id = route.id;
				const s = sessionsRef.current.find(
					(x) => x.id === id || x.aliasIds?.includes(id),
				);
				if (s?.projectId)
					navigate(
						{ view: "workspace", id: s.projectId, tab: "review" },
						{ replace: true },
					);
				else if (s?.branch)
					resolveWorkspaceApi({
						pr: { repo: s.repo || DEFAULT_REPO_ID, branch: s.branch },
					})
						.then(({ workspaceId }) => toWorkspace(workspaceId, "review"))
						.catch(() => {});
			}
		}
		return () => {
			stale = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [route, loading]);
	// The current code session's Review pane, surfaced as a leftmost view-tab in
	// the top strip (siblings share the worktree/PR, so one Review tab suffices).
	const currentHasWorkspace =
		!!currentSession && sessionHasWorkspace(currentSession);
	// Review renders without a chat too: a chat-less PR-backed workspace
	// (branch/prNumber on the record) reviews through the preview APIs.
	const reviewCapable = currentSession
		? currentHasWorkspace
		: !!routeWorkspace &&
			Boolean(routeWorkspace.branch || routeWorkspace.prNumber !== undefined);
	// A PR-backed workspace's whole point is its PR, so its Review tab is
	// default-present (leftmost) however you landed — a sidebar PR row, a chat
	// deep link, a tab switch — until explicitly dismissed (reviewClosed).
	const prBackedWorkspace =
		!!wsRecord &&
		(wsRecord.prNumber !== undefined || !!wsRecord.key?.startsWith("ghpr-"));
	const reviewViewTabs: ViewTab[] =
		reviewCapable &&
		wsKey &&
		(reviewOpen.has(wsKey) ||
			(prBackedWorkspace && !reviewClosed.has(wsKey)))
			? [
					{
						id: `review:${wsKey}`,
						label: "Review",
						active: reviewActive,
						dotClass: currentSession?.prState
							? currentSession.prState === "OPEN" &&
								currentSession.prMergeable === "CONFLICTING"
								? "pr-dot-conflict"
								: `pr-dot-${currentSession.prState.toLowerCase()}`
							: null,
					},
				]
			: [];
	// The Conversation view-tab: the Plain support-ticket thread the workspace
	// (or the open chat) is attached to — timeline, admin actions, replies.
	const conversationThreadId =
		routeWorkspace?.plainThreadId ?? currentSession?.plainThreadId ?? null;
	const conversationViewTabs: ViewTab[] =
		conversationThreadId && wsKey && !conversationClosed.has(wsKey)
			? [
					{
						id: `conversation:${wsKey}`,
						label: "Conversation",
						active: conversationActive,
						dotClass: null,
					},
				]
			: [];
	// Feed descriptors (panel templates, labels) into the module cache that
	// refWebPanel reads — without this the panel has no descriptors to resolve.
	const [, setFeedMetaTick] = useState(0);
	useEffect(() => {
		void ensureFeedMeta().then(() => setFeedMetaTick((t) => t + 1));
	}, []);
	// The Video view-tab: the web panel of the workspace's (or open chat's)
	// feed-item ExternalRef — e.g. the Tella video embed (the feeds design).
	// On a chat route routeWorkspace is null, so fall back to the open chat's
	// workspace record — otherwise the tab vanishes as soon as a chat exists.
	const videoWorkspace =
		routeWorkspace ??
		(currentSession?.projectId
			? projects.find((p) => p.id === currentSession.projectId) ?? null
			: null);
	const videoRef =
		(
			videoWorkspace?.externalRefs ??
			currentSession?.externalRefs ??
			[]
		).find((r) => refWebPanel(r)) ?? null;
	const videoPanel = videoRef ? refWebPanel(videoRef) : null;
	const videoViewTabs: ViewTab[] =
		videoPanel && wsKey && !videoClosed.has(wsKey)
			? [
					{
						id: `video:${wsKey}`,
						label: videoPanel.label,
						active: videoActive,
						dotClass: null,
					},
				]
			: [];
	// The Preview environment view-tab (the PR's Vercel preview, full-width) —
	// opened from the Info panel button. Present once opened for this session.
	const stagingViewTabs: ViewTab[] =
		currentSession && wsKey && stagingOpen.has(wsKey)
			? [
					{
						id: `staging:${wsKey}`,
						label: "Preview environment",
						active: stagingActive,
						dotClass: null,
						// The Preview environment tab reads as just a globe;
						// "Preview environment" stays as its tooltip / aria label.
						icon: <IconGlobe size={16} />,
					},
				]
			: [];
	// The Assets view-tab (the session's scratch artifacts, full-width) — opened
	// from the Info panel's Assets button. Present once opened for this session.
	const assetsViewTabs: ViewTab[] =
		currentSession && wsKey && assetsOpen.has(wsKey)
			? [
					{
						id: `assets:${wsKey}`,
						label: "Assets",
						active: assetsActive,
						dotClass: null,
					},
				]
			: [];
	// The local-dev Preview view-tab (live dev server iframe) — opened from
	// the header Preview button. Present once opened for this session.
	const previewViewTabs: ViewTab[] =
		currentSession && wsKey && previewTabOpen.has(wsKey)
			? [
					{
						id: `preview:${wsKey}`,
						label: "Preview",
						active: previewLiveActive,
						dotClass: null,
					},
				]
			: [];
	// The sub-agent view-tab: a Task drill-in from the open chat's transcript.
	// Bound to that chat rather than the workspace, so switching to a sibling
	// chat hides it — and switching back brings its breadcrumb along. Only the
	// OPEN chat's tab is ever built, so the id's session always matches the
	// pane the split machinery resolves it to.
	const subagentStack = currentSession
		? (subagentTabs[currentSession.id] ?? NO_SUBAGENTS)
		: NO_SUBAGENTS;
	const subagentActive = subagentSelected && subagentStack.length > 0;
	const subagentViewTabs: ViewTab[] =
		currentSession && subagentStack.length > 0
			? [
					{
						id: `subagent:${currentSession.id}`,
						label: subagentStack[subagentStack.length - 1].label,
						active: subagentActive,
						dotClass: null,
					},
				]
			: [];
	// Review leftmost, then Conversation, Preview environment, Preview, Assets,
	// and the sub-agent drill-in last (it comes and goes with the chat).
	const viewTabs: ViewTab[] = [
		...reviewViewTabs,
		...conversationViewTabs,
		...videoViewTabs,
		...stagingViewTabs,
		...previewViewTabs,
		...assetsViewTabs,
		...subagentViewTabs,
	];
	function viewTabKind(id: string): Exclude<ActiveViewTab, null> | null {
		if (id.startsWith("subagent:")) return "subagent";
		if (id.startsWith("staging:")) return "staging";
		if (id.startsWith("assets:")) return "assets";
		if (id.startsWith("preview:")) return "preview";
		if (id.startsWith("conversation:")) return "conversation";
		if (id.startsWith("video:")) return "video";
		if (id.startsWith("review:")) return "review";
		return null;
	}
	function selectViewTab(id: string) {
		const tab = viewTabKind(id);
		if (!tab) return;
		setActiveViewTab(tab);
		if (
			route.view === "workspace" &&
			(tab === "review" || tab === "conversation" || tab === "video")
		)
			navigate({ view: "workspace", id: route.id, tab }, { replace: true });
	}
	// Foreground/dismiss the Review view-tab; onOpenReview re-adds a dismissed
	// one (fired by the PR status chip / "open PR" affordances in SessionViewer).
	function openReview() {
		if (!wsKey) return;
		const key = wsKey;
		setReviewOpen((prev) => {
			if (prev.has(key)) return prev;
			return new Set(prev).add(key);
		});
		// Un-dismiss a PR-backed workspace's default-present tab.
		setReviewClosed((prev) => {
			if (!prev.has(key)) return prev;
			const next = new Set(prev);
			next.delete(key);
			return next;
		});
		setActiveViewTab("review");
	}
	function closeReviewTab() {
		if (wsKey) {
			const key = wsKey;
			setReviewOpen((prev) => {
				if (!prev.has(key)) return prev;
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
			// PR-backed workspaces show Review by default — record the dismissal
			// or the tab pops right back.
			setReviewClosed((prev) => {
				if (prev.has(key)) return prev;
				return new Set(prev).add(key);
			});
		}
		// Only fall back to chat if Review was the foregrounded pane — closing the
		// Review tab while the Preview environment is active leaves it up.
		if (reviewActive) setActiveViewTab(null);
	}
	// Foreground this workspace's Conversation view-tab (the Plain ticket
	// thread); re-adds a dismissed one.
	function openConversation() {
		if (!wsKey) return;
		const key = wsKey;
		setConversationClosed((prev) => {
			if (!prev.has(key)) return prev;
			const next = new Set(prev);
			next.delete(key);
			return next;
		});
		setActiveViewTab("conversation");
	}
	function closeConversationTab() {
		if (wsKey) {
			const key = wsKey;
			setConversationClosed((prev) => {
				if (prev.has(key)) return prev;
				return new Set(prev).add(key);
			});
		}
		if (conversationActive) setActiveViewTab(null);
	}
	function closeVideoTab() {
		if (wsKey) {
			const key = wsKey;
			setVideoClosed((prev) => {
				if (prev.has(key)) return prev;
				return new Set(prev).add(key);
			});
		}
		if (videoActive) setActiveViewTab(null);
	}
	// Open/foreground this workspace's Preview environment view-tab (the Info
	// panel button). Adds the tab to the strip if absent.
	function openStaging() {
		if (!wsKey) return;
		const key = wsKey;
		setStagingOpen((prev) => {
			if (prev.has(key)) return prev;
			return new Set(prev).add(key);
		});
		setActiveViewTab("staging");
	}
	// Open/foreground this workspace's local-dev Preview view-tab (the header
	// Preview button routes here instead of window.open — the Mac shell was
	// turning those into stray Electron windows).
	function openPreviewTab() {
		if (!wsKey) return;
		const key = wsKey;
		setPreviewTabOpen((prev) => {
			if (prev.has(key)) return prev;
			return new Set(prev).add(key);
		});
		setActiveViewTab("preview");
	}
	function closePreviewTab() {
		if (wsKey) {
			const key = wsKey;
			setPreviewTabOpen((prev) => {
				if (!prev.has(key)) return prev;
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
		}
		if (previewLiveActive) setActiveViewTab(null);
	}
	function closeStagingTab() {
		if (wsKey) {
			const key = wsKey;
			setStagingOpen((prev) => {
				if (!prev.has(key)) return prev;
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
		}
		if (stagingActive) setActiveViewTab(null);
	}
	// Open/foreground this workspace's Assets view-tab (the Info panel's Assets
	// button). Adds the tab to the strip if absent.
	function openAssets() {
		if (!wsKey) return;
		const key = wsKey;
		setAssetsOpen((prev) => {
			if (prev.has(key)) return prev;
			return new Set(prev).add(key);
		});
		setActiveViewTab("assets");
	}
	function closeAssetsTab() {
		if (wsKey) {
			const key = wsKey;
			setAssetsOpen((prev) => {
				if (!prev.has(key)) return prev;
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
		}
		if (assetsActive) setActiveViewTab(null);
	}
	// Open (or foreground) a chat's sub-agent tab — the transcript's "Watch"
	// drill-in on a Task call. A Task call inside the sub-agent pushes onto the
	// same tab's breadcrumb instead of opening a second one. Stable identity:
	// it reaches the memoized transcript as a prop, and the tab is never
	// persisted, so it needs nothing from the render scope.
	const openSubagent = React.useCallback(
		(sessionId: string, agentId: string, label: string) => {
			setSubagentTabs((prev) => {
				const stack = prev[sessionId] ?? NO_SUBAGENTS;
				if (stack.some((s) => s.agentId === agentId)) return prev;
				return { ...prev, [sessionId]: [...stack, { agentId, label }] };
			});
			setActiveViewTabState("subagent");
		},
		[],
	);
	const popSubagent = React.useCallback((sessionId: string) => {
		setSubagentTabs((prev) => {
			const stack = prev[sessionId];
			if (!stack?.length) return prev;
			const next = { ...prev };
			if (stack.length === 1) delete next[sessionId];
			else next[sessionId] = stack.slice(0, -1);
			return next;
		});
	}, []);
	const closeSubagentTab = React.useCallback((sessionId: string) => {
		setSubagentTabs((prev) => {
			if (!prev[sessionId]) return prev;
			const next = { ...prev };
			delete next[sessionId];
			return next;
		});
		// Same commit as the close, like every other closeXTab — the effect
		// below only has to catch the chat-switch case.
		setActiveViewTabState((cur) => (cur === "subagent" ? null : cur));
	}, []);
	// Dropping the last breadcrumb (or switching to a chat with no sub-agent
	// open) leaves nothing to show — fall back to the chat itself.
	useEffect(() => {
		if (subagentSelected && subagentStack.length === 0) setActiveViewTabState(null);
	}, [subagentSelected, subagentStack.length]);
	// Sidebar PR row → the PR's ONE workspace (resolve-or-create server-side,
	// adopt-don't-duplicate), landing in its main/last-open chat (Review only
	// leads when the workspace has no chats — the workspace-landing effect
	// decides). Falls back to the legacy preview routes if the resolve fails,
	// so a click is never dead.
	const openPrWorkspace = React.useCallback(
		async (item: ReviewQueueItem) => {
			try {
				const { workspaceId } = await resolveWorkspaceApi({
					pr: {
						repo: item.pr.repo,
						number: item.pr.number,
						branch: item.pr.branch,
						title: item.pr.title,
					},
				});
				refreshProjects();
				navigate({ view: "workspace", id: workspaceId });
			} catch {
				if (item.sessionId) navigate({ view: "reviews", id: item.sessionId });
				else
					navigate({ view: "pr", repo: item.pr.repo, branch: item.pr.branch });
			}
		},
		[refreshProjects],
	);
	const openPrReview = React.useCallback(
		async (pr: OpenPr) => {
			try {
				const { workspaceId } = await resolveWorkspaceApi({
					pr: {
						repo: pr.repo,
						number: pr.number,
						branch: pr.branch,
						title: pr.title,
					},
				});
				refreshProjects();
				navigate({ view: "workspace", id: workspaceId, tab: "review" });
			} catch {
				navigate({ view: "pr", repo: pr.repo, branch: pr.branch });
			}
		},
		[refreshProjects],
	);
	// Sidebar feed row (Tella video, …) → the item's ONE workspace, its web
	// panel foregrounded (the feeds design).
	const openFeedItemWorkspace = React.useCallback(
		async (feed: FeedDescriptor, item: FeedItem) => {
			try {
				const { workspaceId } = await resolveWorkspaceApi({
					externalRef: {
						kind: feed.refKind,
						id: item.id,
						...(item.url ? { url: item.url } : {}),
						title: item.title,
					},
					name: item.title,
				});
				refreshProjects();
				navigate({ view: "workspace", id: workspaceId, tab: "video" });
			} catch (e) {
				console.error("Feed item open failed:", e);
			}
		},
		[refreshProjects],
	);
	// Sidebar Support row → the ticket's ONE workspace, Conversation tab. The
	// row's title rides along as the workspace-name hint (no Plain round-trip).
	const openTicketWorkspace = React.useCallback(
		async (t: SupportThread) => {
			try {
				const { workspaceId } = await resolveWorkspaceApi({
					plainThreadId: t.id,
					name:
						t.title || t.customer.name || t.customer.email || undefined,
				});
				refreshProjects();
				navigate({ view: "workspace", id: workspaceId, tab: "conversation" });
			} catch {
				navigate({ view: "support", threadId: t.id });
			}
		},
		[refreshProjects],
	);
	// Open a session's Review tab from the sidebar: select it and foreground its
	// workspace's Review once it lands (pendingReviewOpen survives the
	// workspace-change reset).
	const openReviewForSession = React.useCallback((session: UnifiedSession) => {
		const key = wsKeyFor(session);
		if (!key) return;
		setReviewOpen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
		setPendingReviewOpen(key);
		navigate({ view: "session", id: session.id });
	}, []);
	currentSessionRef.current = currentSession;

	// Mark the open session read up to its latest activity — both when it's first
	// opened and as new activity streams in while it stays open — so the sidebar's
	// unread flag clears for whatever you're currently looking at.
	useEffect(() => {
		if (currentSession)
			markRead(currentSession.id, currentSession.lastActivity);
	}, [currentSession?.id, currentSession?.lastActivity]);

	const currentNoteId =
		route.view === "notes" && route.sel?.kind === "note" ? route.sel.id : null;

	// The tab strip is scoped to the open chat's workspace: its sibling chats
	// (same projectId), oldest first. Chats with no workspace (slack/linear
	// sources — their files are read-only, so the migration couldn't wrap them)
	// fall back to grouping by shared isolated worktree, so a bks- sibling made
	// via + shows up next to its slack source. Failing that, the open chat alone
	// still gets a strip (one tab + the + button).
	const activeProjectId = routeWorkspaceId ?? (currentSession?.projectId || null);

	// Feed the ⌘⇧C copy-link shortcut: the open chat (workspace-scoped when it
	// has one), the open workspace/PR preview, or nothing linkable.
	copyLinkPathRef.current =
		route.view === "session" && currentSession
			? chatPath(currentSession)
			: route.view === "workspace"
				? routePath(route)
				: route.view === "pr"
					? prPath(route.repo, route.branch)
					: null;

	// Canonicalize the open chat's URL to /workspace/<wsId>/chat/<chatId> once
	// its workspace is known (replaceState: same history depth, so Back and the
	// mobile page-stack are unaffected). Workspace-less chats keep /session/<id>.
	useEffect(() => {
		if (route.view !== "session" || !currentSession) return;
		// Remember the open chat as its workspace's landing tab, so re-entering
		// the workspace (sidebar, bare /workspace/<id> URL) returns here.
		if (activeProjectId) saveWorkspaceLastChat(activeProjectId, route.id);
		const canonical = activeProjectId
			? `${BASE_PATH}/workspace/${encodeURIComponent(activeProjectId)}/chat/${encodeURIComponent(route.id)}`
			: `${BASE_PATH}/session/${encodeURIComponent(route.id)}`;
		if (location.pathname !== canonical)
			// Carry the entry's state across: dropping it would erase this panel's
			// depth and strand `goBack` (and the Back caret) on the way home.
			history.replaceState(history.state, "", canonical);
	}, [route, currentSession, activeProjectId]);
	const byCreated = (a: UnifiedSession, b: UnifiedSession) =>
		(a.createdAt || "").localeCompare(b.createdAt || "");
	// Archived (closed) chats leave the strip — except the one you're actively
	// viewing (e.g. opened from Archived), which keeps its tab.
	const liveTab = (s: UnifiedSession) =>
		!s.archived || s.id === currentSession?.id;
	// The strip's natural order (createdAt asc), before any user reordering.
	const naturalChats: UnifiedSession[] = activeProjectId
		? sessions
				.filter(
					(s) =>
						liveTab(s) &&
						s.projectId === activeProjectId &&
						!s.sideChatOf &&
						// Workers stay behind their parent until explicitly opened from the
						// header's worker menu. The selected worker then gets a temporary tab.
						(!s.parentSessionId || s.id === currentSession?.id),
				)
				.sort(byCreated)
		: currentSession?.worktreeDir?.includes("/worktrees/")
			? sessions
					.filter(
						(s) =>
							liveTab(s) &&
							s.worktreeDir === currentSession.worktreeDir &&
							!s.sideChatOf &&
							(!s.parentSessionId || s.id === currentSession?.id),
					)
					.sort(byCreated)
			: currentSession
				? [currentSession]
				: [];
	// The stable workspace key the tab order is saved under: the workspace id, or
	// the shared isolated-worktree path for workspace-less (slack/linear) groups.
	// Empty ⇒ a lone standalone chat, which has nothing to reorder.
	const tabOrderKey = activeProjectId
		? activeProjectId
		: currentSession?.worktreeDir?.includes("/worktrees/")
			? currentSession.worktreeDir
			: "";
	// Apply the user's saved left-to-right order (drag-drop). Unknown/new chats
	// fall to the end in natural order; a stale saved id matches nothing.
	const projectChats: UnifiedSession[] = (() => {
		if (!tabOrderKey || naturalChats.length < 2) return naturalChats;
		const byId = new Map(naturalChats.map((s) => [s.id, s] as const));
		return applyTabOrder(
			tabOrderKey,
			naturalChats.map((s) => s.id),
		)
			.map((id) => byId.get(id))
			.filter((s): s is UnifiedSession => !!s);
	})();
	// A sub-agent tab whose stack just went away (its chat switched, or the tab
	// was closed) is no longer in the strip, and the chat is what's rendered —
	// so treat it as no view tab rather than leaving the strip with nothing lit
	// for the frame before the reset effect below runs.
	const activeViewTabShown: ActiveViewTab =
		subagentSelected && subagentStack.length === 0 ? null : activeViewTab;
	const focusedTopTabId = activeViewTabShown
		? viewTabs.find((tab) => tab.active)?.id ?? null
		: currentSession?.id ?? null;
	// Every tab in the strip, in its natural order: chats first, then the view
	// panes…
	const naturalStripTabIds = [
		...projectChats.map((chat) => chat.id),
		...viewTabs.map((tab) => tab.id),
	];
	// …then the arrangement the user dragged them into. Chats and panes share
	// ONE saved order, so a Review or Assets tab can sit in front of a chat; a
	// tab the saved order doesn't mention falls to the end in natural order.
	const stripTabIds = tabOrderKey
		? applyTabOrder(tabOrderKey, naturalStripTabIds)
		: naturalStripTabIds;
	const storedTabSplit = tabOrderKey ? getTabSplit(tabOrderKey) : null;
	// The split projected onto the tabs that exist right now. Null once either
	// bar runs out of tabs — that's what collapses the strip back to one bar.
	const tabSplit = isPhone ? null : resolveSplit(storedTabSplit, stripTabIds);
	const activeTabSplit = currentSession ? tabSplit : null;
	const toStoredSplit = (split: ResolvedSplit): TabSplit => ({
		right: split.right,
		leftActive: split.leftActive,
		rightActive: split.rightActive,
		ratio: split.ratio,
	});
	const otherSide = (side: SplitSide): SplitSide => (side === "left" ? "right" : "left");
	/** Which bar owns a tab. The left bar is every tab's default home. */
	const sideOf = (id: string): SplitSide =>
		activeTabSplit?.right.includes(id) ? "right" : "left";
	// The focused bar is whichever holds the routed tab, so its active tab is
	// the one the URL already reflects; the other bar's is remembered below.
	const focusedSide: SplitSide = focusedTopTabId ? sideOf(focusedTopTabId) : "left";
	const activeIdFor = (side: SplitSide): string | null => {
		if (!activeTabSplit) return focusedTopTabId;
		if (side === focusedSide) return focusedTopTabId;
		return side === "left" ? activeTabSplit.leftActive : activeTabSplit.rightActive;
	};
	// Remember each bar's active tab so refocusing the other bar restores what
	// was open there rather than snapping to its first tab.
	useEffect(() => {
		if (!tabOrderKey || !activeTabSplit || !focusedTopTabId) return;
		const stored =
			focusedSide === "left" ? activeTabSplit.leftActive : activeTabSplit.rightActive;
		if (stored === focusedTopTabId) return;
		saveTabSplit(tabOrderKey, {
			...toStoredSplit(activeTabSplit),
			...(focusedSide === "left"
				? { leftActive: focusedTopTabId }
				: { rightActive: focusedTopTabId }),
		});
	});

	/**
	 * Which bar a dragged tab would land in: the pane's left/right half when
	 * there is no split yet (the drop that creates one), or the column actually
	 * under the pointer once there is. Null when the drop would be a no-op.
	 */
	function splitSideAt(
		draggedId: string,
		point: { x: number; y: number },
	): SplitSide | null {
		if (isPhone || !currentSession || !stripTabIds.includes(draggedId)) return null;
		const pane = detailPaneRef.current?.getBoundingClientRect();
		if (!pane || point.x < pane.left || point.x > pane.right || point.y > pane.bottom)
			return null;
		if (activeTabSplit) {
			const side: SplitSide =
				point.x < pane.left + pane.width * activeTabSplit.ratio ? "left" : "right";
			// Dropping a tab back into the bar it already lives in changes nothing.
			return side === sideOf(draggedId) ? null : side;
		}
		// No split yet: the drop has to clear the strip, and needs a tab to leave
		// behind — splitting off the only tab would just move the whole bar over.
		const strip = detailPaneRef.current
			?.querySelector<HTMLElement>(".session-tabs")
			?.getBoundingClientRect();
		if (!strip || point.y < strip.bottom + 8 || stripTabIds.length < 2) return null;
		return point.x < pane.left + pane.width / 2 ? "left" : "right";
	}

	/** Move a tab into `side`'s bar, creating or collapsing the split as needed. */
	function moveTabToSide(draggedId: string, side: SplitSide) {
		if (!tabOrderKey) return;
		setSplitDropSide(null);
		const right = activeTabSplit
			? side === "right"
				? [...activeTabSplit.right, draggedId]
				: activeTabSplit.right.filter((id) => id !== draggedId)
			: // First split: the dragged tab takes the half it was dropped on, alone.
				side === "right"
				? [draggedId]
				: stripTabIds.filter((id) => id !== draggedId);
		// A bar that would hold every tab (or none) is just one bar again.
		if (!right.length || right.length === stripTabIds.length) {
			clearTabSplit(tabOrderKey);
			return;
		}
		saveTabSplit(tabOrderKey, {
			...(activeTabSplit ? toStoredSplit(activeTabSplit) : { ratio: 0.5 }),
			right,
			...(side === "right" ? { rightActive: draggedId } : { leftActive: draggedId }),
		});
	}

	/**
	 * A bar only ever reorders its OWN tabs, but the order is saved per
	 * workspace — so splice the bar's new sequence back into the positions it
	 * occupies in the full strip, leaving the other column's arrangement (and
	 * any tab the bar doesn't hold) exactly where it was.
	 */
	function mergeBarOrder(barIds: string[]): string[] {
		const moved = new Set(barIds);
		const queue = [...barIds];
		const merged = stripTabIds.map((id) => (moved.has(id) ? (queue.shift() as string) : id));
		// `barIds` is a subset of the strip, so the queue drains — unless a tab
		// appeared mid-drag, in which case it lands at the end rather than lost.
		return [...merged, ...queue];
	}

	/**
	 * One tab bar. `side` is null when there is no split (a single bar owning
	 * every tab); otherwise the bar renders only its own side's tabs, keeps its
	 * own active tab and its own "+", and only the rightmost bar carries the
	 * archived-chats menu.
	 */
	function renderTabBar(side: SplitSide | null) {
		const ids =
			side && activeTabSplit
				? side === "left"
					? activeTabSplit.left
					: activeTabSplit.right
				: null;
		const inBar = ids ? new Set(ids) : null;
		const barChats = inBar
			? projectChats.filter((chat) => inBar.has(chat.id))
			: projectChats;
		const barActive = side ? activeIdFor(side) : focusedTopTabId;
		const barViews = (inBar ? viewTabs.filter((tab) => inBar.has(tab.id)) : viewTabs).map(
			(tab) => (side ? { ...tab, active: tab.id === barActive } : tab),
		);
		return (
			<SessionTabs
				tabs={barChats}
				archived={archivedChats}
				activeId={
					barActive && barChats.some((chat) => chat.id === barActive)
						? barActive
						: null
				}
				inSplit={!!side}
				showHistory={side !== "left"}
				colors={tabColors}
				onSelect={(s) => {
					setActiveViewTab(null);
					navigate({ view: "session", id: s.id });
				}}
				onSetColor={(key, color) => setTabColors(setTabColor(key, color))}
				tabOrder={stripTabIds}
				onReorderTabs={(ids) => saveTabOrder(tabOrderKey, mergeBarOrder(ids))}
				onSplitDrag={(id, point) => {
					setSplitDropSide(id && point ? splitSideAt(id, point) : null);
				}}
				onSplitDrop={(id, point) => {
					const target = splitSideAt(id, point);
					setSplitDropSide(null);
					if (!target) return false;
					moveTabToSide(id, target);
					return true;
				}}
				onMoveAcross={side ? (id) => moveTabToSide(id, otherSide(side)) : undefined}
				moveAcrossSide={side ? otherSide(side) : undefined}
				viewTabs={barViews}
				onSelectView={selectViewTab}
				onCloseView={(id) => {
					if (id.startsWith("subagent:"))
						closeSubagentTab(id.slice("subagent:".length));
					else if (id.startsWith("staging:")) closeStagingTab();
					else if (id.startsWith("assets:")) closeAssetsTab();
					else if (id.startsWith("preview:")) closePreviewTab();
					else {
						const closingTab = id.startsWith("conversation:")
							? ("conversation" as const)
							: id.startsWith("video:")
								? ("video" as const)
								: ("review" as const);
						if (closingTab === "conversation") closeConversationTab();
						else if (closingTab === "video") closeVideoTab();
						else closeReviewTab();
						// Drop the tab suffix; the URL replace re-runs the seeding
						// effect, so arm its one-shot suppress (a close with no
						// suffix causes no replace and needs none).
						if (route.view === "workspace" && route.tab === closingTab) {
							suppressWsSeedRef.current = true;
							navigate({ view: "workspace", id: route.id }, { replace: true });
						}
					}
				}}
				onNewChat={(mode) => handleNewChat(mode, side)}
				onRename={async (id, title) => {
					try {
						await renameSessionApi(id, title);
					} catch (e) {
						console.error("Rename failed:", e);
					}
					refresh();
				}}
				onClose={closeChat}
				onToast={showToast}
				onRestore={async (s) => {
					try {
						await archiveSessionApi(s.id, false);
					} catch (e) {
						console.error("Restore failed:", e);
					}
					refresh();
				}}
			/>
		);
	}
	// The strip's history menu: archived (closed) chats of the same workspace,
	// newest activity first. The open chat is excluded — if it's archived it
	// already holds a live tab via liveTab().
	const archivedChats: UnifiedSession[] = (
		activeProjectId
			? sessions.filter(
					(s) =>
						s.archived && s.projectId === activeProjectId && !s.sideChatOf,
				)
			: currentSession?.worktreeDir?.includes("/worktrees/")
				? sessions.filter(
						(s) =>
							s.archived &&
							s.worktreeDir === currentSession.worktreeDir &&
							!s.sideChatOf,
					)
				: []
	)
		.filter((s) => s.id !== currentSession?.id)
		.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));

	async function createNewChatFrom(
		src: UnifiedSession,
		mode: "share" | "stack" | "ask",
	): Promise<string> {
		const { id, session } = await newChatApi(src.id, getCurrentUser(), mode);
		// Inject the created session so the viewer renders the new chat immediately
		// — no "Starting…" flash while the sessions poll catches up. If the
		// server didn't return it, synthesize a close-enough copy from the source
		// chat. Sticky: a poll that was already in flight when the chat was created
		// resolves with a list that predates it and would drop a plain inject —
		// flashing the "Starting…" placeholder until the next poll. The server
		// persisted the chat before responding, so the sticky copy is reconciled
		// away by the first fresh poll either way.
		const now = new Date().toISOString();
		inject(
			session ?? {
				...src,
				id,
				source: "backstage",
				claudeSessionId: null,
				codexThreadId: undefined,
				title: "New chat",
				createdAt: now,
				lastActivity: now,
				isRunning: false,
				transcriptPath: null,
				startedBy: getCurrentUser(),
				archived: false,
				waitingForInput: false,
				queuedCount: 0,
				prUrl: undefined,
				prState: undefined,
				automation: undefined,
				plainThreadId: undefined,
				goal: undefined,
				loop: undefined,
				...(mode === "ask"
					? {
							branch: null,
							worktreeDir: null,
							mode: "ask" as const,
						}
					: {}),
			},
			{ sticky: true },
		);
		setPendingSessionId(id);
		// This create adds a chat to an existing workspace — clear a stale flag
		// from an earlier workspace create so any residual pending state words
		// itself as "chat", not "workspace".
		setPendingNewWorkspace(false);
		clearTimeout(pendingTimer.current);
		pendingTimer.current = setTimeout(() => {
			setPendingSessionId(null);
			unstick(id);
		}, 30000);
		refresh();
		navigate({ view: "session", id });
		return id;
	}

	// Start a new chat in the current workspace. The tab strip's + button and the
	// SessionViewer ⋯ menu (the only reachable entry point on a phone, where the
	// strip and its + are hidden/hover-revealed) both call this. It creates the
	// sibling chat instantly (browser-tab feel): shares the workspace worktree by
	// default, or stacks/asks. No engine run until the first prompt.
	const handleNewChat = async (
		mode: "share" | "stack" | "ask",
		side: SplitSide | null = null,
	) => {
		const src = currentSession || mainChat(naturalChats);
		if (!src) {
			// "+" on an empty workspace (chat-less route): no sibling to clone —
			// open the new-chat palette scoped to it, same as onOpenProject.
			if (route.view === "workspace") {
				const p = projects.find((x) => x.id === route.id);
				setPalette({
					open: true,
					projectId: route.id,
					repo: p?.repo,
					branch: p?.branch,
					// Feed workspaces (externalRefs, no repo) default new chats
					// to Scratch — repo-less, like their existing chats.
					...(p?.externalRefs?.length && !p?.repo
						? { mode: "scratch" as const }
						: {}),
				});
			}
			return;
		}
		try {
			const id = await createNewChatFrom(src, mode);
			// A chat born in the right bar belongs to it; the left bar is the
			// default home, so a left-bar "+" needs no assignment.
			if (side === "right" && tabOrderKey && activeTabSplit)
				saveTabSplit(tabOrderKey, {
					...toStoredSplit(activeTabSplit),
					right: [...activeTabSplit.right, id],
					rightActive: id,
				});
		} catch (e) {
			console.error("New chat failed:", e);
		}
	};
	const handleNewChatRef = useRef(handleNewChat);
	handleNewChatRef.current = handleNewChat;

	// Lanes are per-user (lib/lanes.ts): setting one moves the row in YOUR
	// sidebar only, so teammates can hold the same workspace in their own
	// lanes. Clearing also drops any legacy global override, so "Auto" (and
	// "Remove from my workspaces") releases rows pinned before lanes went
	// per-user. Shared by the sidebar rows' menus and the viewer's ⋯ menu.
	const setChatLanes = (chats: UnifiedSession[], status: Lane | null) => {
		for (const c of chats) {
			setLane(c.id, status);
			if (c.manualStatus) {
				patch(c.id, { manualStatus: undefined });
				setSessionStatusApi(c.id, null).catch(() => {});
			}
		}
	};

	// ⌘Z (legacy ⌘⇧T) reopens what you just archived. Every archive path
	// pushes the chats it tucked away as one entry, so a press undoes one
	// action: closing a tab brings that chat back, archiving a workspace brings
	// the whole row back. Ids only — the session objects go stale on the next
	// refresh, so entries resolve against the live list when they're restored.
	const [archiveUndo, setArchiveUndo] = useState<string[][]>([]);
	const [runningCloseConfirmation, setRunningCloseConfirmation] = useState<{
		runningCount: number;
		onConfirm: () => void;
	} | null>(null);
	useEffect(() => {
		if (!runningCloseConfirmation) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.key !== "Enter" ||
				!(event.metaKey || event.ctrlKey)
			)
				return;
			event.preventDefault();
			const confirmation = runningCloseConfirmation;
			setRunningCloseConfirmation(null);
			confirmation.onConfirm();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [runningCloseConfirmation]);
	const rememberArchived = useCallback((ids: string[]) => {
		if (!ids.length) return;
		setArchiveUndo((prev) =>
			[
				// An id lives in one entry only: archiving a chat again moves it to
				// the top instead of leaving a stale entry underneath.
				...prev
					.map((entry) => entry.filter((id) => !ids.includes(id)))
					.filter((entry) => entry.length),
				ids,
			]
				// An undo affordance, not a history.
				.slice(-10),
		);
	}, []);

	// Close a tab = archive the chat: it leaves the strip and the active list,
	// but stays recoverable from Archived. An empty chat that never ran has
	// nothing to recover, so it's deleted outright instead of cluttering
	// Archived. The local list updates before the request returns so closing
	// feels instant. Shared by the tab ×, the tab context menu, and ⌘W.
	const closeChatNow = async (s: UnifiedSession) => {
		const neverRan =
			s.source === "backstage" &&
			!s.claudeSessionId &&
			!s.codexThreadId &&
			!s.transcriptPath &&
			!s.isRunning &&
			!s.queuedCount;
		const wasOpen = currentSession?.id === s.id;
		// No split bookkeeping here: a closed tab stops being live, so the split
		// resolves without it, and collapses on its own once a bar is emptied.
		// Leaving the id in the record means restoring the chat later puts it
		// back in the bar it was closed from.
		const next = wasOpen ? projectChats.find((c) => c.id !== s.id) : null;
		let replacementId: string | null = null;
		if (wasOpen && !next) {
			try {
				replacementId = await createNewChatFrom(s, "share");
			} catch (e) {
				console.error("Replacement chat failed:", e);
				return;
			}
		}
		if (neverRan) {
			remove(s.id);
		} else {
			patch(s.id, { archived: true, archivedReason: "manual" });
		}
		if (wasOpen) {
			if (next) navigate({ view: "session", id: next.id });
		}
		try {
			if (neverRan) await deleteSessionApi(s.id, false);
			else {
				const { stoppedRun } = await archiveSessionApi(s.id, true);
				if (stoppedRun) showToast("Archived · stopped the running turn");
				rememberArchived([s.id]);
			}
		} catch (e) {
			console.error("Close failed:", e);
			if (neverRan) {
				inject(s);
			} else {
				patch(s.id, { archived: false, archivedReason: undefined });
			}
			if (replacementId) {
				remove(replacementId);
				void deleteSessionApi(replacementId, false).catch((cleanupError) =>
					console.error("Replacement cleanup failed:", cleanupError),
				);
			}
			if (wasOpen) navigate({ view: "session", id: s.id });
			return;
		}
		refresh();
	};
	const confirmRunningCloses = (
		sessionsToClose: UnifiedSession[],
		onConfirm: () => void,
	) => {
		const runningCount = sessionsToClose.filter((session) => session.isRunning).length;
		if (!runningCount) {
			onConfirm();
			return;
		}
		setRunningCloseConfirmation({ runningCount, onConfirm });
	};
	const confirmRunningClose = (session: UnifiedSession, onConfirm: () => void) =>
		confirmRunningCloses([session], onConfirm);
	const closeChat = (s: UnifiedSession) =>
		confirmRunningClose(s, () => void closeChatNow(s));
	const closeChatRef = useRef(closeChat);
	closeChatRef.current = closeChat;
	// Bring archived chats back. Optimistic like the archive paths: the local
	// list flips first so it feels instant, and rolls back if the server refuses.
	const unarchiveChats = async (chats: UnifiedSession[]): Promise<boolean> => {
		if (!chats.length) return false;
		const reasons = new Map(chats.map((c) => [c.id, c.archivedReason]));
		for (const c of chats) {
			patch(c.id, { archived: false, archivedReason: undefined });
		}
		try {
			await Promise.all(chats.map((c) => archiveSessionApi(c.id, false)));
		} catch (e) {
			console.error("Unarchive failed:", e);
			for (const c of chats) {
				patch(c.id, { archived: true, archivedReason: reasons.get(c.id) });
			}
			return false;
		}
		refresh();
		return true;
	};
	const unarchiveChat = (session: UnifiedSession) => unarchiveChats([session]);

	// The newest undo entry that's still restorable, resolved against the live
	// list: an entry whose chats were unarchived elsewhere (or deleted) falls
	// through to the one below it, so ⌘Z never no-ops on a ghost.
	const restorableArchived: UnifiedSession[] = (() => {
		if (!archiveUndo.length) return [];
		const wanted = new Set(archiveUndo.flat());
		const byId = new Map<string, UnifiedSession>();
		for (const s of sessions) {
			if (s.archived && wanted.has(s.id)) byId.set(s.id, s);
		}
		for (let i = archiveUndo.length - 1; i >= 0; i--) {
			const chats = archiveUndo[i]
				.map((id) => byId.get(id))
				.filter((s): s is UnifiedSession => !!s);
			if (chats.length) return chats;
		}
		return [];
	})();
	const restorableArchivedRef = useRef(restorableArchived);
	restorableArchivedRef.current = restorableArchived;

	// ⌘Z (and the palette's "Reopen closed chat"): undo the last archive and
	// land on what came back. The entry is only dropped once the server agrees,
	// so a failed restore stays retryable.
	const reopenLastArchived = async () => {
		const chats = restorableArchivedRef.current;
		if (!chats.length) {
			showToast("Nothing to reopen");
			return;
		}
		if (!(await unarchiveChats(chats))) return;
		const ids = new Set(chats.map((c) => c.id));
		setArchiveUndo((prev) =>
			prev
				.map((entry) => entry.filter((id) => !ids.has(id)))
				.filter((entry) => entry.length),
		);
		navigate({ view: "session", id: chats[0].id });
	};
	const reopenLastArchivedRef = useRef(reopenLastArchived);
	reopenLastArchivedRef.current = reopenLastArchived;

	// Tab shortcuts matching the strip's context-menu hints: ⌘⌥C copies the
	// concise transcript, ⌘W closes (archives) the tab, ⌘T opens a new tab
	// (sibling chat) in the workspace, and ⌘Z (or the legacy ⌘⇧T) reopens what
	// you just archived — a chat, or a whole workspace row.
	// Refs keep this mount-once listener reading fresh state. A browser that
	// reserves these for itself (Chrome) never delivers the keydown — there the
	// browser tab opens/closes as always, and the palette's "Reopen closed chat"
	// covers the undo; where the event does arrive (Safari, the installed PWA,
	// the desktop shell), we take it.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			if (e.shiftKey) {
				if (!e.altKey && e.key.toLowerCase() === "t") {
					e.preventDefault();
					void reopenLastArchivedRef.current();
				}
				// ⌘⇧Z is redo everywhere else, so it deliberately falls through.
				return;
			}
			// ⌘Z undoes the last archive. Unlike the archive chords, every
			// editable keeps it — including the composer textarea, where undoing
			// what you typed is exactly what ⌘Z should do. Sits above the
			// no-open-session bail because archiving the workspace you were in
			// can leave you on Home with nothing selected.
			if (!e.altKey && e.key.toLowerCase() === "z") {
				const editable = (e.target as HTMLElement | null)?.closest(
					"input, textarea, select, [contenteditable='true'], [contenteditable='']",
				);
				if (editable) return;
				e.preventDefault();
				void reopenLastArchivedRef.current();
				return;
			}
			const s = currentSessionRef.current;
			if (!s) return;
			// e.code, not e.key: on macOS ⌥C types "ç".
			if (e.altKey && e.code === "KeyC") {
				e.preventDefault();
				void copySessionTranscript(s, "concise", showToast);
			} else if (!e.altKey && e.key.toLowerCase() === "w") {
				e.preventDefault();
				void closeChatRef.current(s);
			} else if (!e.altKey && e.key.toLowerCase() === "t") {
				e.preventDefault();
				void handleNewChatRef.current("share");
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [showToast]);

	const handleSessionRunningChange = (id: string, isRunning: boolean) => {
		// Keep the existing run-start stamp when the session was already running:
		// the viewer relays a session_status on every (re)open, and re-stamping
		// here reset the sidebar's elapsed ticker to zero on each session switch.
		const prev = sessionsRef.current.find((s) => s.id === id);
		patch(id, {
			isRunning,
			runStartedAt: isRunning
				? (prev?.isRunning ? prev.runStartedAt : undefined) ||
					new Date().toISOString()
				: undefined,
		});
	};

	// Plain title shown in the top bar for non-session views (session routes let
	// the SessionViewer portal its own header in instead). Home stays blank so the
	// bar collapses (`.detail-topbar:empty`).
	const topbarTitle: string =
		route.view === "archived"
				? "Archived"
				: route.view === "tasks"
					? "Tasks"
				: route.view === "new"
					? "New session"
					: route.view === "workspace"
						? routeWorkspace?.name || "Workspace"
						: "";

	// Mobile top-bar brand: logo only, as the account/settings sheet trigger.
	// On desktop that menu lives in the footer user row instead, so the top stays
	// just the title + the collapse toggle.
	const brand = (
		<div className="app-brand">
			<SettingsMenu
				variant="brand"
				onOpenSettings={() => navigate({ view: "settings" })}
				connected={connected}
			/>
		</div>
	);

	// The "toggle left sidebar" panel glyph — a framed rectangle with a divider
	// marking the collapsible left column. Reused by the brand-row collapse button
	// and the floating re-open control. Sized to match the right-panel toggle
	// (IconSidebarRight) in the session header, and to carry the same visual
	// weight as the fuller play/globe glyphs there (a framed rectangle reads a
	// hair lighter than a filled triangle / globe at the same nominal size).
	const panelIcon = <IconSidebarLeft size={24} />;
	const appleShortcuts = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
	const mod = appleShortcuts ? "⌘" : "Ctrl";
	const currentTheme = effectiveTheme();
	const commandActions: CommandPaletteAction[] = [
		{
			id: "new-session",
			label: "New session",
			description: "Start a new ask or code session",
			category: "Actions",
			keywords: ["create", "chat", "workspace"],
			shortcut: [mod, "N"],
			icon: <IconPlus size={18} />,
			run: () => openPalette(),
		},
		...(currentSession
			? [
					{
						id: "new-chat",
						label: "New chat in this workspace",
						description: "Share the current workspace and worktree",
						category: "Actions" as const,
						keywords: ["tab", "conversation", "sibling"],
						shortcut: [mod, "T"],
						icon: <IconPlus size={18} />,
						run: () => void handleNewChat("share"),
					},
					{
						id: "copy-transcript",
						label: "Copy conversation",
						description: "Copy a concise version of the current transcript",
						category: "Actions" as const,
						keywords: ["transcript", "clipboard"],
						shortcut: [mod, appleShortcuts ? "⌥" : "Alt", "C"],
						icon: <IconCopy size={18} />,
						run: () =>
							void copySessionTranscript(currentSession, "concise", showToast),
					},
					{
						id: currentSession.archived ? "unarchive-chat" : "archive-chat",
						label: currentSession.archived
							? "Unarchive current chat"
							: "Archive current chat",
						description: currentSession.archived
							? "Return this chat to the active workspace"
							: "Close this chat and keep it recoverable in Archived",
						category: "Actions" as const,
						keywords: currentSession.archived
							? ["restore", "open"]
							: ["close", "remove"],
						shortcut: [mod, appleShortcuts ? "⇧" : "Shift", "A"],
						icon: <IconArchive size={18} />,
						run: () =>
							void (currentSession.archived
								? unarchiveChat(currentSession)
								: closeChat(currentSession)),
					},
				]
			: []),
		...(restorableArchived.length
			? [
					{
						id: "reopen-archived",
						label: "Reopen closed chat",
						description:
							restorableArchived.length > 1
								? `Bring back the ${restorableArchived.length} chats you just archived`
								: `Bring back "${restorableArchived[0].title || "the chat you just archived"}"`,
						category: "Actions" as const,
						keywords: ["unarchive", "restore", "undo", "closed", "reopen"],
						shortcut: [mod, "Z"],
						icon: <IconUnarchive size={18} />,
						run: () => void reopenLastArchived(),
					},
				]
			: []),
		...(copyLinkPathRef.current
			? [
					{
						id: "copy-link",
						label: "Copy link to current view",
						description: "Copy a shareable link to this chat, workspace, or PR",
						category: "Actions" as const,
						keywords: ["url", "share", "clipboard"],
						shortcut: [mod, appleShortcuts ? "⇧" : "Shift", "C"],
						icon: <IconCopy size={18} />,
						run: () => {
							const path = copyLinkPathRef.current;
							if (path)
								copyToClipboard(absoluteLink(path), () => showToast("Link copied"));
						},
					},
				]
			: []),
		{
			id: "tasks",
			label: "Tasks",
			description: "Open your task list",
			category: "Actions",
			keywords: ["todos", "tasks"],
			icon: <IconListChecks size={18} />,
			run: () => navigate({ view: "tasks" }),
		},
		{
			id: "desk",
			label: "Open Desk",
			description: "Open the standing concierge session",
			category: "Actions",
			keywords: ["concierge", "assistant"],
			shortcut: [mod, "J"],
			icon: <IconDesk size={18} />,
			run: () => setDeskOpen(true),
		},
		{
			id: "toggle-sidebar",
			label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
			description: "Toggle the workspace sidebar",
			category: "Actions",
			keywords: ["toggle", "panel", "navigation"],
			shortcut: [mod, "B"],
			icon: <IconSidebarLeft size={18} />,
			run: toggleSidebarCollapsed,
		},
		{
			id: "toggle-theme",
			label: `Switch to ${currentTheme === "dark" ? "light" : "dark"} mode`,
			description: `Current appearance: ${currentTheme}`,
			category: "Actions",
			keywords: ["toggle", "theme", "appearance", "dark", "light"],
			icon: <IconMoon size={18} />,
			run: () => setThemePref(currentTheme === "dark" ? "light" : "dark"),
		},
		{
			id: "home",
			label: "Home",
			description: "Open the workspace overview",
			category: "Navigate",
			icon: <IconHome size={18} />,
			run: () => navigate({ view: "home" }),
		},
		{
			id: "catch-up",
			label: "Catch up",
			description: "Swipe through unread workspaces",
			category: "Navigate",
			keywords: ["unread", "inbox"],
			icon: <IconStack size={18} />,
			run: () => navigate({ view: "catchup" }),
		},
		{
			id: "pr-tinder",
			label: "PR Tinder",
			description: "Triage open pull requests",
			category: "Navigate",
			keywords: ["pull requests", "review", "swipe"],
			icon: <IconFlame size={18} />,
			run: () => navigate({ view: "prtinder" }),
		},
		{
			id: "support-tinder",
			label: "Support Tinder",
			description: "Triage the Plain todo queue",
			category: "Navigate",
			keywords: ["tickets", "plain", "support"],
			icon: <IconInbox size={18} />,
			run: () => navigate({ view: "supporttinder" }),
		},
		{
			id: "reports",
			label: "Reports",
			description: "Open recurring automation reports",
			category: "Navigate",
			icon: <IconFile size={18} />,
			run: () => navigate({ view: "reports" }),
		},
		{
			id: "analytics",
			label: "Analytics",
			description: "Sessions, tokens, models, and PRs over time",
			category: "Navigate",
			icon: <IconChart size={18} />,
			run: () => navigate({ view: "analytics" }),
		},
		{
			id: "notes",
			label: "Notes",
			description: "Open shared notes and documentation",
			category: "Navigate",
			keywords: ["docs", "documentation"],
			icon: <IconPencil size={18} />,
			run: () => navigate({ view: "notes", sel: null }),
		},
		{
			id: "reviews",
			label: "Reviews",
			description: "Open the pull request review queue",
			category: "Navigate",
			keywords: ["pull requests", "code review"],
			icon: <IconListChecks size={18} />,
			run: () => navigate({ view: "reviews" }),
		},
		{
			id: "automations",
			label: "Automations",
			description: "Manage scheduled and event-triggered routines",
			category: "Navigate",
			keywords: ["routines", "scheduled"],
			icon: <IconWrench size={18} />,
			run: () => navigate({ view: "automations" }),
		},
		{
			id: "goals",
			label: "Goals",
			description: "Manage long-running missions",
			category: "Navigate",
			icon: <IconListChecks size={18} />,
			run: () => navigate({ view: "goals" }),
		},
		{
			id: "actions",
			label: "Actions",
			description: "Open event-triggered action runs",
			category: "Navigate",
			icon: <IconStack size={18} />,
			run: () => navigate({ view: "actions" }),
		},
		{
			id: "security",
			label: "Security",
			description: "Open security scans and findings",
			category: "Navigate",
			icon: <IconBook size={18} />,
			run: () => navigate({ view: "security" }),
		},
		{
			id: "archived",
			label: "Archived",
			description: "Browse closed conversations",
			category: "Navigate",
			keywords: ["history", "closed"],
			icon: <IconArchive size={18} />,
			run: () => navigate({ view: "archived" }),
		},
		{
			id: "settings",
			label: "Settings",
			description: "Configure OpenSession",
			category: "Navigate",
			keywords: ["preferences", "appearance", "connections"],
			icon: <IconGear size={18} />,
			run: () => navigate({ view: "settings" }),
		},
	];
	const openSession = (id: string, created?: UnifiedSession | null) => {
		const known = sessions.some(
			(session) => session.id === id || session.aliasIds?.includes(id),
		);
		if (!known) {
			// A caller that just created the chat (Auto-fix) hands us the server's
			// own copy — its file is written before the response — so drop it
			// straight into the list and open the real chat as a new tab instead of
			// flashing "Starting a new chat…" until the next poll. Sticky so an
			// in-flight poll that predates the create can't take it away again.
			if (created) inject(created, { sticky: true });
			else {
				setPendingSessionId(id);
				setPendingNewWorkspace(false);
				clearTimeout(pendingTimer.current);
				pendingTimer.current = setTimeout(
					() => setPendingSessionId(null),
					30000,
				);
			}
			refresh();
		}
		navigate({ view: "session", id });
	};
	const renderSessionPane = (
		viewerSession: UnifiedSession,
		socket: ReturnType<typeof useWebSocket>,
		focused: boolean,
		splitMode: boolean,
		surfaceId = viewerSession.id,
	) => (
		<SessionViewer
			key={viewerSession.id}
			onOpenPr={(repo, branch) => navigate({ view: "pr", repo, branch })}
			session={viewerSession}
			focused={focused}
			hideHeader={splitMode && !focused}
			hideRightPanel={splitMode && !focused}
			localMode={localMode}
			onBack={goBack}
			onArchive={() =>
				focused
					? sidebarRef.current?.archiveSelected()
					: closeChat(viewerSession)
			}
			onArchived={(stoppedRun) => {
				if (stoppedRun) showToast("Archived · stopped the running turn");
				// Only fires when the viewer archived on its own — with onArchive
				// passed (a focused pane) it defers to the sidebar path instead, so
				// this can't double-record.
				rememberArchived([viewerSession.id]);
			}}
			send={socket.send}
			addHandler={socket.addHandler}
			connected={socket.connected}
			initialPending={pendingInitialPrompts[viewerSession.id]}
			topbarEl={focused ? topbarEl : null}
			headerActionsEl={focused ? headerActionsEl : null}
			headerModelEl={focused ? headerModelEl : null}
			headerRepoEl={focused ? headerRepoEl : null}
			rightPanelEl={focused ? rightPanelEl : null}
			newChatSeq={focused ? newChatSeq : 0}
			autoFocusComposer={focused && focusComposerOnOpen}
			composerPrefillExternal={sessionComposerPrefills[viewerSession.id] ?? null}
			onComposerPrefillConsumed={(seq) =>
				setSessionComposerPrefills((prev) => {
					const cur = prev[viewerSession.id];
					if (!cur || cur.seq !== seq) return prev;
					const next = { ...prev };
					delete next[viewerSession.id];
					return next;
				})
			}
			workspaceChats={projectChats}
			onSetStatus={setChatLanes}
			showReview={
				splitMode ? viewTabKind(surfaceId) === "review" : focused && reviewActive
			}
			showConversation={
				splitMode
					? viewTabKind(surfaceId) === "conversation"
					: focused && conversationActive
			}
			conversationThreadId={conversationThreadId}
			showVideo={
				splitMode ? viewTabKind(surfaceId) === "video" : focused && videoActive
			}
			videoPanel={videoPanel}
			videoTitle={videoRef?.title || null}
			showStaging={
				splitMode ? viewTabKind(surfaceId) === "staging" : focused && stagingActive
			}
			showAssets={
				splitMode ? viewTabKind(surfaceId) === "assets" : focused && assetsActive
			}
			showPreviewTab={
				splitMode
					? viewTabKind(surfaceId) === "preview"
					: focused && previewLiveActive
			}
			// The sub-agent drill-in, opened from this pane's own transcript.
			showSubagent={
				splitMode
					? viewTabKind(surfaceId) === "subagent"
					: focused && subagentActive
			}
			subagentStack={subagentTabs[viewerSession.id] ?? NO_SUBAGENTS}
			onOpenSubagent={openSubagent}
			onSubagentBack={popSubagent}
			onOpenReview={openReview}
			onOpenStaging={openStaging}
			onCloseStaging={closeStagingTab}
			onOpenPreviewTab={openPreviewTab}
			onClosePreviewTab={closePreviewTab}
			onOpenAssets={openAssets}
			onCloseAssets={closeAssetsTab}
			onOpenWorkspace={() => setActiveViewTab(null)}
			allSessions={sessions}
			allProjects={projects}
			onNewChat={handleNewChat}
			// Mirrors SessionTabs' own "render nothing" rule so the header's
			// lone-chat + never doubles up with the strip's.
			tabStripVisible={
				!!activeTabSplit || projectChats.length > 1 || viewTabs.length > 0
			}
			parentSession={
				viewerSession.parentSessionId
					? (() => {
							const parent = sessions.find(
								(session) => session.id === viewerSession.parentSessionId,
							);
							return parent
								? { id: parent.id, title: parent.title, model: parent.model }
								: null;
						})()
					: null
			}
			workerSessions={sessions
				.filter((session) => session.parentSessionId === viewerSession.id)
				.map((session) => ({
					id: session.id,
					title: session.title,
					model: session.model,
					isRunning: session.isRunning,
				}))}
			onOpenSession={openSession}
			onOpenNewSession={openPrefilledSession}
			onRunningChange={handleSessionRunningChange}
			onReviewChange={(id, request) =>
				patch(id, { reviewRequest: request ?? undefined })
			}
			onRename={async (id, title) => {
				try {
					await renameSessionApi(id, title);
				} catch (error) {
					console.error("Rename failed:", error);
				}
				refresh();
			}}
			workspaceName={
				activeProjectId
					? projects.find((project) => project.id === activeProjectId)?.name
					: undefined
			}
			onRenameWorkspace={
				activeProjectId
					? async (name) => {
							try {
								await updateProjectApi(activeProjectId, { name });
							} catch (error) {
								console.error("Rename workspace failed:", error);
							}
							refreshProjects();
						}
					: undefined
			}
		/>
	);

	return (
		<UserGate>
			<RestartOverlay connected={connected} addHandler={addHandler} />
			<MediaLightboxHost />
			<ToastHost />
			<DesktopUpdateToast />
			<Modal.Root
				open={runningCloseConfirmation !== null}
				onOpenChange={(open) => {
					if (!open) setRunningCloseConfirmation(null);
				}}
				disablePointerDismissal
			>
				<Modal.Content widthClassName="max-w-[34rem]" className="gap-5">
					<Modal.Title className="m-0 text-page-title font-semibold tracking-[-0.03em] text-fg">
						Close running chat{runningCloseConfirmation?.runningCount === 1 ? "" : "s"}?
					</Modal.Title>
					<Modal.Description className="m-0 text-body leading-relaxed text-dim">
						{runningCloseConfirmation?.runningCount === 1
							? "This chat is currently running. Closing it will cancel its current run."
							: `These ${runningCloseConfirmation?.runningCount ?? 0} chats are currently running. Closing them will cancel their current runs.`}
					</Modal.Description>
					<Modal.Footer className="mt-3 justify-end gap-3">
						<Modal.Close render={<Button size="lg">Cancel</Button>} />
						<Button
							variant="destructive"
							size="lg"
							onClick={() => {
								const confirmation = runningCloseConfirmation;
								setRunningCloseConfirmation(null);
								confirmation?.onConfirm();
							}}
						>
							<span>Close anyway</span>
							<span className="ml-5 text-[14px] font-medium opacity-70">⌘↵</span>
						</Button>
					</Modal.Footer>
				</Modal.Content>
			</Modal.Root>
			<div className="app">
				{/* Mobile-only top bar. On the sidebar-root page it shows the brand;
				    on a pushed page (a session or other view) the brand is replaced by
				    a Back chevron that pops back to the root, iOS-style. On desktop the
				    brand/user live in the sidebar and this bar is hidden. The catch-up
				    deck renders its own header (back + "N Left" + new-workspace), so we
				    suppress this one there to avoid a duplicate back bar. */}
				{route.view !== "catchup" && (
				<header
					className={`app-header${mobileDetail ? " app-header-detail" : ""}${
						route.view === "home" || route.view === "session"
							? " app-header-overlay"
							: ""
					}`}
				>
					<div className="app-header-left">
						{mobileDetail ? (
							<button
								className="mobile-back"
								onClick={goBack}
								aria-label="Back to sidebar"
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
						) : (
							<>
								{brand}
								{/* Update nudge lives in the top bar on phones, right after
								    the brand logo (desktop keeps the sidebar-bottom toast). */}
								<UpdatePill addHandler={addHandler} variant="pill" />
							</>
						)}
					</div>
					{/* Centered page title on pushed pages, iOS-sheet style. Sessions
					    show the workspace name (per-chat titles live on the tabs) plus a
					    working dot while the engine runs; other views show their plain
					    title. Desktop hides the whole bar. */}
					{mobileDetail && (
						<span
							className={`app-header-title ${
								route.view === "session" && currentSession
									? "session-settings-trigger app-header-title-tappable"
									: ""
								}`}
								{...(route.view === "session" && currentSession
									? {
										role: "button",
										tabIndex: 0,
										onClick: () =>
											window.dispatchEvent(
												new Event("backstage:toggle-session-settings"),
											),
									}
									: {})}
						>
							{/* Slack-header layout: the repo tile leads the pill (portaled in
							    by SessionViewer), with the name on top and the model · cost
							    metadata below it in a stacked column. The whole pill is one
							    tap target that opens the session's deeper info page. */}
							{route.view === "session" && currentSession && (
								<span className="app-header-repo" ref={setHeaderRepoEl} />
							)}
							<span className="app-header-title-col">
								<span className="app-header-title-row">
									<span className="app-header-title-text">
										{route.view === "session"
											? (activeProjectId
												? projects.find((p) => p.id === activeProjectId)?.name
												: undefined) ||
											currentSession?.title ||
											""
										: topbarTitle}
									</span>
								</span>
								{route.view === "session" && currentSession && (
									// Filled by SessionViewer's portal (compact model selector).
									<span className="app-header-model" ref={setHeaderModelEl} />
								)}
							</span>
						</span>
					)}
					<div className="app-header-actions" ref={setHeaderActionsEl}>
						{/* On the root page the actions slot is otherwise empty (session
						    actions only portal in on pushed pages) — it carries Search,
						    which lives in the top bar on phones instead of the sidebar. */}
						{!mobileDetail && (
							<button
								className="mobile-search-btn"
								onClick={() => setSearchOpen(true)}
								aria-label="Open command menu"
							>
								<IconSearch size={22} />
							</button>
						)}
					</div>
				</header>
				)}

				{settingsActive && (
					<Settings
						onBack={goBack}
						section={
							route.view === "settings"
								? route.section
								: isToolView(route.view)
									? route.view
									: undefined
						}
						onShowRoot={() => navigate({ view: "settings" })}
						onSelect={(key) =>
							isToolView(key)
									? navigate({ view: key })
									: navigate({ view: "settings", section: key })
						}
					>
						{route.view === "automations" ? (
							<Automations
								onOpenSession={(id) => navigate({ view: "session", id })}
								selectedId={route.id}
								onSelect={(id) =>
									navigate({ view: "automations", id: id || undefined })
								}
							/>
						) : route.view === "security" ? (
							<Security
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "goals" ? (
							<Goals
								onOpenSession={(id) => navigate({ view: "session", id })}
								selectedId={route.id}
								onSelect={(id) =>
									navigate({ view: "goals", id: id || undefined })
								}
							/>
						) : route.view === "actions" ? (
							<Actions
								onOpenSession={(id) => navigate({ view: "session", id })}
								selectedId={route.id}
								onSelect={(id) =>
									navigate({ view: "actions", id: id || undefined })
								}
							/>
						) : null}
					</Settings>
				)}
				{/* On phones the app-body stays mounted beneath the Settings sheet
				    (the sheet floats over the root list); on desktop Settings is a
				    full page and replaces it. */}
				{(!settingsActive || isPhone) && (
				<div
					className={`app-body ${mobileDetail ? "mobile-detail" : "mobile-root"}${
						sidebarCollapsed ? " sidebar-collapsed" : ""
					}`}
				>
					<div
						className="sidebar-container"
						style={
							{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties
						}
					>
						{/* Desktop chrome row — identical on web and in the desktop shell
						    (the shell additionally insets it past the traffic lights and
						    makes it a drag region): collapse toggle + the avatar account
						    trigger on the left, back/forward + search at the right edge.
						    No app brand inside the app. Hidden on mobile, where the top
						    bar carries the brand instead. */}
						<div className="sidebar-brand">
							<div className="sidebar-brand-actions">
								<Tooltip
									label="Hide sidebar"
									side="bottom"
									shortcut={["⌘", "B"]}
								>
									<button
										className="sidebar-toggle-btn"
										onClick={toggleSidebarCollapsed}
										aria-label="Hide sidebar"
									>
										{panelIcon}
									</button>
								</Tooltip>
							</div>
							<SettingsMenu
								variant="user"
								onOpenSettings={() => navigate({ view: "settings" })}
								connected={connected}
							/>
							<TitleBar onSearch={() => setSearchOpen(true)} />
						</div>
						<Sidebar
							ref={sidebarRef}
							sessions={sessions}
							localMode={localMode}
							cloudUnreachable={cloudUnreachable}
							workspaceDataReady={!loading && projectsLoaded}
							projects={projects}
							notes={notes.map((n) => ({ id: n.id, title: n.title }))}
							teamViewing={teamViewing}
							selectedId={currentSession?.id || null}
							activeNoteId={currentNoteId}
							notesActive={route.view === "notes"}
							onOpenNotes={() => navigate({ view: "notes", sel: null })}
							homeActive={route.view === "home"}
							onOpenHome={() => navigate({ view: "home" })}
							tasksActive={route.view === "tasks"}
							onOpenTasks={() => navigate({ view: "tasks" })}
							taskCount={taskCount}
							onOpenAutomation={(name) =>
								navigate({ view: "automations", id: name })
							}
							onOpenPrItem={openPrWorkspace}
							selectedWorkspaceId={activeProjectId}
							prTinderActive={route.view === "prtinder"}
							onOpenPrTinder={() => navigate({ view: "prtinder" })}
							supportTinderActive={route.view === "supporttinder"}
							onOpenSupportTinder={() => navigate({ view: "supporttinder" })}
							reportsActive={route.view === "reports"}
							onOpenReports={() => navigate({ view: "reports" })}
							analyticsActive={route.view === "analytics"}
							onOpenAnalytics={() => navigate({ view: "analytics" })}
							deskActive={deskOpen}
							onOpenDesk={() => setDeskOpen(true)}
							noteActivity={noteActivity}
							onSelect={(s) => navigate({ view: "session", id: s.id })}
							onOpenReview={openReviewForSession}
							onOpenTicket={openTicketWorkspace}
						onOpenFeedItem={openFeedItemWorkspace}
							onNewSession={() => openPalette()}
							onNewSessionInRepo={(repo) =>
								setPalette({ open: true, repo })
							}
							onOpenProject={(id) => {
								// Sidebar selection navigates directly to a chat rather than via
								// /workspace/<id>, so restore the same remembered tab here too.
								const chat = pickLandingChat(
									sessions,
									id,
									getWorkspaceLastChat(id),
								);
								if (chat) {
									// Workspace rows always foreground the remembered chat, not
									// a previously selected Review/Preview pane.
									saveActiveViewTab(id, null);
									setActiveViewTabState(null);
									setFocusComposerOnOpen(true);
									navigate({ view: "session", id: chat.id });
								} else {
									const p = projects.find((x) => x.id === id);
									// Default the new chat onto the workspace's own branch (share
									// its worktree) when it has one — e.g. all chats archived.
									setPalette({
										open: true,
										projectId: id,
										repo: p?.repo,
										branch: p?.branch,
									...(p?.externalRefs?.length && !p?.repo
										? { mode: "scratch" as const }
										: {}),
									});
								}
							}}
							onRenameProject={async (id, name) => {
								try {
									await updateProjectApi(id, { name });
									refreshProjects();
								} catch (e) {
									console.error("Rename project failed:", e);
								}
							}}
							onDeleteProject={async (id) => {
								try {
									await deleteProjectApi(id);
									refreshProjects();
									refresh();
								} catch (e) {
									console.error("Delete project failed:", e);
								}
							}}
							onToast={showToast}
							onOpenNote={(id) =>
								navigate({ view: "notes", sel: { kind: "note", id } })
							}
							// Only hand the sidebar the top-bar actions slot on the root
							// page — on a pushed page (chat, etc.) the sidebar is still
							// mounted underneath and would portal its filter button into
							// the chat's top bar.
							headerActionsEl={mobileDetail ? null : headerActionsEl}
							onOpenArchived={() => navigate({ view: "archived" })}
							onOpenCatchUp={() => navigate({ view: "catchup" })}
							catchUpActive={route.view === "catchup"}
							archivedActive={route.view === "archived"}
							onArchive={(s, next) => {
								const archive = async () => {
									patch(s.id, { archived: true, archivedReason: "manual" });
									const wasOpen = route.view === "session" && route.id === s.id;
									if (wasOpen) {
										if (next) navigate({ view: "session", id: next.id });
										else goBack();
									}
									try {
										const { stoppedRun } = await archiveSessionApi(s.id, true);
										if (stoppedRun)
											showToast("Archived · stopped the running turn");
										rememberArchived([s.id]);
									} catch (e) {
										console.error("Archive failed:", e);
										patch(s.id, { archived: false, archivedReason: undefined });
										if (wasOpen) navigate({ view: "session", id: s.id });
										return;
									}
									dropStalePins([s]);
									refresh();
								};
								confirmRunningClose(s, () => void archive());
							}}
							onArchiveWorkspace={(chats, next) => {
								const archive = async () => {
									// Archive a whole workspace = archive every member chat (the
									// archive registry is per-chat; the workspace row disappears
									// once no live chats remain).
									for (const chat of chats) {
										patch(chat.id, { archived: true, archivedReason: "manual" });
									}
									const openChatId =
										route.view === "session" &&
										chats.some((c) => c.id === route.id)
											? route.id
											: null;
									if (openChatId) {
										if (next) navigate({ view: "session", id: next.id });
										else goBack();
									}
									try {
										const results = await Promise.all(
											chats.map((c) => archiveSessionApi(c.id, true)),
										);
										const stopped = results.filter((r) => r.stoppedRun).length;
										if (stopped > 0)
											showToast(
												`Archived · stopped ${stopped} running turn${stopped === 1 ? "" : "s"}`,
											);
										// One entry for the whole row, so ⌘Z brings the
										// workspace back in a single press.
										rememberArchived(chats.map((c) => c.id));
									} catch (e) {
										console.error("Archive workspace failed:", e);
										for (const chat of chats) {
											patch(chat.id, {
												archived: false,
												archivedReason: undefined,
											});
										}
										if (openChatId) navigate({ view: "session", id: openChatId });
										return;
									}
									dropStalePins(chats);
									refresh();
								};
								confirmRunningCloses(chats, () => void archive());
							}}
							onUnarchiveWorkspace={async (chats) => {
								// The inverse of onArchiveWorkspace: the archive registry is
								// per-chat, so a row comes back by unarchiving every member.
								const reasons = new Map(
									chats.map((c) => [c.id, c.archivedReason]),
								);
								for (const chat of chats) {
									patch(chat.id, { archived: false, archivedReason: undefined });
								}
								try {
									await Promise.all(
										chats.map((c) => archiveSessionApi(c.id, false)),
									);
								} catch (e) {
									console.error("Unarchive workspace failed:", e);
									for (const chat of chats) {
										patch(chat.id, {
											archived: true,
											archivedReason: reasons.get(chat.id),
										});
									}
									return;
								}
								refresh();
							}}
							onRename={async (s, title) => {
								try {
									await renameSessionApi(s.id, title);
								} catch (e) {
									console.error("Rename failed:", e);
								}
								refresh();
							}}
							onSetStatus={setChatLanes}
						/>
						{/* Desktop: docked toast at the sidebar bottom. On phones the
						    update nudge moves to the top bar (next to the brand). */}
						{!isPhone && <UpdatePill addHandler={addHandler} />}
						{/* Drag the right edge to resize (desktop only; hidden on mobile). */}
						<div
							className="sidebar-resize"
							onMouseDown={startSidebarResize}
							aria-hidden="true"
						/>
					</div>

					<div className="workspace-shell">
						<main className="detail-pane relative flex min-h-0 min-w-0 flex-1 flex-col" ref={detailPaneRef}>
						{/* WCO back/forward fallback: the primary cluster lives in the
						    sidebar's top chrome row, which vanishes when the sidebar is
						    collapsed — this floating copy shows only then (CSS-gated). */}
						<TitleBar pane />
						{/* Floating re-open control, shown only while the desktop sidebar
						    is collapsed (CSS-gated). Mirrors the brand-row toggle so the
						    sidebar can always be brought back. */}
						<Tooltip label="Show sidebar" side="right" shortcut={["⌘", "B"]}>
							<button
								className="sidebar-reopen"
								onClick={toggleSidebarCollapsed}
								aria-label="Show sidebar"
							>
								{panelIcon}
							</button>
						</Tooltip>
						{/* Top bar: session name + actions (portaled in by SessionViewer)
						    on session routes, a plain title otherwise. Sits above the tab
						    strip so the session identity reads first, tabs below it. */}
						<div className="detail-topbar" ref={setTopbarEl}>
							{route.view !== "session" && topbarTitle && (
								<span className="detail-topbar-title">{topbarTitle}</span>
							)}
						</div>
						{!activeTabSplit && renderTabBar(null)}
						{splitDropSide && (
							<div
								className={`tab-split-drop-preview tab-split-drop-preview-${splitDropSide} pointer-events-none absolute bottom-2 z-20 w-[calc(var(--split-preview-share,50%)-12px)] rounded-md border-2 border-accent bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,white_16%,transparent)] ${splitDropSide === "left" ? "left-2" : "right-2"}`}
								// Once there IS a split, the preview outlines the column the
								// tab would join at its real width — the even halves it
								// defaults to are only right for the drop that creates one.
								style={
									activeTabSplit
										? ({
												"--split-preview-share": `${
													(splitDropSide === "left"
														? activeTabSplit.ratio
														: 1 - activeTabSplit.ratio) * 100
												}%`,
											} as React.CSSProperties)
										: undefined
								}
								aria-hidden="true"
							/>
						)}
						{route.view === "workspace" ? (
							routeWorkspace ? (
								<WorkspacePane
									key={route.id}
									onOpenPr={(repo, branch) => navigate({ view: "pr", repo, branch })}
									workspace={routeWorkspace}
									chats={projectChats}
									sessions={sessions}
									tab={
										reviewActive
											? "review"
											: conversationActive
												? "conversation"
												: videoActive
													? "video"
													: null
									}
									connected={connected}
									send={send}
									addHandler={addHandler}
									onOpenSession={openSession}
								/>
							) : (
								<div className="panel-placeholder">
									{projectsLoaded ? "Workspace not found." : "Loading workspace…"}
								</div>
							)
						) : route.view === "pr" ? (
							<PrQueuePreview
								key={`${route.repo}:${route.branch}`}
								repo={route.repo}
								branch={route.branch}
								sessions={sessions}
								onOpenSession={(id) => navigate({ view: "session", id })}
								onOpenPr={(repo, branch) => navigate({ view: "pr", repo, branch })}
								send={send}
								addHandler={addHandler}
							/>
						) : route.view === "reports" ? (
							<Reports
								selectedAutomationId={route.automationId}
								selectedReportId={route.reportId}
								onSelect={(automationId, reportId) =>
									navigate({ view: "reports", automationId, reportId }, { replace: true })
								}
								onBack={() => navigate({ view: "reports" }, { replace: true })}
								onOpenSession={(id) => navigate({ view: "session", id })}
								onOpenSupport={(threadId) => navigate({ view: "support", threadId })}
								onOpenNewSession={openPrefilledSession}
								addHandler={addHandler}
							/>
						) : route.view === "analytics" ? (
							<Analytics />
						) : route.view === "tasks" ? (
							<Tasks
								addHandler={addHandler}
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "notes" ? (
							<Notes
								sel={route.sel}
								notes={notes}
								refreshNotes={refreshNotes}
								pinnedNoteIds={
									new Set(
										pins
											.filter((p) => p.startsWith("note:"))
											.map((p) => p.slice(5)),
									)
								}
								onTogglePinNote={(id) => setPins(togglePin(`note:${id}`))}
								onSelectNote={(id) =>
									navigate({ view: "notes", sel: { kind: "note", id } })
								}
								onSelectDoc={(path) =>
									navigate({
										view: "notes",
										sel: path ? { kind: "doc", path } : null,
									})
								}
								sessions={sessions.map((s) => ({ id: s.id, title: s.title }))}
								onOpenSession={(id) => navigate({ view: "session", id })}
								user={getCurrentUser()}
								connected={connected}
								send={send}
								addHandler={addHandler}
							/>
						) : route.view === "support" ? (
							<SupportPreview
								key={route.threadId}
								threadId={route.threadId}
								connected={connected}
								send={send}
								addHandler={addHandler}
								onOpenSession={(id) =>
									navigate({ view: "session", id })
								}
							/>
						) : route.view === "reviews" ? (
							<Reviews
								sessions={sessions}
								selectedId={route.id ?? null}
								onSelect={(id) => navigate({ view: "reviews", id })}
								onOpenSession={(id) => navigate({ view: "session", id })}
								onOpenPr={(repo, branch) => navigate({ view: "pr", repo, branch })}
								onAddToInput={addToSessionInput}
								send={send}
								addHandler={addHandler}
							/>
						) : route.view === "archived" ? (
							<Archived
								sessions={sessions}
								onSelect={(s) => navigate({ view: "session", id: s.id })}
								onChanged={refresh}
							/>
						) : route.view === "prtinder" ? (
							<PrTinder onExit={leaveDeck} />
						) : route.view === "supporttinder" ? (
							<SupportTinder
								onExit={leaveDeck}
								onOpenSession={(id) => navigate({ view: "session", id })}
							/>
						) : route.view === "catchup" ? (
							<CatchUpDeck
								sessions={sessions}
								projects={projects}
								send={send}
								connected={connected}
								onArchive={(chats) => {
									const archive = async () => {
										try {
											await Promise.all(
												chats.map((c) => archiveSessionApi(c.id, true)),
											);
											// Swiping through the deck archives fast — one entry per
											// card keeps ⌘Z an undo of the last swipe, not of the
											// whole session.
											rememberArchived(chats.map((c) => c.id));
										} catch (e) {
											console.error("Archive failed:", e);
										}
										refresh();
									};
									confirmRunningCloses(chats, () => void archive());
								}}
								onOpenSession={(id) => navigate({ view: "session", id })}
								onNewWorkspace={() => openPalette()}
								onExit={leaveDeck}
							/>
						) : route.view === "session" ? (
							currentSession ? (
								activeTabSplit ? (
									<SessionSplit
										focusedSide={focusedSide}
										ratio={activeTabSplit.ratio}
										onFocusSide={(side) => {
											const id = activeIdFor(side);
											if (!id) return;
											if (viewTabKind(id)) selectViewTab(id);
											else {
												setActiveViewTab(null);
												navigate({ view: "session", id }, { replace: true });
											}
										}}
										onRatioChange={(ratio) =>
											tabOrderKey &&
											saveTabSplit(tabOrderKey, {
												...toStoredSplit(activeTabSplit),
												ratio,
											})
										}
										renderColumn={(side, socket, focused) => {
											const id = activeIdFor(side);
											const session =
												sessions.find((candidate) => candidate.id === id) ??
												currentSession;
											return (
												<>
													{renderTabBar(side)}
													{renderSessionPane(session, socket, focused, true, id ?? session.id)}
												</>
											);
										}}
									/>
								) : (
									renderSessionPane(
										currentSession,
										{ connected, send, addHandler },
										true,
										false,
									)
								)
							) : (
								<div className="detail-empty">
									<div className="detail-empty-inner">
										{(() => {
											const isLoading =
												loading || route.id === pendingSessionId;
											return (
												<>
													<div className="detail-empty-title">
														{!isLoading
															? "Session not found"
															: route.id === pendingSessionId
																? pendingNewWorkspace
																	? "Starting a new workspace…"
																	: "Starting a new chat…"
																: "Loading session…"}
													</div>
													<div className="detail-empty-sub">
														{isLoading ? "" : "It may have been deleted."}
													</div>
												</>
											);
										})()}
									</div>
								</div>
							)
						) : (
							<Home
								sessions={sessions}
								projects={projects}
								teamViewing={teamViewing}
								onSelect={(s) => navigate({ view: "session", id: s.id })}
								onNewSession={() => openPalette()}
								onOpenAnalytics={() => navigate({ view: "analytics" })}
							/>
						)}
						</main>

						{/* Full-height right column inside the same rounded workspace shell as
						    the detail pane. The active session's workspace/sub-agent panel
						    portals in here. */}
						<div className="right-panel-slot" ref={setRightPanelEl} />
					</div>
				</div>
				)}

				{/* Mobile-only floating + on the root list page — thumb-reach shortcut
				    to the new-session palette (desktop hides it via CSS; the sidebar's
				    own + covers that layout). */}
				{!mobileDetail && (
					<button
						className="mobile-fab"
						onClick={() => openPalette()}
						aria-label="New session"
					>
						<svg
							width="26"
							height="26"
							viewBox="0 0 16 16"
							fill="none"
							aria-hidden="true"
						>
							<path
								d="M8 2.5v11M2.5 8h11"
								stroke="currentColor"
								strokeWidth="1.8"
								strokeLinecap="round"
							/>
						</svg>
					</button>
				)}

				{/* The Desk's triggers are ⌘J, the command palette, and the sidebar's
				    Desk tool — which is off until someone turns it on in Settings. */}

				{/* ⌘J Desk overlay — standing concierge session. */}
				<DeskOverlay
					open={deskOpen}
					onClose={() => setDeskOpen(false)}
					phone={isPhone}
					onOpenSession={(id) => navigate({ view: "session", id })}
				/>

				{/* ⌘K command palette — actions, PRs, and sessions across every view. */}
				{searchOpen && (
					<SessionSearch
						sessions={sessions}
						actions={commandActions}
						onSelectSession={(id) => navigate({ view: "session", id })}
						onSelectPr={(pr) => void openPrReview(pr)}
						onClose={() => setSearchOpen(false)}
					/>
				)}

				{/* ⌘N new-session palette — overlays every view. */}
				{palette.open && (
					<NewSession
						onBack={closePalette}
						send={send}
						addHandler={addHandler}
						connected={connected}
						prefillPrompt={palette.prompt}
						projectId={palette.projectId}
						forceRepo={palette.repo}
						forceBranch={palette.branch}
						forceMode={palette.mode}
						onCreateStarted={(draft) => {
							pendingCreateDraftRef.current = {
								...draft,
								startedAt: new Date().toISOString(),
								user: getCurrentUser(),
							};
						}}
					/>
				)}
			</div>
		</UserGate>
	);
}

// The marketing-site preview imports this component into its own fixture root.
// Keep the ordinary SPA bootstrap intact for every production build, including
// servers that still have this file configured as the bundle entry.
const embeddedDemo = (window as typeof window & { __OPENSESSION_DEMO__?: boolean })
	.__OPENSESSION_DEMO__;
if (!embeddedDemo) {
	// The preview interstitial renders INSTEAD of the app (and outside UserGate —
	// it must work in cold-storage contexts like the iOS PWA's in-app browser).
	const previewWaitSessionId = matchPreviewWaitRoute(location.pathname);
	createRoot(document.getElementById("root")!).render(
		previewWaitSessionId ? (
			<PreviewWait sessionId={previewWaitSessionId} />
		) : (
			<TooltipProvider>
				<App />
			</TooltipProvider>
		),
	);
}
