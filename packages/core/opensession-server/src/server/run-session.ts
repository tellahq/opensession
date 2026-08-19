/**
 * Driving a session turn: runSessionPrompt(Inner) and everything that feeds it —
 * the queue-coupled delivery ops (enqueue/steer/interrupt/drain), the sandbox
 * run launch, restart resume (journal snapshot + drained-session wake-up),
 * transcript watcher attachment, usage folding, auto-push, and the /loop ticker.
 *
 * Queue STATE lives in queue-state.ts; WS fan-out in ws-hub.ts; the session
 * cache in session-cache.ts.
 */

import type { McpScope } from "./runner-shared";
import { randomUUIDv7 } from "bun";
import { existsSync, mkdirSync, readFileSync } from "fs";
import {
	runAgent,
	isAgentSessionBusy,
	markSessionStarting,
	unmarkSessionStarting,
	isAgentSessionCancelled,
	cancelAgentRun,
	steerAgentRun,
	interruptAgentRun,
	stopAgentRunTurn,
	engineFamily,
	interruptAndSteerAgentRun,
	RESUME_CONTINUATION_PROMPT,
	type StreamEvent,
} from "./agent-runner";
import { syncAgentSessionEngine } from "./agent-session-sync";
import { runAgentHosted } from "./host-client";
import { getRunState, transitionRunState } from "./run-state";
import { getAutomation, selfImproveMcpForSession } from "./automations";
import { resolveSessionRunInputs } from "./session-run-inputs";
import { defaultRepo } from "./config";
import { isDevInstance } from "./dev-mode";
import {
	buildSessionContextNote,
	buildEngineSwitchHandoffNote,
} from "./fork-handoff";
import { getGitStatus, gitPush } from "./git-status";
import { onSessionIdle as onHumanAsksSessionIdle } from "./human-asks";
import { parseTranscriptAsync } from "./jsonl-parser";
import {
	contextWindowFor,
	interactiveFallbackModel,
	modelLabel,
	providerFor,
	routeModel,
} from "./models";
import {
	appendOpencodeTranscript,
	isOpencodeSessionId,
	storeAppendUserLineEarly,
	transcriptLineRunnerNotice,
	transcriptLineUser,
} from "./opencode-transcript";
import { cacheMissNotice } from "@tellahq/opensession-protocol/notices";
import { wrapContext, stripContext, isContextOnly } from "./prompt-context";
import { takeVoiceHandoff } from "./desk-voice";
import {
	activeRunRecords,
	setJournalSetListener,
	type ActiveRunRecord,
} from "./run-journal";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import { createSlackPostScanner, linkThreadInIndex } from "./slack-links";
import { STRIPE_CONFIRM_TOOLS, looksLikeFabricatedToolTranscript } from "./runner-shared";
import {
	engineSessionIdFor,
	engineSessionPatch,
	engineUserTexts,
	getEngineTranscriptPath,
	mergedSessionTranscript,
	mergedSessionTranscriptAsync,
	readEngineTranscriptAsync,
	trailingUserTexts,
} from "./sessions";
import {
	getSandboxProvider,
	hasRemoteWorkspace,
	workspaceExecFor,
} from "./sandbox";
import {
	isRemoteSandboxProvider,
	isRunnableSandboxProvider,
	sandboxesEnabled,
	sandboxProviderConfigured,
} from "./sandbox/config";
import { ensureSandboxWithTransientRetry } from "./sandbox/reliability";
import { getTitleOverride } from "./title-overrides";
import { ensureGeneratedTitle } from "./generated-titles";
import { clearReplySuggestions, maybeSuggestReplies } from "./reply-suggestions";
import { commitAuthorFor } from "./shared/user-mappings";
import { writeFileAtomic, writeJsonAtomic } from "./shared/atomic-write";
import { startWatching } from "./file-watcher";
import { ensureAskCheckout, ensureScratchDir, getRepo, isSharedCheckoutDir, repoForPath, repoForPathOrNull, reviveWorktree, sessionRepoId, worktreeHeadBranch } from "./worktree";
import { createGoalSelfMcpServer } from "../agents/slack/goal-tools";
import { sendSlackMessage } from "../agents/slack/slack-api";
import { runHostsDir, type RunHostSpec } from "../runner-host/protocol";
import { maybeLaunchRunnerRun } from "./runner-session";
import { shouldPersistModelSwitch, type ImageInput, type TurnUsage } from "./run-events";
import type {
	SessionUsage,
	TranscriptEntry,
	UnifiedSession,
} from "./types";
import {
	findSession,
	getCachedSessions,
	invalidateSessionsCache,
	persistAutoModelSwitch,
	recordRunOutcome,
	touchNativeSession,
	SESSIONS_DIR,
} from "./session-cache";
import { markRecapPendingIfUnwatched } from "./recap";
import { broadcastToSession, sessionWatchers } from "./ws-hub";
import {
	broadcastQueue,
	beginPromptDispatch,
	acknowledgePromptDispatch,
	clearSteerReceipts,
	isGitHubQueueItem,
	persistQueues,
	promptQueues,
	queuedPromptIndex,
	queueItem,
	recordSteer,
	requeueSteerReceipts,
	restorePersistedQueueState,
	steeredReceipts,
	stoppedSessions,
	type QueueItem,
} from "./queue-state";
import { isShuttingDown } from "./shutdown-state";
import {
	parseImageDataUrls,
	stageFileAttachments,
	withUploadsNote,
} from "./uploads";
import { buildSessionNote } from "./session-repos";
import { automationSessionMcp, interactiveMcpServers } from "./interactive-mcp";
import { makeAskHandler, settleRestoredAskAfterRecovery } from "./asks";

// The runner writes its active-run journal before it can call an engine. Once
// that journal names this prompt entry, normal boot recovery owns it and the
// queue's pre-dispatch record is no longer needed.
setJournalSetListener((record) =>
	acknowledgePromptDispatch(record.osSessionId, record.promptEntryId),
);
import { audit } from "./audit";
import {
	announcesNextAction,
	AUTO_CONTINUE_FABRICATED_PROMPT,
	AUTO_CONTINUE_PROMPT,
	AUTO_CONTINUE_USER,
	INTERRUPT_STEER_NOTE,
	isWedgeFailure,
	ORPHANED_STEER_PROMPT,
	WEDGE_RETRY_PROMPT,
} from "./auto-continue";
import { SYSTEM_RESTART_USER } from "./session-actors";
import { selectQueueBatch } from "./queue-hold";

const g = globalThis as any;

// Sessions whose last turn already got an announce-then-stop auto-continue —
// one consecutive WORKLESS nudge max, so a model that announces-and-stops twice
// in a row parks for the human instead of looping. Cleared when a human prompt
// arrives or a turn does real (tool-calling) work — which also means that while
// the agent keeps genuinely working through announced steps, queued messages
// stay held behind fresh auto-continues (the queue-hold in the run-end handler)
// until a turn ends without announcing more work.
const autoContinueNudged: Set<string> = (g.__autoContinueNudged ??= new Set());

// Per-session tail of stranded user messages already redelivered once (see
// the endedWithError branch of maybeQueueAutoContinue) — keyed by content so
// a redelivery turn that fails on the same tail doesn't loop, while a NEW
// stranded message is always eligible. Cleared on any clean turn.
const orphanRedeliveredTails: Map<string, string> = (g.__orphanRedeliveredTails ??=
	new Map());

// Per-session wedge failure already auto-retried once (see the wedge branch of
// maybeQueueAutoContinue) — keyed by failure text so the SAME wedge twice in a
// row parks for the human instead of looping. Cleared on any clean turn.
const wedgeRetriedFailures: Map<string, string> = (g.__wedgeRetriedFailures ??=
	new Map());

// The session's pending interrupt: its current queue head was armed by
// aborting the running turn (busy-send). ONE record with ONE ttl, taken once
// per drain pass — the same mark both waves the batch past the queue hold and
// appends INTERRUPT_STEER_NOTE, so the model treats the delivery as a mid-task
// steer instead of a fresh turn it can acknowledge-and-park on. Reading those
// two halves separately let an expired mark do one without the other: the hold
// was bypassed (a held human send landed mid-task) and the note was then
// refused as expired, so it landed unframed too.
// `soloId` is set when the interrupt targeted a SPECIFIC queued item (the queue
// chip's send/▲ button) rather than a fresh compose-send: only that item rides
// this drain, and the rest of the queue stays put for the next natural stopping
// point. Timestamped so a mark whose drain never happens (the user hits Stop
// before it fires) expires instead of mislabeling — or solo-delivering — a much
// later, unrelated prompt.
const interruptMarks: Map<string, { at: number; soloId?: string }> =
	(g.__interruptMarks ??= new Map());
const INTERRUPT_MARK_TTL_MS = 5 * 60_000;

/** Take this session's pending interrupt. Always clears the record, so one
 *  interrupt drives exactly one drain; an expired one reads as no interrupt. */
function consumeInterruptMark(
	sessionId: string,
): { soloId?: string } | undefined {
	const mark = interruptMarks.get(sessionId);
	if (!mark) return undefined;
	interruptMarks.delete(sessionId);
	if (Date.now() - mark.at >= INTERRUPT_MARK_TTL_MS) return undefined;
	return mark;
}

// One "queue held" notice per hold engagement (not one per watcher tick);
// cleared whenever a drain actually delivers a batch.
const queueHoldNotified: Set<string> = (g.__queueHoldNotified ??= new Set());

/**
 * Child worker runs (spawn_task / create_session with a parent link) keep the
 * parent session "logically working" past its own turn end: the worker's
 * report arrives as the parent's next turn, so a queued human message
 * delivered in the gap would land mid-task. The drain holds `hold`-tagged
 * items while any child run is busy; the queue chip's steer button is the
 * explicit deliver-sooner escape hatch.
 */
export function runningChildCount(sessionId: string): number {
	let n = 0;
	for (const s of getCachedSessions()) {
		if (s.parentSessionId !== sessionId || s.archived) continue;
		if (isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id)) n++;
	}
	return n;
}

/** Append a message to a session's drainable queue and persist + broadcast.
 *  `front` puts it ahead of everything already queued — used by the run-end
 *  queue-hold so its auto-continue delivers before the user's queued messages. */
export function enqueuePrompt(
	sessionId: string,
	item: QueueItem,
	opts?: { front?: boolean },
): void {
	const queue = promptQueues.get(sessionId) || [];
	if (opts?.front) queue.unshift(queueItem(item));
	else queue.push(queueItem(item));
	promptQueues.set(sessionId, queue);
	persistQueues();
	broadcastQueue(sessionId);
	// Queueing is a delivery promise, not just a UI state. Arm the idle watcher
	// here so every queued message drains after the current run, even if a caller
	// forgets to do that explicitly or the session becomes idle between checks.
	watchExternalRunAndDrain(sessionId);
}

export function steerQueuedPrompt(
	sessionId: string,
	queueId?: string,
	queueIndex?: number,
): boolean {
	const session = findSession(sessionId);
	const queue = promptQueues.get(sessionId);
	if (!session || !queue) return false;
	const index = queuedPromptIndex(queue, queueId, queueIndex);
	if (index < 0) return false;
	const [item] = queue.splice(index, 1);
	if (!item) return false;
	if (
		!isAgentSessionBusy(
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		)
	) {
		// Idle-but-queued (typically held behind running child workers): "steer"
		// means "get this in front of the agent now" — deliver it as its own
		// turn immediately. The rest of the queue keeps its hold.
		if (queue.length > 0) promptQueues.set(sessionId, queue);
		else promptQueues.delete(sessionId);
		stoppedSessions.delete(sessionId);
		persistQueues();
		broadcastQueue(sessionId);
		const files =
			Array.isArray(item.files) && item.files.length > 0
				? item.files
				: undefined;
		void runSessionPromptAndDrain(
			sessionId,
			item.content,
			item.user,
			parseImageDataUrls(item.images || []),
			files,
		).catch((e) => {
			console.error(`[queue] Steer-deliver failed for ${sessionId}:`, e);
			enqueuePrompt(sessionId, item);
		});
		return true;
	}
	// Files can't ride a steer (the fold path is text+images only). GitHub FYI
	// items CAN steer — folding in is non-interrupting, so it's the right
	// delivery for them too (they only land in the queue when a steer at
	// delivery time found nothing steerable).
	if (Array.isArray(item.files) && item.files.length > 0) {
		queue.splice(index, 0, item);
		return false;
	}
	const attributed =
		item.user && !isContextOnly(item.content)
			? `[${item.user}] ${item.content}`
			: item.content;
	const images = parseImageDataUrls(item.images || []);
	if (
		!steerAgentRun(
			[session.claudeSessionId, session.codexThreadId, session.id],
			attributed,
			images,
		)
	) {
		queue.splice(index, 0, item);
		return false;
	}
	if (queue.length > 0) promptQueues.set(sessionId, queue);
	else promptQueues.delete(sessionId);
	recordSteer(sessionId, item);
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}

/**
 * Interrupt-deliver a waiting message: abort the run's current turn so the
 * message lands right away instead of at the next natural stopping point.
 * Two cases: an already-steered receipt just needs a bare interrupt (its text
 * is in the run's steer buffer — the forced boundary releases it; pushing it
 * again would double-deliver), while a queued item is folded in through the
 * interrupt-and-steer path. False = still queued, nothing was interrupted.
 */
