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
  cancelAgentRunToken,
  cancelAgentRunTokenAndWait,
  currentAgentRunToken,
  isAgentRunTokenAdmitted,
  engineFamily,
  restartContinuationPrompt,
  type StreamEvent,
} from "./agent-runner";
import { syncAgentSessionEngine } from "./agent-session-sync";
import { cancelAgentWait } from "./agent-waits";
import { runAgentHosted } from "./host-client";
import { getRunState, transitionRunState } from "./run-state";
import { resolveSessionRunInputs } from "./session-run-inputs";
import { defaultRepo } from "./config";
import { isDevInstance } from "./dev-mode";
import {
  buildSessionContextNote,
  buildEngineSwitchHandoffNote,
} from "./fork-handoff";
import { getGitStatus, gitPush } from "./git-status";
import { duplicateContextSessionIds } from "./session-duplicate";
import { onSessionIdle as onHumanAsksSessionIdle } from "./human-asks";
import { parseTranscriptAsync } from "./jsonl-parser";
import {
  contextWindowFor,
  interactiveFallbackModel,
  modelLabel,
  providerFor,
  type Provider,
  routeModel,
} from "./models";
import {
  appendTranscriptEntries,
  storeAppendUserLineEarly,
  transcriptLineRunnerNotice,
  transcriptLineUser,
} from "./transcript-persistence";
import { cacheMissNotice } from "@tellahq/opensession-protocol/notices";
import { RESTART_QUEUE_NOTICE_MESSAGE } from "@tellahq/opensession-protocol/session";
import { dropSandboxPreviewRoutes } from "./preview";
import {
  wrapContext,
  stripContext,
  isContextOnly,
  withPromptAttribution,
} from "./prompt-context";
import { takeVoiceHandoff } from "./desk-voice";
import {
  activeRunRecords,
  journalClearIfLineage,
  journalRetireCancelledAbnormalAfterSettlement,
  setJournalSetListener,
  type ActiveRunRecord,
} from "./run-journal";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import { createSlackPostScanner, linkThreadInIndex } from "./slack-links";
import {
  STRIPE_CONFIRM_TOOLS,
  filterMcpServers,
  looksLikeFabricatedToolTranscript,
} from "./runner-shared";
import {
  engineSessionIdFor,
  engineSessionPatch,
  engineUserTexts,
  getEngineTranscriptPath,
  mergedSessionTranscript,
  mergedSessionTranscriptAsync,
  readEngineHandoffTranscriptAsync,
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
  sandboxAutomationConfig,
  sandboxesEnabled,
  sandboxProviderConfigured,
} from "./sandbox/config";
import { disposeAutomationSandbox } from "./sandbox/automation-disposal";
import {
  automationModelEgressDestinations,
  mcpEgressDestinations,
} from "./sandbox/automation-egress";
import { ensureSandboxWithTransientRetry } from "./sandbox/reliability";
import {
  automationModel,
  getAutomation,
  validateSandboxAutomation,
} from "./automations";
import {
  portableWorkspacePresetRun,
  resolveWorkspaceModelPreset,
} from "./workspace-model-presets";
import { getTitleOverride } from "./title-overrides";
import { ensureGeneratedTitle } from "./generated-titles";
import { nameKnownSessionReferencesForTitle } from "./session-reference-title";
import {
  clearReplySuggestions,
  maybeSuggestReplies,
} from "./reply-suggestions";
import { commitAuthorFor } from "./shared/user-mappings";
import { writeFileAtomic, writeJsonAtomic } from "./shared/atomic-write";
import { startWatching } from "./file-watcher";
import {
  ensureAskCheckout,
  ensureScratchDir,
  getRepo,
  isSharedCheckoutDir,
  repoForPath,
  repoForPathOrNull,
  reviveWorktree,
  sessionRepoId,
  worktreeHeadBranch,
} from "./worktree";
import { createGoalSelfMcpServer } from "../agents/slack/goal-tools";
import { sendSlackMessage } from "../agents/slack/slack-api";
import { runHostsDir, type RunHostSpec } from "../runner-host/protocol";
import { maybeLaunchRunnerRun } from "./runner-session";
import {
  shouldPersistModelSwitch,
  type ImageInput,
  type TurnUsage,
} from "./run-events";
import type { SessionUsage, TranscriptEntry, UnifiedSession } from "./types";
import {
  findSession,
  getCachedSessions,
  invalidateSessionsCache,
  persistAutoModelSwitch,
  retryAutoFallbackModel,
  recordRunOutcome,
  applyRunOutcomeProjection,
  touchNativeSession,
  updateSessionFile,
  SESSIONS_DIR,
} from "./session-cache";
import { markRecapPendingIfUnwatched } from "./recap";
import { scheduleSessionHistoryIndex } from "./session-index";
import { broadcastToSession, sessionWatchers } from "./ws-hub";
import { getWorkspace } from "./workspaces";
import {
  broadcastQueue,
  beginNextPromptDispatch,
  beginPromptDispatch,
  durableQueueItem,
  beginPromptInterruptEffect,
  preparePromptInterrupt,
  settlePromptInterrupt,
  acknowledgePromptDispatch,
  acknowledgeSteerDelivery,
  failPromptDispatch,
  recoverUnownedPromptDispatch,
  isGitHubQueueItem,
  persistQueues,
  promptDispatches,
  promptQueues,
  promoteQueuedPrompt,
  queuedPromptIndex,
  queueItem,
  requeueSteerReceipts,
  restorePersistedQueueState,
  steeredReceipts,
  isUserStopped,
  stoppedSessions,
  takeSteerReceiptForText,
  undeliveredSteers,
  type PromptDispatch,
  type QueueItem,
} from "./queue-state";
import {
  prepareAndInterruptQueuedPrompt,
  prepareAndSteerQueuedPrompt,
} from "./queued-steer";
import { isShuttingDown } from "./shutdown-state";
import {
  parseImageDataUrls,
  stageFileAttachments,
  withUploadsNote,
} from "./uploads";
import {
  buildSessionNote,
  retrievedMemoryNoteFor,
  sessionRepoIds,
} from "./session-repos";
import { automationSessionMcp, interactiveMcpServers } from "./interactive-mcp";
import { makeAskHandler, settleRestoredAskAfterRecovery } from "./asks";
import {
  registerSessionEffectExecutor,
  SessionEffectDeferredError,
  settleCreationCancelled,
  settleCreationFailed,
  settleCreationSucceeded,
  sessionIsQuarantined,
  sessionDelivery,
  sessionKernel,
  sessionTurn,
  sessionTurnSnapshot,
} from "./session-kernel";

const interruptExecutorGlobal = globalThis as typeof globalThis & {
  __opensessionInterruptExecutorRegistered?: boolean;
  __opensessionTurnCancelExecutorRegistered?: boolean;
  __opensessionTurnOutcomeProjectionExecutorRegistered?: boolean;
};
if (
  !interruptExecutorGlobal.__opensessionTurnOutcomeProjectionExecutorRegistered
) {
  registerSessionEffectExecutor("turn_outcome_project", async (item) => {
    const projection = item.payload;
    const decision = await sessionTurn({
      op: "begin_outcome_projection",
      sessionId: item.sessionId,
      projectionId: projection.projectionId,
      runGeneration: projection.runGeneration,
    });
    if (decision === "missing") return;
    if (decision === "completed") {
      // A crash can settle the outcome before it durably schedules history
      // indexing. Replaying the completed effect repairs that narrow gap.
      await scheduleSessionHistoryIndex(
        item.sessionId,
        projection.projectionId,
      );
      return;
    }
    if (decision === "wait")
      throw new SessionEffectDeferredError(
        "Earlier turn outcome is still pending",
      );
    await applyRunOutcomeProjection(
      item.sessionId,
      projection.errorMessage,
      projection,
      true,
    );
    const settled = await sessionTurn({
      op: "settle_outcome_projection",
      sessionId: item.sessionId,
      projectionId: projection.projectionId,
      runGeneration: projection.runGeneration,
    });
    if (!settled)
      throw new Error(
        "Turn outcome projection ownership changed before settlement",
      );
    // The timer is the durable push into history. Its handler reads only this
    // session after the outcome mailbox has been released.
    await scheduleSessionHistoryIndex(item.sessionId, projection.projectionId);
  });
  interruptExecutorGlobal.__opensessionTurnOutcomeProjectionExecutorRegistered = true;
}
if (!interruptExecutorGlobal.__opensessionInterruptExecutorRegistered) {
  registerSessionEffectExecutor("delivery_interrupt_cancel", async (item) => {
    const { interruptId, dispatchId, runIds, runGeneration } = item.payload;
    const retireConfirmedAbnormal = () => {
      if (dispatchId)
        journalRetireCancelledAbnormalAfterSettlement(
          item.sessionId,
          dispatchId,
        );
    };
    const decision = await beginPromptInterruptEffect(
      item.sessionId,
      interruptId,
      runGeneration,
    );
    if (decision === "settled") return;
    if (decision === "confirmed") {
      retireConfirmedAbnormal();
      return;
    }
    if (decision === "adopt_confirmed") {
      await settlePromptInterrupt(item.sessionId, interruptId, "confirmed");
      retireConfirmedAbnormal();
      return;
    }
    const aborted = dispatchId
      ? await cancelAgentRunToken(dispatchId)
      : await cancelAgentRun(...(runIds || []));
    // A retry follows a durably recorded executing phase. False then means
    // either the first attempt already cancelled the owner or this retry found
    // it terminal, so the accepted interrupt is conservatively confirmed.
    const outcome =
      aborted || decision === "retry" ? "confirmed" : "not_aborted";
    await settlePromptInterrupt(item.sessionId, interruptId, outcome);
    if (outcome === "confirmed") retireConfirmedAbnormal();
  });
  interruptExecutorGlobal.__opensessionInterruptExecutorRegistered = true;
}
if (!interruptExecutorGlobal.__opensessionTurnCancelExecutorRegistered) {
  registerSessionEffectExecutor("turn_cancel", async (item) => {
    const { cancelId, dispatchId, runGeneration } = item.payload;
    const retireAbsentInProcessOwner = () => {
      const owner = activeRunRecords().find(
        (run) =>
          run.osSessionId === item.sessionId && run.runKey === dispatchId,
      );
      if (
        owner &&
        !owner.hostId &&
        !owner.runnerId &&
        !owner.sandboxId &&
        !isAgentRunTokenAdmitted(dispatchId)
      )
        journalClearIfLineage(owner);
    };
    const decision = await sessionTurn({
      op: "begin_cancel_effect",
      sessionId: item.sessionId,
      cancelId,
      runGeneration,
    });
    if (decision === "missing") return;
    if (decision === "settled") {
      journalRetireCancelledAbnormalAfterSettlement(item.sessionId, dispatchId);
      retireAbsentInProcessOwner();
      return;
    }
    const settle = async (
      outcome: "confirmed" | "not_aborted",
    ): Promise<boolean> => {
      const settled = await sessionTurn({
        op: "settle_cancel",
        sessionId: item.sessionId,
        cancelId,
        outcome,
      });
      if (!settled) return false;
      journalRetireCancelledAbnormalAfterSettlement(item.sessionId, dispatchId);
      // An explicit prompt may already be parked behind this cancellation.
      // Re-arm delivery only after actor settlement removes the cancel gate.
      watchExternalRunAndDrain(item.sessionId);
      return true;
    };
    if (decision === "adopt_confirmed") {
      await settle("confirmed");
      return;
    }
    const cancelledWait = await cancelAgentWait(item.sessionId);
    const cancelledRun = await cancelAgentRunTokenAndWait(dispatchId);
    if (!cancelledRun && decision === "retry")
      throw new Error(
        `Could not reconcile executing cancellation ${cancelId} for ${dispatchId}`,
      );
    const settled = await settle(
      cancelledWait || cancelledRun ? "confirmed" : "not_aborted",
    );
    if (!settled) return;
    // A pre-engine in-process journal cannot have survived this gateway boot.
    // Retire it only after actor settlement. Detached host/Runner/sandbox
    // records stay for their attached source to complete naturally.
    retireAbsentInProcessOwner();
  });
  interruptExecutorGlobal.__opensessionTurnCancelExecutorRegistered = true;
}

