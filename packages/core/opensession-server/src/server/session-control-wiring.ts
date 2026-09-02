/**
 * Wires the SessionControl registry (src/server/session-control.ts) — the
 * surface behind the opensession-sessions MCP — into the same in-process state and
 * helpers the WebSocket handlers use, so a management session lists/steers/
 * answers/creates exactly like a human in the web UI. Also keeps the linked
 * Slack-channel index + inbound-message bridge fresh. Module-scope side
 * effects: re-run on every hot reload (cheap, and keeps closures current).
 *
 * This module holds NO allowlist and gates nothing. Registering the surface is
 * unconditional; who may reach it is decided entirely at the wiring site —
 * opensession-sessions goes to interactive runs only (interactiveMcpServers in
 * interactive-mcp.ts, whose run-rpc builder fails closed for automation-owned
 * sessions). So a capability added to a callback here reaches every run kind
 * that already carries the server, and none that doesn't. Widen or narrow the
 * exposure there, never here.
 */

import { AUTO_CONTINUE_USER } from "./auto-continue";
import { personaName } from "./config";
import { currentAgentRunToken, isAgentSessionBusy } from "./agent-runner";
import { pendingAskAwaitingAnswer, pendingAsks, type PendingAsk } from "./asks";
import { relinkAskThreads } from "./human-asks";
import {
  SESSION_EFFORTS,
  type SessionEffort,
  providerFor,
  resolveModel,
} from "./models";
import { configuredInteractiveDefaultModel } from "./model-catalog";
import {
  deliveryQueueState,
  durableQueueItem,
  liftUserStop,
  promoteQueuedPrompt,
} from "./queue-state";
import { prepareAndSteerQueuedPrompt } from "./queued-steer";
import {
  storeAppendUserLineEarly,
  transcriptLineUser,
} from "./transcript-persistence";
import {
  drainQueue,
  enqueuePrompt,
  parkQueueForShutdown,
  requestTurnCancel,
  runSessionPrompt,
  sessionMentionsNote,
  watchExternalRunAndDrain,
} from "./run-session";
import {
  creationAttachmentPath,
  parseImageDataUrls,
  prepareCreationAttachmentSources,
  withUploadsNote,
} from "./uploads";
import { type Sandbox } from "./sandbox";
import {
  isRemoteSandboxProvider,
  resolveRequestedSandbox,
} from "./sandbox/config";
import { isShuttingDown } from "./shutdown-state";
import { resolveInteractiveSandbox } from "./sandbox/defaults";
import {
  findSession,
  getCachedSessions,
  getCachedSessionsAsync,
  getSessionListSnapshotAsync,
  invalidateSessionsCache,
  touchNativeSession,
  touchNativeSessionStrict,
} from "./session-cache";
import { nameKnownSessionReferencesForTitle } from "./session-reference-title";
import { validateSessionReparent } from "./session-parenting";
import {
  getSessionControl,
  type CreateSessionOpts,
  type SessionState,
  type SessionSummary,
  registerSessionControl,
} from "./session-control";
import {
  type ResolvedCreate,
  actorCreationSetupPlan,
  forkHandoffContext,
  runOpeningCreateOnce,
  resolveForkContext,
  resolvePinnedAccountId,
  waitForCreatedSessionProjection,
} from "./session-create";
import {
  resolveSessionRepoContext,
  workspaceOwningWorktree,
} from "./session-repos";
import { mergedSessionTranscriptAsync } from "./sessions";
import { rebuildIndex } from "./slack-links";
import { handleSlashCommand } from "./slash-commands";
import { type UnifiedSession } from "./types";
import { type Workspace, getWorkspace, updateWorkspace } from "./workspaces";
import { ownedWorktree } from "./session-workspace";
import {
  ensureAskCheckout,
  ensureScratchDir,
  getRepo,
  isRegisteredWorktree,
  listWorktrees,
  repoForPath,
  repoForPathOrNull,
  resolveUniqueBranch,
  worktreePathFor,
} from "./worktree";
import { broadcastToSession } from "./ws-hub";
import { randomUUIDv7 } from "bun";
import {
  patchCreationSetupPlan,
  requestCreationAttachment,
  requestCreationBranch,
  requestCreationCredential,
  requestCreationWorkspace,
  sessionAsk,
  sessionDelivery,
  sessionKernel,
  sessionTurn,
} from "./session-kernel";
import {
  canonicalCommandPayload,
  sessionIdForRequest,
} from "./session-request-id";
import {
  clearCreatePlan,
  createPlanWorkspaceId,
  restoreResolvedCreate,
  snapshotOpeningCreate,
} from "./session-create-plan";
import {
  githubCredentialForLogin,
  githubCredentialForPrincipal,
  githubCredentialForRun,
} from "./github-auth";
import { existsSync, watch } from "fs";
import { branchNameFromPrompt } from "./suggest-branch";
import {
  getRunner,
  runnerAvailableForSession,
  runnerWorkspacePath,
} from "./runners";
import { isRunnerConnected } from "./runner-ws";

/** Derive the at-a-glance state + control surface for a session (for the MCP). */
function buildSummary(
  s: UnifiedSession,
  pending?: PendingAsk,
  queuedCount = 0,
): SessionSummary {
  const busyHere = isAgentSessionBusy(s.claudeSessionId, s.codexThreadId, s.id);
  // External runs (CLI in tmux, another process) show as running via PID but
  // aren't in our activeRuns — observe-only, can't steer/cancel them.
  const runningExternal = !!s.isRunning && !busyHere;
  let state: SessionState;
  if (s.archived) state = "archived";
  else if (pending) state = "waiting_question";
  else if (busyHere || s.isRunning) state = "running";
  else if (queuedCount > 0) state = "queued";
  else state = "idle";

  return {
    ...s,
    state,
    queuedCount,
    controllable: !runningExternal,
    ...(pending
      ? {
          pendingQuestion: {
            questionId: pending.questionId,
            questions: pending.questions,
          },
        }
      : {}),
  };
}

const summaryState: {
  byId: Map<string, SessionSummary>;
  refresh?: Promise<void>;
} = ((
  globalThis as typeof globalThis & {
    __opensessionSessionSummaryState?: {
      byId: Map<string, SessionSummary>;
      refresh?: Promise<void>;
    };
  }
).__opensessionSessionSummaryState ??= { byId: new Map() });