export function interruptQueuedPrompt(
	sessionId: string,
	queueId?: string,
	queueIndex?: number,
): boolean {
	const session = findSession(sessionId);
	if (!session) return false;
	if (queueId && (steeredReceipts.get(sessionId) || []).some((s) => s.id === queueId)) {
		// Receipt stays visible until the message lands in the transcript (the
		// usual reconcile) — dropping it here would lose it if the interrupt
		// fires between release and delivery.
		return interruptAgentRun([
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		]);
	}
	const queue = promptQueues.get(sessionId);
	if (!queue) return false;
	const index = queuedPromptIndex(queue, queueId, queueIndex);
	if (index < 0) return false;
	const [item] = queue.splice(index, 1);
	if (!item) return false;
	if (isGitHubQueueItem(item) || (Array.isArray(item.files) && item.files.length > 0)) {
		queue.splice(index, 0, item);
		return false;
	}
	const attributed =
		item.user && !isContextOnly(item.content)
			? `[${item.user}] ${item.content}`
			: item.content;
	const images = parseImageDataUrls(item.images || []);
	if (
		!isAgentSessionBusy(
			session.claudeSessionId,
			session.codexThreadId,
			session.id,
		)
	) {
		queue.splice(index, 0, item);
		return false;
	}
	if (
		!interruptAndSteerAgentRun(
			[session.claudeSessionId, session.codexThreadId, session.id],
			attributed,
			images,
		)
	) {
		// No in-band interrupt-and-steer (opencode): keep the item queued — it's
		// the durable record — and abort the turn so the drain delivers it right
		// away. Mark it (by id) as the solo delivery so the drain delivers ONLY
		// this item; every other queued item stays put and drains at the next
		// natural stopping point instead of being swept into this batch. Kept at
		// its original position so the queue doesn't visibly reshuffle.
		const solo = queueItem(item);
		queue.splice(index, 0, solo);
		promptQueues.set(sessionId, queue);
		persistQueues();
		broadcastQueue(sessionId);
		return abortTurnAndDrain(sessionId, session, solo.id);
	}
	// No steer receipt: an interrupt delivers almost immediately, so the
	// transcript entry is the record (same treatment as a direct interrupt send).
	if (queue.length > 0) promptQueues.set(sessionId, queue);
	else promptQueues.delete(sessionId);
	persistQueues();
	broadcastQueue(sessionId);
	return true;
}

/**
 * Restore queued + steered messages a previous process left behind (a real
 * restart/crash; hot reloads keep the in-memory maps). Drainable queue items
 * are re-armed for delivery; unconfirmed steer receipts remain display-only so
 * an adopted run still owns their delivery, while the existing cancel path can
 * requeue them if that run is stopped. Call
 * after resumeInterruptedRuns so a session being resumed reads as busy and the
 * watcher waits it out instead of starting a colliding run.
 */
export function restorePromptQueues(resumedSessionIds: Set<string>): void {
	const active = activeRunRecords();
	const restored = restorePersistedQueueState({
		sessionExists: (sessionId) => !!findSession(sessionId),
		journalOwnsPrompt: (sessionId, promptEntryId) =>
			active.some(
				(run) =>
					run.osSessionId === sessionId && run.promptEntryId === promptEntryId,
			),
		runOwnsSteers: (sessionId) =>
			resumedSessionIds.has(sessionId) &&
			active.some((run) => run.osSessionId === sessionId),
		deliveredUserTexts: (sessionId) => {
			const session = findSession(sessionId);
			return session ? engineUserTexts(session) : [];
		},
	});
	for (const sessionId of restored.queuedSessionIds) {
		watchExternalRunAndDrain(sessionId);
	}
	if (restored.queuedCount > 0 || restored.steeredCount > 0) {
		console.log(
			`[queue] Restored ${restored.queuedCount} queued message(s) and ${restored.steeredCount} steer receipt(s) from before restart`,
		);
	}
}

// ── Wake-all-active-sessions on restart ──────────────────────────────────────
// The run journal (active-runs.json) only retains runs that are STILL executing
// when the process exits. During a graceful restart the 2-min drain lets runs
// finish their current turn — which clears them from the journal — so a session
// that stopped at a turn boundary mid-task was silently NOT resumed (the user had
// to type "continue"). To fix that we snapshot every active session the moment
// SIGTERM arrives (before the drain) and, on boot, nudge any that the journal
// resume didn't already cover. Crash (no graceful shutdown) still falls back to
// the journal, so both paths are covered.
const RESUME_SNAPSHOT_PATH = `${SESSIONS_DIR}/active-at-shutdown.json`;

export function readActiveShutdownSnapshot(): ActiveRunRecord[] {
	try {
		if (!existsSync(RESUME_SNAPSHOT_PATH)) return [];
		const records = JSON.parse(readFileSync(RESUME_SNAPSHOT_PATH, "utf-8"));
		return Array.isArray(records) ? records : [];
	} catch (e) {
		console.error("[resume] Failed to read active-session snapshot:", e);
		return [];
	}
}

/** Snapshot-only local hosts that still have a run directory to reattach to.
 * A host that finished cleanly during the shutdown drain removes this file and
 * remains eligible for the normal generic wake instead. */
export function recoverableLocalHostSnapshotRecords(
	records: ActiveRunRecord[],
	hostsDir = runHostsDir(SESSIONS_DIR),
): ActiveRunRecord[] {
	return records.filter(
		(record) =>
			!!record.hostId &&
			!record.sandboxId &&
			!record.runnerId &&
			existsSync(`${hostsDir}/${record.hostId}/spec.json`),
	);
}

/** Capture the sessions with an in-flight run, for boot-time wake-up. Called at
 *  the very start of graceful shutdown, before the drain empties the journal. */
export function snapshotActiveSessions(): void {
	try {
		const records = activeRunRecords();
		if (records.length === 0) {
			if (existsSync(RESUME_SNAPSHOT_PATH))
				writeFileAtomic(RESUME_SNAPSHOT_PATH, "[]");
			return;
		}
		writeJsonAtomic(RESUME_SNAPSHOT_PATH, records, false);
		console.log(
			`[resume] Snapshotted ${records.length} active session(s) for wake-up on restart`,
		);
	} catch (e) {
		console.error("[resume] Failed to snapshot active sessions:", e);
	}
}

/** Wake sessions that were active at the last graceful shutdown but finished
 *  their turn during the drain (so they weren't in the journal to resume).
 *  `alreadyResumed` are the osSessionIds the journal resume already handled. */
export function resumeDrainedSessions(
	alreadyResumed: Set<string>,
	records = readActiveShutdownSnapshot(),
): void {
	if (!records.length) return;
	// Consume the snapshot so the next (non-graceful) boot doesn't replay it.
	try {
		writeFileAtomic(RESUME_SNAPSHOT_PATH, "[]");
	} catch {}

	let woken = 0;
	for (const r of records) {
		const id = r.osSessionId;
		if (!id || alreadyResumed.has(id)) continue; // journal already resumed it
		if (r.kind?.startsWith("github-")) continue; // github agent owns its recovery
		const session = findSession(id);
		// Only interactive opensession sessions — never re-trigger automations/loops,
		// which are one-shot and would re-run their whole task.
		if (!session || session.source !== "opensession" || session.automation)
			continue;
		if (
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		)
			continue;
		if (providerFor(session.model) === "claude" && !session.claudeSessionId)
			continue;
		woken++;
		console.log(
			`[resume] Waking session ${id} that finished its turn during the drain`,
		);
		void runSessionPromptAndDrain(
			id,
			RESUME_CONTINUATION_PROMPT,
			SYSTEM_RESTART_USER,
		).catch((e) => console.error(`[resume] Wake failed for ${id}:`, e));
	}
	if (woken > 0)
		console.log(
			`[resume] Woke ${woken} drained session(s) from before restart`,
		);
}

/** Per-session Slack-post scanners for recovered (reattached/resumed) runs —
 *  see the capture block in recordRecoveredRunEvent. Cleared on done/error. */
const recoveredSlackScanners = new Map<
	string,
	ReturnType<typeof createSlackPostScanner>
>();
const recoveredFeedStarted: Set<string> = (g.__recoveredFeedStarted ??= new Set());

export function recordRecoveredRunEvent(osSessionId: string, event: StreamEvent): void {
	const session = findSession(osSessionId);
	if (!session) return;
	if (session.source !== "opensession") {
		// Slack/linear-source sessions: a recovered run's engine-id/model flips
		// persist into the owning agent's store, same rationale as the init/
		// model_switch handlers in runSessionPromptInner — a reattached run that
		// had fallback-minted a new engine session must not leave the session
		// file pointing at the dead one.
		if (event.type === "model_switch" && event.toModel) {
			if (
				shouldPersistModelSwitch(event) &&
				syncAgentSessionEngine(session, { model: event.toModel })
			) {
				invalidateSessionsCache();
			}
		} else if (
			(event.type === "init" || event.type === "done") &&
			event.sessionId
		) {
			const provider =
				event.provider || providerFor(event.model || session.model);
			if (
				syncAgentSessionEngine(
					session,
					provider === "pi"
						? { piSessionId: event.sessionId }
						: { engineSessionId: event.sessionId },
				)
			)
				invalidateSessionsCache();
			if (session.worktreeDir)
				attachSessionWatchersToEngineTranscript(
					osSessionId,
					provider,
					session.worktreeDir,
					event.sessionId,
				);
		}
		return;
	}

	// A real restart creates a fresh feed epoch. Rebuild the active feed from the
	// adopted run's own event stream instead of persisting high-frequency feed
	// frames. The transcript backfill remains authoritative for committed text;
	// this path carries only the active phase and text produced after adoption.
	const carriesFeedState =
		event.type === "init" ||
		event.type === "text_chunk" ||
		event.type === "tool_use" ||
		event.type === "tool_result";
	if (carriesFeedState && !recoveredFeedStarted.has(osSessionId)) {
		recoveredFeedStarted.add(osSessionId);
		broadcastToSession(osSessionId, {
			type: "stream_start",
			sessionId: osSessionId,
			by: session.startedBy || "Anonymous",
		});
		broadcastToSession(osSessionId, {
			type: "session_status",
			sessionId: osSessionId,
			isRunning: true,
		});
	}
	if (event.type === "text_chunk") {
		broadcastToSession(osSessionId, {
			type: "stream_text",
			sessionId: osSessionId,
			text: event.text,
			...(event.blockId ? { blockId: event.blockId } : {}),
		});
	} else if (event.type === "tool_use") {
		broadcastToSession(osSessionId, {
			type: "stream_tool_use",
			sessionId: osSessionId,
			entry: {
				id: event.toolUseId || crypto.randomUUID(),
				type: "tool_use",
				content: `Using ${event.toolName}`,
				timestamp: new Date().toISOString(),
				toolName: event.toolName,
				toolInput: event.toolInput,
				toolUseId: event.toolUseId,
			},
		});
	} else if (event.type === "tool_result") {
		broadcastToSession(osSessionId, {
			type: "stream_tool_result",
			sessionId: osSessionId,
			entry: {
				id: event.toolUseId ? `tr-${event.toolUseId}` : crypto.randomUUID(),
				type: "tool_result",
				content: event.content || "",
				timestamp: new Date().toISOString(),
				toolUseId: event.toolUseId,
				...(event.images?.length ? { images: event.images } : {}),
				...(event.videos?.length ? { videos: event.videos } : {}),
				...(event.featuredMedia?.length
					? { featuredMedia: event.featuredMedia }
					: {}),
			},
		});
	}

	// Capture Slack posts so a reply in the posted thread routes back to this
	// session (slack-links index). runAutomation does the same for normal runs;
	// this covers runs that were REATTACHED/resumed after a restart — their
	// events no longer flow through runAutomation's loop (that's how the
	// 2026-07-16 dispute runs lost their thread links).
	{
		let scan = recoveredSlackScanners.get(osSessionId);
		if (!scan) {
			scan = createSlackPostScanner();
			recoveredSlackScanners.set(osSessionId, scan);
		}
		const post = scan(event);
		if (post) {
			const threads = session.slackThreads || [];
			if (
				!threads.some(
					(t) => t.channel === post.channel && t.threadTs === post.threadTs,
				)
			) {
				touchNativeSession(osSessionId, {
					slackThreads: [...threads, { channel: post.channel, threadTs: post.threadTs }],
				});
				linkThreadInIndex(osSessionId, post.channel, post.threadTs);
				invalidateSessionsCache();
			}
		}
		if (event.type === "done" || event.type === "error")
			recoveredSlackScanners.delete(osSessionId);
	}

	if (event.type === "model_switch") {
		const to = event.toModel || "";
		if (!to) return;
		if (!shouldPersistModelSwitch(event)) return;
		if (session.model === to) return;
		const reason = `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`;
		// Conditional: a /model sent while this recovered run was in flight must
		// not be reverted by its fallback (see persistAutoModelSwitch).
		void persistAutoModelSwitch({
			sessionId: osSessionId,
			expectedModel: session.model,
			model: to,
			entry: {
				model: to,
				from: event.fromModel,
				at: new Date().toISOString(),
				by: reason,
			},
		}).then(() => invalidateSessionsCache());
		return;
	}

	if (event.type === "done" || event.type === "error") {
		recoveredFeedStarted.delete(osSessionId);
		if (event.type === "done") {
			clearSteerReceipts(osSessionId);
		} else {
			const requeued = requeueSteerReceipts(
				osSessionId,
				engineUserTexts(session),
			);
			if (requeued > 0) watchExternalRunAndDrain(osSessionId);
		}
		if (settleRestoredAskAfterRecovery(osSessionId)) {
			watchExternalRunAndDrain(osSessionId);
		}
		broadcastToSession(osSessionId, {
			type: "stream_done",
			sessionId: osSessionId,
		});
		broadcastToSession(osSessionId, {
			type: "session_status",
			sessionId: osSessionId,
			isRunning: false,
		});
		onHumanAsksSessionIdle(osSessionId);
		if (event.type === "error") return;
	}

	if (event.type !== "init" && event.type !== "done") return;
	const engineSessionId = event.sessionId || "";
	const model = event.model || session.model;
	const provider = event.provider || providerFor(model);
	touchNativeSession(osSessionId, {
		...(engineSessionId ? engineSessionPatch(provider, engineSessionId) : {}),
		...(engineSessionId && event.provider
			? { lastEngineProvider: event.provider }
			: {}),
		...(event.model ? { lastEngineModel: event.model } : {}),
	});
	if (engineSessionId && session.worktreeDir) {
		attachSessionWatchersToEngineTranscript(
			osSessionId,
			provider,
			session.worktreeDir,
			engineSessionId,
		);
	}
	invalidateSessionsCache();
}

