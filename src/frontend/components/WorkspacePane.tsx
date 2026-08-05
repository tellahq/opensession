import { AGENT_NAME } from "../lib/brand";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Project, UnifiedSession, WSServerMessage } from "../lib/types";
import { fetchModels, type ModelOption } from "../lib/api";
import { Composer } from "./Composer";
import { ConversationPane } from "./ConversationPane";
import { FeedWebPane, refWebPanel } from "./FeedWebPane";
import { SlackChannelPane } from "./SlackChannelPane";
import { plainThreadUrl } from "./PlainThreadPanel";
import { PrPanel } from "./PrPanel";
import { repoLabel } from "./RepoTile";
import { useCurrentUser } from "./UserPicker";
import { useIsPhone } from "../hooks/useIsPhone";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { getDefaultModelPref } from "../lib/default-model-pref";

interface Props {
	workspace: Project;
	/** The workspace's live chats, strip order (empty for a chat-less workspace). */
	chats: UnifiedSession[];
	/** All sessions — the Review pane matches the PR target against any of them. */
	sessions: UnifiedSession[];
	/** Foregrounded view tab; null = the workspace home (first-chat composer). */
	tab: "review" | "conversation" | "video" | null;
	connected: boolean;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
	/** `created` is the server's copy of a chat the info panel just made
	    (Auto-fix), so the app can open it without a loading placeholder. */
	onOpenSession: (id: string, created?: UnifiedSession | null) => void;
	/** Open another PR in the review panel (stack map layer links). */
	onOpenPr?: (repo: string, branch: string) => void;
}

/**
 * The chat-less workspace container: what a /workspace/<id> route renders when
 * no chat is selected. The tab strip above it (SessionTabs) carries the
 * workspace's chats + view tabs; this pane renders the foregrounded view tab's
 * content — Review via the same PrPanel canvas the in-session tab uses (session
 * APIs when a chat carries the PR, repo+branch preview APIs otherwise) — or the
 * workspace home: a composer that starts the first chat. PR-backed workspaces
 * start that chat on the PR's head branch (fromPr); ticket workspaces inherit
 * plainThreadId server-side from the workspace record.
 */