function refreshSessionSummaries(): Promise<void> {
  if (summaryState.refresh) return summaryState.refresh;
  summaryState.refresh = (async () => {
    const [sessions, askEntries, queueEntries] = await Promise.all([
      getCachedSessionsAsync("include"),
      sessionAsk({ op: "entries" }),
      sessionDelivery({ op: "entries", slot: "queued" }),
    ]);
    const asks = new Map(
      (askEntries as Array<[string, PendingAsk]>).filter(
        ([, pending]) => !pending.answerReceived,
      ),
    );
    const queued = new Map(
      (queueEntries as Array<[string, unknown[]]>).map(([id, items]) => [
        id,
        items.length,
      ]),
    );
    const next = new Map<string, SessionSummary>();
    for (const session of sessions)
      next.set(
        session.id,
        buildSummary(
          session,
          asks.get(session.id),
          queued.get(session.id) ?? 0,
        ),
      );
    summaryState.byId = next;
  })().finally(() => {
    summaryState.refresh = undefined;
  });
  return summaryState.refresh;
}

function listSessionSummaries(): SessionSummary[] {
  void refreshSessionSummaries().catch((error) =>
    console.warn("[sessions] summary refresh failed:", error),
  );
  return getCachedSessions().map(
    (session) => summaryState.byId.get(session.id) ?? buildSummary(session),
  );
}

// --- Session control surface (powers the opensession-sessions MCP) ---
// Wire the Slack thread index (thread replies → owning session). Re-run on
// every hot reload (cheap) so the index stays fresh.
void getSessionListSnapshotAsync()
  .then((sessions) => {
    rebuildIndex(sessions);
    // rebuildIndex() clears the index, so replay the links the session files
    // don't hold: a human-ask DM thread belongs to the session that raised it.
    relinkAskThreads();
  })
  .catch((error) => console.warn("[slack-links] index rebuild failed:", error));

// Wires the MCP's tools into the same in-process state and helpers the
// WebSocket handlers use, so a management session steers/answers/creates the
// exact same way a human does in the web UI. See src/server/session-control.ts.
class SessionDeliveryError extends Error {
  constructor(
    readonly result: {
      status: "error";
      message: string;
      deliveryId: string;
    },
  ) {
    super(result.message);
  }
}