/**
 * Attach every socket viewing `sessionId` to a transcript file that only came
 * into existence after they started watching — a fresh session's first run (no
 * transcriptPath existed at watch time), or an engine-id rotation forking to a
 * new file mid-conversation. Without this the whole run is silent for viewers:
 * the sent message sticks at "sending…" and the reply vanishes at stream_done,
 * until a reload re-watches the right file. Streams from byte 0 — entry ids
 * are the jsonl line uuids, so anything the client already has upserts
 * instead of duplicating.
 */
export function attachSessionWatchersToTranscript(
	sessionId: string,
	path: string,
): void {
	const set = sessionWatchers.get(sessionId);
	if (!set) return;
	for (const ws of set) {
		// Transcript v2 viewers (ws-handlers.ts serveTranscriptV2) are fed by
		// the in-process bus — force-registering them onto the (new) mirror
		// watch would double-feed a full-file replay.
		if ((ws as any)?.data?.transcriptV2) continue;
		startWatching(path, ws, 0, sessionId);
	}
}

export function attachSessionWatchersToEngineTranscript(
	sessionId: string,
	// "opencode" and "pi" resolve to no transcript path (both keep their turns
	// in the owned store); those sessions stream through run events only, so
	// this attaches nothing for them.
	provider: "claude" | "codex" | "opencode" | "pi",
	cwd: string,
	engineSessionId: string,
	attempt = 0,
): void {
	const path = getEngineTranscriptPath(cwd, engineSessionId, provider);
	if (path) {
		attachSessionWatchersToTranscript(sessionId, path);
		return;
	}
	if (provider === "codex" && attempt < 5) {
		setTimeout(
			() =>
				attachSessionWatchersToEngineTranscript(
					sessionId,
					provider,
					cwd,
					engineSessionId,
					attempt + 1,
				),
			250,
		);
	}
}

const queueDrains: Map<string, Promise<void>> = (g.__queueDrains ??= new Map());

// One notice per session when a send parks for a restart. In-memory only: the
// next boot delivers the parked queue, so a stale entry costs nothing.
const shutdownParkNotified: Set<string> = (g.__shutdownParkNotified ??= new Set());
function notifyShutdownPark(sessionId: string): void {
	if (shutdownParkNotified.has(sessionId)) return;
	shutdownParkNotified.add(sessionId);
	broadcastToSession(sessionId, {
		type: "notice",
		sessionId,
		message:
			"The server is restarting. Your message is queued and will be delivered when it's back.",
	});
}

/**
 * Serialize queue draining per session. A sleeping Sandbox may take seconds
 * to resume, during which later composer sends must stay behind the first
 * persisted message instead of each initiating another provider wake.
 */
export function drainQueue(sessionId: string): Promise<void> {
	const existing = queueDrains.get(sessionId);
	if (existing) return existing;
	const drain = drainQueueInner(sessionId).finally(() => {
		if (queueDrains.get(sessionId) === drain) queueDrains.delete(sessionId);
	});
	queueDrains.set(sessionId, drain);
	return drain;
}

async function drainQueueInner(sessionId: string): Promise<void> {
	let queue;
	while ((queue = promptQueues.get(sessionId)) && queue.length > 0) {
		// The user pressed stop: leave the queue visible-but-parked until their
		// next explicit action instead of restarting the run they just stopped.
		if (stoppedSessions.has(sessionId)) return;
		// Graceful shutdown: park the queue instead of starting a turn. A turn
		// started after the shutdown snapshot races the drain deadline (an
		// in-process one is SIGKILLed there and redone from the journal), and
		// the sender's socket dies mid-stream either way. The queue is already
		// persisted, so the next boot's restorePromptQueues delivers this
		// message cleanly instead.
		if (isShuttingDown()) {
			notifyShutdownPark(sessionId);
			return;
		}
		// A racing run can own the session by the time we loop again (e.g. our
		// last batch lost the start race and got re-queued) — hand off to the
		// idle-watcher instead of busy-spinning runs that immediately bounce.
		const session = findSession(sessionId);
		if (
			session &&
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		) {
			watchExternalRunAndDrain(sessionId);
			return;
		}
		// Batch selection lives in queue-hold.ts (pure, unit-tested): a solo
		// interrupt (queue chip ▲) delivers one item, a head auto-continue
		// delivers alone, and while child worker runs are still going, human
		// composer sends (item.hold) stay parked until the agent FULLY
		// completes. Orchestration traffic (worker reports, FYIs) keeps
		// flowing so held items can't wedge the run.
		//
		// One read of the pending interrupt per pass: the same record decides
		// both whether this batch skips the hold and whether it gets the steer
		// note below, so an expired one can never do one without the other.
		const interrupt = consumeInterruptMark(sessionId);
		const plan = selectQueueBatch(queue, {
			soloId: interrupt?.soloId,
			interruptMark: interrupt !== undefined,
			stillWorking: runningChildCount(sessionId) > 0,
		});
		if (plan.kind === "hold") {
			if (!queueHoldNotified.has(sessionId)) {
				queueHoldNotified.add(sessionId);
				broadcastToSession(sessionId, {
					type: "notice",
					sessionId,
					message: `Holding ${plan.heldCount} queued message${plan.heldCount === 1 ? "" : "s"} until the agent fully completes (worker sessions still running). Steer sends one in sooner.`,
				});
			}
			watchExternalRunAndDrain(sessionId);
			return;
		}
		queueHoldNotified.delete(sessionId);
		const batch = plan.batch;
		if (plan.rest.length > 0) promptQueues.set(sessionId, plan.rest);
		else promptQueues.delete(sessionId);
		// Persist the delivery intent before starting work. If the process dies
		// after this point but before the runner journals its run, boot restores
		// this batch to the front of the queue.
		const promptEntryId = beginPromptDispatch(sessionId, batch);
		broadcastQueue(sessionId);
		let combined = batch
			.map((m) =>
				batch.length > 1 && m.user ? `[${m.user}] ${m.content}` : m.content,
			)
			.join("\n\n");
		// Interrupt delivery (busy-send aborted the turn to land this batch):
		// append the fenced steer note so the model resumes the interrupted work
		// instead of acknowledge-and-parking. Fenced, so the transcript shows
		// only the user's text.
		if (interrupt) {
			combined = `${combined}\n\n${wrapContext(INTERRUPT_STEER_NOTE, "steer-note")}`;
		}
		// Attachments queued alongside the text ride the drained turn: images are
		// decoded to ImageInput, files handed through as staged/inline refs.
		const combinedImages = parseImageDataUrls(
			batch.flatMap((m) => m.images ?? []),
		);
		const combinedFiles = batch.flatMap((m) =>
			Array.isArray(m.files) ? m.files : [],
		);
		const contextSessions = [...new Set(batch.flatMap((m) => m.contextSessions ?? []))];
		// A queued Slack-thread reply carries its origin thread — the turn's answer
		// mirrors back there. Last one wins if a batch somehow spans threads.
		const slackReplyTo = [...batch].reverse().find((m) => m.slackReplyTo)?.slackReplyTo;
		try {
			await runSessionPrompt(
				sessionId,
				combined,
				batch[0].user,
				combinedImages,
				combinedFiles.length ? combinedFiles : undefined,
				contextSessions.length ? contextSessions : undefined,
				slackReplyTo,
				promptEntryId,
			);
		} catch (e) {
			// The batch was already spliced out and persisted away — put it back at
			// the front of the queue so a throw doesn't lose the messages.
			acknowledgePromptDispatch(sessionId, promptEntryId, false);
			const current = promptQueues.get(sessionId) || [];
			promptQueues.set(sessionId, [...batch, ...current]);
			persistQueues();
			broadcastQueue(sessionId);
			throw e;
		}
	}
}

export async function runSessionPromptAndDrain(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
	contextSessions?: string[],
	slackReplyTo?: { channel: string; threadTs: string },
): Promise<void> {
	await runSessionPrompt(sessionId, content, user, images, rawFiles, contextSessions, slackReplyTo);
	await drainQueue(sessionId);
}

// Messages queued while a run we didn't start is in flight (Slack runs, CLI
// sessions in tmux, automations) have no drain loop of their own — watch the
// busy state and deliver the queue once the external run finishes.
const drainWatchers: Set<string> = (g.__drainWatchers ??= new Set());
export function watchExternalRunAndDrain(sessionId: string): void {
	if (drainWatchers.has(sessionId)) return;
	drainWatchers.add(sessionId);
	const timer = setInterval(async () => {
		const session = findSession(sessionId);
		if (!session || !(promptQueues.get(sessionId) || []).length) {
			clearInterval(timer);
			drainWatchers.delete(sessionId);
			return;
		}
		if (
			isAgentSessionBusy(
				session.claudeSessionId,
				session.codexThreadId,
				session.id,
			)
		)
			return;
		clearInterval(timer);
		drainWatchers.delete(sessionId);
		try {
			await drainQueue(sessionId);
		} catch (e) {
			console.error(
				`[queue] Drain after external run failed for ${sessionId}:`,
				e,
			);
		}
	}, 3000);
}

/**
 * Esc+Enter for engines with no in-band interrupt-and-steer (opencode): abort
 * the run's current turn — the same abort the Esc/stop path uses — and let the
 * drain watcher deliver the queue as the immediate next turn on the same
 * engine session. The interrupting message must already be in promptQueues
 * before calling (durability: nothing is lost if the abort races a crash).
 * False = nothing abortable (external CLI/tmux run) — the message stays queued
 * for the run's natural stopping point.
 */
export function abortTurnAndDrain(
	sessionId: string,
	session: {
		claudeSessionId?: string | null;
		codexThreadId?: string | null;
		opencodeSessionId?: string | null;
		transcriptPath?: string | null;
		id: string;
	},
	/** The one queued item this interrupt targeted (queue chip send/▲), when
	 *  it targeted one — the rest of the queue stays put for this drain. */
	soloId?: string,
): boolean {
	const ids = [session.claudeSessionId, session.codexThreadId, session.id];
	const aborted = stopAgentRunTurn(ids) || cancelAgentRun(...ids);
	if (!aborted) return false;
	// The user explicitly asked for delivery now — unpark an earlier Stop, and
	// fold steer receipts the engine never got back in ahead so nothing is
	// dropped (landed steers are already in the engine history — requeueing
	// them would deliver duplicates).
	stoppedSessions.delete(sessionId);
	requeueSteerReceipts(sessionId, engineUserTexts(session));
	// The drained batch is an interrupt delivery: record it so the next drain
	// pass lets it past the queue hold and frames it as a mid-task steer (see
	// INTERRUPT_STEER_NOTE). Only marked once the abort actually took — a
	// message left queued for the run's natural stopping point was never
	// interrupted into anything.
	interruptMarks.set(sessionId, { at: Date.now(), soloId });
	watchExternalRunAndDrain(sessionId);
	return true;
}

/**
 * Fold a completed run's usage into a session's cumulative totals. Cost and
 * token counts accumulate; context size (contextTokens/contextWindow) reflects
 * the latest turn rather than a sum — it's the current window fill, not lifetime
 * throughput.
 */