export function WorkspacePane({
	workspace,
	chats,
	sessions,
	tab,
	connected,
	send,
	addHandler,
	onOpenSession,
	onOpenPr,
}: Props) {
	const draftKey = `workspace-home:${workspace.id}`;
	const [prompt, setPrompt] = useState(() => loadDraft(draftKey).text);
	useEffect(() => {
		saveDraft(draftKey, { text: prompt });
	}, [draftKey, prompt]);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const startingRef = useRef(false);
	const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	const [model, setModel] = useState(""); // "" = default
	const currentUser = useCurrentUser();
	const isPhone = useIsPhone();

	useEffect(() => {
		fetchModels()
			.then((m) => {
				setModels(m.models);
				setDefaultModel(m.default);
				// Preselect the user's own default-model pref (Settings →
				// Composer) when set and selectable; "" keeps the workspace default.
				const pref = getDefaultModelPref();
				if (pref && m.models.some((item) => item.id === pref))
					setModel((current) => current || pref);
			})
			.catch(() => {});
	}, []);

	// Success navigates away on session_created (App handles it); on failure the
	// `starting` lock would stick forever — reset on server error or timeout
	// (same pattern as the PR/support previews).
	useEffect(() => {
		return addHandler((msg) => {
			if (msg.type === "error" && startingRef.current) {
				clearTimeout(startTimer.current);
				startingRef.current = false;
				setStarting(false);
				setStartError(msg.message || "Failed to start the session.");
			} else if (msg.type === "session_created" && startingRef.current) {
				clearDraft(draftKey);
			}
		});
	}, [addHandler, draftKey]);
	useEffect(() => () => clearTimeout(startTimer.current), []);

	// The Review pane's target: the workspace's own PR branch, rendered through
	// the newest session that carries it (session PR APIs) or the repo+branch
	// preview APIs when none does — the PrQueuePreview pattern, workspace-scoped.
	const reviewTarget = workspace.branch
		? { repo: workspace.repo || "repository", branch: workspace.branch }
		: null;
	const reviewSession = useMemo(() => {
		if (!reviewTarget) return null;
		return (
			[...sessions]
				.filter(
					(s) =>
						(s.repo || "repository") === reviewTarget.repo &&
						s.branch === reviewTarget.branch,
				)
				.sort((a, b) =>
					(b.lastActivity || "").localeCompare(a.lastActivity || ""),
				)[0] || null
		);
	}, [sessions, reviewTarget?.repo, reviewTarget?.branch]);

	function handleStart() {
		const q = prompt.trim();
		if (!q || starting || !connected) return;
		setStarting(true);
		startingRef.current = true;
		setStartError(null);
		clearTimeout(startTimer.current);
		startTimer.current = setTimeout(() => {
			if (!startingRef.current) return;
			startingRef.current = false;
			setStarting(false);
			setStartError(
				`${AGENT_NAME} didn't respond. Check your connection and try again.`,
			);
		}, 15_000);
		// PR-backed workspaces start on the PR's existing head branch (fromPr:
		// isolated worktree even on shared-checkout repos); ticket/plain
		// workspaces start ask-style — the server links plainThreadId from the
		// workspace record and injects the ticket context. Feed-item workspaces
		// (externalRefs, no repo — e.g. a Tella video) start in scratch mode:
		// repo-less scratch dir, write+bash allowed, MCP as usual.
		send({
			type: "create_session",
			mode: workspace.branch
				? "code"
				: workspace.externalRefs?.length && !workspace.repo
					? "scratch"
					: "ask",
			branch: workspace.branch || "",
			...(workspace.repo ? { repo: workspace.repo } : {}),
			...(workspace.branch ? { fromPr: true } : {}),
			workspaceId: workspace.id,
			prompt: q,
			user: currentUser,
			...(model ? { model } : {}),
		});
		// App navigates into the session on session_created.
	}

	// The workspace's standing right sidebar: a workspace is a first-class
	// surface, so it always shows one — even chat-less.
	// Compact info: identity, linkage (repo/branch/PR/ticket), and its chats.
	const infoPanel = !isPhone && (
		<aside className="viewer-panel">
			<div className="flex-1 min-h-0 overflow-y-auto p-4">
				<div className="text-item-title font-semibold leading-snug text-fg">
					{workspace.name}
				</div>
				<div className="mt-2 flex flex-col gap-1.5 text-supporting text-dim">
					{workspace.repo && (
						<div className="flex items-center gap-2 min-w-0">
							<span className="text-faint shrink-0">Repo</span>
							<span className="truncate">{repoLabel(workspace.repo)}</span>
						</div>
					)}
					{workspace.branch && (
						<div className="flex items-center gap-2 min-w-0">
							<span className="text-faint shrink-0">Branch</span>
							<span className="truncate text-label">
								{workspace.branch}
							</span>
						</div>
					)}
					{workspace.prNumber !== undefined && (
						<div className="flex items-center gap-2 min-w-0">
							<span className="text-faint shrink-0">Pull request</span>
							<span>#{workspace.prNumber}</span>
						</div>
					)}
					{workspace.plainThreadId && (
						<div className="flex items-center gap-2 min-w-0">
							<span className="text-faint shrink-0">Ticket</span>
							<a
								className="truncate text-dim hover:text-fg"
								href={plainThreadUrl(workspace.plainThreadId)}
								target="_blank"
								rel="noreferrer"
							>
								Open in Plain ↗
							</a>
						</div>
					)}
					<div className="flex items-center gap-2 min-w-0">
						<span className="text-faint shrink-0">Created</span>
						<span className="truncate">
							{new Date(workspace.createdAt).toLocaleDateString()} ·{" "}
							{workspace.createdBy}
						</span>
					</div>
				</div>
				<div className="mt-4">
					<div className="text-meta font-semibold uppercase tracking-wide text-faint">
						Chats
					</div>
					{chats.length === 0 ? (
						<div className="mt-1.5 text-supporting text-dim">
							None yet — the composer below starts the first one
							{workspace.branch ? " on the PR's branch" : ""}.
						</div>
					) : (
						<div className="flex flex-col mt-1.5">
							{chats.map((c) => (
								<button
									key={c.id}
									className="cursor-pointer truncate border-0 bg-transparent py-1 text-left text-control-label text-dim hover:text-fg"
									onClick={() => onOpenSession(c.id)}
								>
									{c.title || "Untitled chat"}
								</button>
							))}
						</div>
					)}
				</div>
			</div>
		</aside>
	);

	const withPanel = (main: React.ReactNode) => (
		<div className="flex h-full min-h-0">
			<div className="flex-1 min-w-0 min-h-0">{main}</div>
			{infoPanel}
		</div>
	);

	if (tab === "review" && reviewTarget) {
		return withPanel(
			<div className="workspace-view-main h-full min-h-0 bg-surface">
				<PrPanel
					onOpenPr={onOpenPr}
					key={`${reviewTarget.repo}:${reviewTarget.branch}`}
					sessionId={reviewSession?.id || ""}
					previewTarget={reviewSession ? undefined : reviewTarget}
					reviewCanvas
					send={send}
					addHandler={addHandler}
					sessions={sessions}
					onOpenSessionById={onOpenSession}
					onOpenSession={
						reviewSession ? () => onOpenSession(reviewSession.id) : undefined
					}
					walkthrough={reviewSession?.walkthrough}
				/>
			</div>,
		);
	}

	if (tab === "conversation" && workspace.plainThreadId) {
		return withPanel(
			<div className="workspace-view-main flex flex-col h-full min-h-0">
				<ConversationPane
					threadId={workspace.plainThreadId}
					onOpenSession={onOpenSession}
					hideTriage={chats.length > 0}
				/>
			</div>,
		);
	}

	// The feed web panel (Tella video embed, … — the feeds design) on the
	// chat-less workspace route.
	const webRef = (workspace.externalRefs || []).find((r) => refWebPanel(r));
	const webPanel = webRef ? refWebPanel(webRef) : null;
	if (tab === "video" && webPanel) {
		return withPanel(
			<div className="workspace-view-main flex flex-col h-full min-h-0">
				{webPanel.component === "slack-channel" ? (
					<SlackChannelPane channelId={webPanel.refId} />
				) : (
					<FeedWebPane
						panel={webPanel}
						title={webRef?.title || workspace.name}
					/>
				)}
			</div>,
		);
	}

	// Workspace home: normally only reachable chat-less (with chats, App lands
	// in the first chat) — a composer that starts the workspace's first chat.
	return withPanel(
		<div className="workspace-view-main flex flex-col h-full min-h-0">
			<div className="flex-1 min-h-0 overflow-y-auto">
				<div className="w-full max-w-[760px] mx-auto px-5 py-6">
					<div className="text-section-title font-semibold text-fg">
						{workspace.name}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-2 text-supporting text-dim">
						{workspace.repo && <span>{repoLabel(workspace.repo)}</span>}
						{workspace.branch && (
							<span className="text-label">{workspace.branch}</span>
						)}
					</div>
					{chats.length === 0 && (
						<div className="mt-5 text-control-label text-dim">
							No chats in this workspace yet — start one below
							{workspace.branch ? " on the PR's branch" : ""}.
						</div>
					)}
				</div>
			</div>
			<div className="w-full max-w-[760px] mx-auto px-5 pb-5 shrink-0">
				<Composer
					value={prompt}
					onChange={setPrompt}
					onSend={handleStart}
					placeholder={starting ? "Starting…" : "Start a chat in this workspace…"}
					disabled={starting}
					sendDisabled={starting || !connected || !prompt.trim()}
					sendTitle="Start a chat in this workspace (Enter)"
					models={models}
					defaultModel={defaultModel}
					model={model}
					onModelChange={setModel}
					modelTitle="Model for this chat"
				/>
				{startError && <div className="ask-error">{startError}</div>}
			</div>
		</div>,
	);
}