registerSessionControl({
  listSessions: listSessionSummaries,

  getSession: (id) => {
    void refreshSessionSummaries().catch((error) =>
      console.warn("[sessions] summary refresh failed:", error),
    );
    const s = findSession(id);
    return s ? (summaryState.byId.get(s.id) ?? buildSummary(s)) : undefined;
  },

  transcriptTail: async (id, n) => {
    const s = findSession(id);
    if (!s) return [];
    // Engine-spanning read (file + actor store) — same as the transcript
    // route, so get_session works after shared-store retirement.
    return (await mergedSessionTranscriptAsync(s)).slice(-Math.max(0, n));
  },

  answerQuestion: async (id, answers, opts) => {
    const requestId = opts?.requestId || randomUUIDv7();
    const questionId = (await pendingAskAwaitingAnswer(id))?.questionId || null;
    // The actor records the answer durably under the caller's retry
    // identity; the aggregate makes replay idempotent. The gateway-side
    // resolver then runs its live side effects (escalation cancel,
    // broadcast, tool-promise wake) — it owns the answerReceived flag.
    const settled = await sessionAsk({
      op: "answer",
      sessionId: id,
      questionId,
      answers,
      answeredVia: requestId,
    });
    if (!settled.matched) return false;
    // An exact retry must wake the waiter with the already-committed
    // answers, never the retry call's payload.
    const effective =
      settled.answers ??
      (answers && typeof answers === "object" ? answers : null);
    const pending = (await pendingAsks.getAsync(id)) as
      | {
          questionId?: string;
          resolve?: (value: unknown) => void | Promise<void>;
        }
      | undefined;
    if (
      pending?.resolve &&
      (questionId === null || pending.questionId === questionId)
    )
      await pending.resolve(effective);
    return true;
  },

  deliverToSession: async (id, content, user, opts) => {
    const deliveryId = opts?.deliveryId || randomUUIDv7();

    const identity = {
      content,
      user,
      busy: opts?.busy,
      hold: opts?.hold,
      reviewHandoff: opts?.reviewHandoff,
      admissionKey: opts?.admissionKey,
      contextSessions: opts?.contextSessions,
      slackReplyTo: opts?.slackReplyTo,
      attachmentsHash: new Bun.CryptoHasher("sha256")
        .update(
          JSON.stringify({
            imageUrls: opts?.imageUrls,
            images: opts?.images,
            files: opts?.files,
          }),
        )
        .digest("hex"),
    };
    const deliverOwned = async () => {
      const session = findSession(id);
      if (!session)
        throw new SessionDeliveryError({
          status: "error",
          message: "No session with that id.",
          deliveryId,
        });
      const priorDelivery = deliveryQueueState(id, deliveryId);
      if (priorDelivery === "steered")
        return {
          status: "steered" as const,
          message: "Folded into the running turn.",
          deliveryId,
        };
      if (priorDelivery === "queued" || priorDelivery === "dispatching")
        return {
          status:
            priorDelivery === "queued"
              ? ("queued" as const)
              : ("started" as const),
          message:
            priorDelivery === "queued"
              ? "Queued behind the current run."
              : "Started a new turn on the session.",
          deliveryId,
        };

      if (opts?.admit && !opts.admit())
        return {
          status: "handled" as const,
          message: "The delivery intent is no longer current.",
          deliveryId,
        };

      // Slash commands (/loop, /goal, /model, /help) are handled by opensession
      // itself, exactly like the WebSocket prompt path — checked BEFORE the
      // busy branch so "/loop stop" configures the session instead of being
      // steered into its running turn as literal prompt text. This is what
      // lets a monitor session manage loops (its own and others') via the
      // opensession-sessions send_to_session tool.
      const notice = handleSlashCommand(
        session,
        String(content || "").trim(),
        user,
      );
      if (notice !== null) {
        invalidateSessionsCache();
        return { status: "handled" as const, message: notice, deliveryId };
      }

      // A delivery is an explicit next action on this session, so it lifts a
      // prior Stop here rather than inside the run the Stop prevents: the busy
      // branch below only enqueues, and drainQueue parks at the latch, which
      // would leave the message queued forever.
      await liftUserStop(id);

      const attributed = user ? `[${user}] ${content}` : content;
      // Disk-staged files can only be supplied to a fresh turn. Never fold them
      // into a steer request, where the runner has no file staging channel.
      const hasFiles = Array.isArray(opts?.files) && opts.files.length > 0;
      const queuedItem = {
        id: deliveryId,
        content,
        user,
        images: opts?.imageUrls,
        files: opts?.files,
        contextSessions: opts?.contextSessions,
        slackReplyTo: opts?.slackReplyTo,
        ...(opts?.hold ? { hold: true } : {}),
        ...(opts?.reviewHandoff ? { reviewHandoff: true } : {}),
      };

      // A draining server accepts durable intake but must not steer it into an
      // old turn or start a new one. Check before the busy route, then check
      // again after enqueue below to close a shutdown that begins during it.
      if (isShuttingDown()) {
        await enqueuePrompt(id, queuedItem);
        parkQueueForShutdown(id);
        return {
          status: "queued" as const,
          message: "Queued while the server restarts.",
          deliveryId,
        };
      }

      if (
        isAgentSessionBusy(
          session.claudeSessionId,
          session.codexThreadId,
          session.id,
        )
      ) {
        // Busy + owned here → fold into the running turn (delivered at the next
        // stopping point). Otherwise queue and drain when the external run ends.
        // busy: "queue" opts out of steering; Slack-thread replies always set it
        // (and never steer regardless): the in-thread answer mirror only fires
        // on a turn that carries the slackReplyTo, and a steered message can't
        // (it folds into a turn that's already running).
        if (opts?.busy !== "queue" && !opts?.slackReplyTo && !hasFiles) {
          const steerItem = durableQueueItem(id, {
            id: deliveryId,
            content,
            user,
            images: opts?.imageUrls,
            contextSessions: opts?.contextSessions,
            ...(opts?.hold ? { hold: true } : {}),
            ...(opts?.reviewHandoff ? { reviewHandoff: true } : {}),
          });
          const steerResult = await prepareAndSteerQueuedPrompt({
            sessionId: id,
            itemId: deliveryId,
            item: steerItem,
            text: attributed,
            images: opts?.images,
          });
          if (steerResult === "steered") {
            return {
              status: "steered" as const,
              message: "Folded into the running turn.",
              deliveryId,
            };
          }
          if (steerResult === "rejected") {
            watchExternalRunAndDrain(id);
            return {
              // Physical steering lost the run-end race, but admission did
              // not: the visible transcript row is sent and the actor-owned
              // fallback is the immediate next turn.
              status: "steered" as const,
              message: "Sent to the session.",
              deliveryId,
            };
          }
          if (steerResult === "not_prepared") {
            const promptEntryId = steerItem.promptEntryId || deliveryId;
            await promoteQueuedPrompt(id, deliveryId, promptEntryId, {
              ...steerItem,
              promptEntryId,
            });
            await storeAppendUserLineEarly(
              id,
              transcriptLineUser(
                attributed,
                promptEntryId,
                undefined,
                opts?.images,
                [deliveryId],
              ),
              { required: true },
            );
            watchExternalRunAndDrain(id);
            return {
              status: "steered" as const,
              message: "Sent to the session.",
              deliveryId,
            };
          }
        }
        await enqueuePrompt(id, queuedItem);
        watchExternalRunAndDrain(id);
        return {
          status: "queued" as const,
          message: "Queued behind the current run.",
          deliveryId,
        };
      }
      // Open Session sessions with no engine id are fresh sessions — the first prompt
      // starts a new conversation (see runSessionPrompt).
      if (
        providerFor(session.model) === "claude" &&
        !session.claudeSessionId &&
        session.source !== "opensession"
      ) {
        throw new SessionDeliveryError({
          status: "error",
          message: "Session has no Claude session to resume yet.",
          deliveryId,
        });
      }

      // Every accepted prompt is durable before any engine or workspace wake.
      // A crash after this write but before dispatch replays the same queue id.
      await enqueuePrompt(id, queuedItem);
      // Intake stays available during graceful shutdown because the queue is
      // durable, but no new turn may start after the drain snapshot. Tell the
      // client where the message actually landed so it stays on one surface.
      if (parkQueueForShutdown(id)) {
        return {
          status: "queued" as const,
          message: "Queued while the server restarts.",
          deliveryId,
        };
      }
      void drainQueue(id).catch((error) =>
        console.error(`[sessions-mcp] deliver to ${id} failed:`, error),
      );
      return {
        status: "started" as const,
        message: "Started a new turn on the session.",
        deliveryId,
      };
    };
    const plan = await sessionDelivery({
      op: "request_submit_command",
      sessionId: id,
      requestId: deliveryId,
      identity,
    });
    if (plan.status === "completed") {
      const result = plan.result as Awaited<ReturnType<typeof deliverOwned>>;
      return { ...result, duplicate: true };
    }
    if (plan.status === "in_progress")
      throw Object.assign(new Error("Prompt delivery is already in progress"), {
        retryable: true,
      });
    let submitPhysicalFinished = false;
    try {
      const result = await deliverOwned();
      submitPhysicalFinished = true;
      return (await sessionDelivery({
        op: "complete_submit_command",
        sessionId: id,
        requestId: deliveryId,
        result,
      })) as typeof result;
    } catch (error) {
      if (error instanceof SessionDeliveryError) {
        submitPhysicalFinished = true;
        await sessionDelivery({
          op: "complete_submit_command",
          sessionId: id,
          requestId: deliveryId,
          result: error.result,
        });
        return error.result;
      }
      if (!submitPhysicalFinished)
        await sessionDelivery({
          op: "fail_submit_command",
          sessionId: id,
          requestId: deliveryId,
          error: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
  },

  cancelSession: async (id, opts) => {
    const requestId = opts?.requestId || randomUUIDv7();
    const plan = await sessionTurn({
      op: "request_cancel_command",
      sessionId: id,
      requestId,
      fallbackRunId: currentAgentRunToken(id) || null,
    });
    if (plan.status === "completed") return plan.result;
    let cancelPhysicalFinished = false;
    try {
      const currentSession = findSession(id);
      if (!currentSession) {
        cancelPhysicalFinished = true;
        return await sessionTurn({
          op: "complete_cancel_command",
          sessionId: id,
          requestId,
          result: false,
        });
      }
      await requestTurnCancel(id, currentSession, {
        cancelId: `stop:${requestId}`,
        expectedRunId: plan.targetRunId,
        expectedGeneration: plan.targetRunGeneration,
        source: "session_control",
      });
      cancelPhysicalFinished = true;
      return await sessionTurn({
        op: "complete_cancel_command",
        sessionId: id,
        requestId,
        result: true,
      });
    } catch (error) {
      if (!cancelPhysicalFinished)
        await sessionTurn({
          op: "fail_cancel_command",
          sessionId: id,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
  },

  reparentSession: async (id, parentSessionId) => {
    const validation = validateSessionReparent(
      id,
      parentSessionId,
      findSession,
    );
    if (!validation.ok) return validation;

    const previousParentSessionId = validation.session.parentSessionId;
    if (previousParentSessionId === parentSessionId) {
      return {
        ok: true as const,
        previousParentSessionId,
        parentSessionId,
        changed: false,
      };
    }

    // Report receipts and failure-beacon throttles belong to the old parent.
    // Clear them atomically with the relationship so the new parent can receive
    // a fresh report without inheriting suppression state.
    await touchNativeSessionStrict(id, {
      parentSessionId,
      lastReportToParentAt: undefined,
      parentNotifiedAt: undefined,
    });
    summaryState.byId.delete(id);
    return {
      ok: true as const,
      previousParentSessionId,
      parentSessionId,
      changed: true,
    };
  },

  createSession: async (input: CreateSessionOpts) => {
    const requestId = input.requestId || randomUUIDv7();
    const actorScope = input.requestScope || input.user || "automation";
    const requestedId = input.id || sessionIdForRequest(actorScope, requestId);
    const ownedInput: CreateSessionOpts = {
      ...input,
      id: requestedId,
      requestId,
    };
    // The creation FSM below is the durable/idempotent owner. Do not put a
    // second create_session command around it: the outer command would wait for
    // projection while the opening effect waits for its session-file command.
    const {
      prompt,
      branch,
      baseRef,
      stackedOnBranch,
      repo: repoInput,
      repoLess,
      mode,
      model: modelInput,
      effort: effortInput,
      fastMode: fastModeInput,
      images: imageUrls,
      files: rawFiles,
      mcpServers,
      runner: runnerInput,
      automationDescendantPolicy,
      workspaceId,
      isolatedWorktree,
      parentSessionId,
      spawnDepth,
      agentStarted,
      spawnedBy: spawnedByInput,
      reportBack,
      user,
      createdByLogin,
      sandbox,
      forkFrom,
      accountId: accountIdInput,
    } = ownedInput;
    const bksId = requestedId;
    const createIdentity = new Bun.CryptoHasher("sha256")
      .update(canonicalCommandPayload(ownedInput))
      .digest("hex");
    const durableCreation = await sessionKernel(bksId).creationState();
    if (durableCreation && durableCreation.identity !== createIdentity)
      throw new Error(
        "Create request identity crossed durable session ownership",
      );
    let completedCreate = findSession(requestedId);
    if (
      durableCreation?.state === "opening_dispatched" ||
      durableCreation?.state === "ready" ||
      durableCreation?.state === "failed" ||
      durableCreation?.state === "cancelled"
    ) {
      completedCreate = await waitForCreatedSessionProjection(
        bksId,
        createIdentity,
      );
      if (
        durableCreation.state === "ready" ||
        durableCreation.state === "cancelled"
      )
        clearCreatePlan(bksId);
      return {
        id: bksId,
        createdBy:
          completedCreate.createdBy ||
          completedCreate.startedBy ||
          user ||
          "Anonymous",
        createdAt:
          completedCreate.createdAt ||
          new Date(durableCreation.updatedAt).toISOString(),
      };
    }
    if (
      completedCreate?.claudeSessionId ||
      completedCreate?.codexThreadId ||
      completedCreate?.piSessionId
    ) {
      clearCreatePlan(bksId);
      return {
        id: completedCreate.id,
        createdBy:
          completedCreate.createdBy ||
          completedCreate.startedBy ||
          user ||
          "Anonymous",
        createdAt: completedCreate.createdAt || new Date().toISOString(),
      };
    }
    let createPlan = await actorCreationSetupPlan(bksId, createIdentity);
    // Fork: branch a new session off an existing one — same rules as the
    // web create (shares the source's cwd/branch/model; Claude sources are
    // cloned via SDK forkSession, others get a transcript handoff). An
    // unknown source id fails the create loudly.
    const fork = resolveForkContext(forkFrom);
    // Scratch: repo-less sessions (feed-item workspaces — the feeds design).
    const isScratch = fork
      ? fork.source.mode === "scratch"
      : mode === "scratch";
    const isAsk = fork
      ? !isScratch && fork.source.mode !== "code"
      : !isScratch && mode !== "code";
    const isRepoLess = fork
      ? isScratch || fork.source.repoLess === true
      : isScratch || (isAsk && repoLess === true);
    const model = fork
      ? fork.source.model
      : (modelInput ? resolveModel(String(modelInput))?.id : undefined) ||
        configuredInteractiveDefaultModel();
    // Same validation as the web palette's create_session: unknown efforts
    // are dropped rather than persisted; images arrive as data URLs. Forks
    // inherit the source's effort/fast-mode/account pin, like the web path.
    const createEffort = fork
      ? fork.source.effort
      : typeof effortInput === "string" &&
          (SESSION_EFFORTS as readonly string[]).includes(
            effortInput.trim().toLowerCase(),
          )
        ? (effortInput.trim().toLowerCase() as SessionEffort)
        : undefined;
    const createFastMode = fork
      ? fork.source.fastMode === true
      : fastModeInput === true;
    // Pinned provider account: validated exactly like the web palette
    // (mismatched/unknown/foreign ids drop to the pool).
    const createAccountId = fork
      ? fork.source.accountId
      : resolvePinnedAccountId(model, accountIdInput, user);
    const images = parseImageDataUrls(imageUrls);
    const parentSession = parentSessionId ? findSession(parentSessionId) : null;
    // opensession-sessions is withheld from automation-owned runs. Scope the
    // server-owned worktree fetch to this trusted interactive creator.
    const githubCredential = parentSession?.automation
      ? null
      : parentSession?.createdByLogin
        ? githubCredentialForLogin(parentSession.createdByLogin)
        : githubCredentialForRun(user || parentSession?.createdBy);
    const githubGitEnv = githubCredential?.env;
    // Attribution only (CreateSessionInput.spawnedBy): the session whose agent
    // asked for this one, recorded even when the create was standalone and
    // carries no parent link. It is what lets the sidebar keep an agent's own
    // helper sessions — a scratch session spun up mid-run — out of the human's
    // rows. The Desk is deliberately exempt: it delegates on the user's behalf,
    // so the work it spawns is the user's own and stays visible.
    const spawnerSession = spawnedByInput ? findSession(spawnedByInput) : null;
    const spawnedBy =
      spawnerSession && !spawnerSession.desk ? spawnerSession.id : undefined;
    // Explicit workspace join (the native apps' "new session in this workspace" —
    // this path's equivalent of the web tab strip's "+"). An unknown id is a
    // hard error: falling back to a standalone create would silently mint the
    // duplicate sidebar row the caller asked to avoid.
    const joinedWorkspace = workspaceId ? getWorkspace(workspaceId) : null;
    if (workspaceId && !joinedWorkspace) {
      throw new Error(`No such workspace: ${workspaceId}`);
    }
    // A child defaults to the parent's primary repo, but an explicit repo —
    // or a prompt that names exactly one attached worktree — inherits that
    // exact repo context. This is load-bearing for reviewers of in-progress
    // attached-repo work: a fresh ask checkout cannot see those changes.
    const parentRepoContext = parentSession
      ? resolveSessionRepoContext(parentSession, repoInput, prompt)
      : null;
    // A joined workspace's repo outranks the global default: a caller that
    // names only a workspace means "a session in there", and defaulting to the
    // configured default repo would mint a foreign worktree inside it.
    const repo = getRepo(
      repoInput ||
        joinedWorkspace?.repo ||
        parentRepoContext?.repo ||
        parentSession?.repo,
    );
    const requestedRunnerId =
      typeof runnerInput === "string" && runnerInput.trim()
        ? runnerInput.trim()
        : undefined;
    // An explicit Runner bypasses the instance's default Sandbox. Explicitly
    // asking for both remains an error below.
    const sandboxResolved =
      fork || requestedRunnerId
        ? resolveRequestedSandbox(undefined, repo.id, model)
        : resolveInteractiveSandbox(sandbox, user, repo.id, model);
    if (!sandboxResolved.ok) throw new Error(sandboxResolved.error);
    const sandboxProvider = sandboxResolved.provider;
    if (automationDescendantPolicy && !requestedRunnerId && !sandboxProvider)
      throw new Error(
        "Automation descendants require an explicit sandbox or isolation-approved Runner",
      );
    if (requestedRunnerId && sandbox !== undefined && sandbox !== false)
      throw new Error("Choose either Sandbox or a Runner for this session");
    const selectedRunner = requestedRunnerId
      ? getRunner(requestedRunnerId)
      : undefined;
    if (requestedRunnerId) {
      if (!selectedRunner || !isRunnerConnected(selectedRunner.id))
        throw new Error("That Runner is offline");
      if (
        isAsk ||
        isScratch ||
        fork ||
        joinedWorkspace ||
        !runnerAvailableForSession(selectedRunner, {
          user,
          repo: repo.id,
          sessionId: bksId,
          automationDescendant: !!automationDescendantPolicy,
        }) ||
        !selectedRunner.workspaceRoots.length
      )
        throw new Error(
          "That Runner is not available for a new code workspace in this repository",
        );
    }
    const remoteSandbox = isRemoteSandboxProvider(sandboxProvider);
    const parentWorkspace = parentSession?.workspaceId
      ? getWorkspace(parentSession.workspaceId)
      : null;
    // The workspace this session lands in: the one it explicitly joins, else the
    // parent's. Everything a session inherits from its workspace — repo context,
    // worktree, feed refs and their MCP scoping — reads from this.
    const contextWorkspace = joinedWorkspace ?? parentWorkspace;
    // Least privilege: sessions in feed-item workspaces default their MCP
    // allowlist to the feed's declared servers, else inherit the parent's
    // scoping — never widen back to the full mcp-config.
    const { feedMcpServersForRefs } = await import("./feeds");
    const effectiveMcpServers =
      mcpServers !== undefined
        ? mcpServers
        : contextWorkspace?.externalRefs?.length
          ? ((await feedMcpServersForRefs(contextWorkspace.externalRefs)) ??
            parentSession?.mcpServers)
          : parentSession?.mcpServers;

    let wtPath: string;
    let materializeWorktree: (() => Promise<string>) | undefined;
    let sessionBranch = branch || "";
    const sharedParentContext =
      !isolatedWorktree &&
      parentSession &&
      parentSession.mode !== "ask" &&
      parentSession.mode !== "scratch" &&
      parentRepoContext?.repo === repo.id &&
      existsSync(parentRepoContext.dir)
        ? parentRepoContext
        : null;
    if (selectedRunner) {
      if (!sessionBranch.trim()) {
        if (createPlan.branch) sessionBranch = createPlan.branch;
        else {
          sessionBranch = await branchNameFromPrompt(prompt);
          sessionBranch = await resolveUniqueBranch(sessionBranch, repo.id);
          createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
            branch: sessionBranch,
          });
        }
      }
      wtPath = runnerWorkspacePath(selectedRunner, bksId);
    } else if (fork) {
      // Share the source's cwd so the fork sees the same code state.
      wtPath = fork.source.worktreeDir || repo.repo;
      sessionBranch = fork.source.branch || "";
    } else if (isRepoLess) {
      // Repo-less sessions share their workspace's scratch dir when there is
      // one; standalone creates get a fresh directory. Ask remains read-only,
      // while scratch keeps its normal write permissions.
      wtPath = ensureScratchDir(
        joinedWorkspace?.id ||
          parentSession?.workspaceId ||
          createPlanWorkspaceId(bksId),
      );
      sessionBranch = "";
    } else if (isAsk) {
      // A child reviewer shares the selected parent worktree read-only so
      // it sees uncommitted/current-branch work. Standalone ask sessions
      // keep using the pinned default-branch checkout.
      if (sharedParentContext) {
        wtPath = sharedParentContext.dir;
        sessionBranch = sharedParentContext.branch || sessionBranch;
      } else {
        wtPath = await ensureAskCheckout(repo.id);
      }
    } else {
      // Same workspace ⇒ same worktree: a code session joining a workspace (its
      // parent's, or one it named) shares that worktree/branch instead of
      // creating a fresh one. Only when the repo matches — a session explicitly
      // targeting another repo still gets its own isolated worktree there.
      const shared =
        !isolatedWorktree && sharedParentContext
          ? {
              dir: sharedParentContext.dir,
              branch: sharedParentContext.branch,
            }
          : !isolatedWorktree &&
              contextWorkspace?.worktreeDir &&
              repoForPath(contextWorkspace.worktreeDir).id === repo.id &&
              existsSync(contextWorkspace.worktreeDir)
            ? {
                dir: contextWorkspace.worktreeDir,
                branch: contextWorkspace.branch,
              }
            : !isolatedWorktree &&
                parentSession?.worktreeDir &&
                parentSession.mode !== "ask" &&
                repoForPath(parentSession.worktreeDir).id === repo.id &&
                existsSync(parentSession.worktreeDir)
              ? { dir: parentSession.worktreeDir, branch: parentSession.branch }
              : null;
      if (shared) {
        wtPath = shared.dir;
        sessionBranch = shared.branch || sessionBranch;
      } else {
        if (!sessionBranch.trim()) {
          if (createPlan.branch) sessionBranch = createPlan.branch;
          else {
            sessionBranch = await branchNameFromPrompt(prompt);
            sessionBranch = await resolveUniqueBranch(sessionBranch, repo.id);
            createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
              branch: sessionBranch,
            });
          }
        }
        const worktrees = await listWorktrees(repo.id);
        wtPath = worktrees.find((w) => w.branch === sessionBranch)?.path || "";
        // `isolated` only says anything on a shared-checkout repo, where it
        // is the difference between this session getting a tree of its own
        // and joining every other session in the live main checkout.
        if (!wtPath) {
          const worktreeOptions = {
            ...(isolatedWorktree ? { isolated: true } : {}),
          };
          wtPath = worktreePathFor(sessionBranch, repo.id, worktreeOptions);
          const plannedBranch = sessionBranch;
          const plannedWorktreePath = wtPath;
          const credentialPrincipal = githubCredential?.principal;
          materializeWorktree = async () => {
            if (credentialPrincipal) {
              await requestCreationCredential({
                sessionId: bksId,
                identity: createIdentity,
                principal: credentialPrincipal,
                scope: `git:${repo.id}`,
              });
            }
            await requestCreationBranch({
              sessionId: bksId,
              identity: createIdentity,
              project: repo.id,
              branch: plannedBranch,
              worktreePath: plannedWorktreePath,
              baseBranch: baseRef || repo.defaultBranch,
              isolated: isolatedWorktree === true,
              credentialPrincipal,
            });
            return plannedWorktreePath;
          };
        }
      }
    }
    // The first code session in a joined workspace that owns no worktree yet (an
    // ask-style or ticket workspace) materializes it, so the next session joining
    // the workspace inherits THIS worktree instead of minting a second one and
    // silently splitting the tabs across two trees. Only an isolated worktree
    // is owned — never a shared main/ask checkout, which every other session in
    // the repo uses too.
    if (
      joinedWorkspace &&
      !joinedWorkspace.worktreeDir &&
      !isAsk &&
      !isScratch &&
      ownedWorktree(wtPath)
    ) {
      updateWorkspace(joinedWorkspace.id, {
        worktreeDir: wtPath,
        ...(sessionBranch ? { branch: sessionBranch } : {}),
      });
    }

    // "auto-continue" is a turn's sender, not a person. A session spawned
    // from a resumed turn belongs to whoever owns the session that spawned
    // it, not to the sentinel that woke it: owned by the sentinel it has no
    // person at all, so nothing it goes on to commit can be credited either
    // (commitAuthorFor falls back to exactly this field).
    const creator = user && user !== AUTO_CONTINUE_USER ? user : null;
    const sessionCreatedBy =
      creator ||
      parentSession?.startedBy ||
      parentSession?.createdBy ||
      personaName();
    const sessionCreatedAt = new Date().toISOString();
    const namedPrompt = await nameKnownSessionReferencesForTitle(prompt);
    const title =
      namedPrompt.trim().split("\n")[0].slice(0, 80) ||
      (Array.isArray(rawFiles) && rawFiles.length
        ? "Attached file"
        : imageUrls?.length
          ? "Image"
          : "New session");
    // The Desk (desk.ts) is an orchestrator living in an overlay, not a piece
    // of work: it carries no workspace, and a worker it spawns is its own
    // independent thing. So a desk parent contributes NOTHING to the workspace
    // resolution below — no inherited id, no name seed, no back-fill. Without
    // this the workers landed in (or minted) a workspace named "Desk", which
    // is exactly how the Desk surfaced in the sidebar's Workspaces list.
    const deskParent = !!parentSession?.desk;
    // A joined workspace is the session's workspace, which also skips the mint /
    // adopt block below — and with it the auto-naming: a session that merely
    // joins an existing workspace must never rename it. A fork lands next to
    // its source in the same workspace (same rule as the web create).
    let resolvedWorkspaceId =
      joinedWorkspace?.id ||
      fork?.source.workspaceId ||
      (deskParent ? null : parentSession?.workspaceId) ||
      null;
    // A workspace minted below from THIS session's provisional first line is
    // renamed once the generated summary lands, exactly like the web create
    // path — the sidebar rows (web and native) are titled by the workspace,
    // so without this a session started from the native apps wears its raw
    // 80-character prompt for life while its own title is a short summary.
    let autoNamedWorkspace: Workspace | null = null;
    if (!resolvedWorkspaceId) {
      // Adopt the workspace that already owns the (parent's or this child's)
      // worktree before minting a duplicate one over it. Failing that, mint —
      // every session lives in a workspace (session-workspace.ts), so a parentless
      // child, or one hanging off a workspace-less slack/linear session, gets
      // wrapped here instead of surfacing as an orphan for the read-side
      // sweep to adopt. The parent's identity seeds the name when there is
      // one: the pair is one piece of work.
      // The Desk lends nothing to a minted workspace (see deskParent above):
      // seeding from it would name the workspace "Desk" — and a
      // parent-seeded name never arms autoNamedWorkspace, so that name
      // would stick for life instead of being replaced by the generated
      // summary. Treating it as parentless makes the child name its own
      // workspace, which is what a delegated worker deserves.
      const wsParent = deskParent ? null : parentSession;
      const owned =
        workspaceOwningWorktree(wsParent?.worktreeDir) ??
        workspaceOwningWorktree(wtPath);
      if (owned) resolvedWorkspaceId = owned.id;
      else {
        const plannedWorkspaceId =
          createPlan.workspaceId || createPlanWorkspaceId(bksId);
        if (!createPlan.workspaceId)
          createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
            workspaceId: plannedWorkspaceId,
          });
        const branchForWs = wsParent?.branch || sessionBranch;
        // Only an isolated worktree is owned — never a shared main/ask
        // checkout, which every other session there uses too.
        const dir =
          ownedWorktree(wsParent?.worktreeDir) ?? ownedWorktree(wtPath);
        const wsName =
          wsParent?.title || wsParent?.branch || title || "Workspace";
        await requestCreationWorkspace({
          sessionId: bksId,
          identity: createIdentity,
          workspaceId: plannedWorkspaceId,
          dedupeKey: `session-create:${createIdentity}`,
          name: wsName,
          createdBy:
            creator ||
            wsParent?.createdBy ||
            wsParent?.startedBy ||
            "Anonymous",
          ...(isRepoLess ? {} : { project: wsParent?.repo || repo.id }),
          ...(branchForWs ? { branch: branchForWs } : {}),
          ...(dir ? { worktreeDir: dir } : {}),
        });
        const ws = getWorkspace(plannedWorkspaceId);
        if (!ws)
          throw new Error(
            `Workspace ${plannedWorkspaceId} projection is missing after actor receipt`,
          );
        resolvedWorkspaceId = ws.id;
        // Only when the name was seeded from this session's own first line
        // (compared before createWorkspace trims it): a workspace named
        // after the parent's identity belongs to the parent's work, and
        // this child's summary must not rename it.
        if (wsName === title) autoNamedWorkspace = ws;
      }
      // …but never drag the Desk into its worker's workspace: that would put
      // it right back in the sidebar, and touchNativeSession would bump its
      // lastActivity on every delegation too.
      if (
        resolvedWorkspaceId &&
        !deskParent &&
        parentSession?.source === "opensession"
      )
        touchNativeSession(parentSession.id, {
          workspaceId: resolvedWorkspaceId,
        });
    }

    // @session:<id> mentions in a create_session prompt (e.g. a monitor
    // session spun up to watch others) get the same resolving footer as
    // prompts on existing sessions — this create path bypasses
    // runSessionPromptInner.
    const createMentionsNote = sessionMentionsNote(prompt);
    const attachmentSources =
      createPlan.attachments ??
      prepareCreationAttachmentSources(bksId, rawFiles);
    if (!createPlan.attachments && attachmentSources.length)
      createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
        attachments: attachmentSources,
      });
    for (const attachment of attachmentSources)
      await requestCreationAttachment({
        sessionId: bksId,
        identity: createIdentity,
        ...attachment,
      });
    let openingPrompt = withUploadsNote(
      prompt,
      attachmentSources.map((attachment) => ({
        name: attachment.name,
        path: creationAttachmentPath(
          bksId,
          attachment.attachmentId,
          attachment.name,
        ),
      })),
    );
    if (createMentionsNote)
      openingPrompt += `

${createMentionsNote}`;
    // A session joining a workspace opens with the workspace's own context, the
    // same as the web create: the feed item it hangs off, and the support
    // ticket it belongs to. Without this a "new tab" in a ticket workspace is
    // an amnesiac session that has to be told what it's looking at.
    if (joinedWorkspace) {
      const { wrapContext } = await import("./prompt-context");
      if (joinedWorkspace.externalRefs?.length) {
        const { externalRefsOpeningContext } = await import("./feeds");
        const refsContext = await externalRefsOpeningContext(
          joinedWorkspace.externalRefs,
          { scratch: isScratch, user },
        );
        if (refsContext)
          openingPrompt += `\n\n${wrapContext(refsContext, "external-refs")}`;
      }
      if (joinedWorkspace.plainThreadId) {
        const threadId = joinedWorkspace.plainThreadId;
        try {
          const { getThreadWithMessages, formatThreadContext } =
            await import("../agents/plain/api");
          const thread = await getThreadWithMessages(threadId);
          openingPrompt += `\n\n${wrapContext(
            `This session was opened from a Plain support ticket. Ticket context:\n\n${formatThreadContext(thread, true)}`,
            "ticket",
          )}`;
        } catch (e) {
          console.error(
            `[create_session] Plain thread lookup failed for ${threadId}:`,
            e,
          );
          openingPrompt += `\n\n${wrapContext(
            `This session was opened from Plain support ticket ${threadId} (the context lookup failed — use the plain MCP tools to fetch the thread).`,
            "ticket",
          )}`;
        }
      }
    }
    // A non-clonable fork hands the source transcript over in the opening
    // prompt instead (same as the web create).
    if (fork?.needsHandoff) {
      openingPrompt += `\n\n${await forkHandoffContext(fork)}`;
    }

    const computedSpec: ResolvedCreate = {
      id: bksId,
      title,
      titlePrompt: prompt,
      displayPrompt: prompt,
      openingPrompt,
      user,
      createdBy: sessionCreatedBy,
      createdByLogin,
      createdAt: sessionCreatedAt,
      mode: isScratch
        ? ("scratch" as const)
        : isAsk
          ? ("ask" as const)
          : ("code" as const),
      wtPath,
      // Ask/scratch sessions record no branch (a shared parent worktree's
      // branch still drives the branch note + HEAD-drift compare below).
      persistBranch: isAsk || isScratch ? "" : sessionBranch,
      branch: sessionBranch,
      // Repo-less sessions record none (wtPath is a plain dir no repo
      // owns — scratch, or a repo-less ask session being forked). A
      // fork's worktree names its repo: the source may live elsewhere.
      repoId: isRepoLess
        ? undefined
        : fork
          ? repoForPathOrNull(wtPath)?.id
          : repo.id,
      memoryRepoIds: [repo.id],
      workspaceId: resolvedWorkspaceId || undefined,
      announceWorkspaceId: resolvedWorkspaceId || undefined,
      autoNameWorkspace: autoNamedWorkspace,
      parentSessionId,
      spawnDepth,
      agentStarted,
      spawnedBy,
      reportBack,
      automationDescendantPolicy,
      model,
      effort: createEffort,
      fastMode: createFastMode || undefined,
      accountId: createAccountId,
      images,
      // Feed-item linkage follows the session's workspace (Video tab +
      // sidebar feed-row join — the feeds design).
      externalRefs: contextWorkspace?.externalRefs,
      // A session in a support-ticket workspace is on that ticket too —
      // same rule as the web tab strip's "+".
      plainThreadId: joinedWorkspace?.plainThreadId,
      // Persist the MCP scoping so follow-up prompts keep it.
      persistMcpServers: effectiveMcpServers,
      // Unscoped creates leave this undefined (read as "all" downstream,
      // like the web path) — the sandbox launcher fail-closes to [].
      runMcpServers: effectiveMcpServers,
      sandboxProvider,
      runnerTarget: selectedRunner
        ? {
            id: selectedRunner.id,
            name: selectedRunner.label || selectedRunner.name,
            workspacePath: wtPath,
            repositoryUrl: `https://github.com/${repo.ghRepo}.git`,
          }
        : undefined,
      volumeWorkspace: false,
      remoteSandbox,
      openingPromptEntryId: `create-${requestId}`,
      // Persist the full decision before git creates anything. The opening
      // setup materializes this deterministic path after announcement.
      gitPrincipal: githubCredential?.principal,
      gitEnv: githubGitEnv,
      worktreeBaseRef: baseRef,
      stackedOn: stackedOnBranch
        ? { repo: repo.id, branch: stackedOnBranch }
        : undefined,
      needsWorktree: !!materializeWorktree,
      worktreeKind: "new",
      worktreeIsolated: isolatedWorktree === true,
      materializeWorktree,
      fork: fork?.canFork
        ? {
            engineSessionId: fork.source.claudeSessionId!,
            resumeAt: fork.messageId,
          }
        : undefined,
      finish: "auto-continue-guard",
    };
    const restoredSpec = createPlan.resolved
      ? restoreResolvedCreate<ResolvedCreate>(createPlan.resolved)
      : undefined;
    const restoredGitEnv = githubCredentialForPrincipal(
      restoredSpec?.gitPrincipal,
    )?.env;
    const restoredWorktreeReady =
      restoredSpec?.needsWorktree &&
      typeof restoredSpec.wtPath === "string" &&
      typeof restoredSpec.repoId === "string" &&
      typeof restoredSpec.branch === "string"
        ? await isRegisteredWorktree(
            restoredSpec.wtPath,
            restoredSpec.repoId,
            restoredSpec.branch,
          )
        : false;
    const restoredMaterializer =
      restoredSpec?.needsWorktree &&
      !restoredWorktreeReady &&
      typeof restoredSpec.wtPath === "string" &&
      typeof restoredSpec.branch === "string" &&
      typeof restoredSpec.repoId === "string"
        ? async () => {
            const credentialPrincipal = restoredSpec.gitPrincipal;
            if (credentialPrincipal) {
              await requestCreationCredential({
                sessionId: bksId,
                identity: createIdentity,
                principal: credentialPrincipal,
                scope: `git:${restoredSpec.repoId!}`,
              });
            }
            await requestCreationBranch({
              sessionId: bksId,
              identity: createIdentity,
              project: restoredSpec.repoId!,
              branch: restoredSpec.branch!,
              worktreePath: restoredSpec.wtPath!,
              baseBranch:
                restoredSpec.worktreeBaseRef ||
                restoredSpec.stackedOn?.branch ||
                getRepo(restoredSpec.repoId!).defaultBranch,
              isolated: restoredSpec.worktreeIsolated === true,
              credentialPrincipal,
            });
            return restoredSpec.wtPath!;
          }
        : undefined;
    const spec: ResolvedCreate = restoredSpec
      ? {
          ...computedSpec,
          ...restoredSpec,
          images: computedSpec.images,
          gitEnv: restoredGitEnv,
          materializeWorktree: restoredMaterializer,
          needsWorktree: !!restoredMaterializer,
        }
      : computedSpec;
    if (!createPlan.resolved) {
      createPlan = await patchCreationSetupPlan(bksId, createIdentity, {
        resolved: snapshotOpeningCreate(computedSpec),
      });
    }

    // Run in the background; watchers (web UI) see the live stream, the same
    // as a UI-created session. The tool returns once the session file exists
    // (the announce), while engine startup continues behind it.
    const openingCreationState = await sessionKernel(bksId).creationState();
    return await new Promise<{
      id: string;
      createdBy: string;
      createdAt: string;
    }>((resolve, reject) => {
      const opening = runOpeningCreateOnce(
        spec,
        {
          announce: (info) => {
            resolve({
              id: info.id,
              createdBy: info.createdBy,
              createdAt: info.createdAt,
            });
          },
          emit: (m) => broadcastToSession(bksId, { ...m, sessionId: bksId }),
          fail: (message) => reject(new Error(message)),
        },
        createIdentity,
      );
      if (!opening.owner) {
        const existing = findSession(bksId);
        resolve({
          id: bksId,
          createdBy: existing?.createdBy || user || "Anonymous",
          createdAt:
            existing?.createdAt ||
            new Date(
              openingCreationState?.updatedAt ?? Date.now(),
            ).toISOString(),
        });
        return;
      }
      void opening.done.then(
        () => clearCreatePlan(bksId),
        (e) => {
          console.error(`[sessions-mcp] create session ${bksId} failed:`, e);
          reject(e);
        },
      );
    });
  },
});