export function foldSessionUsage(
	prev: SessionUsage | undefined,
	turn: TurnUsage,
	model?: string | null,
): SessionUsage {
	const base: SessionUsage = prev ?? {
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		contextTokens: 0,
		contextWindow: 0,
		turns: 0,
		updatedAt: "",
	};
	return {
		costUsd: base.costUsd + (turn.costUsd ?? 0),
		inputTokens: base.inputTokens + turn.inputTokens,
		outputTokens: base.outputTokens + turn.outputTokens,
		cacheReadTokens: base.cacheReadTokens + turn.cacheReadTokens,
		cacheCreationTokens: base.cacheCreationTokens + turn.cacheCreationTokens,
		contextTokens: turn.contextTokens || base.contextTokens,
		contextWindow: contextWindowFor(model) || base.contextWindow,
		turns: base.turns + 1,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Silent auto-push: when a session's turn ends idle, publish any local commits
 * that are ahead of an already-tracked upstream. This is the real "sessions push
 * automatically" mechanism — the agent's prompt-level `git push` is best-effort
 * and silently misses whenever a turn ends between commit and push (or the
 * commits landed outside a turn), leaving the status header parked on a stale
 * "Ahead by N commits". We only touch a branch that:
 *   - is NOT the repo's default branch — never auto-push main/master (this also
 *     excludes the opensession shared checkout, which pushes master by hand), and
 *   - already has an upstream (published once, so pushing follow-up commits is
 *     the expected sync; an un-pushed branch with no PR goes via Create PR), and
 *   - is strictly ahead (behind === 0) — a diverged branch needs a human/agent
 *     to reconcile, and a plain push would be rejected anyway.
 * Never forces. A failed push is swallowed (logged) — it just leaves the Push
 * button as the visible fallback. Fire-and-forget from the turn-end path so it
 * never delays draining the queue; a `git_pushed` broadcast nudges the header to
 * refetch the instant the push lands.
 */
export async function autoPushSessionBranches(session: UnifiedSession): Promise<void> {
	// Repo-less sessions (scratch, repo-less ask) have no primary branch to
	// push, and their worktreeDir is a plain dir repoForPath would throw on.
	// Attached repos still push: those carry their own repo and branch.
	const primaryRepoId = sessionRepoId(session);
	const targets: Array<{ dir: string; branch: string; repoId: string }> = [];
	if (session.worktreeDir && session.branch && primaryRepoId)
		targets.push({
			dir: session.worktreeDir,
			branch: session.branch,
			repoId: primaryRepoId,
		});
	for (const att of session.attachedRepos || [])
		if (att.dir && att.branch)
			targets.push({ dir: att.dir, branch: att.branch, repoId: att.repo });

	for (const { dir, branch, repoId } of targets) {
		// The primary dir of a volume-mode sandbox workspace exists only in the
		// container — status/push route through the session's sandbox exec.
		const isPrimary = dir === session.worktreeDir;
		const remote = isPrimary && hasRemoteWorkspace(session);
		if (!existsSync(dir) && !remote) continue;
		let repo;
		try {
			repo = getRepo(repoId);
		} catch {
			continue;
		}
		// Never auto-push the repo's mainline (covers the opensession shared master).
		if (branch === repo.defaultBranch) continue;
		const exec = isPrimary ? await workspaceExecFor(session, dir) : undefined;
		let git;
		try {
			git = await getGitStatus(dir, repo.defaultBranch, exec);
		} catch {
			continue;
		}
		if (!git.hasUpstream || git.ahead <= 0 || git.behind > 0) continue;
		const result = await gitPush(dir, branch, exec);
		if ("error" in result) {
			console.warn(
				`[auto-push] ${session.id} ${repoId}/${branch}: ${result.error}`,
			);
		} else {
			console.log(
				`[auto-push] ${session.id} ${repoId}/${branch}: pushed ${git.ahead} commit(s)`,
			);
			broadcastToSession(session.id, {
				type: "git_pushed",
				sessionId: session.id,
				repo: repoId,
			});
		}
	}
}


/**
 * Sandbox routing for runSessionPromptInner (docs/self-hosting-sandboxes.md;
 * generalized to every registry provider — docker/daytona/e2b). Returns the
 * run's event stream when the session opted into a sandbox at create time.
 * Null means only that the session did not select a runnable sandbox. Once a
 * session records a provider, every unavailable/config/launch failure is
 * surfaced by the caller and the prompt is not run on the host. Changing the
 * execution, trust or billing boundary always requires a person's choice.
 * Automation-owned sessions are refused outright — sandboxes carry
 * interactive-parity credentials (~/.ssh, gh, account pool / scoped OAuth
 * upload) that untrusted prompt text must not reach.
 */
export async function maybeLaunchSandboxedRun(
	session: UnifiedSession,
	opts: {
		prompt: string;
		/** Transcript id of the already-written user line (host-engine runs
		 *  upsert instead of duplicating it; mirrors the host runAgent call). */
		promptEntryId?: string;
		seedTranscriptEntries?: TranscriptEntry[];
		engineSessionId?: string;
		cwd: string;
		user?: string;
		images?: ImageInput[];
		mcpServers?: McpScope;
		isAutomationSession: boolean;
		startToken?: string;
	},
): Promise<(
	AsyncGenerator<StreamEvent> & {
		freshEngine?: boolean;
		sandboxProvider?: string;
		sandboxId?: string;
		sandboxReadyMs?: number;
	}
) | null> {
	const sbProvider = session.sandbox?.provider;
	if (!isRunnableSandboxProvider(sbProvider)) return null; // "local"/absent/unknown = host
	const cancelledRun = (sandbox?: { id: string }) =>
		Object.assign((async function* (): AsyncGenerator<StreamEvent> {})(), {
			sandboxProvider: sbProvider,
			sandboxId: sandbox?.id,
			sandboxReadyMs: Date.now() - sandboxStartedAt,
		});
	if (!sandboxesEnabled()) {
		throw new Error("Sandbox execution is disabled by the operator kill switch");
	}
	if (!sandboxProviderConfigured(sbProvider)) {
		throw new Error(`Sandbox provider "${sbProvider}" is not configured and Ready`);
	}
	if (opts.isAutomationSession) {
		throw new Error("Interactive sandbox connections are unavailable to automation sessions");
	}
	// Hoisted so the catch below can unregister it — a failed launch must not
	// leak the run token (spawnHostRun's error path does the same cleanup).
	let rpcToken: string | undefined;
	const sandboxStartedAt = Date.now();
	try {
		if (isAgentSessionCancelled(session.id, opts.startToken)) return cancelledRun();
		if (session.source === "opensession" && session.sandbox) {
			touchNativeSession(session.id, {
				sandbox: {
					...session.sandbox,
					lifecycle: session.sandbox.sandboxId ? "waking" : "preparing",
					lastLifecycleError: undefined,
				},
			});
		}
		const provider = getSandboxProvider(sbProvider);
		const sandbox = await ensureSandboxWithTransientRetry(provider, {
			sessionId: session.id,
			repo: session.repo,
			branch: session.branch || undefined,
			mode: session.mode,
			cwd: opts.cwd,
			// Bind-mode containers mount attached repos too (a changed set
			// recreates the container); volume mode rejects them in ensure().
			attachedDirs: (session.attachedRepos || [])
				.map((r) => r.dir)
				.filter(Boolean),
		}, {
			onRetry(error) {
				console.warn(
					`[sandbox:${sbProvider}] transient ensure failure for ${session.id}; retrying once:`,
					error instanceof Error ? error.message : String(error),
				);
				audit({
					kind: "sandbox_start_retry",
					session_id: session.id,
					provider: sbProvider,
				});
			},
		});
		if (isAgentSessionCancelled(session.id, opts.startToken)) return cancelledRun(sandbox);
		// Remote engine databases live inside the sandbox. A replacement VM cannot
		// resume the old engine id, even when its git workspace was safely pushed.
		const remoteSandboxReplaced =
			isRemoteSandboxProvider(sbProvider) &&
			session.sandbox?.sandboxId !== sandbox.id;
		const legacyEngine = (session.sandbox as { engine?: unknown } | undefined)?.engine;
		if (
			session.source === "opensession" &&
			(session.sandbox?.sandboxId !== sandbox.id ||
				session.sandbox?.workspace !== sandbox.workspace ||
				legacyEngine !== undefined)
		) {
			touchNativeSession(session.id, {
				sandbox: {
					provider: sbProvider,
					sandboxId: sandbox.id,
					// Record how the workspace materialized ("volume" = it lives only
					// inside the sandbox; host existsSync guards must not gate it).
					workspace: sandbox.workspace,
					lifecycle: "awake",
					lastLifecycleError: undefined,
				},
				...(remoteSandboxReplaced
					? {
							claudeSessionId: undefined,
							codexThreadId: undefined,
							opencodeSessionId: undefined,
						}
					: {}),
			});
		}
		if (session.source === "opensession" && session.sandbox) {
			// Keep lifecycle state current even when this is a re-use of the same
			// materialized Sandbox and no engine/session fields changed above.
			touchNativeSession(session.id, {
				sandbox: {
					...session.sandbox,
					provider: sbProvider,
					sandboxId: sandbox.id,
					workspace: sandbox.workspace,
					lifecycle: "awake",
					lastLifecycleError: undefined,
				},
			});
		}
		// opensession-* tools reach the container as stdio proxies over the run-rpc
		// socket — same path Codex and hosted runs use. The names must match
		// what the registered InteractiveMcpBuilder can build for this session —
		// including opensession-goal-self for goal-driven sessions (the builder adds
		// it from the session's goalId, mirroring the in-process path below).
		const proxyMcpServers = [
			...Object.keys(
				interactiveMcpServers(
					opts.user,
					session.id,
					opts.mcpServers ?? "all",
				),
			),
			...(session.goalId ? ["opensession-goal-self"] : []),
		];
		rpcToken = crypto.randomUUID();
		registerRunToken(rpcToken, { sessionId: session.id, user: opts.user });
		const spec: RunHostSpec = {
			hostId: `rh-${randomUUIDv7()}`,
			osSessionId: session.id,
			prompt: opts.prompt,
			promptEntryId: opts.promptEntryId,
			seedTranscriptEntries: opts.seedTranscriptEntries,
			engineSessionId: remoteSandboxReplaced
				? undefined
				: opts.engineSessionId || undefined,
			cwd: sandbox.cwd,
			mode: session.mode,
			model: session.model,
			images: opts.images,
			mcpServers: opts.mcpServers ?? "all",
			proxyMcpServers,
			rpcToken,
			reposNote: await buildSessionNote(session, opts.user),
			confirmTools: STRIPE_CONFIRM_TOOLS,
			aws: true,
			author: commitAuthorFor(opts.user, session.startedBy),
			user: opts.user,
			mcpGrantUser: session.startedBy || undefined,
			fallbackModel: interactiveFallbackModel(session.model),
			effort: session.effort,
			fastMode: session.fastMode,
			accountId: session.accountId,
			journalKind: "prompt",
		};
		if (isAgentSessionCancelled(session.id, opts.startToken)) {
			unregisterRunToken(rpcToken);
			return cancelledRun(sandbox);
		}
		const runCallbacks = {
			onAskUser: makeAskHandler(session.id),
			// A steer that reached the in-container run too late must not
			// evaporate — queue it like the busy-path does.
			onSteerFailed: (text: string) => {
				enqueuePrompt(session.id, { content: text, user: opts.user });
				watchExternalRunAndDrain(session.id);
			},
		};
		// Launch eagerly (docker exec + socket connect awaited here) so failure is
		// visible before the stream begins and the prompt is never rerouted.
		const handle = sandbox.launchRunEager
			? await sandbox.launchRunEager(spec, runCallbacks)
			: sandbox.launchRun(spec, runCallbacks);
		if (isAgentSessionCancelled(session.id, opts.startToken)) {
			handle.cancel();
			unregisterRunToken(rpcToken);
			return cancelledRun(sandbox);
		}
		console.log(`[sandbox] ${session.id}: running in ${sandbox.id} (${sandbox.cwd})`);
		return Object.assign(handle.events(), {
			freshEngine: remoteSandboxReplaced || undefined,
			sandboxProvider: sbProvider,
			sandboxId: sandbox.id,
			sandboxReadyMs: Date.now() - sandboxStartedAt,
		});
	} catch (e: any) {
		// The token was registered mid-try; the failed run will never consume it.
		unregisterRunToken(rpcToken);
		const reason = String(e?.message || e).slice(0, 200);
		if (session.source === "opensession" && session.sandbox) {
			touchNativeSession(session.id, {
				sandbox: { ...session.sandbox, lifecycle: "needs_attention", lastLifecycleError: reason },
			});
		}
		audit({
			kind: "sandbox_turn_metric",
			session_id: session.id,
			environment: "sandbox",
			provider: sbProvider,
			outcome: "launch_failed",
			sandbox_ready_ms: Date.now() - sandboxStartedAt,
			error: reason,
		});
		// Daytona's WS dial-back is the launch step that fails when egress is
		// blocked (lower org tiers) or callbackBaseUrl isn't sandbox-reachable.
		const dialBackHint =
			sbProvider === "daytona"
				? " If the sandbox could not dial back, check callbackBaseUrl and your Daytona org tier's egress — see docs/self-hosting-sandboxes.md."
				: "";
		console.error(`[sandbox] ${session.id}: launch failed — prompt not run:`, e);
		broadcastToSession(session.id, {
			type: "notice",
			message: `Sandbox unavailable (${reason}) — the prompt was not run. Retry when ${sbProvider} is healthy or explicitly choose another environment for a new session.${dialBackHint}`,
		});
		throw new Error(`Sandbox unavailable: ${reason}`);
	}
}


/**
 * Announce-then-stop guard: the instruction-layer fix (28731464) still lets
 * an occasional turn end cleanly on a plan sentence ("Now let me read the
 * exact code…") — including after substantial tool use. The session then sits
 * idle until the human types "continue" (seen 2026-07-10 bks-019f4b70,
 * 2026-07-12 bks-019f533e, and repeatedly after 5-8 tool calls in 2026-07-29
 * bks-019fad64). Queue ONE auto-continue per human prompt when a clean
 * interactive turn ends on an announced next action; the drain delivers it as
 * the next turn. Never for automation sessions or over a user Stop.
 *
 * Queue-hold: queued messages are a promise to deliver at FULL completion,
 * so when the turn ends still announcing work while something is queued,
 * the nudge fires ahead of the queue (front + solo drain) — regardless of
 * tool use — and the user's messages stay parked until a turn ends without
 * announcing more. When messages are waiting, turns doing real work reset
 * the nudge budget so a genuinely working agent holds the queue as long as it
 * needs; without a queue, the budget remains one nudge per human prompt so a
 * model cannot loop indefinitely by using one tool before each announcement.
 *
 * Shared with the session-creation path: a session's OPENING turn runs its own
 * event loop (session-control-wiring.ts, run kind "create") and bypasses
 * runSessionPromptInner entirely, so a first turn that announced and stopped
 * just parked — the guard only existed on follow-up turns (2026-08-03
 * bks-019fc695 ended turn 1 on "…Let me examine that commit." and sat idle).
 * Callers own delivery: the prompt path drains via runSessionPromptAndDrain,
 * the create path arms watchExternalRunAndDrain when this returns true.
 */
export function maybeQueueAutoContinue(opts: {
	sessionId: string;
	assistantText: string;
	toolUseCount: number;
	endedWithError: boolean;
	runFailure: string | null;
	/** Skip the lookup when the caller already holds the session. */
	session?: UnifiedSession | null;
}): boolean {
	const { sessionId, assistantText, toolUseCount, endedWithError, runFailure } = opts;
	// When a turn that plainly announced a next step is NOT nudged, record why:
	// 2026-08-03 bks-019fc75f ended on "Now let me correlate…" with no nudge and
	// no trace of which condition vetoed it, which made the miss undebuggable.
	const suppressed = (reason: string): false => {
		if (announcesNextAction(assistantText))
			audit({
				msg: "auto_continue_suppressed",
				session_id: sessionId,
				reason,
				tail: assistantText.trim().slice(-200),
			});
		return false;
	};
	const session = opts.session ?? findSession(sessionId);
	if (!session) return suppressed("session_not_found");
	const queuedBehind = (promptQueues.get(sessionId) || []).filter(
		(m) => m.user !== AUTO_CONTINUE_USER,
	).length;
	if (queuedBehind > 0 && toolUseCount > 0) autoContinueNudged.delete(sessionId);
	// A turn whose TAIL is a fabricated tool transcript (the model narrated a
	// tool call as text and stopped — bks-019fad97, 2026-07-29) is the same
	// stall in a worse costume: it believes work is in flight that was never
	// started. Tail-only so a mid-turn fabrication the runner already steered
	// past doesn't re-trigger at the end of an otherwise clean turn.
	const endedOnFabricatedTranscript = looksLikeFabricatedToolTranscript(
		assistantText.slice(-2000),
	);
	if (endedWithError) {
		// A failed/aborted turn can strand user messages the model never read: a
		// busy-send steer is a noReply history append the running turn only reads
		// at its NEXT LLM step, so when the turn dies first the message sits in
		// the engine history unprocessed — and its receipt already reconciled
		// away as "delivered" the moment it landed (2026-08-03 bks-019fc798:
		// "continue" steered into a wedged oracle turn was silently swallowed).
		// Trailing user entries with no assistant/tool reply are the durable
		// signal; fire ONE redelivery turn per distinct tail so the messages get
		// read — never over a user Stop, never for automations, and a repeat
		// failure on the same tail doesn't loop.
		if (
			session.source === "opensession" &&
			!session.automation &&
			!stoppedSessions.has(sessionId)
		) {
			const trailing = trailingUserTexts(session).filter(
				(t) =>
					!t.includes("<opensession:context>") &&
					!t.startsWith(`[${AUTO_CONTINUE_USER}]`),
			);
			const tailKey = trailing.join("\n").trim().slice(-500);
			if (tailKey && orphanRedeliveredTails.get(sessionId) !== tailKey) {
				orphanRedeliveredTails.set(sessionId, tailKey);
				audit({
					msg: "orphaned_steer_redelivery",
					session_id: sessionId,
					trailing_count: trailing.length,
					tail: tailKey.slice(-200),
				});
				broadcastToSession(sessionId, {
					type: "notice",
					message:
						"The interrupted turn never read the latest message(s) — auto-continuing so they're addressed.",
				});
				enqueuePrompt(
					sessionId,
					{
						content: wrapContext(ORPHANED_STEER_PROMPT, "auto-continue"),
						user: AUTO_CONTINUE_USER,
					},
					{ front: true },
				);
				return true;
			}
			// A mid-turn engine wedge is the runner's failure, not the user's or
			// the model's — the engine state is preserved and a fresh turn
			// usually just works (the wedge is per-request). Auto-retry ONCE per
			// distinct failure text: wedge → retry; the same wedge again → park
			// with the error for the human. A clean turn clears the key.
			if (isWedgeFailure(runFailure)) {
				const failKey = `wedge:${(runFailure || "").slice(0, 200)}`;
				if (wedgeRetriedFailures.get(sessionId) !== failKey) {
					wedgeRetriedFailures.set(sessionId, failKey);
					audit({
						msg: "wedge_auto_retry",
						session_id: sessionId,
						error: (runFailure || "").slice(0, 300),
					});
					broadcastToSession(sessionId, {
						type: "notice",
						message:
							"Turn was cut short by an engine stall — auto-continuing (state preserved).",
					});
					enqueuePrompt(
						sessionId,
						{
							content: wrapContext(WEDGE_RETRY_PROMPT, "auto-continue"),
							user: AUTO_CONTINUE_USER,
						},
						{ front: true },
					);
					return true;
				}
			}
		}
		return suppressed("ended_with_error");
	}
	// A clean turn responded to everything in history — reset the redelivery
	// and wedge-retry once-guards so future failures are eligible again.
	orphanRedeliveredTails.delete(sessionId);
	wedgeRetriedFailures.delete(sessionId);
	if (runFailure) return suppressed("run_failure");
	if (session.source !== "opensession") return suppressed(`source_${session.source}`);
	if (session.automation) return suppressed("automation_session");
	if (stoppedSessions.has(sessionId)) return suppressed("user_stop");
	if (autoContinueNudged.has(sessionId)) return suppressed("already_nudged");
	if (!(announcesNextAction(assistantText) || endedOnFabricatedTranscript)) return false;
	autoContinueNudged.add(sessionId);
	audit({
		msg: "auto_continue_nudge",
		session_id: sessionId,
		tail: assistantText.trim().slice(-200),
		...(queuedBehind > 0 ? { queued_held: queuedBehind } : {}),
		...(endedOnFabricatedTranscript ? { fabricated_tail: true } : {}),
	});
	broadcastToSession(sessionId, {
		type: "notice",
		message: endedOnFabricatedTranscript
			? "Turn ended on a narrated (never-executed) tool call — auto-continuing with a correction."
			: queuedBehind > 0
				? `Still mid-task — auto-continuing first; ${queuedBehind} queued message${queuedBehind === 1 ? "" : "s"} deliver once the agent fully finishes.`
				: "Turn ended on an announced next step without doing it — auto-continuing.",
	});
	// Fenced so the transcript never shows it as a user bubble: the parsers
	// strip <opensession:context> from user text and skip the then-empty entry,
	// while the engine still sees the full instruction. The notice above (and
	// the audit event) are the human-visible trace.
	enqueuePrompt(
		sessionId,
		{
			content: wrapContext(
				endedOnFabricatedTranscript ? AUTO_CONTINUE_FABRICATED_PROMPT : AUTO_CONTINUE_PROMPT,
				"auto-continue",
			),
			user: AUTO_CONTINUE_USER,
		},
		{ front: true },
	);
	return true;
}

/** Run a prompt against an existing session, broadcasting to all watchers. */
export async function runSessionPrompt(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
	contextSessions?: string[],
	slackReplyTo?: { channel: string; threadTs: string },
	promptEntryId?: string,
): Promise<void> {
	// Any explicit new run lifts a user stop — the queue may drain again.
	stoppedSessions.delete(sessionId);
	// Synchronously reserve the session BEFORE the awaits below (worktree revive,
	// title gen, upload staging) register the run with the runner — otherwise two
	// racing prompts both pass isAgentSessionBusy and the loser's message is
	// dropped as a "Session is busy" error toast.
	const startToken = markSessionStarting(sessionId);
	try {
		await runSessionPromptInner(
			sessionId,
			content,
			user,
			images,
			rawFiles,
			contextSessions,
			slackReplyTo,
			startToken,
			promptEntryId,
		);
		// Sandboxes and non-standard runners may not create an active-run journal.
		// A completed turn is nevertheless a safe acknowledgement of its dispatch.
		acknowledgePromptDispatch(sessionId, promptEntryId);
	} catch (e) {
		// A throw before the run registered (workspace revive, session-note
		// build, …) would strand the FSM in "starting" forever — the wedge the
		// run-state watchdog flags. Settle it; later throws have their own
		// terminal transitions and are left alone.
		if (getRunState(sessionId) === "starting")
			transitionRunState(sessionId, "start_failed", {
				source: "prompt_throw",
				error: String(e),
			});
		// A normal start failure is not a crash-recovery case. Keep the visible
		// transcript line and its error, but do not replay it on a later restart.
		acknowledgePromptDispatch(sessionId, promptEntryId);
		throw e;
	} finally {
		unmarkSessionStarting(sessionId, startToken);
	}
}

async function runSessionPromptInner(
	sessionId: string,
	content: string,
	user?: string,
	images?: ImageInput[],
	rawFiles?: unknown,
	contextSessions?: string[],
	slackReplyTo?: { channel: string; threadTs: string },
	startToken?: string,
	promptEntryId?: string,
): Promise<void> {
	const session = findSession(sessionId);
	if (!session) return;

	// A fresh human prompt re-arms the announce-then-stop guard (the nudge's
	// own delivery keeps the flag, capping it at one consecutive auto-continue).
	if (user !== AUTO_CONTINUE_USER) autoContinueNudged.delete(sessionId);

	// The engine session id depends on the session's model: codex models resume
	// the codex thread, claude models the claude session. A missing engine id
	// just means "first run on this provider" — a fresh thread/session starts.
	// Native picker ids still dispatch through OpenCode. Once a session has run,
	// resume the engine that actually owns its session id rather than inferring a
	// legacy provider from the unchanged user selection.
	// An explicit engine choice on the model id (pi/, claude/, codex/), or the
	// per-model default engine for an interactive session, decides which engine
	// this turn runs on — ahead of the engine that last drove the session. The
	// routing changed, and that IS the cross-engine switch the handoff below
	// exists for; without this the turn would hand the previous engine's
	// session id to the new engine and resume nothing. Unrouted ids (native
	// slugs, opencode/…) keep the historic order exactly.
	const routedEngine = routeModel(session.model, {
		interactive: !session.automation,
	}).engine;
	const provider =
		routedEngine === "opencode"
			? session.lastEngineProvider || providerFor(session.model)
			: routedEngine;
	let effectiveProvider = provider;
	let effectiveModel = session.model;
	// The model this run last wrote (or started on): what an automatic switch
	// must still find stored before it may overwrite the session's model. A
	// human's /model lands in between and wins — see persistAutoModelSwitch.
	let lastPersistedModel = session.model;
	// Cumulative token/cost accounting — seeded from the session's stored total,
	// folded per run, persisted + broadcast live (see the `usage_snapshot` and
	// `done` cases). `usageBase` is the total as of the last *completed* run:
	// snapshots are run-cumulative, so each fold recomputes base+run rather than
	// stacking onto the previous snapshot (which would double-count).
	let latestUsage: SessionUsage | undefined = session.usage;
	let usageBase: SessionUsage | undefined = latestUsage;
	// Which slot holds the id this provider resumes is the inverse of the write
	// rule in engineSessionPatch, so both live together in sessions.ts.
	const engineSessionId = engineSessionIdFor(session, provider);
	// A claude session with no engine id yet is a *fresh* session (e.g. a new sibling
	// session opened from the tab strip's +): its first prompt starts a new claude
	// conversation, and finalSessionId is persisted below — same as codex, which
	// already runs fresh with no thread id. (Previously this hard-errored, which
	// blocked never-run sessions from ever receiving their first message.)
	if (provider === "claude" && !engineSessionId) {
		console.log(`[prompt] ${sessionId}: first claude run (no engine id yet)`);
	}

	// Durable intake (2026-07-24, bks-019f93ea): persist the user's message to
	// the transcript store NOW — before the worktree/title/engine-spawn awaits —
	// so a process death anywhere in the run path can no longer lose it. The
	// uuid threads through to the runner (promptEntryId), whose own transcript
	// write upserts this same row (with any context decoration) instead of
	// duplicating the bubble. Sandbox runs keep their own transcript mirror
	// with its own ids — skip those to avoid a doubled user line.
	const durablePromptEntryId = promptEntryId || crypto.randomUUID();
	if (!session.sandbox && content?.trim()) {
		storeAppendUserLineEarly(
			sessionId,
			transcriptLineUser(content, durablePromptEntryId, undefined, images),
			isOpencodeSessionId(engineSessionId) ? engineSessionId : undefined,
		);
	}

	// Cross-provider handoff: the session's model was switched to the other engine
	// (Fable orchestrator → gpt-5.5 executor, or back) since the last run. The
	// incoming engine has no memory of the conversation — its thread either never
	// existed or is stale — so bridge it with the recent transcript from whichever
	// engine last drove the session. Without this, a mid-session /model switch
	// across providers drops the agent into a blank continuation. (Same-provider
	// switches — opus↔sonnet, gpt-5.5↔codex — resume their own thread and need no
	// bridge.) Recorded provider is set after every run below.
	const lastProvider = session.lastEngineProvider;
	let switchHandoff: string | null = null;
	// Prior-engine entries backing the handoff note — also passed to the runner
	// so a fresh opencode session's persisted transcript is seeded with them
	// (keeps the UI transcript continuous across an engine migration).
	let switchHandoffEntries: TranscriptEntry[] = [];
	// Anthropic and OpenAI models both report provider "opencode", but they run
	// on different servers: a family switch (claude-* ↔ gpt-*) can't resume the
	// engine session and starts fresh, so it needs the same bridge as a classic
	// cross-provider switch. Detected via the model that last actually drove a
	// run (bks-019f57a0 dropped its visible history across exactly this switch,
	// 2026-07-12; sessions from before lastEngineModel existed skip this and
	// still get the runner's prior-transcript file seeding).
	const familySwitch =
		lastProvider === "opencode" &&
		provider === "opencode" &&
		!!session.lastEngineModel &&
		!!session.model &&
		engineFamily(session.lastEngineModel) !== engineFamily(session.model);
	if (lastProvider && (lastProvider !== provider || familySwitch)) {
		// Same slot rule as the run-start arm above, read for the OUTGOING
		// engine, so a pi→anything switch on a slack/linear session still finds
		// the id to build its handoff from.
		const prevEngineId = engineSessionIdFor(session, lastProvider);
		// The pi read serves the owned transcript store, where THIS turn's
		// prompt is already durably persisted (storeAppendUserLineEarly above) —
		// drop it so the handoff describes history *before* the prompt, which
		// follows below the note anyway (engine-handoff-transcript.ts filters
		// the same way). No-op for engine-native reads, which predate the prompt.
		const prevEntries = (
			prevEngineId
				? await readEngineTranscriptAsync(
						session.worktreeDir || defaultRepo().repo,
						prevEngineId,
						lastProvider,
					)
				: []
		).filter((e) => e.id !== durablePromptEntryId);
		if (prevEntries.length) {
			switchHandoffEntries = prevEntries;
			// Claude coming back to a thread it already ran (engineSessionId set)
			// remembers everything up to the switch and only needs the interim
			// turns; a fresh target treats the transcript as the whole conversation.
			switchHandoff = buildEngineSwitchHandoffNote({
				// The model that last drove the session is the second-to-last
				// modelHistory entry (the last is the switch into the current model).
				fromModel:
					session.modelHistory && session.modelHistory.length >= 2
						? session.modelHistory[session.modelHistory.length - 2].model
						: undefined,
				fromProvider: lastProvider,
				toProvider: provider,
				// A family switch never resumes — the target server doesn't have the
				// session, so the incoming model needs the whole transcript.
				targetResuming: familySwitch ? false : !!engineSessionId,
				entries: prevEntries,
			});
			console.log(
				`[prompt] ${sessionId}: cross-${familySwitch ? "family" : "provider"} switch ${lastProvider}→${provider}; bridging ${prevEntries.length} transcript entries`,
			);
		}
	}

	// A cleaned-up worktree makes the SDK spawn fail with a misleading "binary
	// not found" (ENOENT on the missing cwd) — revive it first. Same path as
	// before, so resuming the claude session keeps its history. Volume-mode
	// sandbox workspaces are exempt: their dir never exists host-side — the
	// sandbox provider materializes it in-container, so reviving a host
	// worktree at the same path would shadow (and fork) the real workspace.
	// Ask sessions can be minted without a worktree (sibling "+ → Ask", legacy
	// files): resolve them to the pinned ask checkout, never the mutable main
	// checkout, whose parked branch is a false context clue (ensureAskCheckout —
	// 82a296a6 covered the create paths but missed this prompt-path fallback).
	let cwd =
		session.worktreeDir ||
		(session.mode === "scratch"
			? ensureScratchDir(session.workspaceId || session.id)
			: session.mode === "ask"
				? await ensureAskCheckout(session.repo)
				: defaultRepo().repo);
	if (!repoForPathOrNull(cwd)) {
		// A dir no registered repo owns: a scratch dir, or a repo-less ask
		// session's inert cwd. Nothing to revive — just make sure it exists
		// after cleanups/moves. (Asking the path rather than the mode is what
		// keeps a repo-less ask session out of the revive branch below, whose
		// repoForPath would throw on it.)
		if (!existsSync(cwd) && !hasRemoteWorkspace(session))
			mkdirSync(cwd, { recursive: true });
	} else if (
		session.worktreeDir &&
		!existsSync(session.worktreeDir) &&
		!hasRemoteWorkspace(session)
	) {
		const repo = session.repo
			? getRepo(session.repo)
			: repoForPath(session.worktreeDir);
		if (session.branch) {
			broadcastToSession(sessionId, {
				type: "notice",
				message: `This session's worktree was cleaned up — recreating it from branch ${session.branch}…`,
			});
			try {
				cwd = await reviveWorktree(session.branch, repo.id);
			} catch (e) {
				broadcastToSession(sessionId, {
					type: "notice",
					message: `Couldn't recreate the worktree (${e}); running in the main checkout instead.`,
				});
				cwd = repo.repo;
			}
		} else {
			broadcastToSession(sessionId, {
				type: "notice",
				message:
					"This session's worktree is gone; running in the main checkout.",
			});
			cwd = repo.repo;
		}
	}
	let prompt = content;
	// A teammate sending into someone else's idle session gets the same
	// "[Name] " attribution the steer path already applies — without it the
	// message lands bare in the transcript and the viewer credits it to the
	// session owner (startedBy). The owner's own turns stay bare (the common
	// case), automation runs pass no user, and multi-message queue drains
	// arrive pre-attributed — don't double-prefix those. A prompt that is ONLY
	// injected context (the auto-continue nudge) is nobody's message: attributing
	// it left a bare "[auto-continue] " stub as the whole transcript entry.
	if (
		user &&
		user !== session.startedBy &&
		!isContextOnly(content) &&
		!content.startsWith(`[${user}] `)
	) {
		prompt = `[${user}] ${prompt}`;
	}
	// Bridge a cross-provider engine switch (computed above) so the incoming
	// engine continues the conversation instead of starting blank. Fenced so the
	// transcript shows only the human's message — the model-switch divider already
	// marks the engine change; the handoff itself is plumbing (see prompt-context).
	if (switchHandoff) prompt = `${wrapContext(switchHandoff, "handoff")}\n\n${prompt}`;
	// Bridge a Desk voice call into this text turn: the GPT Realtime turns are
	// mirrored into the visible transcript, but the text engine's own
	// conversation state never saw them — without this note the first text
	// message after a call gets a Desk that's amnesiac about the conversation
	// it apparently just had (see desk-voice.ts).
	if (session.desk) {
		const voiceHandoff = takeVoiceHandoff(sessionId);
		if (voiceHandoff) prompt = `${wrapContext(voiceHandoff, "handoff")}\n\n${prompt}`;
	}
	// Sibling-session transcripts attached from the fresh-session "Add session
	// transcripts" chips: inline a bounded digest of each, fenced so the rendered
	// transcript shows only the human's message. Skip automation sessions because
	// their prompts are untrusted text.
	const inlinedSessionIds = new Set<string>();
	if (!session.automation) {
		const attachedIds = [...new Set(contextSessions ?? [])];
		const attachedSessions = attachedIds
			.filter((id) => id !== sessionId)
			.map((id) => findSession(id))
			.filter((s): s is UnifiedSession => !!s);
		const attachedDigests: {
			id: string;
			title: string | undefined;
			model: string | undefined;
			entries: TranscriptEntry[];
		}[] = [];
		for (const s of attachedSessions) {
			attachedDigests.push({
				id: s.id,
				title: s.title,
				model: s.model,
				// Async: an attached session's transcript can be multi-MB — the
				// sync parse held the event loop for the whole read.
				entries: s.transcriptPath
					? await parseTranscriptAsync(s.transcriptPath)
					: [],
			});
		}
		for (const c of attachedDigests) inlinedSessionIds.add(c.id);
		if (attachedDigests.length)
			prompt = `${wrapContext(buildSessionContextNote(attachedDigests), "attached-session-excerpt")}\n\n${prompt}`;
	}
	// Non-image attachments: stage to disk and tell the agent where they landed.
	prompt = withUploadsNote(prompt, stageFileAttachments(sessionId, rawFiles));
	if (session.goal) {
		prompt += `\n\n[Pinned session goal — keep working toward it and note how this turn advanced it: ${session.goal}]`;
	}

	// Resuming an automation-owned session must keep that automation's scoping
	// (MCP allowlist + tool denials) — otherwise a resume would silently hand it
	// every MCP server and drop the customer/identity write denials. The whole
	// decision lives in session-run-inputs.ts so the effective-config endpoint
	// reads the same answer this turn runs with.
	const runInputs = await resolveSessionRunInputs(session, { user });
	const isAutomationSession = runInputs.isAutomationSession;
	const mcpServers = runInputs.mcpServers;
	const deniedTools = runInputs.deniedTools;

	// @session:<id> mentions → footer resolving them for the agent's
	// opensession-sessions tools. Interactive sessions only (same gate as the tools).
	if (!isAutomationSession) {
		const mentionsNote = sessionMentionsNote(prompt, inlinedSessionIds);
		if (mentionsNote) prompt += `\n\n${mentionsNote}`;
	}

	// First engine turn of a feed-workspace session that was born prompt-less
	// (tab-strip "+" siblings): inject the workspace's external-object context
	// (Tella video metadata + transcript excerpt, scratch-dir note) exactly
	// like the create_session paths do — a session must get this context no
	// matter how it was created (the feeds design).
	if (
		!isAutomationSession &&
		session.externalRefs?.length &&
		!session.claudeSessionId &&
		!session.opencodeSessionId &&
		!session.codexThreadId &&
		!session.piSessionId
	) {
		try {
			const { externalRefsOpeningContext } = await import("./feeds");
			const refsContext = await externalRefsOpeningContext(
				session.externalRefs,
				{
					scratch: session.mode === "scratch",
					user: session.startedBy || user || undefined,
				},
			);
			if (refsContext) prompt += `\n\n${wrapContext(refsContext, "external-refs")}`;
		} catch (e) {
			console.error("[run-session] externalRefs context failed:", e);
		}
	}

	// Sidebar name: make sure this session has a short generated summary title.
	// Covers tab-strip "New session" sessions (never named at creation — this is
	// their first prompt) and retries sessions whose creation-time Haiku call
	// failed (e.g. account exhaustion), which otherwise wear the raw first
	// line of the prompt forever. Retries summarize the stored provisional
	// title (the opening prompt's first line), not this turn's message, so a
	// mid-conversation "yes, do it" never becomes the title source. Automation
	// and goal sessions carry deliberate titles; a manual rename wins anyway.
	if (
		session.source === "opensession" &&
		!isAutomationSession &&
		!session.goalId &&
		!getTitleOverride(session.id)
	) {
		const provisional =
			!session.title || session.title === "New session";
		const firstLine = content.trim().split("\n")[0].slice(0, 80);
		if (provisional && firstLine)
			touchNativeSession(session.id, { title: firstLine });
		void ensureGeneratedTitle(
			session.id,
			provisional ? content : session.title,
			user || session.startedBy || undefined,
			session.model || undefined,
		).then((t) => {
			if (t) invalidateSessionsCache();
		});
	}

	// The last turn's quick-reply chips offered a choice that this prompt just
	// made, whichever way it was made (see reply-suggestions.ts).
	clearReplySuggestions(sessionId);

	// Everyone viewing this session sees the prompt and the live run
	broadcastToSession(sessionId, {
		type: "stream_start",
		sessionId,
		by: user || "Anonymous",
	});
	broadcastToSession(sessionId, {
		type: "session_status",
		sessionId,
		isRunning: true,
	});

	// Sandbox routing (docs/self-hosting-sandboxes.md): a session that opted
	// into a sandbox (docker/daytona/e2b) runs this prompt inside its
	// per-session sandbox; null (the default for every session without the
	// opt-in field) = the unchanged in-process path below. A recorded provider
	// that is unavailable throws before this point; it never falls back.
	const turnMetricStartedAt = Date.now();
	// Pi buffers its native session file until the first assistant message.
	// Detached hosts get a server-read snapshot for the rare resume-miss case;
	// the host must never open transcripts.db itself.
	const piHostSeedEntries =
		routedEngine === "pi" && engineSessionId
			? (
					await readEngineTranscriptAsync(cwd, engineSessionId, "pi")
				).filter((entry) => entry.id !== durablePromptEntryId)
			: undefined;
	const runnerRun = await maybeLaunchRunnerRun(session, {
		prompt,
		engineSessionId: engineSessionId || undefined,
		images,
		mcpServers: mcpServers ?? "all",
		user,
		reposNote: isAutomationSession ? undefined : await buildSessionNote(session, user),
	});
	const sandboxRun = runnerRun ? null : await maybeLaunchSandboxedRun(session, {
		prompt,
		promptEntryId: durablePromptEntryId,
		seedTranscriptEntries: piHostSeedEntries,
		engineSessionId: engineSessionId || undefined,
		cwd,
		user,
		images,
		mcpServers: mcpServers ?? "all",
		isAutomationSession,
		startToken,
	});

	// Defensive guard: a session with an explicit runnable provider must never
	// reach the host path, even if a future launcher regression returns null.
	if (!runnerRun && !sandboxRun && isRunnableSandboxProvider(session.sandbox?.provider)) {
		const msg =
			"This session's workspace lives in its sandbox volume, but the sandbox is unavailable (disabled by config/kill-switch, or it failed to start) — the prompt was not run. Re-enable sandboxes and try again." +
			(session.sandbox?.provider === "daytona"
				? " Daytona: if the launch failed because the sandbox could not dial back, check callbackBaseUrl and your org tier's egress (docs/self-hosting-sandboxes.md)."
				: "");
		broadcastToSession(sessionId, { type: "error", sessionId, message: msg });
		recordRunOutcome(session.id, msg);
		broadcastToSession(sessionId, { type: "stream_done", sessionId });
		broadcastToSession(sessionId, {
			type: "session_status",
			sessionId,
			isRunning: false,
		});
		return;
	}

	// Local detached run host for the pi engine: pi drives its turn in-process
	// via the SDK, so unlike opencode there is no detachable engine server to
	// outlive a restart. Instead the whole turn moves into a transient
	// run-host unit (host-client.ts) that survives `systemctl restart` and is
	// reattached by the boot sweep (resumeLocalHostRun). Transcript writes are
	// proxied back over the host protocol, so the server stays the store's
	// only writer. Kill switch: OPENSESSION_PI_DETACH=0 (the generic
	// disable-run-hosts file and runAgentHosted's in-process fallback also
	// apply). Automation-owned sessions ride it too, with the automation's
	// scoping intact: proxy names come from the same fail-closed automation
	// set the run-rpc fallback builder serves, the repos note and MCP grant
	// identity are withheld, and the automation's prReviewer rides the spec.
	const hostedRun =
		!runnerRun &&
		!sandboxRun &&
		routedEngine === "pi" &&
		process.env.OPENSESSION_PI_DETACH !== "0"
			? runAgentHosted({
					osSessionId: session.id,
					prompt,
					promptEntryId: durablePromptEntryId,
					seedTranscriptEntries: piHostSeedEntries,
					sessionId: engineSessionId || undefined,
					cwd,
					mode: session.mode,
					// Automation runs pass no MCP grant identity: a human's OAuth
					// grants must not ride an automation-owned session's turns.
					mcpGrantUser: isAutomationSession
						? undefined
						: session.startedBy || undefined,
					model: session.model,
					images,
					mcpServers: mcpServers ?? "all",
					proxyMcpServers: isAutomationSession
						? Object.keys(automationSessionMcp(session, sessionId))
						: [
								...Object.keys(
									interactiveMcpServers(user, sessionId, mcpServers ?? "all"),
								),
								...(session.goalId ? ["opensession-goal-self"] : []),
							],
					reposNote: isAutomationSession
						? undefined
						: await buildSessionNote(session, user),
					deniedTools,
					confirmTools: STRIPE_CONFIRM_TOOLS,
					aws: true,
					author: commitAuthorFor(user, session.startedBy),
					user: runInputs.user,
					fallbackModel: interactiveFallbackModel(session.model),
					effort: session.effort,
					fastMode: session.fastMode,
					accountId: session.accountId,
					// A human steering an automation-owned session still opens PRs
					// under that automation's policy (parity with the in-process
					// call below).
					prReviewer:
						isAutomationSession && session.automationId
							? getAutomation(session.automationId)?.prReviewer
							: undefined,
					trustProfile: isAutomationSession ? "automation" : "interactive",
					journalKind: "prompt",
					onAskUser: makeAskHandler(sessionId),
					onSteerFailed: (text) => {
						enqueuePrompt(session.id, { content: text, user });
						watchExternalRunAndDrain(session.id);
					},
					fallbackInProcessMcp: () =>
						isAutomationSession
							? automationSessionMcp(session, sessionId)
							: session.goalId
								? {
										...interactiveMcpServers(user, sessionId, mcpServers ?? "all"),
										"opensession-goal-self": createGoalSelfMcpServer(session.goalId),
									}
								: interactiveMcpServers(user, sessionId, mcpServers ?? "all"),
				})
			: null;

	let finalSessionId = sandboxRun?.freshEngine ? "" : engineSessionId || "";
	let endedWithError = false;
	// Terminal failure this run died on (usage limits with no account left,
	// credit/API errors) — recorded on the session after the loop so the sidebar
	// surfaces it as "Needs input"; null (a clean finish) clears an earlier one.
	let runFailure: string | null = null;
	// How recordRunOutcome should word the failure's transcript chip, and
	// whether the runner already wrote a friendlier one itself (timeouts).
	let failureNoticeLabel: string | undefined;
	let failureNoticePersisted = false;
	// Accumulate the assistant reply so we can mirror it back to a Slack thread
	// the session posted to (slackReplyTo — e.g. a reply under an automation's
	// summary message lands here via deliverToSession).
	let assistantText = "";
	let firstEventMs: number | undefined;
	let firstTokenMs: number | undefined;
	// Tool calls seen this run — used to replenish the continuation budget only
	// while human messages are queued behind ongoing work.
	let toolUseCount = 0;

	for await (const event of runnerRun ?? sandboxRun ?? hostedRun ?? runAgent({
		prompt,
		promptEntryId: durablePromptEntryId,
		sessionId: engineSessionId || undefined,
		cwd,
		mode: session.mode,
		model: session.model,
		// Reasoning effort from the composer pill, persisted on the session.
		effort: session.effort,
		fastMode: session.fastMode,
		// Pinned subscription for this session (claude-runner prefers it, pool
		// fallback on exhaustion). Ignored by Codex models.
		accountId: session.accountId,
		// Only switch models when a fallback is explicitly configured. By default,
		// usage exhaustion stops the run so the human can choose what to do.
		fallbackModel: interactiveFallbackModel(session.model),
		images,
		// Engine switch: seed the fresh opencode session's persisted transcript
		// with the prior history (same entries the handoff note was built from)
		// so the UI transcript stays continuous. Everything dispatches onto the
		// opencode engine, so no provider gate — the picker id's provider can be
		// "codex"/"claude" (bare gpt-5.6-sol) while the run still lands on
		// opencode; the old `provider === "opencode"` guard silently dropped the
		// seed for exactly those switches.
		seedTranscriptEntries:
			switchHandoff && switchHandoffEntries.length
				? switchHandoffEntries
				: undefined,
		mcpServers: mcpServers ?? "all",
		// Self-management tools for normal sessions; withheld from automation
		// sessions (and their interactive resumes) — same gate as deniedTools above.
		// Exception: a selfImprove automation's sessions keep their scoped pair
		// (spawn_task suite + own-prompt update) so a Slack thread reply reaches
		// a session with the same tools its nightly run had.
		// A goal-driven session also gets its own opensession-goal-self controls, so an
		// interactive turn (a human steering it in the UI) can set the next wake,
		// append to the ledger, or pause/finish — the same tools the headless wake has.
		inProcessMcp: isAutomationSession
			? selfImproveMcpForSession(session, sessionId)
			: session.goalId
				? {
						...interactiveMcpServers(user, sessionId, mcpServers ?? "all"),
						"opensession-goal-self": createGoalSelfMcpServer(session.goalId),
					}
				: interactiveMcpServers(user, sessionId, mcpServers ?? "all"),
		reposNote: isAutomationSession
			? undefined
			: await buildSessionNote(session, user),
		// A human steering an automation-owned session still opens PRs under
		// that automation's policy — keep its reviewer so a resumed turn's PR
		// surfaces the same way the unattended run's would have.
		prReviewer: isAutomationSession && session.automationId
			? getAutomation(session.automationId)?.prReviewer
			: undefined,
		deniedTools,
		confirmTools: STRIPE_CONFIRM_TOOLS,
		aws: true, // sessions keep AWS read access (via injected creds)
		// Attribute any commits this turn makes to whoever sent the prompt, or
		// to whoever the session belongs to when nobody did (an auto-continue,
		// a restart resume, a queue drain).
		author: commitAuthorFor(user, session.startedBy),
		// Gate per-user MCP servers (allowedUsers) to the prompt's author. Automation
		// sessions pass no user, so they never see a user-restricted server.
		user: runInputs.user,
		journal: { osSessionId: session.id, kind: "prompt" },
		startToken,
		onAskUser: makeAskHandler(sessionId),
	})) {
		firstEventMs ??= Date.now() - turnMetricStartedAt;
		switch (event.type) {
			case "init":
				if (event.provider) effectiveProvider = event.provider;
				if (event.model) effectiveModel = event.model;
				if (event.sessionId && event.sessionId !== finalSessionId) {
					finalSessionId = event.sessionId;
					// The engine session id just changed (first run of a fresh session, or
					// a rotation fork): the run writes to a transcript file nobody is
					// watching yet. Persist + attach NOW — waiting for the run to end
					// (the old behavior) left the entire turn invisible to viewers.
					if (session.source === "opensession") {
						touchNativeSession(session.id, {
							...engineSessionPatch(effectiveProvider, finalSessionId),
							lastEngineProvider: effectiveProvider,
							...(effectiveModel
								? {
										lastEngineModel: effectiveModel,
									}
								: {}),
						});
						invalidateSessionsCache(); // new watchers must see the new transcriptPath
					} else if (
						// Slack/linear-source sessions need the same persistence, into
						// the owning agent's store — otherwise a fallback/rotation-minted
						// id lives only in the run journal, the session file keeps
						// pointing at the dead engine session (frozen transcript), and
						// queued prompts fork the stale thread (slack-can-you-try,
						// 2026-07-16). Pi ids take their own patch slot: shape-ambiguous
						// in the claude slot, the next turn's run-start arm couldn't
						// tell them from a claude id and minted a fresh pi session.
						syncAgentSessionEngine(
							session,
							effectiveProvider === "pi"
								? { piSessionId: finalSessionId }
								: { engineSessionId: finalSessionId },
						)
					) {
						invalidateSessionsCache();
					}
					attachSessionWatchersToEngineTranscript(
						sessionId,
						effectiveProvider,
						cwd,
						finalSessionId,
					);
				}
				break;
			case "text_chunk":
				firstTokenMs ??= Date.now() - turnMetricStartedAt;
				assistantText += event.text;
				broadcastToSession(sessionId, {
					type: "stream_text",
					sessionId,
					text: event.text,
					// Which assistant block this belongs to, when the engine names
					// them: a viewer cancels the live copy by id the moment the
					// durable entry lands (see LiveTextBuffer).
					...(event.blockId ? { blockId: event.blockId } : {}),
				});
				break;
			case "model_switch": {
				// Every fallback changes the model driving this turn. Only a usage
				// fallback changes the user's selection; transient infra recovery is
				// intentionally scoped to this turn.
				const to = event.toModel || "";
				const reason = `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`;
				if (to) {
					effectiveModel = to;
					effectiveProvider = providerFor(to);
				}
				const persistSwitch = to && shouldPersistModelSwitch(event);
				if (to && !persistSwitch) {
					broadcastToSession(sessionId, {
						type: "notice",
						message: `${modelLabel(event.fromModel)} ${event.switchReason || "fell back"} — using ${modelLabel(to)} for this turn only.`,
					});
				}
				if (persistSwitch && session.source === "opensession") {
					void persistAutoModelSwitch({
						sessionId: session.id,
						expectedModel: lastPersistedModel,
						model: to,
						entry: {
							model: to,
							from: event.fromModel,
							at: new Date().toISOString(),
							by: reason,
						},
					}).then(() => invalidateSessionsCache());
					// Track it either way: a walk that hops twice must expect what
					// IT last wrote, and if the first write was refused (a human
					// chose meanwhile) every later hop is refused too, which is
					// exactly right — their choice stands.
					lastPersistedModel = to;
				} else if (
					persistSwitch &&
					syncAgentSessionEngine(session, { model: to })
				) {
					// Keep the slack/linear store's model in step so the next turn
					// (from the loop or the UI) resumes on the fallback, not the
					// exhausted model. The new engine id follows via the init event.
					invalidateSessionsCache();
				}
				if (persistSwitch)
					broadcastToSession(sessionId, {
						type: "model_changed",
						sessionId,
						model: to,
						from: event.fromModel,
						by: reason,
					});
				break;
			}
			case "tool_use":
				toolUseCount++;
				broadcastToSession(sessionId, {
					type: "stream_tool_use",
					sessionId,
					entry: {
						id: event.toolUseId || crypto.randomUUID(),
						type: "tool_use",
						content: `Using ${event.toolName}`,
						timestamp: new Date().toISOString(),
						toolName: event.toolName,
						toolInput: event.toolInput,
						toolUseId: event.toolUseId,
					},
				});
				break;
			case "tool_result":
				broadcastToSession(sessionId, {
					type: "stream_tool_result",
					sessionId,
					entry: {
						// Same id scheme as the jsonl tail so the full (untruncated)
						// transcript entry upserts over this streamed copy
						id: event.toolUseId ? `tr-${event.toolUseId}` : crypto.randomUUID(),
						type: "tool_result",
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
					},
				});
				break;
			case "usage_snapshot":
				// Live mid-run cost/context — same fold as `done`, recomputed from
				// the pre-run base (snapshots are cumulative for the run). Broadcast
				// only; persistence waits for the end of the run.
				if (event.usage) {
					latestUsage = foldSessionUsage(
						usageBase,
						event.usage,
						effectiveModel,
					);
					broadcastToSession(sessionId, {
						type: "usage_update",
						sessionId,
						usage: latestUsage,
					});
				}
				break;
			case "done":
				finalSessionId = event.sessionId || finalSessionId;
				if (event.provider) effectiveProvider = event.provider;
				if (event.model) effectiveModel = event.model;
				// Dying on usage limits with no account left reports as a `done`
				// whose result is the limit notice (not an `error` event) — but it
				// still needs a human, so treat it as a failure.
				if (event.usageLimitExhausted) {
					runFailure = event.result || "Usage limit reached on every account";
					// This one was a clean `done`, not an error — recordRunOutcome
					// writes the transcript chip below, worded as a stop.
					failureNoticeLabel = "Run stopped";
				}
				// Fold this run's token/cost into the session total and push it live
				// to viewers (persisted below with the rest of the session patch).
				if (event.usage) {
					latestUsage = foldSessionUsage(
						usageBase,
						event.usage,
						event.model || effectiveModel,
					);
					usageBase = latestUsage;
					broadcastToSession(sessionId, {
						type: "usage_update",
						sessionId,
						usage: latestUsage,
					});
				}
				// A cache miss is the one cost event worth keeping: it re-sent the
				// whole conversation, at roughly twenty times a cached turn. It used
				// to be a toast, which the person who paid for it usually never saw
				// (the turn often finishes with nobody watching), so it lands in the
				// transcript instead, on the turn it happened to, where the token
				// count still means something a week later.
				if (event.cacheMissWarning) {
					const ocId = finalSessionId || session.claudeSessionId;
					if (ocId) {
						try {
							appendOpencodeTranscript(ocId, [
								transcriptLineRunnerNotice(
									cacheMissNotice(event.usage?.cacheCreationTokens),
								),
							]);
						} catch {}
					}
				}
				invalidateSessionsCache();
				break;
			case "error":
				// "Session is busy" = we lost the start race to a concurrent run (the
				// pendingStarts guard closes most of that window; the runner's own
				// check is the last line). Queue the message for delivery after the
				// winning run instead of dropping it as an error toast. Return early:
				// the tail below (steer-receipt clearing, stream_done) belongs to the
				// run that actually owns the session.
				if (event.content === "Session is busy") {
					enqueuePrompt(sessionId, { content, user });
					watchExternalRunAndDrain(sessionId);
					broadcastToSession(sessionId, {
						type: "notice",
						message:
							"Session was busy — message queued; it sends when the current run finishes.",
					});
					return;
				}
				endedWithError = true;
				runFailure = event.content || "Run failed";
				// The transcript chip is written by recordRunOutcome below — this is
				// the choke point AFTER agent-runner's rotation/fallback walk, so only
				// the final, user-facing error lands (one line per dead run). Skipped
				// when the runner already wrote a friendlier line (timeout).
				if (event.noticePersisted) failureNoticePersisted = true;
				broadcastToSession(sessionId, {
					type: "error",
					sessionId,
					message: event.content,
				});
				break;
		}
	}

	audit({
		kind: "session_turn_metric",
		session_id: session.id,
		environment: sandboxRun ? "sandbox" : "worktree",
		provider: sandboxRun?.sandboxProvider || "host",
		sandbox_id: sandboxRun?.sandboxId,
		sandbox_ready_ms: sandboxRun?.sandboxReadyMs,
		start_to_first_event_ms: firstEventMs,
		start_to_first_token_ms: firstTokenMs,
		duration_ms: Date.now() - turnMetricStartedAt,
		outcome: endedWithError || runFailure ? "failed" : "ok",
	});

	// Persist activity on our own session store. Slack/linear stores stay the
	// owning agent's property, with one surgical exception: engine-id/model
	// flips sync through agent-session-sync so the file never points at a dead
	// engine session (see that module's doc).
	if (session.source === "opensession") {
		// The agent may have switched branches in its worktree during the turn
		// (e.g. renaming an auto-generated branch before opening a PR). Keep the
		// record on the actual HEAD so PR lookups, the PR tab, and the review
		// handoff keep resolving this session. Shared checkouts (a repo's main
		// or ask checkout) are exempt: no session owns their HEAD, so syncing
		// would stamp whatever branch another flow left parked there onto this
		// session (bks-019f97ec, 2026-07-25).
		const headBranch =
			session.branch && !isSharedCheckoutDir(session.worktreeDir)
				? worktreeHeadBranch(session.worktreeDir)
				: null;
		touchNativeSession(
			session.id,
			{
				...engineSessionPatch(effectiveProvider, finalSessionId),
				lastEngineProvider: effectiveProvider,
				...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
				...(latestUsage ? { usage: latestUsage } : {}),
				...(headBranch && headBranch !== session.branch
					? { branch: headBranch }
					: {}),
			},
		);
	} else if (finalSessionId) {
		syncAgentSessionEngine(
			session,
			effectiveProvider === "pi"
				? { piSessionId: finalSessionId }
				: { engineSessionId: finalSessionId },
		);
	}

	// A terminal failure keeps the session in the "Needs input" bucket until a
	// later run finishes cleanly (which clears it here too), and lands in the
	// transcript as a system chip. finalSessionId wins over the session file's
	// id: a run that rotated to a fresh engine session mid-turn must write the
	// chip into the transcript the conversation actually continues in.
	recordRunOutcome(session.id, runFailure, {
		engineSessionId: finalSessionId || session.claudeSessionId || undefined,
		noticePersisted: failureNoticePersisted,
		noticeLabel: failureNoticeLabel,
	});

	// On a clean finish any steered messages already landed in the transcript, so
	// drop their display-only receipts. But if the run ended in error/abort (e.g.
	// a restart killed the SDK stream mid-turn), a steered message may NOT have
	// been delivered yet — keep the receipt so persistQueues/restorePromptQueues
	// can re-deliver it on the next boot instead of silently dropping it.
	if (!endedWithError) clearSteerReceipts(sessionId);

	broadcastToSession(sessionId, { type: "stream_done", sessionId });
	broadcastToSession(sessionId, {
		type: "session_status",
		sessionId,
		isRunning: false,
	});

	// Mirror the agent's reply back to Slack: a turn that came from a Slack thread
	// (a reply under a message this session posted — see slackReplyTo plumbing)
	// answers in that thread.
	if (!endedWithError && assistantText.trim() && slackReplyTo) {
		void sendSlackMessage(
			slackReplyTo.channel,
			assistantText.trim().slice(0, 38000),
			slackReplyTo.threadTs,
		).catch(() => {});
	}

	// Announce-then-stop guard (shared with the create path — see
	// maybeQueueAutoContinue). runSessionPromptAndDrain delivers what it queues.
	maybeQueueAutoContinue({
		sessionId,
		session,
		assistantText,
		toolUseCount,
		endedWithError,
		runFailure,
	});

	// The session just finished a turn; if nothing's queued it's idle now, so fire
	// any "when_done" / "on_pr" human asks waiting on this session. Idempotent.
	if (!promptQueues.get(sessionId)?.length) {
		onHumanAsksSessionIdle(sessionId);
		// Publish any commits the turn left unpushed so the status header doesn't
		// linger on "Ahead by N commits" (see autoPushSessionBranches). Only on a
		// clean finish — an errored/aborted turn may be mid-work. Fire-and-forget.
		if (!endedWithError) void autoPushSessionBranches(session);
		// Clean finish with nobody looking → next returning viewer gets a recap
		// system chip (recap.ts). Errored turns already land a failure chip, and
		// a turn that published a walkthrough already summarized itself, which is
		// what the turn's start time lets recap.ts check.
		if (!endedWithError && (assistantText.trim() || toolUseCount > 0))
			markRecapPendingIfUnwatched(sessionId, turnMetricStartedAt);
		// A turn that ended on a choice ("fix both, or only step 1?") offers that
		// choice as chips above the composer. Generated only for a watcher who is
		// actually there; anyone arriving later gets them on watch instead
		// (reply-suggestions.ts).
		if (!endedWithError && assistantText.trim())
			maybeSuggestReplies(sessionId, user || session.startedBy || undefined);
	}
}

/**
 * Expand `@session:os-…` mentions in a prompt into a footer the agent can act
 * on with its opensession-sessions tools. The mention token itself stays in place
 * (it carries the id); the footer resolves each id to a title/state and points
 * at the tools — including slash commands over send_to_session (e.g. "/loop").
 * Interactive sessions only: automations don't get opensession-sessions.
 */
export function sessionMentionsNote(
	content: string,
	excludeIds?: Iterable<string>,
): string | null {
	// Only the human's visible message counts: fenced <opensession:context> blocks
	// (attached session transcripts, handoffs) name sessions as @session:<id> too,
	// and those must not grow a redundant — and unfenced, so user-visible —
	// mentions footer. `|| ""` because a non-string reaching here crashed the
	// whole process on 2026-07-27 (stripContext passes falsy input through).
	content = stripContext(content || "");
	// A session attached as a digest above already carries its context; skip it here
	// so it doesn't also get a pointer footer for the same id.
	const skip = new Set(excludeIds ?? []);
	const ids = [
		...new Set(
			// `os-` is the minted prefix; `bks-` is the pre-rename one, which
			// every session started before 2026-08-05 still carries.
			[...content.matchAll(/@session:((?:os|bks)-[0-9a-f-]+)/g)].map(
				(m) => m[1],
			),
		),
	].filter((id) => !skip.has(id));
	if (!ids.length) return null;
	const lines = ids.map((id) => {
		const s = findSession(id);
		if (!s) return `- @session:${id} — (no session with this id)`;
		const busy = isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id);
		const bits = [
			s.title || "Untitled",
			s.branch ? `branch ${s.branch}` : null,
			busy ? "running" : "idle",
		].filter(Boolean);
		return `- @session:${id} — ${bits.join(" · ")}`;
	});
	return (
		`[The @session mentions above refer to other Open Session sessions:\n${lines.join("\n")}\n` +
		`Use the opensession-sessions MCP tools with these ids: get_session (state, pending question, ` +
		`transcript tail), send_to_session (a message — or a slash command handled by opensession ` +
		`itself, e.g. "/loop 15m <prompt>" to set a recurring self-prompt on the target that fires ` +
		`only while it is idle, "/loop stop" to clear it; this works on your own session id too), ` +
		`answer_session_question, cancel_session.]`
	);
}