export type TurnCancelRequest = {
  cancelId: string;
  expectedRunId: string;
  expectedGeneration: number;
  source: string;
  user?: string;
};

/** Commit Stop ownership before its physical cancel, atomically parking any
 * undelivered steer receipts with the stopped run generation. */
export async function requestTurnCancel(
  sessionId: string,
  session: UnifiedSession,
  request: TurnCancelRequest,
): Promise<{ requeued: number }> {
  const existingCancel = (await sessionTurnSnapshot(sessionId)).cancel;
  const exactReplay =
    existingCancel?.cancelId === request.cancelId &&
    existingCancel.runId === request.expectedRunId &&
    existingCancel.runGeneration === request.expectedGeneration
      ? existingCancel
      : undefined;
  const steered = steeredReceipts.get(sessionId) || [];
  const requeued = undeliveredSteers(steered, await engineUserTexts(session));
  const requeueIds =
    exactReplay?.requeueIds ??
    requeued
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  await sessionTurn({
    op: "prepare_cancel",
    sessionId,
    cancelId: request.cancelId,
    expectedRunId: request.expectedRunId,
    expectedGeneration: request.expectedGeneration,
    dispatchId: request.expectedRunId,
    requeueIds,
    source: request.source,
    ...(request.user ? { user: request.user } : {}),
  });
  // The durable Stop committed above must not be undone by a concurrent
  // creation settlement racing this read: terminal settlements are idempotent
  // (see settleCreationCancelled), so only genuine invariant failures throw.
  // Bookkeeping below always runs, even when the error propagates.
  try {
    await settleCreationOpeningForStop(sessionId);
  } finally {
    stoppedSessions.add(sessionId);
    persistQueues();
    await broadcastQueue(sessionId);
  }
  return {
    requeued: exactReplay ? exactReplay.requeueIds.length : requeued.length,
  };
}

export async function settleCreationOpeningForStop(
  sessionId: string,
): Promise<boolean> {
  const kernel = sessionKernel(sessionId);
  const creation = await kernel.creationState();
  const effectId = creation?.currentEffectId;
  if (
    creation?.state !== "opening_dispatched" ||
    !effectId?.startsWith("opening:")
  )
    return false;
  await settleCreationCancelled(sessionId, creation.identity, kernel, effectId);
  await acknowledgePromptDispatch(sessionId, effectId.slice("opening:".length));
  return true;
}

export async function creationOwnsPrompt(
  sessionId: string,
  promptEntryId: string,
): Promise<boolean> {
  const creation = await sessionKernel(sessionId).creationState();
  return (
    creation?.state === "opening_dispatched" &&
    creation.currentEffectId === `opening:${promptEntryId}`
  );
}

/** Settle an actor-owned opening recovered by the generic local-run adopter. */
export async function settleRecoveredCreationOpening(
  sessionId: string,
  promptEntryId: string,
  failure?: string,
  runId?: string,
): Promise<boolean> {
  const creation = await sessionKernel(sessionId).creationState();
  const effectId = `opening:${promptEntryId}`;
  if (
    !creation ||
    creation.currentEffectId !== effectId ||
    creation.state !== "opening_dispatched"
  )
    return false;
  const cancel = (await sessionTurnSnapshot(sessionId)).cancel;
  if (runId && cancel?.runId === runId) {
    await settleCreationCancelled(
      sessionId,
      creation.identity,
      sessionKernel(sessionId),
      effectId,
    );
  } else if (failure) {
    await settleCreationFailed(
      sessionId,
      creation.identity,
      new Error(failure),
      sessionKernel(sessionId),
      effectId,
    );
  } else {
    await settleCreationSucceeded(
      sessionId,
      creation.identity,
      sessionKernel(sessionId),
      effectId,
    );
  }
  await acknowledgePromptDispatch(sessionId, promptEntryId);
  return true;
}

// The runner writes its active-run journal before it can call an engine. Once
// that journal names this prompt entry, normal boot recovery owns it and the
// queue's pre-dispatch record is no longer needed.
setJournalSetListener(async (record) => {
  if (
    record.osSessionId &&
    record.promptEntryId &&
    (await creationOwnsPrompt(record.osSessionId, record.promptEntryId))
  )
    return;
  await acknowledgePromptDispatch(record.osSessionId, record.promptEntryId);
});
import { audit } from "./audit";
import {
  githubCredentialForLogin,
  githubCredentialForRun,
} from "./github-auth";
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

const g = globalThis as any;

// Sessions whose last turn already got an announce-then-stop auto-continue —
// one consecutive WORKLESS nudge max, so a model that announces-and-stops twice
// in a row parks for the human instead of looping. Cleared when a human prompt
// arrives or a turn does real (tool-calling) work — which also means that while
// the agent keeps genuinely working through announced steps, queued messages
// stay held behind fresh auto-continues (the actor queue hold at run end)
// until a turn ends without announcing more work.
const autoContinueNudged: Set<string> = (g.__autoContinueNudged ??= new Set());

// Per-session tail of stranded user messages already redelivered once (see
// the endedWithError branch of maybeQueueAutoContinue) — keyed by content so
// a redelivery turn that fails on the same tail doesn't loop, while a NEW
// stranded message is always eligible. Cleared on any clean turn.
const orphanRedeliveredTails: Map<string, string> =
  (g.__orphanRedeliveredTails ??= new Map());

// Per-session wedge failure already auto-retried once (see the wedge branch of
// maybeQueueAutoContinue) — keyed by failure text so the SAME wedge twice in a
// row parks for the human instead of looping. Cleared on any clean turn.
const wedgeRetriedFailures: Map<string, string> = (g.__wedgeRetriedFailures ??=
  new Map());

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
 *  actor queue hold so its auto-continue delivers before queued user messages. */
export async function enqueuePrompt(
  sessionId: string,
  item: QueueItem,
  opts?: { front?: boolean },
): Promise<void> {
  const owned = durableQueueItem(sessionId, queueItem(item));
  // Actor-owned enqueue makes concurrent producers atomic. Stable ids make a
  // replay after commit an adoption rather than a second prompt.
  await sessionDelivery({
    op: "enqueue",
    sessionId,
    item: owned,
    front: opts?.front,
  });
  persistQueues();
  await broadcastQueue(sessionId);
  // Queueing is a delivery promise, not just a UI state. Arm the idle
  // watcher only after the durable queue write commits.
  watchExternalRunAndDrain(sessionId);
}

/**
 * A steer the engine bounced back (`steer_failed`): put the message into the
 * queue as the ITEM it was, not as the string the host echoed.
 *
 * hostSteer returns true once the frame is written to the socket, not once
 * the host accepts it, so a steer can be recorded as delivered and then be
 * refused (the run was already finishing, or that backend cannot steer).
 * Both halves of the reversal belong here: retire the receipt, which
 * otherwise goes on claiming the running turn has this message, and re-queue
 * the original content with its user kept in its own field. Enqueueing the
 * echoed text instead stored "[Name] " inside content, which showed up in
 * the queue row and got attributed a second time by a multi-item drain.
 *
 * Front of the queue: this message was already meant to reach the agent
 * ahead of anything queued behind it, and the steer is the only reason it
 * left the queue at all.
 */
export async function requeueFailedSteer(
  sessionId: string,
  text: string,
  user?: string,
): Promise<void> {
  // effects=false: the enqueue below persists and broadcasts both maps, so
  // watchers never see a frame with the message in neither of them.
  const receipt = await takeSteerReceiptForText(sessionId, text, false);
  // No receipt (a steer recorded by a path that keeps none, or one already
  // reconciled away): fall back to the echoed text, minus the prefix this
  // run composed, so content stays the raw message either way.
  const prefix = user ? `[${user}] ` : "";
  const item = receipt ?? {
    content:
      prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text,
    user,
  };
  await enqueuePrompt(sessionId, item, { front: true });
  watchExternalRunAndDrain(sessionId);
}

