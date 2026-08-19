/**
 * Session creation — the ONE create path shared by the web UI and the
 * opensession-sessions MCP (session-control-wiring.ts).
 *
 * Layout:
 *  - Each entry point resolves its own inputs (repo/worktree/workspace/opening
 *    prompt) into a `ResolvedCreate` — that's where the paths deliberately
 *    differ (the web palette knows PR rows and stacked worktrees; the MCP
 *    knows parent/worker inheritance and prompt-derived branch names).
 *  - `openCreatedSession()` is the shared engine: persist the session file,
 *    announce the id, materialize a deferred worktree, launch the opening run
 *    (sandboxed or host) and drive the full event ladder (init → model_switch
 *    → text_chunk → tool_use → tool_result → usage_snapshot → done → error),
 *    then persist the outcome. Path-specific transport (who hears the events,
 *    how failures surface) rides the `CreateSessionIO` callbacks.
 *
 * `handleCreateSessionMessage` is the web UI adapter (the WebSocket
 * `create_session` case delegates here); the MCP adapter lives in
 * session-control-wiring.ts.
 */

import type { ServerWebSocket } from "bun";
import { randomUUIDv7 } from "bun";
import { type StreamEvent, markSessionStarting, runAgent, unmarkSessionStarting } from "./agent-runner";
import { makeAskHandler } from "./asks";
import { getAccountById } from "./claude-accounts";
import { getCodexAccountById } from "./codex-accounts";
import { buildForkHandoffNote } from "./fork-handoff";
import { ensureGeneratedTitle } from "./generated-titles";
import { onSessionIdle as onHumanAsksSessionIdle } from "./human-asks";
import { interactiveMcpServers } from "./interactive-mcp";
import { parseTranscriptAsync } from "./jsonl-parser";
import { accountProviderForModel, interactiveDefaultModel, interactiveFallbackModel, modelLabel, providerFor, resolveModel } from "./models";
import { notifyMentions } from "./mentions";
import { newSessionId } from "./paths";
import { wrapContext } from "./prompt-context";
import { promptQueues } from "./queue-state";
import { type ImageInput, shouldPersistModelSwitch } from "./run-events";
import { attachSessionWatchersToEngineTranscript, drainQueue, foldSessionUsage, maybeLaunchSandboxedRun, maybeQueueAutoContinue, sessionMentionsNote, watchExternalRunAndDrain } from "./run-session";
import { type McpScope, STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { isRemoteSandboxProvider, resolveRequestedSandbox, sandboxConfig, sandboxesEnabled } from "./sandbox/config";
import { resolveInteractiveSandbox } from "./sandbox/defaults";
import { getRunner, runnerAvailableForSession, runnerWorkspacePath } from "./runners";
import { isRunnerConnected, prepareRunnerWorkspace } from "./runner-ws";
import { maybeLaunchRunnerRun } from "./runner-session";
import { githubAppRepositoryToken } from "./github-app";

/** Sandbox provider id as resolveRequestedSandbox resolves it (null = host). */
type ResolvedSandboxProvider = Extract<
	ReturnType<typeof resolveRequestedSandbox>,
	{ ok: true }
>["provider"];
import { SESSION_EFFORTS, findSession, invalidateSessionsCache, recordRunOutcome, touchNativeSession, updateSessionFile } from "./session-cache";
import { attachRepo, buildBranchNote, buildReposNote, memoryNoteFor, planCreateAttachRepos, workspaceOwningWorktree } from "./session-repos";
import { ownedWorktree } from "./session-workspace";
import { engineSessionPatch } from "./sessions";
import { commitAuthorFor, userMatchesAny } from "./shared/user-mappings";
import { sanitizeBranchSlug } from "./suggest-branch";
import { type NativeSessionFile, type SessionUsage, type UnifiedSession } from "./types";
import { parseImageDataUrls, stageFileAttachments, withUploadsNote } from "./uploads";
import { resolvePlainWorkspace } from "./workspace-resolve";
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";
import { type Workspace, createWorkspace, getWorkspace, updateWorkspace } from "./workspaces";
import { AUTO_REPO, createWorktree, createWorktreeForExistingBranch, ensureAskCheckout, ensureScratchDir, getRepo, listWorktrees, NO_REPO, repoForPath, repoForPathOrNull, resolveUniqueBranch, sharedCheckoutForNewSessions, worktreeHeadBranch, worktreePathFor } from "./worktree";
import { type WSClientData, broadcastToSession, preparingWorkspaces } from "./ws-hub";

/**
 * The `create_session` client message fields the flow reads. Fields typed
 * `unknown` are validated at their use site exactly as before (the message
 * arrives as parsed JSON and was previously read off an `any`).
 */
export interface CreateSessionMessage {
	prompt: string;
	user?: string;
	mode?: string;
	branch: string;
	images?: unknown;
	files?: unknown;
	fromPr?: unknown;
	forkFrom?: unknown;
	model?: unknown;
	effort?: unknown;
	accountId?: string;
	mcpServers?: unknown;
	repo?: unknown;
	/** Repos to work in beside `repo` (the palette's multi-select picker). */
	attachRepos?: unknown;
	sandbox?: unknown;
	runner?: unknown;
	worktreeMode?: unknown;
	workspaceId?: unknown;
	/** Workspace that supplied a model preset for an otherwise independent create. */
	modelWorkspaceId?: unknown;
	plainThreadId?: unknown;
	createWorkspace?: { name?: unknown };
}

/** A resolved fork request: the source session plus how it can be forked. */
export interface ForkContext {
	source: UnifiedSession;
	/** Fork point: resume from this past message (default: the tip). */
	messageId?: string;
	/** Claude can clone the real engine conversation via SDK forkSession… */
	canFork: boolean;
	/** …other backends get a transcript handoff in the opening prompt instead. */
	needsHandoff: boolean;
}

/**
 * Resolve a create's fork request. Returns undefined when no fork was asked
 * for; throws when the source session doesn't exist (callers surface that on
 * their own transport).
 */
export function resolveForkContext(
	forkFrom: { sourceId?: string; messageId?: string } | undefined,
): ForkContext | undefined {
	if (!forkFrom?.sourceId) return undefined;
	const source = findSession(forkFrom.sourceId);
	if (!source) throw new Error("Fork source session not found");
	const canFork =
		providerFor(source.model) === "claude" && !!source.claudeSessionId;
	return {
		source,
		messageId: forkFrom.messageId,
		canFork,
		needsHandoff: !canFork,
	};
}

/** Opening-prompt context block handing a non-clonable fork its source transcript. */
export async function forkHandoffContext(fork: ForkContext): Promise<string> {
	const entries = fork.source.transcriptPath
		? await parseTranscriptAsync(fork.source.transcriptPath)
		: [];
	return wrapContext(
		buildForkHandoffNote({
			sourceId: fork.source.id,
			sourceTitle: fork.source.title,
			sourceModel: fork.source.model,
			messageId: fork.messageId,
			entries,
		}),
		"handoff",
	);
}

/**
 * Validate a requested provider-account pin for a create. Soft pin: the
 * runner prefers it and falls back to the pool when it's exhausted.
 * Mismatched, unknown, and foreign personal ids are dropped (undefined)
 * rather than persisted as a pin that can never apply.
 */
export function resolvePinnedAccountId(
	model: string | undefined,
	accountId: unknown,
	user: string | undefined,
): string | undefined {
	const provider = accountProviderForModel(model);
	const requested =
		typeof accountId === "string" && accountId
			? provider === "codex"
				? getCodexAccountById(accountId)
				: provider === "claude"
					? getAccountById(accountId)
					: undefined
			: undefined;
	return requested &&
		(!requested.owner || (!!user && userMatchesAny(user, [requested.owner])))
		? (accountId as string)
		: undefined;
}

/**
 * A create resolved down to what the shared engine needs: where the session
 * lives, what it persists, and how its opening run is configured. Built by
 * the per-path setup (web palette vs. MCP) — every deliberate difference
 * between those paths lives in how they fill this in.
 */
export interface ResolvedCreate {
	id: string;
	/** Raw first-line title persisted immediately (replaced by the generated summary). */
	title: string;
	/** The raw prompt the background title/summary is generated from. */
	titlePrompt: string;
	/** The fully assembled opening prompt (uploads note, contexts, handoffs). */
	openingPrompt: string;
	user?: string;
	createdBy: string;
	createdAt: string;
	/** Verified web sign-in identity of the creator (web creates only). */
	createdByLogin?: string;
	mode: "ask" | "code" | "scratch";
	wtPath: string;
	/** Branch recorded on the session file ("" for ask/scratch sessions). */
	persistBranch: string;
	/** Branch the session works on — branch note + HEAD-drift comparisons. */
	branch: string;
	/** Repo recorded on the session file; undefined for repo-less scratch. */
	repoId?: string;
	/** Repos whose memory notes ride the opening prompt. */
	memoryRepoIds: string[];
	/**
	 * Repos to work in beside the session's own: an isolated worktree each, on
	 * one shared branch, prepared after the announce and BEFORE the opening run
	 * so its system note and any sandbox mounts already know about them.
	 */
	attachRepos?: { repos: string[]; branch: string };
	stackedOn?: { repo: string; branch: string };
	/** Workspace recorded on the session file. */
	workspaceId?: string;
	/** Workspace id echoed on the announce (the web session_created event). */
	announceWorkspaceId?: string;
	/** Whether this create minted a brand-new workspace (announce hint). */
	createdWorkspaceNow?: boolean;
	/** Workspace to rename once the generated title lands (minted by THIS create). */
	autoNameWorkspace?: Workspace | null;
	parentSessionId?: string;
	/** Agent that created this session (SessionData.spawnedBy). */
	spawnedBy?: string;
	reportBack?: boolean;
	/** Undefined only for forks of sessions with no recorded model (historic). */
	model?: string;
	effort?: string;
	/** Stable preset instructions captured at creation, even if the workspace changes later. */
	presetNote?: string;
	fastMode?: boolean;
	accountId?: string;
	images?: ImageInput[];
	externalRefs?: NativeSessionFile["externalRefs"];
	plainThreadId?: string;
	/** MCP allowlist persisted on the session file (non-empty lists only). */
	persistMcpServers?: string[];
	/**
	 * MCP scope for the opening run. May be undefined at runtime (historic
	 * web-palette behavior — read as "all" downstream); the sandbox launcher
	 * defaults it to [] (fail-closed) instead.
	 */
	runMcpServers?: McpScope;
	sandboxProvider: ResolvedSandboxProvider;
	/** Explicit persistent-machine target. Mutually exclusive with Sandbox. */
	runnerTarget?: { id: string; name: string; workspacePath: string; repositoryUrl: string };
	/** Sandbox volume workspace: no host worktree, provider clones in-container. */
	volumeWorkspace: boolean;
	remoteSandbox: boolean;
	/** Worktree creation deferred until after the announce (web creates). */
	needsWorktree: boolean;
	/** Materializes the deferred worktree (present iff needsWorktree). */
	materializeWorktree?: () => Promise<unknown>;
	/** Engine-level fork (Claude SDK forkSession) of the source conversation. */
	fork?: { engineSessionId: string; resumeAt?: string };
	/**
	 * How the opening run hands off at the end: "drain" delivers any queued
	 * prompts right away (web creates); "auto-continue-guard" runs the shared
	 * announce-then-stop guard first (MCP creates, which nothing wraps in
	 * runSessionPromptAndDrain).
	 */
	finish: "drain" | "auto-continue-guard";
}

/** Per-path transport for a create: who hears the announce/stream/failures. */
export interface CreateSessionIO {
	/**
	 * The session file exists and the id is resolvable — the web adapter sends
	 * session_created, the MCP adapter resolves the tool call.
	 */
	announce(info: {
		id: string;
		workspaceId?: string;
		newWorkspace: boolean;
		preparingWorkspace: boolean;
		createdBy: string;
		createdAt: string;
	}): void;
	/** A stream event of the opening run (no sessionId stamp — adapters add it). */
	emit(m: Record<string, unknown>): void;
	/** Failure before the announce — no session exists to surface it on. */
	fail(message: string): void;
}

/**
 * The shared create engine: persist + announce the resolved session, then run
 * its opening turn end-to-end. Failures after the announce close out the
 * stream and are recorded on the session (a setup-failed session must not
 * look inexplicably empty — bks-019f472f, 2026-07-09); failures before it go
 * to io.fail.
 */
/**
 * Cut a worktree for each repo the create asked to work in beside its own, and
 * record it on the session. Best-effort per repo: one that can't be checked
 * out (a branch collision in that repo, a fetch that failed) is reported as a
 * notice and the session goes on without it, rather than taking down a create
 * whose real subject is the other repos. Returns the ones that landed — which
 * is what the opening run is then told about, so the agent is never pointed at
 * a worktree that isn't there.
 */
async function attachCreateRepos(
	sessionId: string,
	plan: { repos: string[]; branch: string },
	io: CreateSessionIO,
): Promise<string[]> {
	const attached: string[] = [];
	for (const repoId of plan.repos) {
		try {
			await attachRepo(sessionId, repoId, plan.branch);
			attached.push(repoId);
		} catch (e) {
			io.emit({
				type: "notice",
				message: `Couldn't add ${repoId} to this session: ${
					e instanceof Error ? e.message : String(e)
				}. The other repos are ready; add this one from the repo menu when it is.`,
			});
		}
	}
	return attached;
}

export async function openCreatedSession(
	spec: ResolvedCreate,
	io: CreateSessionIO,
): Promise<void> {
	const bksId = spec.id;
	// Replace the raw first-line title with a short summary in the background;
	// the next sessions poll (≤5s) picks it up. A workspace minted by THIS
	// create is named ONCE from the same generated summary (it provisionally
	// wore the raw first line) and keeps that name for life — later sessions
	// never rename it, and a manual rename in the meantime wins.
	const wsToName = spec.autoNameWorkspace;
	void ensureGeneratedTitle(bksId, spec.titlePrompt, spec.user, spec.model).then(
		(t) => {
			if (!t) return;
			invalidateSessionsCache();
			if (!wsToName) return;
			const cur = getWorkspace(wsToName.id);
			if (cur && cur.name === wsToName.name)
				updateWorkspace(wsToName.id, { name: t });
		},
	);

	// Set once the session has been announced — a later failure must then
	// close out the stream instead of leaving the just-opened viewer spinning.
	let announced = false;
	let engineSessionId = "";
	let effectiveModel = spec.model;
	let selectedModel = spec.model;
	let effectiveProvider = providerFor(effectiveModel);
	const modelHistory: NonNullable<NativeSessionFile["modelHistory"]> = [];
	let persisted = false;
	// Cumulative token/cost for this new session's opening run.
	let latestUsage: SessionUsage | undefined;
	// Extra repos that actually got a worktree (see attachCreateRepos) — what
	// the opening run's repos note and memory scopes are built from.
	let attachedRepoIds: string[] = [];
	// Terminal failure the opening run died on — recorded after the loop so
	// the fresh session surfaces as "Needs input".
	let runFailure: string | null = null;
	// The runner already wrote its own, friendlier transcript line.
	let failureNoticePersisted = false;
	// The opening turn's reply and tool count, for the announce-then-stop
	// guard (finish: "auto-continue-guard").
	let assistantText = "";
	let toolUseCount = 0;
	// Actual worktree HEAD when it drifted from the recorded branch (the
	// agent switched/renamed branches during the opening turn).
	const headBranchPatch = () => {
		if (spec.runnerTarget) return {};
		const head = spec.persistBranch ? worktreeHeadBranch(spec.wtPath) : null;
		return head && head !== spec.branch ? { branch: head } : {};
	};
	// Field-scoped write: creation fields are create-if-absent defaults
	// (an existing file — e.g. one touched with the engine id or a
	// materialized sandboxId while the opening run streams — wins);
	// this run only owns the engine-id/model/HEAD-sync fields it
	// actually changes. Serialized via updateSessionFile.
	const persist = () =>
		updateSessionFile(bksId, (data) => {
			// Widen to Partial: the file may not exist yet.
			const existing: Partial<NativeSessionFile> = data;
			return {
				id: bksId,
				claudeSessionId: "",
				branch: spec.persistBranch,
				worktreeDir: spec.wtPath,
				// Repo-less sessions resolve no repoId, and record the absence as
				// a decision so clients don't have to guess (types.ts, repoLess).
				...(spec.repoId ? { repo: spec.repoId } : { repoLess: true }),
				...(spec.workspaceId ? { workspaceId: spec.workspaceId } : {}),
				...(spec.parentSessionId
					? { parentSessionId: spec.parentSessionId }
					: {}),
				...(spec.spawnedBy ? { spawnedBy: spec.spawnedBy } : {}),
				// Persisted so the failure beacon (handoff-evidence.ts) can tell
				// a worker that owes its parent a report from a child session
				// that was explicitly told not to report (e.g. the PR session).
				...(spec.parentSessionId && spec.reportBack ? { reportBack: true } : {}),
				createdBy: spec.createdBy,
				...(spec.createdByLogin
					? { createdByLogin: spec.createdByLogin }
					: {}),
				createdAt: spec.createdAt,
				title: spec.title,
				mode: spec.mode,
				...(spec.stackedOn && spec.stackedOn.branch !== spec.persistBranch
					? { stackedOn: spec.stackedOn }
					: {}),
				...(spec.effort ? { effort: spec.effort } : {}),
				...(spec.presetNote ? { presetNote: spec.presetNote } : {}),
				...(spec.fastMode ? { fastMode: true } : {}),
				...(spec.accountId ? { accountId: spec.accountId } : {}),
				...(spec.plainThreadId ? { plainThreadId: spec.plainThreadId } : {}),
				...(spec.externalRefs?.length
					? { externalRefs: spec.externalRefs }
					: {}),
				...(spec.persistMcpServers?.length
					? { mcpServers: spec.persistMcpServers }
					: {}),
				...(spec.sandboxProvider
					? {
							sandbox: {
								provider: spec.sandboxProvider,
								lifecycle: "preparing",
								// Volume intent is recorded up front so the prompt
								// paths know the workspace never exists host-side
								// (hasRemoteWorkspace) even before the first ensure.
								// Remote providers are ALWAYS volume — no host mounts.
								...(spec.volumeWorkspace || spec.remoteSandbox
									? { workspace: "volume" as const }
									: {}),
							},
						}
					: {}),
				...(spec.runnerTarget
					? { runner: { id: spec.runnerTarget.id, name: spec.runnerTarget.name, workspacePath: spec.runnerTarget.workspacePath, lifecycle: "preparing" as const } }
					: {}),
				...existing,
				...(engineSessionId
					? engineSessionPatch(effectiveProvider, engineSessionId)
					: {}),
				// Record the engine that ran so the first later cross-provider
				// switch bridges context (see runSessionPromptInner handoff).
				...(engineSessionId
					? { lastEngineProvider: effectiveProvider }
					: {}),
				...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
				...(selectedModel ? { model: selectedModel } : {}),
				...(modelHistory.length ? { modelHistory } : {}),
				...headBranchPatch(),
				lastActivity: new Date().toISOString(),
			};
		}).then(() => {
			persisted = true;
		});

	try {
		// Persist + announce BEFORE the slow parts (worktree git work,
		// engine boot with its MCP connects) so the client drops into
		// the empty session immediately — the title fills in from the
		// background summary and the opening turn streams in when the
		// engine is up. The starting mark keeps a prompt typed in that
		// window from double-starting a run (same race as
		// runSessionPrompt).
		const startToken = markSessionStarting(bksId);
		const pendingAttach = spec.attachRepos?.repos.length
			? spec.attachRepos
			: null;
		const preparingEnvironment = spec.needsWorktree || Boolean(pendingAttach) || Boolean(spec.sandboxProvider) || Boolean(spec.runnerTarget);
		if (preparingEnvironment) preparingWorkspaces.add(bksId);
		try {
			await persist();
			// A session starting in a workspace consumes its draft. The
			// composer prompt it held is now this session's opening prompt.
			// After persist() so this never races the create with a client
			// still editing the draft through the workspace PATCH route.
			if (spec.workspaceId) {
				const ws = getWorkspace(spec.workspaceId);
				if (ws?.draft) updateWorkspace(ws.id, { draft: null });
			}
			io.announce({
				id: bksId,
				workspaceId: spec.announceWorkspaceId,
				newWorkspace: !!spec.createdWorkspaceNow,
				preparingWorkspace: preparingEnvironment,
				createdBy: spec.createdBy,
				createdAt: spec.createdAt,
			});
			announced = true;
			// A teammate tagged in the opening message is tagged like one in
			// any other message: the session exists now, so the badge has a row
			// to land on. Scanned from the raw prompt, never the assembled one,
			// so a repo note or a handoff cannot invent a mention.
			void notifyMentions(
				spec.titlePrompt,
				spec.user || "",
				bksId,
				"prompt",
				spec.title || "a session",
			);

			// Every worktree this session works in, its own first. The extra
			// repos are cut inside the same gate: they are git work of the same
			// order, and flipping the viewer to ready before them would tell the
			// reader the workspace was up while it was still being assembled.
			if ((spec.needsWorktree && spec.materializeWorktree) || pendingAttach) {
				try {
					if (spec.needsWorktree && spec.materializeWorktree) {
						await spec.materializeWorktree();
						// Deps install runs in the background (worktree.ts) — say
						// so, since builds/tests may not be ready for a beat.
						io.emit({
							type: "notice",
							message:
								"Workspace ready — installing dependencies in the background.",
						});
					}
					if (pendingAttach)
						attachedRepoIds = await attachCreateRepos(
							bksId,
							pendingAttach,
							io,
						);
				} finally {
					// Ready (or failed — the error surfaces separately): flip the
					// viewer out of "Waiting for workspace" and let the queue go.
					preparingWorkspaces.delete(bksId);
					io.emit({ type: "workspace_status", ready: true });
				}
			}

			// Sandbox session: route the OPENING turn through the same
			// launcher the prompt path uses (the session file was persisted
			// above, so it resolves) — bind mode included, so the first turn
			// runs in the sandbox like every later one (the worktree was
			// created above, so the bind mounts are ready; ensure() is
			// idempotent + per-session locked, and later prompts are held
			// behind markSessionStarting, so there's no double-ensure race).
			// A failed launch errors the stream for every selected provider.
			// Bind mode has a host checkout, but silently using it would still
			// change the chosen isolation boundary.
			let sandboxOpeningRun: AsyncGenerator<StreamEvent> | null = null;
			let runnerOpeningRun: AsyncGenerator<StreamEvent> | null = null;
			if (spec.sandboxProvider) {
				const created = findSession(bksId);
				sandboxOpeningRun = created
					? await maybeLaunchSandboxedRun(created, {
							prompt: spec.openingPrompt,
							cwd: spec.wtPath,
							user: spec.user,
							images: spec.images,
							mcpServers: spec.runMcpServers ?? [],
							isAutomationSession: false,
							startToken,
						})
					: null;
				if (!sandboxOpeningRun) {
					throw new Error(
						"Sandbox unavailable - the opening prompt was not run. Check the selected sandbox connection and retry.",
					);
				}
				preparingWorkspaces.delete(bksId);
				io.emit({ type: "workspace_status", ready: true });
			}
			if (spec.runnerTarget) {
				const cloneToken = spec.repoId
					? await githubAppRepositoryToken(getRepo(spec.repoId).ghRepo)
					: null;
				await prepareRunnerWorkspace(spec.runnerTarget.id, {
					sessionId: bksId,
					repo: spec.repoId || "",
					branch: spec.branch,
					workspacePath: spec.runnerTarget.workspacePath,
					repositoryUrl: spec.runnerTarget.repositoryUrl,
					...(cloneToken ? { cloneToken } : {}),
					user: spec.user,
				});
				touchNativeSession(bksId, {
					runner: { id: spec.runnerTarget.id, name: spec.runnerTarget.name, workspacePath: spec.runnerTarget.workspacePath, lifecycle: "awake" },
				});
				const created = findSession(bksId);
				runnerOpeningRun = created
					? await maybeLaunchRunnerRun(created, {
						prompt: spec.openingPrompt,
						images: spec.images,
						mcpServers: spec.runMcpServers ?? [],
						user: spec.user,
						reposNote: [
							buildBranchNote({ mode: spec.mode, branch: spec.branch, worktreeDir: spec.wtPath }),
							await memoryNoteFor(spec.user, spec.memoryRepoIds),
						].filter(Boolean).join("\n\n") || undefined,
					})
					: null;
				if (!runnerOpeningRun) throw new Error("Runner unavailable. Check its connection and retry.");
				preparingWorkspaces.delete(bksId);
				io.emit({ type: "workspace_status", ready: true });
			}

			// The session as persisted, once it spans repos: the map the agent
			// gets is read back rather than reassembled, so it can only name
			// worktrees that were actually cut.
			const spanning = attachedRepoIds.length ? findSession(bksId) : null;
			for await (const event of sandboxOpeningRun ?? runnerOpeningRun ?? runAgent({
				prompt: spec.openingPrompt,
				cwd: spec.wtPath,
				mode: spec.mode,
				model: spec.model,
				effort: spec.effort,
				fastMode: spec.fastMode,
				accountId: spec.accountId,
				fallbackModel: interactiveFallbackModel(spec.model),
				// Feed workspaces default to their feed's scoped list (least
				// privilege) — same value the session file persists above.
				// May be undefined at runtime (see ResolvedCreate.runMcpServers).
				mcpServers: spec.runMcpServers as McpScope,
				reposNote:
					[
						spec.presetNote || "",
						// A session that spans repos is handed the map of them
						// (which repo is where, on which branch) in place of the
						// branch note — buildReposNote carries that note inside it.
						spanning
							? buildReposNote(spanning)
							: buildBranchNote({
									mode: spec.mode,
									branch: spec.branch,
									worktreeDir: spec.wtPath,
								}),
						await memoryNoteFor(spec.user, [
							...spec.memoryRepoIds,
							...attachedRepoIds,
						]),
					]
						.filter(Boolean)
						.join("\n\n") || undefined,
				images: spec.images,
				// Fork: resume the source engine session into a new branch,
				// optionally from a specific past message.
				...(spec.fork
					? {
							sessionId: spec.fork.engineSessionId,
							forkSession: true,
							resumeSessionAt: spec.fork.resumeAt,
						}
					: {}),
				inProcessMcp: interactiveMcpServers(
					spec.user,
					bksId,
					spec.runMcpServers ?? "all",
				),
				confirmTools: STRIPE_CONFIRM_TOOLS,
				aws: true, // interactive sessions keep AWS read access (via injected creds)
				// Whose commits these are. Passing `user` alone is not enough:
				// the git identity is a separate option, and this is a
				// session's whole first turn, which for most sessions is where
				// the work lands. Without it that work commits under the
				// machine's default identity and shows up under nobody. The
				// sandbox and runner paths above resolve the same identity
				// inside their own launchers.
				author: commitAuthorFor(spec.user, spec.createdBy),
				user: spec.user, // gate per-user MCP servers (allowedUsers) to the creator
				journal: { osSessionId: bksId, kind: "create" },
				startToken,
				onAskUser: makeAskHandler(bksId),
			})) {
				if (event.type === "init") {
					engineSessionId = event.sessionId || "";
					if (event.provider) effectiveProvider = event.provider;
					if (event.model) effectiveModel = event.model;
					// Session was persisted/announced before setup — just record
					// the engine id so the run is resumable while it streams.
					touchNativeSession(
						bksId,
						{
							...engineSessionPatch(
								effectiveProvider,
								engineSessionId,
							),
							...(engineSessionId
								? { lastEngineProvider: effectiveProvider }
								: {}),
							...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
						},
					);
					// The transcript file didn't exist when viewers sent their
					// watch (fresh session) — attach them now so this first turn
					// streams live instead of only appearing after a re-watch.
					if (engineSessionId) {
						attachSessionWatchersToEngineTranscript(
							bksId,
							effectiveProvider,
							spec.wtPath,
							engineSessionId,
						);
					}
				}
				if (event.type === "model_switch") {
					const to = event.toModel || "";
					const reason = `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`;
					if (to) {
						effectiveModel = to;
						effectiveProvider = providerFor(to);
						if (shouldPersistModelSwitch(event)) {
							selectedModel = to;
							modelHistory.push({
								model: to,
								from: event.fromModel,
								at: new Date().toISOString(),
								by: reason,
							});
							touchNativeSession(bksId, {
								model: selectedModel,
								modelHistory,
							});
							io.emit({
								type: "model_changed",
								model: to,
								from: event.fromModel,
								by: reason,
							});
						} else {
							io.emit({
								type: "notice",
								message: `${modelLabel(event.fromModel)} ${event.switchReason || "fell back"} — using ${modelLabel(to)} for this turn only.`,
							});
						}
					}
				}
				if (event.type === "text_chunk") {
					assistantText += event.text;
					io.emit({ type: "stream_text", text: event.text });
				}
				if (event.type === "tool_use") {
					toolUseCount++;
					const entry = {
						id: event.toolUseId || crypto.randomUUID(),
						type: "tool_use" as const,
						content: `Using ${event.toolName}`,
						timestamp: new Date().toISOString(),
						toolName: event.toolName,
						toolInput: event.toolInput,
						toolUseId: event.toolUseId,
					};
					io.emit({ type: "stream_tool_use", entry });
				}
				if (event.type === "tool_result") {
					const entry = {
						id: event.toolUseId
							? `tr-${event.toolUseId}`
							: crypto.randomUUID(),
						type: "tool_result" as const,
						content: event.content || "",
						timestamp: new Date().toISOString(),
						toolUseId: event.toolUseId,
						...(event.images && event.images.length > 0
							? { images: event.images }
							: {}),
						...(event.videos && event.videos.length > 0
							? { videos: event.videos }
							: {}),
						...(event.featuredMedia && event.featuredMedia.length > 0
							? { featuredMedia: event.featuredMedia }
							: {}),
					};
					io.emit({ type: "stream_tool_result", entry });
				}
				if (event.type === "usage_snapshot" && event.usage) {
					// Live mid-run cost/context. Snapshots are run-cumulative and
					// this is the session's only run, so the fold base is empty —
					// each snapshot recomputes the total from scratch (folding
					// onto latestUsage would double-count).
					latestUsage = foldSessionUsage(
						undefined,
						event.usage,
						effectiveModel,
					);
					io.emit({ type: "usage_update", usage: latestUsage });
				}
				if (event.type === "done") {
					engineSessionId = event.sessionId || engineSessionId;
					if (event.provider) effectiveProvider = event.provider;
					if (event.model) effectiveModel = event.model;
					if (event.usageLimitExhausted)
						runFailure =
							event.result || "Usage limit reached on every account";
					if (event.usage) {
						latestUsage = foldSessionUsage(
							undefined,
							event.usage,
							event.model || effectiveModel,
						);
						// emit (not a bare broadcast) so it also reaches the
						// creator's socket in the window before they watch.
						io.emit({ type: "usage_update", usage: latestUsage });
					}
					if (event.cacheMissWarning)
						io.emit({ type: "cache_warning", sessionId: bksId });
				}
				if (event.type === "error") {
					runFailure = event.content || "Run failed";
					if (event.noticePersisted) failureNoticePersisted = true;
					io.emit({ type: "error", message: event.content });
				}
			}

			if (!persisted) await persist();
			else
				touchNativeSession(
					bksId,
					{
						...engineSessionPatch(
							effectiveProvider,
							engineSessionId,
						),
						...(engineSessionId
							? { lastEngineProvider: effectiveProvider }
							: {}),
						...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
						...(modelHistory.length ? { modelHistory } : {}),
						// The opening turn may have switched branches in the
						// worktree (same sync as runSessionPromptInner's run-end
						// patch) — keep the record on the actual HEAD.
						...headBranchPatch(),
					},
				);
			// Persist opening-run usage regardless of which branch ran
			// above (persist() writes the base file without it).
			if (latestUsage)
				touchNativeSession(bksId, { usage: latestUsage });
			recordRunOutcome(bksId, runFailure, {
				engineSessionId,
				noticePersisted: failureNoticePersisted,
			});
		} finally {
			unmarkSessionStarting(bksId, startToken);
			// Safety net for throws before the worktree block's own finally
			// (persist/announce failures) — must never leak a session stuck
			// in "Waiting for workspace".
			preparingWorkspaces.delete(bksId);
		}

		io.emit({ type: "stream_done" });
		io.emit({ type: "session_status", isRunning: false });
		if (spec.finish === "auto-continue-guard") {
			// An opening turn announce-then-stops exactly like a later one, and
			// this path bypasses runSessionPromptInner — so run the shared guard
			// here too. Nothing wraps this run in runSessionPromptAndDrain, so a
			// queued nudge needs the drain watcher to deliver it.
			if (
				maybeQueueAutoContinue({
					sessionId: bksId,
					assistantText,
					toolUseCount,
					endedWithError: !!runFailure,
					runFailure,
				})
			) {
				watchExternalRunAndDrain(bksId);
			}
			if (!promptQueues.get(bksId)?.length) {
				onHumanAsksSessionIdle(bksId);
			}
		} else {
			if (promptQueues.get(bksId)?.length)
				await drainQueue(bksId);
			else
				onHumanAsksSessionIdle(bksId);
		}
	} catch (e: any) {
		// Failure after the early announce: the client is already in the
		// session — close out the stream and surface the failure there
		// instead of leaving the viewer spinning. Before the announce there's
		// no session to scope to, so the raw error goes back to the caller.
		if (announced) {
			if (spec.runnerTarget) {
				touchNativeSession(bksId, {
					runner: {
						id: spec.runnerTarget.id,
						name: spec.runnerTarget.name,
						workspacePath: spec.runnerTarget.workspacePath,
						lifecycle: "needs_attention",
						lastLifecycleError: String(e.message || e).slice(0, 200),
					},
				});
			}
			io.emit({ type: "error", message: e.message || String(e) });
			io.emit({ type: "stream_done" });
			io.emit({
				type: "notice",
				message: `Session setup failed: ${e.message || String(e)}`,
			});
			io.emit({ type: "session_status", isRunning: false });
			// Persist the failure on the session file too — the live
			// events above are gone on reload, and a setup-failed session
			// (e.g. `git worktree add` refusing a branch name that
			// collides with an existing `name/...` ref) otherwise shows
			// as an inexplicably empty session (bks-019f472f, 2026-07-09).
			recordRunOutcome(
				bksId,
				`Session setup failed: ${e.message || String(e)}`,
			);
		} else {
			io.fail(e.message || String(e));
		}
	}
}

/**
 * Create a session from a UI WebSocket `create_session` message and drive its
 * opening run, streaming events back to the creating socket / session room.
 */
export async function handleCreateSessionMessage(
	ws: ServerWebSocket<WSClientData>,
	msg: CreateSessionMessage,
): Promise<void> {
	const { prompt, user, mode } = msg;
	// Mutable: a brand-new code branch is made collision-free below (a
	// name clashing with an existing `name/...` ref — or vice versa —
	// makes `git worktree add -b` fail, killing the session).
	let branch = msg.branch;
	const images = parseImageDataUrls(msg.images);
	// Session opened from a PR row (sidebar): `branch` is the PR's
	// EXISTING head branch — check it out instead of creating a new
	// branch off origin/default.
	const fromPr =
		msg.fromPr === true && typeof branch === "string" && !!branch;

	// Fork: branch a new session off an existing one. Claude can clone the
	// real engine conversation via SDK forkSession; backends without clone
	// support get a transcript handoff in the opening prompt instead.
	const forkFrom = msg.forkFrom as
		| { sourceId?: string; messageId?: string }
		| undefined;
	let fork: ForkContext | undefined;
	try {
		fork = resolveForkContext(forkFrom);
	} catch {
		ws.send(
			JSON.stringify({
				type: "error",
				message: "Fork source session not found",
			}),
		);
		return;
	}
	const forkSource = fork?.source;
	const canFork = !!fork?.canFork;
	const needsForkHandoff = !!fork?.needsHandoff;

	// Scratch: repo-less sessions for feed-item workspaces (Tella videos —
	// the feeds design). Full write + bash in a per-workspace scratch
	// dir, MCP tools as usual; no repo, branch, or PR flow.
	const isScratch = forkSource
		? forkSource.mode === "scratch"
		: mode === "scratch";
	const isAsk = forkSource
		? !isScratch && forkSource.mode !== "code"
		: mode === "ask";
	// Repo-less: no repo to read, no branch, no PR flow. Scratch always is.
	// Ask is when the palette's repo picker is set to "No repo" — a session
	// that is a conversation with the model and its MCP tools. A fork stays
	// whatever its source was; an OMITTED repo still means "inherit, else the
	// default", which is what agent-created subagents depend on.
	// "Auto": the advisory picker preview had not resolved yet. Never block
	// creation on another model call: start in the normal fallback environment
	// and let the opening session move itself if the task belongs elsewhere.
	let requestedRepo = typeof msg.repo === "string" ? msg.repo : undefined;
	const deferredAutoRepo = !forkSource && requestedRepo === AUTO_REPO;
	if (deferredAutoRepo) requestedRepo = undefined;
	const isRepoLess = forkSource
		? isScratch || (forkSource.mode === "ask" && !forkSource.repo)
		: isScratch || (isAsk && requestedRepo === NO_REPO);
	// Optional model pick from the UI; invalid input falls back to default.
	// A fork inherits the source's model. No pick = stamp the interactive
	// default NOW: leaving it empty would let the init event persist the
	// engine's resolved model — which for a dial default would silently
	// disengage the dial (the preset id must be what the session stores).
	const workspacePreset = forkSource
		? undefined
		: resolveWorkspaceModelPreset(msg.model, msg.workspaceId ?? msg.modelWorkspaceId);
	const model = forkSource
		? forkSource.model
		: workspacePreset?.id || (msg.model ? resolveModel(String(msg.model))?.id : undefined) ||
			interactiveDefaultModel();
	// Reasoning effort from the New-session palette (forks inherit).
	const createEffort = forkSource
		? forkSource.effort
		: workspacePreset?.effort || (typeof msg.effort === "string" &&
				SESSION_EFFORTS.has(msg.effort.trim().toLowerCase())
			? msg.effort.trim().toLowerCase()
			: undefined);
	const createFastMode = forkSource?.fastMode;
	// Pinned provider account from the palette (forks inherit).
	const createAccountId = forkSource
		? forkSource.accountId
		: resolvePinnedAccountId(workspacePreset?.model || model, msg.accountId, user);
	const createMcpServers = Array.isArray(msg.mcpServers)
		? msg.mcpServers.map(String)
		: undefined;
	// Which repo this session works in (tella-fusion by default). A repo-less
	// session still resolves one here — sandbox selection and memory scopes
	// are repo-keyed — but never records it (see `repoId` on the spec below).
	const repo = getRepo(
		requestedRepo && requestedRepo !== NO_REPO ? requestedRepo : undefined,
	);
	// Sandbox opt-in (the sandbox rollout plan): boolean true = the
	// config's default provider (legacy toggle behavior); a string
	// names an explicit provider (including "modal" / "lambda-microvm"),
	// validated against the current config. Forks never sandbox —
	// they share/fork the source session's engine state and cwd.
	const sandboxResolved = forkSource
		? resolveRequestedSandbox(undefined, repo.id, model)
		: resolveInteractiveSandbox(
				msg.sandbox as boolean | string | undefined,
				user,
				repo.id,
				model,
			);
	if (!sandboxResolved.ok) {
		ws.send(
			JSON.stringify({ type: "error", message: sandboxResolved.error }),
		);
		return;
	}
	// null = host (no sandbox recorded on the session).
	const createSandboxProvider = sandboxResolved.provider;
	const requestedRunnerId = typeof msg.runner === "string" && msg.runner.trim() ? msg.runner.trim() : undefined;
	if (requestedRunnerId) {
		ws.send(JSON.stringify({ type: "error", message: "Runner full sessions are not available. Use Runner command delegation from a standard session." }));
		return;
	}
	if (requestedRunnerId && createSandboxProvider) {
		ws.send(JSON.stringify({ type: "error", message: "Choose either Sandbox or a Runner for this session." }));
		return;
	}
	const selectedRunner = requestedRunnerId ? getRunner(requestedRunnerId) : undefined;
	if (requestedRunnerId) {
		if (!selectedRunner || !isRunnerConnected(selectedRunner.id)) {
			ws.send(JSON.stringify({ type: "error", message: "That Runner is offline." }));
			return;
		}
		if (!runnerAvailableForSession(selectedRunner, { user, repo: repo.id, sessionId: "new" }) || !selectedRunner.workspaceRoots.length) {
			ws.send(JSON.stringify({ type: "error", message: "That Runner is not available for this repository." }));
			return;
		}
		if (forkSource || fromPr || isScratch || isAsk) {
			ws.send(JSON.stringify({ type: "error", message: "Runner sessions require a new code workspace." }));
			return;
		}
	}
	// Remote providers have no host mounts — always volume-style.
	const remoteSandbox = isRemoteSandboxProvider(createSandboxProvider);
	// Workspace linkage. The New modal creates a Workspace + first Session
	// together (createWorkspace); the tab/sidebar + adds a Session to an
	// existing workspace (workspaceId) that either shares the workspace's
	// worktree (default) or stacks a new one branched off it.
	const worktreeMode: "share" | "stack" | "ask" = isAsk
		? "ask"
		: msg.worktreeMode === "stack"
			? "stack"
			: "share";
	let workspace =
		typeof msg.workspaceId === "string" && msg.workspaceId
			? getWorkspace(msg.workspaceId)
			: null;
	// A ticket-linked create always lands in the ticket's ONE workspace
	// (adopt-don't-duplicate, workspace-resolve.ts) — even when the
	// client asked for a fresh workspace, a second workspace for the
	// same ticket is never right. A createWorkspace name doubles as
	// the ticket-title hint for a first-time resolve.
	const msgPlainThreadId =
		typeof msg.plainThreadId === "string" && msg.plainThreadId
			? msg.plainThreadId
			: undefined;
	if (msgPlainThreadId && !workspace) {
		try {
			workspace = resolvePlainWorkspace({
				threadId: msgPlainThreadId,
				title:
					typeof msg.createWorkspace?.name === "string"
						? msg.createWorkspace.name
						: undefined,
				createdBy: user || "Anonymous",
			}).workspace;
		} catch {}
	}
	// Whether this create made a brand-new workspace (vs. adding a session
	// to an existing one) — echoed on session_created so the client can
	// word its brief pending state accordingly.
	let createdWorkspaceNow = false;
	if (!workspace && msg.createWorkspace) {
		// A code create landing on a branch whose worktree an existing
		// workspace already owns joins that workspace (the worktree
		// lookup below would silently reuse the worktree anyway —
		// re-submitted prompt slugs and existing branches picked in the
		// unscoped palette both hit this). Only then mint a fresh one.
		if (!isAsk && !forkSource && !fromPr && !sharedCheckoutForNewSessions(repo) && branch) {
			const existingWt = (await listWorktrees(repo.id)).find(
				(w) => w.branch === branch,
			)?.path;
			workspace = workspaceOwningWorktree(existingWt);
		}
		if (!workspace) {
			createdWorkspaceNow = true;
			workspace = createWorkspace({
				name:
					(typeof msg.createWorkspace.name === "string" &&
						msg.createWorkspace.name) ||
					prompt.trim().split("\n")[0].slice(0, 80) ||
					"Workspace",
				...(isRepoLess ? {} : { repo: repo.id }),
				createdBy: user || "Anonymous",
			});
		}
	}
	// Set once the session has been announced to the client (early
	// session_created) — a later failure must then close out the
	// stream instead of leaving the just-opened viewer spinning.
	let announcedId: string | null = null;

	// One outlet for this run's stream events (usable only after the
	// announce sets announcedId). Everything is stamped with sessionId
	// so clients can filter, and the creator's direct send is GATED on
	// what their socket currently watches: it only covers the gap
	// between session_created and their watch landing. Once they watch
	// this session, the room broadcast reaches them; once they've
	// navigated to a DIFFERENT session, they get nothing — the old
	// unconditional ws.send kept streaming this run into whatever session
	// that socket had open (until a refresh replaced the socket).
	const emit = (m: Record<string, unknown>) => {
		if (!announcedId) return;
		const scoped = { ...m, sessionId: announcedId };
		const watching = ws.data?.watchingSessionId;
		if (!watching) {
			try {
				ws.send(JSON.stringify(scoped));
			} catch {}
		}
		broadcastToSession(announcedId, scoped, watching ? undefined : ws);
	};
	let spec: ResolvedCreate;
	try {
		const bksId = newSessionId();
		let wtPath: string;
		// Deferred worktree setup: the git fetch + worktree add +
		// bun install can take tens of seconds, so the session is
		// announced on the deterministic path first and the worktree
		// is created after session_created goes out (in
		// openCreatedSession).
		let needsWorktree = false;
		// Volume-mode sandbox workspace (Phase 2): no host worktree at
		// all - the sandbox provider clones it in-container on the
		// opening run below.
		let volumeWorkspace = false;
		if (selectedRunner) {
			if (!branch)
				branch = sanitizeBranchSlug(prompt.trim().split("\n")[0]) || `session-${Date.now().toString(36)}`;
			wtPath = runnerWorkspacePath(selectedRunner, bksId);
		} else if (forkSource) {
			// Share the source's cwd so the fork sees the same code state.
			wtPath = forkSource.worktreeDir || repo.repo;
		} else if (fromPr) {
			// From a PR row: work on the PR's existing head branch in an
			// isolated worktree (even for shared-checkout repos and ask
			// mode — the PR's code is the subject, and a PR branch must
			// never check out in the live main checkout). Reuses a
			// worktree already on that branch.
			const worktrees = await listWorktrees(repo.id);
			wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
			if (!wtPath) {
				wtPath = worktreePathFor(branch, repo.id, { isolated: true });
				needsWorktree = true;
			}
		} else if (isRepoLess) {
			// Repo-less sessions run in a plain per-workspace scratch dir —
			// never a repo checkout. Scratch writes there (shared by the
			// workspace's sessions so downloads persist across them); a
			// repo-less ask session only needs somewhere for bash to stand,
			// and carries no tool that can write to it.
			wtPath = ensureScratchDir(workspace?.id || randomUUIDv7());
		} else if (isAsk) {
			// Ask sessions read the repo's pinned ask checkout (default
			// branch, detached) — never the mutable main checkout, whose
			// parked branch is a false context clue. Instant once the
			// checkout exists; only the first-ever create pays a worktree
			// add (ensureAskCheckout).
			wtPath = await ensureAskCheckout(repo.id);
		} else if (sharedCheckoutForNewSessions(repo)) {
			// Open Session: code sessions edit the live main checkout on the
			// default branch (hot-reloads in the running server). No worktree.
			wtPath = repo.repo;
		} else if (workspace?.worktreeDir && worktreeMode === "share") {
			// Share the workspace's owned worktree (parallel sessions, one branch).
			wtPath = workspace.worktreeDir;
		} else {
			// selfDev:"worktree" only: the client may omit a branch for a
			// repo it still believes is shared-checkout — derive one so the
			// worktree path never degenerates to `<wtPrefix>-`. Scoped to
			// sharedCheckout repos so every other repo's path is untouched.
			if (!branch && repo.sharedCheckout)
				branch =
					sanitizeBranchSlug(prompt.trim().split("\n")[0]) ||
					`session-${Date.now().toString(36)}`;
			// New/stacked worktree. Stack branches off the workspace's branch
			// so stacked PRs line up; otherwise branch off origin/default.
			const worktrees = await listWorktrees(repo.id);
			wtPath = worktrees.find((w) => w.branch === branch)?.path || "";
			if (!wtPath) {
				// A genuinely new branch: dodge ref-hierarchy collisions
				// (e.g. requested `test` while `test/foo` already exists)
				// before we bake the name into the path + session file.
				if (branch)
					branch = await resolveUniqueBranch(branch, repo.id);
				wtPath = worktreePathFor(branch, repo.id);
				// Volume-mode sandbox (docs/self-hosting-sandboxes.md): the
				// workspace is cloned into a per-session volume INSIDE the
				// sandbox — skip host createWorktree entirely. The session
				// keeps the canonical path; the provider's ensure()
				// materializes it on the opening run below. Docker only in
				// volume config; remote providers (daytona/e2b) always.
				if (
					createSandboxProvider &&
					sandboxesEnabled() &&
					(remoteSandbox ||
						(createSandboxProvider === "docker" &&
							sandboxConfig().workspace === "volume"))
				) {
					volumeWorkspace = true;
				} else {
					needsWorktree = true;
				}
			}
		}
		// The layer this session stacks on, captured BEFORE the adoption
		// block below can rewrite workspace.branch to this session's own
		// branch — reading it afterwards would make a stacked session try
		// to base on itself.
		const stackBase =
			worktreeMode === "stack" && !isAsk && !isScratch
				? workspace?.branch || ""
				: "";
		// First code session materializes the workspace's owned worktree so
		// later share-mode sessions inherit it. Stacked sessions keep their own —
		// except a "stack" in a workspace with no branch yet, which has no
		// base to stack on and is really the workspace's first worktree.
		// fromPr is exempt from the shared-checkout exclusion: PR-branch
		// worktrees are isolated even for shared-checkout repos, so a PR
		// workspace on e.g. opensession still materializes.
		if (
			workspace &&
			!workspace.worktreeDir &&
			!isAsk &&
			!isScratch &&
			(!sharedCheckoutForNewSessions(repo) || fromPr) &&
			(worktreeMode !== "stack" || !workspace.branch)
		) {
			updateWorkspace(workspace.id, {
				worktreeDir: wtPath,
				...(branch ? { branch } : {}),
			});
			workspace = { ...workspace, worktreeDir: wtPath, branch };
		}
		// The branch this session actually works on (also persisted below).
		const sessionBranch = forkSource
			? forkSource.branch || ""
			: fromPr
				? branch
				: isAsk || isScratch
					? ""
					: selectedRunner
						? branch
						: sharedCheckoutForNewSessions(repo)
						? repo.defaultBranch
						: workspace?.worktreeDir === wtPath
							? workspace.branch || branch
							: branch;

		// Repos to work in beside this one (the palette's ⌘-click). Each gets an
		// isolated worktree on the session's own branch, so the branches — and
		// the PRs that follow them — line up across repos. A session whose repo
		// is a shared checkout works on that repo's mainline, which is no name
		// to give another repo, so the create's requested branch stands in.
		const attachBranch =
			sessionBranch && sessionBranch !== repo.defaultBranch
				? sessionBranch
				: (branch || "").trim();
		const unsupportedAttach =
			isAsk || isScratch || isRepoLess
				? "Only a Code session with a repo can work in more than one repo."
				: forkSource || fromPr
					? "A session started from a fork or a pull request works in the repo it came from."
					: selectedRunner
						? "Runner sessions work in one repo."
						: volumeWorkspace || remoteSandbox
							? "This sandbox keeps the workspace inside the container, which can't hold a second repo yet. Choose This machine, or a sandbox that mounts the worktree."
							: "";
		const askedForRepos = Array.isArray(msg.attachRepos) && msg.attachRepos.length;
		if (askedForRepos && unsupportedAttach) throw new Error(unsupportedAttach);
		const attachRepoIds = planCreateAttachRepos(
			askedForRepos ? msg.attachRepos : [],
			repo.id,
			attachBranch,
		);

		const title = prompt.trim().split("\n")[0].slice(0, 80);
		// Every session lives in a workspace (session-workspace.ts). A create
		// that resolved none — no picker choice, no fork parent, no
		// explicit id — mints its own here rather than surfacing as an
		// orphan the read-side sweep has to adopt a moment later: only a
		// workspace minted on this path can be auto-named from the
		// generated title below.
		let mintedForSession = false;
		if (
			!workspace &&
			!forkSource?.workspaceId &&
			!(typeof msg.workspaceId === "string" && msg.workspaceId)
		) {
			workspace = createWorkspace({
				name: title || "Workspace",
				...(isRepoLess ? {} : { repo: repo.id }),
				createdBy: user || "Anonymous",
				...(sessionBranch ? { branch: sessionBranch } : {}),
				// Only an isolated worktree is owned — a shared main/ask
				// checkout is used by every other session there too.
				...(ownedWorktree(wtPath) ? { worktreeDir: wtPath } : {}),
			});
			mintedForSession = true;
		}
		// An auto-created workspace is renamed ONCE from the generated
		// summary (see openCreatedSession) — it provisionally wears the raw
		// first line. Only a workspace minted by THIS create gets auto-named;
		// an adopted pre-existing workspace keeps its own name. Same one-shot
		// deal for a workspace whose first session just consumed a draft that
		// still wears the draft's first-line name (autoName not demoted to
		// false). The generated title upgrades that first line the same way.
		const wsAutoNamed =
			mintedForSession ||
			(createdWorkspaceNow &&
				!!workspace &&
				!!msg.createWorkspace &&
				!msg.createWorkspace.name) ||
			(!mintedForSession && !!workspace?.draft && workspace.draft.autoName !== false);
		// Non-image attachments: stage to disk, hand the agent the paths.
		let openingPrompt = withUploadsNote(
			prompt,
			stageFileAttachments(bksId, msg.files),
		);
		if (deferredAutoRepo) {
			openingPrompt += `\n\n${wrapContext(
				isAsk
					? `Repository selection was left on Auto and session creation did not wait for the preview. Decide whether this question belongs to a registered repository. If another repository is a better fit, use opensession-repos list_repos and read it from the checkout path returned there.`
					: `Repository selection was left on Auto and session creation did not wait for the preview. Decide whether this task belongs in the current repository before editing. If another registered repository is a better fit, use the opensession-repos tools to switch this session or attach that repository first.`,
				"repos-note",
			)}`;
		}
		// @session:<id> mentions from the New-session box get the same
		// resolving footer as prompts on existing sessions (see
		// runSessionPromptInner) — this create path bypasses it.
		{
			const mentionsNote = sessionMentionsNote(openingPrompt);
			if (mentionsNote) openingPrompt += `\n\n${mentionsNote}`;
		}
		// Session opened from the Support view: link it to its Plain
		// thread (conversation tab + the sidebar's ticket→session
		// mapping) and hand the agent the ticket conversation so the
		// first message is self-contained. A session created inside a
		// ticket workspace (tab-strip "+") inherits the thread too.
		// A session created inside a feed-item workspace (PostHog dashboard, …)
		// inherits the workspace's externalRefs — that's what keeps the
		// Video tab on its sessions and joins the sidebar feed row to the
		// session — and gets the item named in its opening context.
		const inheritedRefs = workspace?.externalRefs;
		// Least privilege for feed-workspace sessions: unless the creator
		// explicitly picked servers, the session's MCP allowlist is the
		// feed's declared list (e.g. posthog → ["posthog"]) — never the full
		// mcp-config (a feed session must not see Plain/Stripe/WorkOS).
		const feedMcpServers =
			!createMcpServers?.length && inheritedRefs?.length
				? await (
						await import("./feeds")
					).feedMcpServersForRefs(inheritedRefs)
				: undefined;
		if (inheritedRefs?.length) {
			const refsContext = await (
				await import("./feeds")
			).externalRefsOpeningContext(inheritedRefs, {
				scratch: isScratch,
				// The creator's MCP grant fetches the object context
				// (e.g. the Tella video via their account).
				user,
			});
			if (refsContext)
				openingPrompt += `\n\n${wrapContext(refsContext, "external-refs")}`;
		}
		const plainThreadId = msgPlainThreadId || workspace?.plainThreadId;
		if (plainThreadId) {
			try {
				const { getThreadWithMessages, formatThreadContext } =
					await import("../agents/plain/api");
				const thread = await getThreadWithMessages(plainThreadId);
				openingPrompt += `\n\n${wrapContext(
					`This session was opened from a Plain support ticket. Ticket context:\n\n${formatThreadContext(thread, true)}`,
					"ticket",
				)}`;
			} catch (e) {
				console.error(
					`[create_session] Plain thread lookup failed for ${plainThreadId}:`,
					e,
				);
				openingPrompt += `\n\n${wrapContext(
					`This session was opened from Plain support ticket ${plainThreadId} (the context lookup failed — use the plain MCP tools to fetch the thread).`,
					"ticket",
				)}`;
			}
		}
		if (needsForkHandoff && fork) {
			openingPrompt += `\n\n${await forkHandoffContext(fork)}`;
		}

		spec = {
			id: bksId,
			title,
			titlePrompt: prompt,
			openingPrompt,
			user,
			createdBy: user || "Anonymous",
			createdAt: new Date().toISOString(),
			createdByLogin: ws.data?.authLogin || undefined,
			mode: isScratch
				? ("scratch" as const)
				: isAsk
					? ("ask" as const)
					: ("code" as const),
			wtPath,
			persistBranch: sessionBranch,
			branch: sessionBranch,
			// Repo-less sessions record no repo: wtPath is a plain scratch dir
			// no registered repo owns.
			repoId: isRepoLess
				? undefined
				: selectedRunner
					? repo.id
					: repoForPathOrNull(wtPath)?.id,
			memoryRepoIds: [repo.id],
			...(attachRepoIds.length
				? { attachRepos: { repos: attachRepoIds, branch: attachBranch } }
				: {}),
			stackedOn: stackBase
				? { repo: repoForPath(wtPath).id, branch: stackBase }
				: undefined,
			workspaceId: workspace
				? workspace.id
				: forkSource?.workspaceId
					? // A fork lands next to its source in the same workspace.
						forkSource.workspaceId
					: typeof msg.workspaceId === "string" && msg.workspaceId
						? msg.workspaceId
						: undefined,
			announceWorkspaceId: workspace?.id,
			createdWorkspaceNow,
			autoNameWorkspace: wsAutoNamed ? workspace : null,
			model,
			effort: createEffort,
			presetNote: workspacePreset?.note,
			fastMode: createFastMode,
			accountId: createAccountId,
			images,
			externalRefs: inheritedRefs,
			plainThreadId,
			persistMcpServers: createMcpServers?.length
				? createMcpServers
				: feedMcpServers?.length
					? feedMcpServers
					: undefined,
			// May be undefined at runtime (historic behavior — reads as "all"
			// downstream); see ResolvedCreate.runMcpServers.
			runMcpServers: (createMcpServers?.length
				? createMcpServers
				: feedMcpServers) as McpScope | undefined,
			sandboxProvider: createSandboxProvider,
			runnerTarget: selectedRunner ? {
				id: selectedRunner.id,
				name: selectedRunner.label || selectedRunner.name,
				workspacePath: wtPath,
				repositoryUrl: `https://github.com/${repo.ghRepo}.git`,
			} : undefined,
			volumeWorkspace,
			remoteSandbox,
			needsWorktree,
			materializeWorktree: needsWorktree
				? () =>
						fromPr
							? createWorktreeForExistingBranch(branch, repo.id)
							: createWorktree(
									branch,
									repo.id,
									stackBase ? { base: stackBase } : undefined,
								)
				: undefined,
			fork: canFork
				? {
						engineSessionId: forkSource!.claudeSessionId!,
						resumeAt: forkFrom?.messageId,
					}
				: undefined,
			finish: "drain",
		};
	} catch (e: any) {
		// Setup failed before anything was persisted or announced — the raw
		// error goes straight back to the sender (same as before extraction).
		ws.send(
			JSON.stringify({
				type: "error",
				message: e.message || String(e),
			}),
		);
		return;
	}

	await openCreatedSession(spec, {
		announce: (info) => {
			ws.send(
				JSON.stringify({
					type: "session_created",
					id: info.id,
					...(info.workspaceId ? { workspaceId: info.workspaceId } : {}),
					...(info.newWorkspace ? { newWorkspace: true } : {}),
					...(info.preparingWorkspace ? { preparingWorkspace: true } : {}),
				}),
			);
			announcedId = info.id;
			emit({ type: "stream_start" });
		},
		emit,
		fail: (message) => {
			ws.send(JSON.stringify({ type: "error", message }));
		},
	});
}