/**
 * Loop ticker: fire due session loops (skips busy/archived sessions).
 * Called once from opensession.ts's boot block; idempotent, so a hot reload
 * never stacks a second interval. Never arm this at module scope — a loop
 * fires a real engine run, and this module is imported by most of the server
 * graph, so any script or test that touched it would start prompting live
 * sessions. Dev instances skip it (see src/server/dev-mode.ts).
 */
export function startLoopTicker(): void {
	if (g.__loopTicker || isDevInstance()) return;
	g.__loopTicker = setInterval(() => {
		for (const session of getCachedSessions()) {
			const loop = session.loop;
			if (!loop || session.archived || session.source !== "opensession") continue;
			if (!session.claudeSessionId && !session.codexThreadId) continue;
			if (
				isAgentSessionBusy(
					session.claudeSessionId,
					session.codexThreadId,
					session.id,
				)
			)
				continue;
			const last = loop.lastRunAt ? new Date(loop.lastRunAt).getTime() : 0;
			if (Date.now() - last < loop.intervalMinutes * 60_000) continue;
			touchNativeSession(session.id, {
				loop: { ...loop, lastRunAt: new Date().toISOString() },
			});
			console.log(
				`[loop] Firing loop prompt for ${session.id} (every ${loop.intervalMinutes}m)`,
			);
			void runSessionPromptAndDrain(
				session.id,
				loop.prompt,
				loop.setBy ? `${loop.setBy} (loop)` : "loop",
			).catch((e) =>
				console.error(`[loop] Loop prompt failed for ${session.id}:`, e),
			);
		}
	}, 60_000);
}