export async function steerQueuedPrompt(
  sessionId: string,
  queueId?: string,
  queueIndex?: number,
): Promise<boolean> {
  const session = findSession(sessionId);
  const queue = promptQueues.get(sessionId);
  if (!session || !queue) return false;
  const index = queuedPromptIndex(queue, queueId, queueIndex);
  if (index < 0) return false;
  const rawItem = queue[index];
  if (!rawItem) return false;
  const item = queueItem(rawItem);
  const promptEntryId = item.promptEntryId || item.id;
  const sentItem = { ...item, promptEntryId };
  if (
    !isAgentSessionBusy(
      session.claudeSessionId,
      session.codexThreadId,
      session.id,
    )
  ) {
    // Idle-but-queued (typically held behind running child workers): sending
    // now promotes the row into the conversation and dispatches it as its own
    // immediate turn. The exact prompt id lets the runner upsert that visible
    // line instead of appending a second copy.
    await beginPromptDispatch(
      sessionId,
      [sentItem],
      promptEntryId,
      false,
      undefined,
      true,
    );
    const images = parseImageDataUrls(item.images || []);
    try {
      await storeAppendUserLineEarly(
        sessionId,
        transcriptLineUser(item.content, promptEntryId, undefined, images, [
          item.id,
        ]),
        { required: true },
      );
    } catch (error) {
      await failPromptDispatch(sessionId, promptEntryId);
      throw error;
    }
    stoppedSessions.delete(sessionId);
    persistQueues();
    await broadcastQueue(sessionId);
    const files =
      Array.isArray(item.files) && item.files.length > 0
        ? item.files
        : undefined;
    void runSessionPromptAndDrain(
      sessionId,
      item.content,
      item.user,
      images,
      files,
      undefined,
      undefined,
      promptEntryId,
    ).catch(async (e) => {
      console.error(`[queue] Send-now delivery failed for ${sessionId}:`, e);
      await failPromptDispatch(sessionId, promptEntryId);
    });
    return true;
  }
  // Files can't ride a steer (the fold path is text+images only). GitHub FYI
  // items CAN steer — folding in is non-interrupting, so it's the right
  // delivery for them too (they only land in the queue when a steer at
  // delivery time found nothing steerable).
  if (Array.isArray(item.files) && item.files.length > 0) return false;
  const attributed =
    item.user && !isContextOnly(item.content)
      ? `[${item.user}] ${item.content}`
      : item.content;
  const images = parseImageDataUrls(item.images || []);
  if (!item.id) return false;
  const outcome = await prepareAndSteerQueuedPrompt({
    sessionId,
    itemId: item.id,
    item: sentItem,
    text: attributed,
    images,
  });
  if (outcome === "steered") return true;
  if (outcome === "rejected") {
    // The message is already a durable transcript row. Its actor-owned queue
    // fallback is delivery plumbing only and drains as the immediate next turn.
    watchExternalRunAndDrain(sessionId);
    return true;
  }
  // The run may have finished between the busy check and actor preparation.
  // Re-enter once through the idle path rather than asking the user to retry.
  if (
    !isAgentSessionBusy(
      session.claudeSessionId,
      session.codexThreadId,
      session.id,
    )
  )
    return steerQueuedPrompt(sessionId, queueId, queueIndex);

  // The run is still authoritative but its physical control is temporarily
  // unavailable (for example during host reattachment). Accept the user's
  // command anyway: keep an urgent, hidden queue owner and let the watcher
  // dispatch it as the immediate next turn.
  const promoted = await promoteQueuedPrompt(
    sessionId,
    item.id,
    promptEntryId,
    sentItem,
  );
  if (!promoted) return false;
  await storeAppendUserLineEarly(
    sessionId,
    transcriptLineUser(attributed, promptEntryId, undefined, images, [item.id]),
    { required: true },
  );
  watchExternalRunAndDrain(sessionId);
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
export async function interruptQueuedPrompt(
  sessionId: string,
  queueId?: string,
  queueIndex?: number,
): Promise<boolean> {
  const session = findSession(sessionId);
  if (!session) return false;
  const receipt = queueId
    ? (steeredReceipts.get(sessionId) || []).find((s) => s.id === queueId)
    : undefined;
  if (receipt) {
    // A receipt means the running turn has ACCEPTED this message: it sits in
    // the engine's steering queue and is read at the next step boundary,
    // which a long tool call can push out by minutes. "Deliver now" forces
    // that boundary. The transcript is the arbiter of delivered-vs-not: the
    // user entry is written at the same engine event that folds a steer into
    // history, so a receipt whose text already landed needs nothing forced
    // (the reconcile retires it on its own — report success, not a notice).
    if (
      undeliveredSteers([receipt], await engineUserTexts(session)).length === 0
    ) {
      return true;
    }
    // Still unread: abort the turn. An aborted run never drains its steering
    // queue (the engine discards it on dispose), so abortTurnAndDrain
    // requeues every receipt the transcript has not seen and the solo mark
    // delivers exactly this one as the immediate next turn — any other
    // pending steers go back to the queue and wait for a natural boundary
    // instead of being swept into this forced one. The INTERRUPT_STEER_NOTE
    // frames the delivery as a mid-task steer so the model resumes the
    // interrupted work rather than acknowledge-and-parking.
    return await abortTurnAndDrain(sessionId, session, receipt.id);
  }
  const queue = promptQueues.get(sessionId);
  if (!queue) return false;
  const index = queuedPromptIndex(queue, queueId, queueIndex);
  if (index < 0) return false;
  let item = queue[index];
  if (!item) return false;
  if (
    isGitHubQueueItem(item) ||
    (Array.isArray(item.files) && item.files.length > 0)
  )
    return false;
  if (!item.id) {
    item = queueItem(item);
    queue[index] = item;
    await promptQueues.set(sessionId, queue);
    persistQueues();
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
  )
    return false;
  const interrupt = await prepareAndInterruptQueuedPrompt({
    sessionId,
    itemId: item.id!,
    item: {
      ...item,
      promptEntryId: item.promptEntryId || item.id,
    },
    text: attributed,
    images,
  });
  if (interrupt === "interrupted") return true;
  if (interrupt === "target_changed") {
    watchExternalRunAndDrain(sessionId);
    return true;
  }
  if (interrupt === "not_prepared")
    return steerQueuedPrompt(sessionId, queueId, queueIndex);
  // No in-band interrupt-and-steer (pi): the fenced rejection restored the
  // durable queue item. Abort the exact current turn so the drain delivers
  // only this item immediately; every other prompt stays queued.
  return await abortTurnAndDrain(sessionId, session, item.id!);
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
export async function restorePromptQueues(
  resumedSessionIds: Set<string>,
): Promise<void> {
  const active = activeRunRecords();
  const restored = await restorePersistedQueueState({
    sessionExists: (sessionId) => !!findSession(sessionId),
    // Preserve quarantined queue state without projecting or mutating it. A
    // quarantine is intentionally inert until an operator releases it.
    sessionQuarantined: sessionIsQuarantined,
    journalOwnsPrompt: (sessionId, promptEntryId) =>
      active.some(
        (run) =>
          run.osSessionId === sessionId && run.promptEntryId === promptEntryId,
      ),
    creationOwnsPrompt,
    runOwnsSteers: (sessionId) =>
      resumedSessionIds.has(sessionId) &&
      active.some((run) => run.osSessionId === sessionId),
    deliveredUserTexts: async (sessionId) => {
      const session = findSession(sessionId);
      return session ? engineUserTexts(session) : [];
    },
  });
  const dispatchEntries = await sessionDelivery({
    op: "entries",
    slot: "dispatch",
  });
  const restoredCreates = [
    ...new Set(
      dispatchEntries
        .filter(([, value]) => (value as PromptDispatch).kind === "create")
        .map(([sessionId]) => sessionId),
    ),
  ];
  if (restoredCreates.length) {
    void import("./session-create")
      .then(async (module) => {
        let next = 0;
        const worker = async () => {
          while (next < restoredCreates.length) {
            const sessionId = restoredCreates[next++]!;
            try {
              if (!(await module.resumePlannedCreate(sessionId)))
                console.error(
                  `[create] No durable plan could resume ${sessionId}`,
                );
            } catch (error) {
              console.error(`[create] Failed to resume ${sessionId}:`, error);
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(4, restoredCreates.length) }, worker),
        );
      })
      .catch((error) =>
        console.error("[create] Restored-create recovery pool failed:", error),
      );
  }
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
      restartContinuationPrompt(r.prompt),
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
const recoveredFeedStarted: Set<string> = (g.__recoveredFeedStarted ??=
  new Set());

/** Fold one detached host's run-cumulative usage onto the total stored before
 * the gateway restart. The host terminal is authoritative even when every
 * intermediate usage_snapshot fell into the restart's live-only event gap. */
export function foldRecoveredSessionUsage(
  session: Pick<UnifiedSession, "model" | "usage">,
  event: Pick<StreamEvent, "model" | "usage">,
): SessionUsage | undefined {
  if (!event.usage) return undefined;
  return foldSessionUsage(
    session.usage,
    event.usage,
    event.model || session.model,
  );
}

/** Persist terminal usage in the recovery settlement path. This deliberately
 * runs separately from recordRecoveredRunEvent: recovered snapshots are live
 * readouts only, so another gateway restart can still fold the host's complete
 * terminal total onto the same pre-run base. `runId` makes the terminal write
 * idempotent when another restart lands between this write and journal cleanup. */
export async function persistRecoveredRunUsage(
  osSessionId: string,
  event: StreamEvent,
  runId?: string,
): Promise<void> {
  const session = findSession(osSessionId);
  const turnUsage = event.usage;
  if (!session || session.source !== "opensession" || !turnUsage) return;
  let usage: SessionUsage | undefined;
  await updateSessionFile(osSessionId, (data) => {
    if (runId && data.usageRunId === runId) {
      usage = data.usage;
      return data;
    }
    usage = foldSessionUsage(data.usage, turnUsage, event.model || data.model);
    return {
      ...data,
      usage,
      ...(runId ? { usageRunId: runId } : {}),
      lastActivity: new Date().toISOString(),
    };
  });
  if (usage)
    broadcastToSession(osSessionId, {
      type: "usage_update",
      sessionId: osSessionId,
      usage,
    });
}

export async function recordRecoveredRunEvent(
  osSessionId: string,
  event: StreamEvent,
): Promise<void> {
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
  if (event.type === "usage_snapshot") {
    const usage = foldRecoveredSessionUsage(session, event);
    if (usage)
      broadcastToSession(osSessionId, {
        type: "usage_update",
        sessionId: osSessionId,
        usage,
      });
    return;
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
          slackThreads: [
            ...threads,
            { channel: post.channel, threadTs: post.threadTs },
          ],
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
    // Exact steer-delivered events already retired anything the engine read.
    // Every remaining receipt becomes the immediate next turn, even after a
    // clean finish: the run may have ended between buffering and its next step.
    const requeued = await requeueSteerReceipts(
      osSessionId,
      await engineUserTexts(session),
    );
    if (requeued > 0) watchExternalRunAndDrain(osSessionId);
    if (await settleRestoredAskAfterRecovery(osSessionId)) {
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
  // "pi" and "pi" resolve to no transcript path (both keep their turns
  // in the owned store); those sessions stream through run events only, so
  // this attaches nothing for them.
  provider: "claude" | "codex" | "pi",
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
const shutdownParkNotified: Set<string> = (g.__shutdownParkNotified ??=
  new Set());
function notifyShutdownPark(sessionId: string): void {
  if (shutdownParkNotified.has(sessionId)) return;
  shutdownParkNotified.add(sessionId);
  broadcastToSession(sessionId, {
    type: "notice",
    sessionId,
    message: RESTART_QUEUE_NOTICE_MESSAGE,
  });
}

/** Report and retain accepted queue intake once graceful shutdown has fenced
 * new turns. Delivery callers use the result to acknowledge the real queued
 * placement instead of claiming that a parked prompt started. */
export function parkQueueForShutdown(sessionId: string): boolean {
  if (!isShuttingDown()) return false;
  notifyShutdownPark(sessionId);
  return true;
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
    if (await isUserStopped(sessionId)) return;
    // Graceful shutdown: park the queue instead of starting a turn. A turn
    // started after the shutdown snapshot races the drain deadline (an
    // in-process one is SIGKILLed there and redone from the journal), and
    // the sender's socket dies mid-stream either way. The queue is already
    // persisted, so the next boot's restorePromptQueues delivers this
    // message cleanly instead.
    if (parkQueueForShutdown(sessionId)) return;
    // A racing run can own the session by the time we loop again (e.g. our
    // last batch lost the start race and got re-queued) — hand off to the
    // idle-watcher instead of busy-spinning runs that immediately bounce.
    const session = findSession(sessionId);
    const ownerActive = () =>
      isAgentSessionBusy(
        session?.claudeSessionId,
        session?.codexThreadId,
        sessionId,
      );
    if (ownerActive()) {
      watchExternalRunAndDrain(sessionId);
      return;
    }
    if (await recoverUnownedPromptDispatch(sessionId, ownerActive)) {
      console.warn(
        `[queue] Restored an unowned prompt dispatch before draining ${sessionId}`,
      );
      continue;
    }
    // Batch selection lives in the actor's pure queue reducer: a solo
    // interrupt (queue chip ▲) delivers one item, a head auto-continue
    // delivers alone, and while child worker runs are still going, human
    // composer sends (item.hold) stay parked until the agent FULLY
    // completes. Orchestration traffic (worker reports, FYIs) keeps
    // flowing so held items can't wedge the run.
    //
    // Selection, interrupt consumption, and claim are one actor reduction.
    // Queue contents cannot change between choosing a batch and durable
    // dispatch ownership, and a crash cannot lose or duplicate the interrupt.
    const claim = await beginNextPromptDispatch(sessionId, {
      stillWorking: runningChildCount(sessionId) > 0,
    });
    if (claim.kind === "empty") continue;
    if (claim.kind === "hold") {
      if (!queueHoldNotified.has(sessionId)) {
        queueHoldNotified.add(sessionId);
        broadcastToSession(sessionId, {
          type: "notice",
          sessionId,
          message: `Holding ${claim.heldCount} queued message${claim.heldCount === 1 ? "" : "s"} until the agent fully completes (worker sessions still running). Steer sends one in sooner.`,
        });
      }
      watchExternalRunAndDrain(sessionId);
      return;
    }
    queueHoldNotified.delete(sessionId);
    const { batch, promptEntryId, interrupted } = claim;
    await broadcastQueue(sessionId);
    let combined = batch
      .map((m) =>
        batch.length > 1 && m.user ? `[${m.user}] ${m.content}` : m.content,
      )
      .join("\n\n");
    // Interrupt delivery (busy-send aborted the turn to land this batch):
    // append the fenced steer note so the model resumes the interrupted work
    // instead of acknowledge-and-parking. Fenced, so the transcript shows
    // only the user's text.
    if (interrupted) {
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
    const contextSessions = [
      ...new Set(batch.flatMap((m) => m.contextSessions ?? [])),
    ];
    // A queued Slack-thread reply carries its origin thread — the turn's answer
    // mirrors back there. Last one wins if a batch somehow spans threads.
    const slackReplyTo = [...batch]
      .reverse()
      .find((m) => m.slackReplyTo)?.slackReplyTo;
    const sourceMessageIds = batch.flatMap((item) =>
      item.id ? [item.id] : [],
    );
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
        sourceMessageIds,
      );
    } catch (e) {
      // The batch was already spliced out and persisted away — put it back at
      // the front of the queue so a throw doesn't lose the messages.
      await failPromptDispatch(sessionId, promptEntryId);
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
  promptEntryId?: string,
  sourceMessageIds?: string[],
): Promise<void> {
  try {
    await runSessionPrompt(
      sessionId,
      content,
      user,
      images,
      rawFiles,
      contextSessions,
      slackReplyTo,
      promptEntryId,
      sourceMessageIds,
    );
  } catch (error) {
    if (error instanceof RunPreparationDeferredError) return;
    throw error;
  }
  await drainQueue(sessionId);
}

// Messages queued while a run we did not start is in flight have no drain
// loop of their own. Each session gets one self-scheduling poll, never an
// overlapping async interval.
type DrainWatcher = { timer?: ReturnType<typeof setTimeout>; failures: number };
const drainWatchers: Map<string, DrainWatcher> = (g.__asyncDrainWatchers ??=
  new Map());

export function sessionQueueOwnerActive(sessionId: string): boolean {
  return drainWatchers.has(sessionId) || queueDrains.has(sessionId);
}

function drainWatcherDelay(failures: number): number {
  const base = Math.min(60_000, 3_000 * 2 ** Math.min(failures, 5));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export function watchExternalRunAndDrain(sessionId: string): void {
  if (drainWatchers.has(sessionId)) return;
  const watcher: DrainWatcher = { failures: 0 };
  drainWatchers.set(sessionId, watcher);

  const stop = () => {
    if (watcher.timer) clearTimeout(watcher.timer);
    if (drainWatchers.get(sessionId) === watcher)
      drainWatchers.delete(sessionId);
  };
  const schedule = (delayMs: number) => {
    watcher.timer = setTimeout(() => {
      void tick().catch((error) => {
        // tick owns every fallible operation. This terminal observer is a
        // final process-safety fence and always preserves the durable queue.
        console.error(`[queue] Drain watcher crashed for ${sessionId}:`, error);
        watcher.failures += 1;
        schedule(drainWatcherDelay(watcher.failures));
      });
    }, delayMs);
    watcher.timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    try {
      const session = findSession(sessionId);
      if (!session) {
        stop();
        return;
      }
      const delivery = await sessionDelivery({ op: "snapshot", sessionId });
      if (!delivery.queued.length) {
        stop();
        return;
      }
      if (
        isAgentSessionBusy(
          session.claudeSessionId,
          session.codexThreadId,
          session.id,
        )
      ) {
        watcher.failures = 0;
        schedule(drainWatcherDelay(0));
        return;
      }
      await drainQueue(sessionId);
      watcher.failures = 0;
      const remaining = await sessionDelivery({ op: "snapshot", sessionId });
      if (remaining.queued.length) schedule(drainWatcherDelay(0));
      else stop();
    } catch (error) {
      watcher.failures += 1;
      console.error(
        `[queue] Drain after external run failed for ${sessionId}; retrying:`,
        error,
      );
      schedule(drainWatcherDelay(watcher.failures));
    }
  };

  schedule(drainWatcherDelay(0));
}

/**
 * Esc+Enter for engines with no in-band interrupt-and-steer (pi): abort
 * the run's current turn — the same abort the Esc/stop path uses — and let the
 * drain watcher deliver the queue as the immediate next turn on the same
 * engine session. The interrupting message must already be in promptQueues
 * before calling. True means the actor accepted the durable cancel intent. If
 * the fenced effect proves the owner was not abortable, it records
 * `not_aborted` and the message stays queued for the natural stopping point.
 */
export async function abortTurnAndDrain(
  sessionId: string,
  session: {
    claudeSessionId?: string | null;
    codexThreadId?: string | null;
    transcriptPath?: string | null;
    id: string;
  },
  /** The one queued item this interrupt targeted (queue chip send/▲), when
   *  it targeted one. The rest of the queue stays put for this drain. */
  soloId?: string,
  /** The queued item that fences even a whole-batch composer interrupt. */
  anchorId?: string,
): Promise<boolean> {
  const interruptAnchorId = anchorId || soloId;
  if (!interruptAnchorId)
    throw new Error("Interrupted prompt is missing its durable queue identity");
  // Actor preparation and its outbox effect commit before physical cancel.
  // The effect retries against the fenced run generation after a crash, while
  // the queue anchor prevents a stale result from crossing into later work.
  const dispatchId =
    sessionKernel(sessionId).runStateProjection().currentRunId ||
    currentAgentRunToken(sessionId);
  if (!dispatchId) return false;
  await preparePromptInterrupt(
    sessionId,
    interruptAnchorId,
    dispatchId,
    soloId,
  );
  stoppedSessions.delete(sessionId);
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
export async function autoPushSessionBranches(
  session: UnifiedSession,
): Promise<void> {
  const githubGitEnv =
    session.automation ||
    session.automationId ||
    session.automationDescendantPolicy
      ? undefined
      : session.createdByLogin
        ? githubCredentialForLogin(session.createdByLogin)?.env
        : githubCredentialForRun(session.createdBy || session.startedBy)?.env;
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
    const result = await gitPush(dir, branch, exec, githubGitEnv);
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
 * Automation-owned root sessions use a separate disposable path: every turn
 * revalidates the owning automation, reapplies its minimal credentials and
 * egress policy, and destroys the Executor when the stream closes.
 */
export function sandboxRunSecuritySpec(
  session: UnifiedSession,
  opts: {
    isAutomationSession: boolean;
    user?: string;
    mcpServers?: McpScope;
    deniedTools?: Record<string, string>;
  },
): Pick<
  RunHostSpec,
  | "mcpServers"
  | "proxyMcpServers"
  | "reposNote"
  | "deniedTools"
  | "publicationPolicy"
  | "aws"
  | "user"
  | "mcpGrantUser"
  | "journalKind"
  | "trustProfile"
> {
  const descendant = session.automationDescendantPolicy;
  return {
    mcpServers: opts.isAutomationSession ? (opts.mcpServers ?? []) : [],
    proxyMcpServers: opts.isAutomationSession
      ? []
      : [
          ...Object.keys(interactiveMcpServers(opts.user, session.id)),
          ...(session.goalId ? ["opensession-goal-self"] : []),
        ],
    reposNote: undefined,
    deniedTools: opts.deniedTools,
    publicationPolicy: descendant
      ? {
          repo: descendant.publicationRepo,
          branch: descendant.baseBranch,
          headBranch: session.branch || "",
        }
      : undefined,
    aws: !opts.isAutomationSession,
    user: opts.isAutomationSession ? undefined : opts.user,
    mcpGrantUser: opts.isAutomationSession
      ? undefined
      : session.createdByLogin || undefined,
    journalKind: opts.isAutomationSession ? "automation" : "prompt",
    trustProfile: opts.isAutomationSession ? "automation" : "interactive",
  };
}

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
    deniedTools?: Record<string, string>;
    isAutomationSession: boolean;
    startToken?: string;
  },
): Promise<
  | (AsyncGenerator<StreamEvent> & {
      freshEngine?: boolean;
      sandboxProvider?: string;
      sandboxId?: string;
      sandboxReadyMs?: number;
    })
  | null
> {
  const sbProvider = session.sandbox?.provider;
  if (!isRunnableSandboxProvider(sbProvider)) return null; // "local"/absent/unknown = host
  const cancelledRun = (sandbox?: { id: string }) =>
    Object.assign((async function* (): AsyncGenerator<StreamEvent> {})(), {
      sandboxProvider: sbProvider,
      sandboxId: sandbox?.id,
      sandboxReadyMs: Date.now() - sandboxStartedAt,
    });
  if (!sandboxesEnabled()) {
    throw new Error(
      "Sandbox execution is disabled by the operator kill switch",
    );
  }
  if (!sandboxProviderConfigured(sbProvider)) {
    throw new Error(
      `Sandbox provider "${sbProvider}" is not configured and Ready`,
    );
  }
  const disposableAutomationResume =
    opts.isAutomationSession && !session.automationDescendantPolicy;
  const owningAutomation = disposableAutomationResume
    ? session.automationId
      ? getAutomation(session.automationId)
      : null
    : null;
  if (disposableAutomationResume) {
    if (
      !owningAutomation ||
      !owningAutomation.sandbox ||
      owningAutomation.name !== session.automation ||
      owningAutomation.accountId !== session.accountId ||
      !!session.sandbox?.sandboxId
    ) {
      throw new Error(
        "Sandbox automation resume policy is unavailable or has changed",
      );
    }
    const validation = validateSandboxAutomation({
      ...owningAutomation,
      model: session.model || owningAutomation.model,
    });
    if (validation) throw new Error(validation.error);
  }
  // Hoisted so the catch below can unregister credentials and dispose a
  // sandbox when launch fails after ensure but before the event stream exists.
  let rpcToken: string | undefined;
  let disposableResumeSandbox:
    | { provider: ReturnType<typeof getSandboxProvider>; id: string }
    | undefined;
  const disposeResumeSandbox = async () => {
    const owned = disposableResumeSandbox;
    if (!owned) return;
    disposableResumeSandbox = undefined;
    await disposeAutomationSandbox({
      provider: owned.provider,
      sandboxId: owned.id,
      sessionId: session.id,
    });
  };
  const sandboxStartedAt = Date.now();
  try {
    if (isAgentSessionCancelled(session.id, opts.startToken))
      return cancelledRun();
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
    const automationSandbox = disposableAutomationResume
      ? sandboxAutomationConfig()
      : undefined;
    const resumeModel = disposableAutomationResume
      ? automationModel(session.model || owningAutomation?.model)
      : undefined;
    const sandbox = await ensureSandboxWithTransientRetry(
      provider,
      {
        sessionId: session.id,
        repo: owningAutomation
          ? getRepo(owningAutomation.repo).id
          : session.repo,
        branch: session.branch || undefined,
        mode: session.mode,
        ...(disposableAutomationResume
          ? {
              trustProfile: "automation" as const,
              egressAllowlist: [
                ...(automationSandbox?.egressAllowlist || []),
                ...automationModelEgressDestinations(resumeModel || ""),
                ...mcpEgressDestinations(
                  filterMcpServers(
                    owningAutomation?.mcpServers || [],
                    undefined,
                    [],
                  ),
                ),
              ],
            }
          : {
              cwd: opts.cwd,
              // Bind-mode containers mount attached repos too (a changed set
              // recreates the container); volume mode rejects them in ensure().
              attachedDirs: (session.attachedRepos || [])
                .map((r) => r.dir)
                .filter(Boolean),
            }),
      },
      {
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
      },
    );
    if (disposableAutomationResume) {
      disposableResumeSandbox = { provider, id: sandbox.id };
    }
    if (isAgentSessionCancelled(session.id, opts.startToken)) {
      await disposeResumeSandbox();
      return cancelledRun(sandbox);
    }
    // Remote engine databases live inside the sandbox. A replacement VM cannot
    // resume the old engine id, even when its git workspace was safely pushed.
    const previousSandboxId = session.sandbox?.sandboxId;
    const remoteSandboxReplaced =
      isRemoteSandboxProvider(sbProvider) && previousSandboxId !== sandbox.id;
    if (remoteSandboxReplaced && previousSandboxId) {
      // A restored remote workspace keeps its Portal registry but none of the
      // old sandbox's processes or relays. Remove dead URLs before publishing
      // the replacement sandbox ID; its declared Portals can then start cleanly.
      await dropSandboxPreviewRoutes(previousSandboxId).catch((error) =>
        console.warn(
          `[sandbox] could not drop stale Portal routes for ${previousSandboxId}:`,
          error,
        ),
      );
    }
    const legacyEngine = (session.sandbox as { engine?: unknown } | undefined)
      ?.engine;
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
    rpcToken = crypto.randomUUID();
    registerRunToken(rpcToken, {
      sessionId: session.id,
      user: opts.isAutomationSession ? undefined : opts.user,
    });
    // Detached sandbox hosts cannot read the server's workspace store. Resolve
    // the picker-only workspace preset before crossing that boundary. A preset
    // matching built-in Dial/Orchestrator wiring keeps that portable id, while
    // an ordinary custom preset carries its concrete lead model.
    const workspacePreset = resolveWorkspaceModelPreset(session.model);
    const portablePreset = workspacePreset
      ? portableWorkspacePresetRun(workspacePreset)
      : undefined;
    const spec: RunHostSpec = {
      // Bind the physical sandbox host to the admitted run token, exactly like
      // the Runner and local paths: exact-token Stop must reach the live host,
      // and restart adoption must reattach under the same durable identity.
      hostId: opts.startToken || `rh-${randomUUIDv7()}`,
      osSessionId: session.id,
      prompt: opts.prompt,
      promptEntryId: opts.promptEntryId,
      seedTranscriptEntries: opts.seedTranscriptEntries,
      engineSessionId: remoteSandboxReplaced
        ? undefined
        : opts.engineSessionId || undefined,
      cwd: sandbox.cwd,
      mode: session.mode,
      model: portablePreset?.model ?? session.model,
      selectedModel: portablePreset?.selectedModel,
      images: opts.images,
      // Interactive remote sandboxes keep Open Session's in-process tools
      // through proxyMcpServers below, but cannot run the host's external MCP
      // commands or reuse its dynamic OAuth state. Sending "all" made every
      // turn wait on a ladder of ENOENT, 401 and 60s timeout failures before
      // the model could answer. Automation keeps its explicit fail-closed
      // allowlist because those remote connectors are part of its contract.
      ...sandboxRunSecuritySpec(session, opts),
      rpcToken,
      reposNote: opts.isAutomationSession
        ? undefined
        : await buildSessionNote(session, opts.user),
      confirmTools: STRIPE_CONFIRM_TOOLS,
      author: commitAuthorFor(
        opts.isAutomationSession ? undefined : opts.user,
        opts.isAutomationSession ? undefined : session.startedBy,
      ),
      fallbackModel: opts.isAutomationSession
        ? undefined
        : interactiveFallbackModel(session.model),
      effort: portablePreset?.effort ?? session.effort,
      fastMode: session.fastMode,
      accountId: disposableAutomationResume
        ? owningAutomation?.accountId
        : session.accountId,
      accountStrict: disposableAutomationResume ? true : undefined,
      usageCredits: disposableAutomationResume
        ? owningAutomation?.usageCredits
        : undefined,
    };
    if (isAgentSessionCancelled(session.id, opts.startToken)) {
      unregisterRunToken(rpcToken);
      rpcToken = undefined;
      await disposeResumeSandbox();
      return cancelledRun(sandbox);
    }
    const runCallbacks = {
      onAskUser: makeAskHandler(session.id),
      // A steer that reached the in-container run too late must not
      // evaporate. Hand it back to the queue, receipt and all.
      onSteerFailed: (text: string) =>
        requeueFailedSteer(session.id, text, opts.user),
    };
    // Launch eagerly (docker exec + socket connect awaited here) so failure is
    // visible before the stream begins and the prompt is never rerouted.
    const handle = sandbox.launchRunEager
      ? await sandbox.launchRunEager(spec, runCallbacks)
      : sandbox.launchRun(spec, runCallbacks);
    if (isAgentSessionCancelled(session.id, opts.startToken)) {
      handle.cancel();
      unregisterRunToken(rpcToken);
      rpcToken = undefined;
      await disposeResumeSandbox();
      return cancelledRun(sandbox);
    }
    console.log(
      `[sandbox] ${session.id}: running in ${sandbox.id} (${sandbox.cwd})`,
    );
    const events = disposableAutomationResume
      ? (async function* (): AsyncGenerator<StreamEvent> {
          try {
            yield* handle.events();
          } finally {
            unregisterRunToken(rpcToken);
            rpcToken = undefined;
            try {
              await disposeResumeSandbox();
            } catch (error) {
              console.error(
                `[sandbox] could not dispose automation Executor ${sandbox.id} after follow-up:`,
                error,
              );
            }
          }
        })()
      : handle.events();
    return Object.assign(events, {
      freshEngine: remoteSandboxReplaced || undefined,
      sandboxProvider: sbProvider,
      sandboxId: sandbox.id,
      sandboxReadyMs: Date.now() - sandboxStartedAt,
    });
  } catch (e: any) {
    unregisterRunToken(rpcToken);
    const reason = String(e?.message || e).slice(0, 200);
    const hadDisposableResumeSandbox = !!disposableResumeSandbox;
    if (hadDisposableResumeSandbox) {
      try {
        await disposeResumeSandbox();
      } catch (error) {
        console.error(
          `[sandbox] could not dispose automation Executor after launch failure:`,
          error,
        );
      }
    }
    if (
      (!disposableAutomationResume || !hadDisposableResumeSandbox) &&
      session.source === "opensession" &&
      session.sandbox
    ) {
      touchNativeSession(session.id, {
        sandbox: {
          ...session.sandbox,
          lifecycle: "needs_attention",
          lastLifecycleError: reason,
        },
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
    console.error(
      `[sandbox] ${session.id}: launch failed — prompt not run:`,
      e,
    );
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
export async function maybeQueueAutoContinue(opts: {
  sessionId: string;
  assistantText: string;
  toolUseCount: number;
  endedWithError: boolean;
  runFailure: string | null;
  /** Skip the lookup when the caller already holds the session. */
  session?: UnifiedSession | null;
}): Promise<boolean> {
  const { sessionId, assistantText, toolUseCount, endedWithError, runFailure } =
    opts;
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
  if (queuedBehind > 0 && toolUseCount > 0)
    autoContinueNudged.delete(sessionId);
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
      !(await isUserStopped(sessionId))
    ) {
      const trailing = (await trailingUserTexts(session)).filter(
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
        await enqueuePrompt(
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
          await enqueuePrompt(
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
  if (session.source !== "opensession")
    return suppressed(`source_${session.source}`);
  if (session.automation) return suppressed("automation_session");
  if (await isUserStopped(sessionId)) return suppressed("user_stop");
  if (autoContinueNudged.has(sessionId)) return suppressed("already_nudged");
  if (!(announcesNextAction(assistantText) || endedOnFabricatedTranscript))
    return false;
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
  await enqueuePrompt(
    sessionId,
    {
      content: wrapContext(
        endedOnFabricatedTranscript
          ? AUTO_CONTINUE_FABRICATED_PROMPT
          : AUTO_CONTINUE_PROMPT,
        "auto-continue",
      ),
      user: AUTO_CONTINUE_USER,
    },
    { front: true },
  );
  return true;
}

class RunPreparationDeferredError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} already has an accepted run preparation`);
  }
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
  sourceMessageIds?: string[],
): Promise<void> {
  // Any explicit new run lifts a user stop — the queue may drain again.
  stoppedSessions.delete(sessionId);
  // A direct send to a sandbox can spend minutes provisioning before its run
  // journal exists. Give it the same durable dispatch record as a queue drain,
  // so a restart during provisioning requeues the complete prompt.
  let durablePromptEntryId = promptEntryId;
  if (!durablePromptEntryId && findSession(sessionId)?.sandbox) {
    durablePromptEntryId = await beginPromptDispatch(sessionId, [
      {
        content,
        user,
        ...(images?.length
          ? {
              images: images.map(
                (image) => `data:${image.mediaType};base64,${image.data}`,
              ),
            }
          : {}),
        ...(rawFiles !== undefined ? { files: rawFiles } : {}),
        ...(contextSessions?.length ? { contextSessions } : {}),
        ...(slackReplyTo ? { slackReplyTo } : {}),
      },
    ]);
  }
  // Synchronously reserve the session BEFORE the awaits below (worktree revive,
  // title gen, upload staging) register the run with the runner — otherwise two
  // racing prompts both pass isAgentSessionBusy and the loser's message is
  // dropped as a "Session is busy" error toast.
  const startToken = await markSessionStarting(sessionId);
  if (currentAgentRunToken(sessionId) !== startToken) {
    // A queue-drain caller restores its own claimed dispatch in the catch
    // below. A direct sandbox dispatch was created here and must be restored
    // before surfacing the deferral.
    if (!promptEntryId && durablePromptEntryId) {
      await failPromptDispatch(sessionId, durablePromptEntryId);
    } else if (!durablePromptEntryId) {
      await enqueuePrompt(sessionId, {
        content,
        user,
        ...(images?.length
          ? {
              images: images.map(
                (image) => `data:${image.mediaType};base64,${image.data}`,
              ),
            }
          : {}),
        ...(rawFiles !== undefined ? { files: rawFiles } : {}),
        ...(contextSessions?.length ? { contextSessions } : {}),
        ...(slackReplyTo ? { slackReplyTo } : {}),
      });
    }
    unmarkSessionStarting(sessionId, startToken);
    watchExternalRunAndDrain(sessionId);
    throw new RunPreparationDeferredError(sessionId);
  }
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
      durablePromptEntryId,
      sourceMessageIds,
    );
    // Sandboxes and non-standard runners may not create an active-run journal.
    // A completed turn is nevertheless a safe acknowledgement of its dispatch.
    await acknowledgePromptDispatch(sessionId, durablePromptEntryId);
  } catch (e) {
    // A throw before the run registered (workspace revive, session-note
    // build, …) would strand the FSM in "starting" forever — the wedge the
    // run-state watchdog flags. Settle it; later throws have their own
    // terminal transitions and are left alone.
    if (getRunState(sessionId) === "starting")
      await transitionRunState(sessionId, "start_failed", {
        source: "prompt_throw",
        error: String(e),
      });
    // A direct sandbox send owns the dispatch it created above, so a normal
    // start failure retires that recovery record. A queue drain passes its own
    // dispatch in and must retain it for the caller to restore atomically.
    if (!promptEntryId)
      await acknowledgePromptDispatch(sessionId, durablePromptEntryId);
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
  sourceMessageIds?: string[],
): Promise<void> {
  const autoRetry = await retryAutoFallbackModel(sessionId);
  const session = findSession(sessionId);
  if (!session) return;
  if (autoRetry) {
    broadcastToSession(sessionId, {
      type: "model_changed",
      sessionId,
      model: autoRetry.model,
      from: autoRetry.fromModel,
      by: autoRetry.by,
    });
  }

  // A fresh human prompt re-arms the announce-then-stop guard (the nudge's
  // own delivery keeps the flag, capping it at one consecutive auto-continue).
  if (user !== AUTO_CONTINUE_USER) autoContinueNudged.delete(sessionId);

  // The engine session id depends on the session's model: codex models resume
  // the codex thread, claude models the claude session. A missing engine id
  // just means "first run on this provider" — a fresh thread/session starts.
  // Native picker ids still dispatch through Pi. Once a session has run,
  // resume the engine that actually owns its session id rather than inferring a
  // legacy provider from the unchanged user selection.
  // An explicit engine choice on the model id (pi/, claude/, codex/), or the
  // per-model default engine for an interactive session, decides which engine
  // this turn runs on — ahead of the engine that last drove the session. The
  // routing changed, and that IS the cross-engine switch the handoff below
  // exists for; without this the turn would hand the previous engine's
  // session id to the new engine and resume nothing. Unrouted ids (native
  // slugs, pi/…) keep the historic order exactly.
  const routedEngine = routeModel(session.model, {
    interactive: !session.automation,
  }).engine;
  const provider = routedEngine;
  let effectiveProvider: Provider = provider;
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

  // A teammate sending into someone else's session needs explicit attribution:
  // bare transcript turns belong to the session owner. Apply it before durable
  // intake so the sender stays correct even when setup or engine launch fails.
  // Multi-message queue drains arrive pre-attributed, and context-only turns
  // are nobody's message; withPromptAttribution leaves both unchanged.
  let prompt = withPromptAttribution(content, user, session.startedBy);

  // Durable intake (2026-07-24, bks-019f93ea): persist the user's message to
  // the transcript store NOW, before the worktree/title/engine-spawn awaits,
  // so a process death anywhere in the run path can no longer lose it. The
  // uuid threads through to every runner as promptEntryId, so a detached or
  // sandbox host's transcript forwarding upserts this same row instead of
  // duplicating the bubble. This must include sandbox runs: a remote host can
  // finish empty or fail during MCP startup before it emits any transcript
  // entry, which previously made an accepted prompt disappear completely.
  const durablePromptEntryId = promptEntryId || crypto.randomUUID();
  if (content?.trim()) {
    await storeAppendUserLineEarly(
      sessionId,
      transcriptLineUser(
        prompt,
        durablePromptEntryId,
        undefined,
        images,
        sourceMessageIds,
      ),
      { required: true },
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
  // so a fresh pi session's persisted transcript is seeded with them
  // (keeps the UI transcript continuous across an engine migration).
  let switchHandoffEntries: TranscriptEntry[] = [];
  // Anthropic and OpenAI models both report provider "pi", but they run
  // on different servers: a family switch (claude-* ↔ gpt-*) can't resume the
  // engine session and starts fresh, so it needs the same bridge as a classic
  // cross-provider switch. Detected via the model that last actually drove a
  // run (bks-019f57a0 dropped its visible history across exactly this switch,
  // 2026-07-12; sessions from before lastEngineModel existed skip this and
  // still get the runner's prior-transcript file seeding).
  const familySwitch =
    lastProvider === "pi" &&
    provider === "pi" &&
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
        ? await readEngineHandoffTranscriptAsync(
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
      let revived = false;
      try {
        cwd = await reviveWorktree(session.branch, repo.id);
        revived = true;
      } catch (e) {
        broadcastToSession(sessionId, {
          type: "notice",
          message: `Couldn't recreate the worktree (${e}); running in the main checkout instead.`,
        });
        cwd = repo.repo;
      }
      // A branch rename changes reviveWorktree's path. Keep the owning row on
      // the checkout we just created so activity protection and every later
      // turn stop targeting the missing pre-rename path.
      if (
        revived &&
        session.source === "opensession" &&
        cwd !== session.worktreeDir
      ) {
        await updateSessionFile(session.id, (data) => ({
          ...data,
          worktreeDir: cwd,
        }));
        session.worktreeDir = cwd;
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
  // Bridge a cross-provider engine switch (computed above) so the incoming
  // engine continues the conversation instead of starting blank. Fenced so the
  // transcript shows only the human's message — the model-switch divider already
  // marks the engine change; the handoff itself is plumbing (see prompt-context).
  if (switchHandoff)
    prompt = `${wrapContext(switchHandoff, "handoff")}\n\n${prompt}`;
  // Bridge a Desk voice call into this text turn: the GPT Realtime turns are
  // mirrored into the visible transcript, but the text engine's own
  // conversation state never saw them — without this note the first text
  // message after a call gets a Desk that's amnesiac about the conversation
  // it apparently just had (see desk-voice.ts).
  if (session.desk) {
    const voiceHandoff = takeVoiceHandoff(sessionId);
    if (voiceHandoff)
      prompt = `${wrapContext(voiceHandoff, "handoff")}\n\n${prompt}`;
  }
  // Sibling-session transcripts attached from the fresh-session "Add session
  // transcripts" chips: inline a bounded digest of each, fenced so the rendered
  // transcript shows only the human's message. Skip automation sessions because
  // their prompts are untrusted text.
  const inlinedSessionIds = new Set<string>();
  if (!session.automation) {
    const attachedIds = duplicateContextSessionIds(
      session,
      contextSessions ?? [],
    );
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
        // Async: an attached session's transcript can be multi-MB. Read the
        // actor-owned transcript first, with the legacy file fallback.
        entries: await mergedSessionTranscriptAsync(s),
      });
    }
    for (const c of attachedDigests) inlinedSessionIds.add(c.id);
    if (attachedDigests.length)
      prompt = `${wrapContext(buildSessionContextNote(attachedDigests), "attached-session-excerpt")}\n\n${prompt}`;
  }
  // Non-image attachments: stage to disk and tell the agent where they landed.
  prompt = withUploadsNote(prompt, stageFileAttachments(sessionId, rawFiles));
  // The goal guides the model on every turn, but it is session-level system
  // context, not text the person added to this message. Fence it so the model
  // sees it while transcript projections keep the user bubble unchanged.
  if (session.goal) {
    prompt = `${wrapContext(
      `Pinned session goal. Keep working toward it and note how this turn advanced it:\n\n${session.goal}`,
      "pinned-goal",
    )}\n\n${prompt}`;
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

  // Retrieval is query-specific context for this turn. Keep it out of the
  // stable system prefix so an unrelated memory write cannot invalidate every
  // cached token behind the run instructions.
  if (!isAutomationSession) {
    const memoryContext = await retrievedMemoryNoteFor(
      content,
      user,
      sessionRepoIds(session),
    );
    if (memoryContext) prompt = `${memoryContext}\n\n${prompt}`;
  }

  // @session:<id> mentions → footer resolving them for the agent's
  // opensession-sessions tools. Interactive sessions only (same gate as the tools).
  if (!isAutomationSession) {
    const mentionsNote = sessionMentionsNote(prompt, inlinedSessionIds);
    if (mentionsNote) prompt += `\n\n${mentionsNote}`;
  }

  // First engine turn of a feed-workspace session that was born prompt-less
  // (tab-strip "+" siblings): inject the workspace's external-object context
  // (video metadata + transcript excerpt, scratch-dir note) exactly
  // like the create_session paths do — a session must get this context no
  // matter how it was created (the feeds design).
  if (
    !isAutomationSession &&
    session.externalRefs?.length &&
    !session.claudeSessionId &&
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
      if (refsContext)
        prompt += `\n\n${wrapContext(refsContext, "external-refs")}`;
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
    const provisional = !session.title || session.title === "New session";
    const titleSource = await nameKnownSessionReferencesForTitle(
      provisional ? content : session.title,
    );
    const firstLine = titleSource.trim().split("\n")[0].slice(0, 80);
    if (provisional && firstLine)
      touchNativeSession(session.id, { title: firstLine });
    void ensureGeneratedTitle(
      session.id,
      titleSource,
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
      ? (await readEngineTranscriptAsync(cwd, engineSessionId, "pi")).filter(
          (entry) => entry.id !== durablePromptEntryId,
        )
      : undefined;
  if (isAgentSessionCancelled(session.id, startToken)) return;
  if (
    session.automationDescendantPolicy &&
    !session.runner?.id &&
    !isRunnableSandboxProvider(session.sandbox?.provider)
  )
    throw new Error(
      "Automation descendants require a sandbox or an explicitly isolated Runner",
    );
  const runnerRun = await maybeLaunchRunnerRun(session, {
    prompt,
    hostId: startToken,
    shouldCancel: () => isAgentSessionCancelled(session.id, startToken),
    engineSessionId: engineSessionId || undefined,
    images,
    mcpServers: mcpServers ?? "all",
    user,
    reposNote: isAutomationSession
      ? undefined
      : await buildSessionNote(session, user),
  });
  const sandboxRun = runnerRun
    ? null
    : await maybeLaunchSandboxedRun(session, {
        prompt,
        promptEntryId: durablePromptEntryId,
        seedTranscriptEntries: piHostSeedEntries,
        engineSessionId: engineSessionId || undefined,
        cwd,
        user,
        images,
        mcpServers: mcpServers ?? "all",
        deniedTools,
        isAutomationSession,
        startToken,
      });

  // Defensive guard: a session with an explicit runnable provider must never
  // reach the host path, even if a future launcher regression returns null.
  if (
    !runnerRun &&
    !sandboxRun &&
    isRunnableSandboxProvider(session.sandbox?.provider)
  ) {
    const msg =
      "This session's workspace lives in its sandbox volume, but the sandbox is unavailable (disabled by config/kill-switch, or it failed to start) — the prompt was not run. Re-enable sandboxes and try again." +
      (session.sandbox?.provider === "daytona"
        ? " Daytona: if the launch failed because the sandbox could not dial back, check callbackBaseUrl and your org tier's egress (docs/self-hosting-sandboxes.md)."
        : "");
    broadcastToSession(sessionId, { type: "error", sessionId, message: msg });
    await recordRunOutcome(
      session.id,
      msg,
      startToken
        ? {
            runId: startToken,
            runGeneration: sessionKernel(session.id).runStateProjection()
              .generation,
            projectionId: `outcome:${startToken}`,
          }
        : undefined,
    );
    broadcastToSession(sessionId, { type: "stream_done", sessionId });
    broadcastToSession(sessionId, {
      type: "session_status",
      sessionId,
      isRunning: false,
    });
    return;
  }

  // Local detached run host for the pi engine: pi drives its turn in-process
  // via the SDK, so unlike pi there is no detachable engine server to
  // outlive a restart. Instead the whole turn moves into a transient
  // run-host unit (host-client.ts) that survives `systemctl restart` and is
  // reattached by the boot sweep (resumeLocalHostRun). Transcript writes are
  // proxied back over the host protocol, so the server stays the store's
  // only writer. On systemd hosts this path fails closed if detached hosts are
  // unavailable; it never absorbs an engine into the gateway's control-plane
  // cgroup. Automation-owned sessions ride it too, with the automation's
  // scoping intact: proxy names come from the same fail-closed automation
  // set the run-rpc fallback builder serves, while the repos note and MCP
  // grant identity are withheld.
  const hostedRun =
    !runnerRun && !sandboxRun && routedEngine === "pi"
      ? runAgentHosted({
          osSessionId: session.id,
          prompt,
          promptEntryId: durablePromptEntryId,
          startToken,
          shouldCancel: () => isAgentSessionCancelled(session.id, startToken),
          seedTranscriptEntries: piHostSeedEntries,
          sessionId: engineSessionId || undefined,
          cwd,
          mode: session.mode,
          // Automation runs pass no MCP grant identity: a human's OAuth
          // grants must not ride an automation-owned session's turns.
          mcpGrantUser: isAutomationSession
            ? undefined
            : session.createdByLogin || undefined,
          model: session.model,
          images,
          mcpServers: mcpServers ?? "all",
          proxyMcpServers: session.automationDescendantPolicy
            ? []
            : isAutomationSession
              ? Object.keys(automationSessionMcp(session, sessionId))
              : [
                  ...Object.keys(interactiveMcpServers(user, sessionId)),
                  ...(session.goalId ? ["opensession-goal-self"] : []),
                ],
          reposNote: isAutomationSession
            ? undefined
            : await buildSessionNote(session, user),
          deniedTools,
          publicationPolicy: session.automationDescendantPolicy
            ? {
                repo: session.automationDescendantPolicy.publicationRepo,
                branch: session.automationDescendantPolicy.baseBranch,
                headBranch: session.branch || "",
              }
            : undefined,
          confirmTools: STRIPE_CONFIRM_TOOLS,
          aws: !isAutomationSession,
          author: commitAuthorFor(user, session.startedBy),
          user: runInputs.user,
          fallbackModel: interactiveFallbackModel(session.model),
          effort: session.effort,
          fastMode: session.fastMode,
          accountId: session.accountId,
          trustProfile: isAutomationSession ? "automation" : "interactive",
          journalKind: "prompt",
          onAskUser: makeAskHandler(sessionId),
          onSteerFailed: (text) => requeueFailedSteer(session.id, text, user),
          fallbackInProcessMcp: () =>
            isAutomationSession
              ? automationSessionMcp(session, sessionId)
              : session.goalId
                ? {
                    ...interactiveMcpServers(user, sessionId),
                    "opensession-goal-self": createGoalSelfMcpServer(
                      session.goalId,
                    ),
                  }
                : interactiveMcpServers(user, sessionId),
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

  for await (const event of runnerRun ??
    sandboxRun ??
    hostedRun ??
    runAgent({
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
      // Engine switch: seed the fresh pi session's persisted transcript
      // with the prior history (same entries the handoff note was built from)
      // so the UI transcript stays continuous. Everything dispatches onto the
      // pi engine, so no provider gate — the picker id's provider can be
      // "codex"/"claude" (bare gpt-5.6-sol) while the run still lands on
      // pi; the old `provider === "pi"` guard silently dropped the
      // seed for exactly those switches.
      seedTranscriptEntries:
        switchHandoff && switchHandoffEntries.length
          ? switchHandoffEntries
          : undefined,
      mcpServers: mcpServers ?? "all",
      // Self-management tools for normal sessions; withheld from automation
      // sessions (and their interactive resumes), same gate as deniedTools
      // above. Automation-owned sessions keep their automation-bar set
      // (papercuts + report/workflows rebuild + the selfImprove pair, the
      // same fail-closed set the hosted path proxies and run-rpc's fallback
      // builder serves) so a Slack thread reply reaches a session with the
      // same tools its unattended run had.
      // A goal-driven session also gets its own opensession-goal-self controls, so an
      // interactive turn (a human steering it in the UI) can set the next wake,
      // append to the ledger, or pause/finish — the same tools the headless wake has.
      inProcessMcp: session.automationDescendantPolicy
        ? {}
        : isAutomationSession
          ? automationSessionMcp(session, sessionId)
          : session.goalId
            ? {
                ...interactiveMcpServers(user, sessionId),
                "opensession-goal-self": createGoalSelfMcpServer(
                  session.goalId,
                ),
              }
            : interactiveMcpServers(user, sessionId),
      reposNote: isAutomationSession
        ? undefined
        : await buildSessionNote(session, user),
      deniedTools,
      publicationPolicy: session.automationDescendantPolicy
        ? {
            repo: session.automationDescendantPolicy.publicationRepo,
            branch: session.automationDescendantPolicy.baseBranch,
            headBranch: session.branch || "",
          }
        : undefined,
      confirmTools: STRIPE_CONFIRM_TOOLS,
      aws: !isAutomationSession, // automation descendants never receive AWS credentials
      // Attribute any commits this turn makes to whoever sent the prompt, or
      // to whoever the session belongs to when nobody did (an auto-continue,
      // a restart resume, a queue drain).
      author: commitAuthorFor(user, session.startedBy),
      // Gate per-user MCP servers (allowedUsers) to the prompt's author. Automation
      // sessions pass no user, so they never see a user-restricted server.
      user: runInputs.user,
      // The creator grant also gives provider routing a safe human identity for
      // synthetic continuations such as worker reports and restart recovery.
      mcpGrantUser: runInputs.mcpGrantUser,
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
      case "steer_delivered":
        // Exact engine acknowledgement, consumed internally. Context-only
        // system steers are intentionally absent from the visible transcript,
        // so transcript matching alone cannot retire their receipts.
        if (event.steerId)
          await acknowledgeSteerDelivery(sessionId, event.steerId);
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
              await appendTranscriptEntries(ocId, [
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
          await enqueuePrompt(sessionId, { content, user });
          watchExternalRunAndDrain(sessionId);
          broadcastToSession(sessionId, {
            type: "notice",
            message:
              "Session was busy — message queued; it sends when the current run finishes.",
          });
          return;
        }
        if (event.usage) {
          latestUsage = foldSessionUsage(
            usageBase,
            event.usage,
            event.model || effectiveModel,
          );
          broadcastToSession(sessionId, {
            type: "usage_update",
            sessionId,
            usage: latestUsage,
          });
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
    touchNativeSession(session.id, {
      ...engineSessionPatch(effectiveProvider, finalSessionId),
      lastEngineProvider: effectiveProvider,
      ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
      ...(latestUsage
        ? {
            usage: latestUsage,
            ...(startToken ? { usageRunId: startToken } : {}),
          }
        : {}),
      ...(headBranch && headBranch !== session.branch
        ? { branch: headBranch }
        : {}),
    });
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
  await recordRunOutcome(session.id, runFailure, {
    engineSessionId: finalSessionId || session.claudeSessionId || undefined,
    noticePersisted: failureNoticePersisted,
    noticeLabel: failureNoticeLabel,
    ...(startToken
      ? {
          runId: startToken,
          runGeneration: sessionKernel(session.id).runStateProjection()
            .generation,
          projectionId: `outcome:${startToken}`,
        }
      : {}),
  });

  // A socket-level steer acceptance is not engine delivery. Exact boundary
  // acknowledgements already retired consumed receipts; anything left must
  // become the immediate next turn, including after a clean run-end race.
  const unreadSteers = await requeueSteerReceipts(
    sessionId,
    await engineUserTexts(session),
  );
  if (unreadSteers > 0) watchExternalRunAndDrain(sessionId);

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
  await maybeQueueAutoContinue({
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
    // Ephemeral providers can persist an exact, session-private filesystem
    // image now that the turn is quiescent. This is detached from response
    // latency; the provider serializes a follow-up restore behind it.
    if (
      !endedWithError &&
      sandboxRun?.sandboxId &&
      isRunnableSandboxProvider(sandboxRun.sandboxProvider)
    ) {
      const provider = getSandboxProvider(sandboxRun.sandboxProvider);
      if (provider.checkpoint) {
        void provider.checkpoint(sandboxRun.sandboxId).catch((error) => {
          console.warn(
            `[sandbox] checkpoint ${sandboxRun!.sandboxId} after ${sessionId} failed:`,
            error,
          );
        });
      }
    }
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
 * Expand session and workspace mentions into a footer the agent can act on
 * with its opensession-sessions tools. Tokens stay in the visible prompt while
 * this note resolves stable ids into names, state, and workspace membership.
 * Interactive sessions only: automations don't get opensession-sessions.
 */
export function sessionMentionsNote(
  content: string,
  excludeIds?: Iterable<string>,
): string | null {
  // Only the human's visible message counts. Fenced <opensession:context> blocks
  // can carry references too, and those must not grow a redundant, unfenced
  // mentions footer. `|| ""` guards the falsy input stripContext passes through.
  content = stripContext(content || "");
  // A session attached as a digest already carries its context. Skip it here so
  // it doesn't also get a pointer footer for the same id.
  const skip = new Set(excludeIds ?? []);
  const sessionIds = [
    ...new Set(
      // `os-` is the minted prefix. `bks-` is the pre-rename one kept by
      // sessions created before 2026-08-05.
      [...content.matchAll(/@session:((?:os|bks)-[0-9a-f-]+)/g)].map(
        (match) => match[1],
      ),
    ),
  ].filter((id) => !skip.has(id));
  const workspaceIds = [
    ...new Set(
      [...content.matchAll(/@workspace:(ws-[A-Za-z0-9_-]+)/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  if (!sessionIds.length && !workspaceIds.length) return null;

  const sections: string[] = [];
  if (sessionIds.length) {
    const lines = sessionIds.map((id) => {
      const session = findSession(id);
      if (!session) return `- @session:${id} · no session with this id`;
      const busy = isAgentSessionBusy(
        session.claudeSessionId,
        session.codexThreadId,
        session.id,
      );
      const bits = [
        session.title || "Untitled",
        session.branch ? `branch ${session.branch}` : null,
        busy ? "running" : "idle",
      ].filter(Boolean);
      return `- @session:${id} · ${bits.join(" · ")}`;
    });
    sections.push(`Sessions:\n${lines.join("\n")}`);
  }
  if (workspaceIds.length) {
    const sessions = getCachedSessions();
    const lines = workspaceIds.map((id) => {
      const workspace = getWorkspace(id);
      if (!workspace) return `- @workspace:${id} · no workspace with this id`;
      const members = sessions.filter(
        (session) => session.workspaceId === id && !session.archived,
      );
      const memberText = members.length
        ? members
            .map(
              (session) =>
                `@session:${session.id} (${session.title || "Untitled"})`,
            )
            .join(", ")
        : "no active sessions";
      const details = [workspace.repo, workspace.branch].filter(Boolean);
      return `- @workspace:${id} · ${workspace.name}${details.length ? ` · ${details.join(" · ")}` : ""} · ${memberText}`;
    });
    sections.push(`Workspaces:\n${lines.join("\n")}`);
  }

  return (
    `[The @ mentions above refer to Open Session work:\n${sections.join("\n\n")}\n` +
    `A workspace mention means its active member sessions. Use the opensession-sessions MCP tools ` +
    `with the resolved session ids: get_session (state, pending question, transcript tail), ` +
    `send_to_session (a message or a slash command such as "/loop 15m <prompt>"), ` +
    `answer_session_question, or cancel_session.]`
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
      if (!loop || session.archived || session.source !== "opensession")
        continue;
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
