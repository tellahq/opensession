/**
 * The UI WebSocket: watch/unwatch sessions, live prompts and queue control,
 * question answers, terminals — plus the create_session flow. Extracted
 * verbatim from opensession.ts; sandbox transport sockets are delegated to
 * run-ws.ts before any of this runs.
 */

import type { WebSocketHandler } from "bun";
import type { WSClientData } from "./ws-hub";
import { sessionRunningWithHolds } from "./session-state-events";

import {
  currentAgentRunToken,
  interruptAndSteerAgentRun,
  isAgentSessionBusy,
  retractAgentSteer,
} from "./agent-runner";

import { audit } from "./audit";
import { pendingAskAwaitingAnswer } from "./asks";
import { resendPendingSlackComposer } from "./slack-compose";
import { notifyMentions } from "./mentions";
import {
  startWatching,
  stopAllWatchesForClient,
  transcriptRev,
} from "./file-watcher";
import {
  INIT_WIRE_CLAMP_BYTES,
  entriesForWire,
  parseTranscriptAsync,
  parseTranscriptTail,
  parseTranscriptWindow,
  prepareEntriesForWire,
} from "./jsonl-parser";
import { providerFor } from "./models";

import {
  appendTranscriptEntries,
  clearTranscriptStoreDegraded,
  storeAppendUserLineEarly,
  transcriptLineRunnerNotice,
  transcriptLineUser,
} from "./transcript-persistence";
import {
  deleteQueuedPrompt,
  editableSteerReceipt,
  liftUserStop,
  persistQueues,
  promoteQueuedPrompt,
  promptQueues,
  queueDisplayState,
  durableQueueItem,
  queueItem,
  reorderQueuedPrompt,
  steeredReceipts,
  stoppedSessions,
  takeQueuedPrompt,
  takeSteeredPrompt,
  updateQueuedPrompt,
} from "./queue-state";
import { prepareAndSteerQueuedPrompt } from "./queued-steer";

import {
  abortTurnAndDrain,
  drainQueue,
  enqueuePrompt,
  interruptQueuedPrompt,
  requestTurnCancel,
  runSessionPrompt,
  runSessionPromptAndDrain,
  steerQueuedPrompt,
  watchExternalRunAndDrain,
} from "./run-session";
import { sandboxWsClose, sandboxWsMessage, sandboxWsOpen } from "./run-ws";
import { handleCreateSessionMessage } from "./session-create";
import { markReplayedCommandResult } from "./command-replay";
import { sessionIdForRequest } from "./session-request-id";
import { runnerWsClose, runnerWsMessage, runnerWsOpen } from "./runner-ws";
import {
  sandboxPortalRelayClose,
  sandboxPortalRelayMessage,
  sandboxPortalRelayOpen,
} from "./sandbox-portal-relay";
import { type Sandbox } from "./sandbox";
import {
  findSessionAsync,
  invalidateSessionsCache,
  maybePersistEffort,
  maybePersistFastMode,
} from "./session-cache";
import {
  mergedSessionTranscript,
  mergedSessionTranscriptAsync,
  v2MirrorFiles,
  v2TranscriptHasDrift,
} from "./sessions";
import { handleSlashCommand } from "./slash-commands";
import { maybeRecapOnReturn } from "./recap";
import {
  maybeSuggestRepliesOnReturn,
  resendReplySuggestions,
} from "./reply-suggestions";
import { unarchiveForHumanTurn } from "./session-unarchive";
import {
  resizeTerminal,
  startSessionTerminal,
  stopAllTerminals,
  stopTerminal,
  writeTerminal,
} from "./terminals";
import { subscribeTranscript } from "./transcript-bus";
import { resumeSessionFeed } from "./session-feed";
import type { SeqEntry } from "./transcript-store";
import { importLegacyTranscript, transcript } from "./actor-transcript";
import { startTranscriptWatch } from "./transcript-watch";
import { clampV2InitEntries } from "./transcript-wire";
import {
  MAX_UPLOAD_BYTES,
  WS_MAX_PAYLOAD_BYTES,
  asDataUrlList,
  parseImageDataUrls,
} from "./uploads";
import { githubReconnectRequired } from "./github-auth";
import { refreshWebIdentity } from "./web-auth";
import {
  BOOT_ID,
  allClients,
  broadcastToAll,
  broadcastToSession,
  globalPresenceFrame,
  joinSession,
  leaveSession,
  markClientSeen,
  setClientAway,
  setClientTyping,
} from "./ws-hub";
import { existsSync, readFileSync, statSync, watch } from "fs";
import { stateDir } from "./paths";
import { isInternalKernelDispatch } from "./session-kernel/ws-command-bridge";
import { withSessionMutationLock } from "./session-mutation-lock";
import {
  acknowledgeSessionCommand,
  deliveryInterruptForAnchor,
  durableSessionCommand,
  isCreationEffectPendingError,
  isRetryableSessionCommandError,
  sessionProjectionOr,
  sessionGatewayCommand,
  sessionDelivery,
  sessionKernel,
  sessionQuarantineSnapshot,
  sessionTurn,
  targetForDeliveryInterrupt,
  targetForTurnCancel,
} from "./session-kernel";
import { publicSessionSafety } from "./session-safety";
import { TRANSCRIPT_ACTOR_RANGE_PAGE_LIMIT } from "./session-kernel/transcript-protocol";

// Who likely triggered the restart that booted THIS process — read once from
// the marker the previous process wrote in gracefulShutdown, and only trusted
// when the shutdown was recent (a stale marker from days ago means this boot
// wasn't that restart). Parked on globalThis so hot reloads keep the value.
function lastRestartBy(): string {
  const g = globalThis as any;
  if (g.__lastRestartBy === undefined) {
    g.__lastRestartBy = "";
    try {
      const d = JSON.parse(readFileSync(stateDir("last-restart.json"), "utf8"));
      if (d?.by && Date.now() - Date.parse(d.at) < 10 * 60_000)
        g.__lastRestartBy = String(d.by);
    } catch {}
  }
  return g.__lastRestartBy;
}

/**
 * The non-transcript half of the watch handshake — pending question, queue +
 * steer receipts, running status. Sent on both watch paths: the full-snapshot
 * one AND the sinceOffset resume (these are cheap and idempotent; the client
 * replaces rather than merges them).
 */
async function sendWatchExtras(
  ws: any,
  sessionId: string,
  session: NonNullable<Awaited<ReturnType<typeof findSessionAsync>>>,
): Promise<void> {
  const pendingAsk = await pendingAskAwaitingAnswer(sessionId);
  if (pendingAsk) {
    ws.send(
      JSON.stringify({
        type: "ask_question",
        sessionId,
        questionId: pendingAsk.questionId,
        questions: pendingAsk.questions,
      }),
    );
  }
  resendPendingSlackComposer(sessionId, (message) =>
    ws.send(JSON.stringify(message)),
  );
  resendReplySuggestions(sessionId, (message) =>
    ws.send(JSON.stringify(message)),
  );

  // Older in-memory rows may lack ids; assign and persist them before
  // sending so edit/delete/steer actions can address the same row.
  const queueState = await queueDisplayState(sessionId);
  if (queueState) {
    const {
      queued: queuedPrompts,
      steered: steeredPrompts,
      pendingDeliveryIds,
    } = queueState;
    if (queuedPrompts.length > 0 || steeredPrompts.length > 0) persistQueues();
    ws.send(
      JSON.stringify({
        type: "queue_update",
        sessionId,
        queued: queuedPrompts,
        steered: steeredPrompts,
        pendingDeliveryIds,
      }),
    );
  }
  const quarantine = await sessionQuarantineSnapshot(sessionId);
  const safety = quarantine ? publicSessionSafety(quarantine) : undefined;
  ws.send(
    JSON.stringify({
      type: "session_status",
      sessionId,
      isRunning:
        !safety &&
        sessionRunningWithHolds(
          session.id,
          session.isRunning ||
            isAgentSessionBusy(
              session.claudeSessionId,
              session.codexThreadId,
              session.id,
            ),
        ),
      ...(safety ? { safety } : {}),
    }),
  );

  // The transcript snapshot above is authoritative. Replay the bounded live
  // phase after it, or send an active snapshot when the cursor cannot resume.
  if (ws.data?.supportsFeed) {
    const { frames, snapshot } = resumeSessionFeed(
      sessionId,
      ws.data.sinceFeedSeq,
      ws.data.feedEpoch,
    );
    for (const frame of frames) ws.send(JSON.stringify(frame));
    ws.send(JSON.stringify(snapshot));
  }
}

// ── Transcript v2 serve path (docs/transcripts.md §4) ──────────────
// Capability-gated: the client sends `supportsSeq: true` on watch. Eligible
// watches are served from the owned transcript store and fed live by the
// in-process bus — no mirror file-watcher polling. The legacy offset/rev
// watch below stays as the serve path for external CLI/tmux sessions and as
// the code-level fallback whenever the v2 serve refuses or throws (the env
// kill switch was retired with the mirror writes, 2026-07-23).

// Per-socket bus unsubscribe handles. Parked on globalThis so a hot reload
// can still tear down subscriptions made by the previous module instance
// (same reason file-watcher parks its watch map).
const v2Unsubs: Map<unknown, () => void> = ((
  globalThis as any
).__osTranscriptV2Unsubs ??= new Map());

/**
 * The ONE v2 teardown helper — called from all three paths that end a
 * socket's view of a session (mirroring stopAllWatchesForClient's contract):
 * watch-switch (re-watch of a different session on the same socket), unwatch,
 * and close. Releases the bus subscription and clears the v2 mark so the
 * rotation re-watch (run-session.ts) treats the socket as legacy again.
 */
function releaseTranscriptV2(ws: any): void {
  const unsub = v2Unsubs.get(ws);
  if (unsub) {
    v2Unsubs.delete(ws);
    try {
      unsub();
    } catch {}
  }
  if (ws?.data?.transcriptV2) ws.data.transcriptV2 = false;
}

/** Legacy transcripts above this mirror-file size import in the background
 *  (this watch serves legacy) instead of blocking the watch handshake — the
 *  §4 "import timeout → legacy + queued background import" behavior, applied
 *  proactively by size since the import itself is synchronous. */
const V2_SYNC_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** Session ids with a background import scheduled (dedupe). */
const v2BgImports: Set<string> = ((
  globalThis as any
).__osTranscriptV2BgImports ??= new Set());

/**
 * What `prepareEntriesForWire` does for every legacy send site, for the v2
 * store path: strip injected context, classify how each entry reads, and say
 * what each tool call is. Store rows are RAW — the marker-derived
 * `noticeKind` is on them, but the `notice` a client renders from is not, and
 * delivery plumbing ("[Name] " prefixes,
 * worker/session sentinels, the "💬 X answered" header) is still in `content`.
 * The web re-classifies client-side, so this went unnoticed until the native
 * apps moved onto seq paging: they read `notice`/`sender` only, so a recap
 * arrived as an anonymous system chip and a teammate's answer as words the
 * session owner appeared to have typed.
 *
 * Clamping stays separate and comes after (see clampV2InitEntries): the
 * classifier strips plumbing out of `content`, so a clamp applied afterwards
 * measures the text a reader actually sees.
 */
function classifyV2Entries(entries: SeqEntry[]): SeqEntry[] {
  return prepareEntriesForWire(entries) as SeqEntry[];
}

function sendTranscriptFrame(
  ws: { send(payload: string, compress?: boolean): unknown },
  frame: Record<string, unknown>,
): void {
  ws.send(JSON.stringify(frame), true);
}

async function sendTranscriptIndex(
  ws: any,
  sessionId: string,
  isCurrent: () => boolean,
): Promise<void> {
  const index = await transcript.readTranscriptIndex(sessionId);
  if (!isCurrent()) return;
  sendTranscriptFrame(ws, {
    type: "transcript_index",
    sessionId,
    ...index,
  });
}

/**
 * V2 snapshot/history pages use the same bounded previews as the legacy
 * transcript path. Live transcript_append frames keep the larger store form.
 */

/** Legacy (re-)import for a session (same routine as §3's import-first
 *  gate): merged cross-engine history → importLegacyTranscript (which marks
 *  the session imported; empty history marks 'live-only'). Watermark = the
 *  TOTAL size of the §8 drift candidate set (session transcript file + oc
 *  mirror — the exact set v2TranscriptHasDrift compares against; measuring
 *  only transcriptPath would leave pi sessions permanently
 *  grown-beyond-watermark). Also the drift RE-import: idempotent upserts, and
 *  a completed import releases the failure-side store-degraded marker. */
async function v2ImportSession(
  session: NonNullable<Awaited<ReturnType<typeof findSessionAsync>>>,
): Promise<void> {
  // Deliberately id-less ref: guarantees the legacy merge — an id-carrying
  // ref would route mergedSessionTranscript back into the v2 store path,
  // which on a drift re-import is exactly what we're refreshing.
  const entries = mergedSessionTranscript({
    transcriptPath: session.transcriptPath ?? null,
  });
  await v2FinishImport(session, entries);
}

/** v2ImportSession for the background queue: the merge parse yields to the
 *  event loop (mergedSessionTranscriptAsync), so a multi-MB legacy transcript
 *  — exactly what gets routed here by the sync-import size ceiling — no
 *  longer wedges the server for the duration of the parse. */
async function v2ImportSessionAsync(
  session: NonNullable<Awaited<ReturnType<typeof findSessionAsync>>>,
): Promise<void> {
  const entries = await mergedSessionTranscriptAsync({
    transcriptPath: session.transcriptPath ?? null,
  });
  await v2FinishImport(session, entries);
}

async function v2FinishImport(
  session: NonNullable<Awaited<ReturnType<typeof findSessionAsync>>>,
  entries: ReturnType<typeof mergedSessionTranscript>,
): Promise<void> {
  let watermark: number | null = null;
  try {
    const files = v2MirrorFiles(session);
    if (files.length) watermark = files.reduce((sum, f) => sum + f.size, 0);
  } catch {}
  await importLegacyTranscript(
    session.id,
    entries,
    entries.length ? "merged" : "live-only",
    watermark,
  );
  clearTranscriptStoreDegraded(session.id, session.claudeSessionId);
}

/** Queue an off-handshake import. `reimport` = the session is already
 *  imported but drifted (serveTranscriptV2's §8 check) — run the import even
 *  though needsImport is false; without it only never-imported sessions load. */
function v2QueueBackgroundImport(sessionId: string, reimport = false): void {
  if (v2BgImports.has(sessionId)) return;
  v2BgImports.add(sessionId);
  setTimeout(async () => {
    try {
      const session = await findSessionAsync(sessionId);
      if (session && (reimport || (await transcript.needsImport(sessionId))))
        await v2ImportSessionAsync(session);
    } catch (e) {
      console.warn(`[ws] v2 background import failed for ${sessionId}:`, e);
    } finally {
      v2BgImports.delete(sessionId);
    }
  }, 0);
}

/**
 * Serve a watch from the v2 store + bus. Returns true when the watch was
 * fully served (caller sends the watch extras and stops); false = not
 * eligible / import deferred / flag off — fall through to the untouched
 * legacy path.
 */
async function serveTranscriptV2(
  ws: any,
  sessionId: string,
  session: NonNullable<Awaited<ReturnType<typeof findSessionAsync>>>,
  msg: any,
): Promise<boolean> {
  if (msg.supportsSeq !== true) return false;
  // Plain loop runs don't thread a unified session id to the runner (§3), so
  // their store rows would be forever partial — refuse v2, keep legacy.
  // (Linear runs DO since transcriptSessionId landed; they lazy-import here
  // like any other session, and appends from runs started before the
  // enabling restart degrade safely via the §8 store-degraded/drift path.)
  if (sessionId.startsWith("plain-")) return false;
  // Externally-owned runs (CLI/tmux: running via PID but not in our
  // activeRuns — session-control's observe-only signal) write only their
  // transcript file. The file-watcher feeds parsed appends into the store
  // (file-watcher.ts feedTranscriptStore), but that feed only runs while
  // some legacy watch exists — a v2-only viewer set would have no feeder,
  // so v2 here would render silently stale mid-run. The refusal stays until
  // a socket-independent feed lifecycle exists — the one remaining step of
  // mirror retirement (design doc §11); mirror writes themselves are gone.
  if (
    session.isRunning &&
    !isAgentSessionBusy(
      session.claudeSessionId,
      session.codexThreadId,
      session.id,
    )
  )
    return false;

  const store = transcript;
  try {
    if (await store.needsImport(sessionId)) {
      // Lazy import: small legacy transcripts import synchronously inside
      // the watch; big ones import in the background and THIS watch serves
      // legacy (the next one upgrades). The ceiling measures the WHOLE §8
      // candidate set (session transcript file + oc mirror) — transcriptPath
      // alone undercounts pi sessions, whose history mostly lives in
      // the mirror.
      let mirrorSize = 0;
      try {
        for (const f of v2MirrorFiles(session)) mirrorSize += f.size;
      } catch {}
      if (mirrorSize > V2_SYNC_IMPORT_MAX_BYTES) {
        v2QueueBackgroundImport(sessionId);
        return false;
      }
      await v2ImportSession(session);
    } else if (await v2TranscriptHasDrift(store, sessionId, session)) {
      // Imported but stale (§8): the mirror grew in a way the store can't
      // explain — external CLI/tmux runs while we were idle, unmapped oc
      // ids, failed store appends, kill-switch windows — or the failure-side
      // store-degraded flag is set. The bus never fires for those entries,
      // so serving v2 would render silently stale. Queue the background
      // re-import (idempotent upserts; clears the flag) and fall through to
      // the legacy file-watcher path for THIS watch — live external appends
      // keep streaming; the next watch upgrades to v2.
      v2QueueBackgroundImport(sessionId, true);
      return false;
    }
  } catch (e) {
    console.warn(`[ws] v2 import failed for ${sessionId} — legacy path:`, e);
    return false;
  }

  // From here this socket is a v2 viewer for this session. The extracted
  // protocol subscribes BEFORE reading and treats bus events as wake-ups for
  // durable changeSeq reconciliation, closing both handshake and reconnect
  // rewrite gaps.
  ws.data.transcriptV2 = true;
  const scheduleTranscriptIndex = () => {
    if (msg.supportsTranscriptIndex !== true) return;
    setTimeout(async () => {
      if (ws.data?.watchingSessionId !== sessionId || !ws.data?.transcriptV2)
        return;
      try {
        await sendTranscriptIndex(
          ws,
          sessionId,
          () =>
            ws.data?.watchingSessionId === sessionId && !!ws.data?.transcriptV2,
        );
      } catch (error) {
        console.warn(`[ws] transcript index failed for ${sessionId}:`, error);
      }
    }, 0);
  };
  try {
    const watch = await startTranscriptWatch({
      sessionId,
      store,
      socket: ws,
      subscribe: subscribeTranscript,
      isCurrent: () =>
        ws.data?.watchingSessionId === sessionId && !!ws.data?.transcriptV2,
      ...(msg.supportsChangeSeq === true &&
      typeof msg.sinceChangeSeq === "number"
        ? { sinceChangeSeq: msg.sinceChangeSeq }
        : {}),
      prepareEntries: classifyV2Entries,
      clampSnapshot: clampV2InitEntries,
      formatAppend: (frame, event) =>
        ws.data?.supportsFeed && event?.feed
          ? { ...event.feed, event: frame }
          : frame,
      afterResetSnapshot: scheduleTranscriptIndex,
    });
    v2Unsubs.set(ws, () => watch.unsubscribe());
    // Let the bounded tail frame flush first. The complete outline is a
    // content-free follow-up and may lazily backfill this one session.
    scheduleTranscriptIndex();
  } catch (error) {
    ws.data.transcriptV2 = false;
    throw error;
  }
  return true;
}

const kernelDispatchTokens = new Set<string>();
const kernelDispatchResults = new Map<string, unknown>();
const kernelDispatchErrors = new Map<string, Error>();

export const websocketHandlers: WebSocketHandler<WSClientData> = {
  // One shared compressor keeps connection memory bounded. Only large
  // transcript frames opt into compression at send sites; small live frames
  // stay uncompressed to avoid spending CPU for negligible wire savings.
  perMessageDeflate: { compress: "shared", decompress: "shared" },
  // Default is 16 MB — too small for a base64'd attachment near MAX_UPLOAD_BYTES,
  // which would otherwise drop the frame (close 1009) before staging. See above.
  maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
  open(ws) {
    // Sandbox transport sockets (run hosts / MCP proxies dialing back)
    // are not UI clients — run-ws.ts owns them entirely.
    if (sandboxWsOpen(ws)) return;
    // Runner channels are not UI clients either (runner-ws.ts).
    if (runnerWsOpen(ws)) return;
    if (sandboxPortalRelayOpen(ws)) return;
    allClients.add(ws);
    // Hello frame: hands the client this process's bootId so a reconnect
    // can tell a real restart (bootId changed → "restarted" toast) from a
    // transient socket blip (unchanged → clear the reconnecting pill
    // silently). Clients on servers without this frame fall back to
    // polling /api/health, which also carries bootId. `restartBy` names the
    // session that likely triggered the restart (marker written by the OLD
    // process's shutdown — see gracefulShutdown) so the toast can say who.
    try {
      ws.send(
        JSON.stringify({
          type: "hello",
          bootId: BOOT_ID,
          capabilities: { commandResults: true },
          ...(ws.data?.authLogin
            ? { commandScope: `github:${ws.data.authLogin.toLowerCase()}` }
            : {}),
          ...(lastRestartBy() ? { restartBy: lastRestartBy() } : {}),
        }),
      );
    } catch {}
    // Who's where, once, right away: presence is broadcast on change only,
    // so without this a client that just connected shows an empty team
    // until somebody opens or leaves a session.
    try {
      ws.send(JSON.stringify(globalPresenceFrame()));
    } catch {}
    console.log("WebSocket client connected");
  },

  async message(ws, message) {
    if (sandboxWsMessage(ws, message as any)) return;
    if (runnerWsMessage(ws, message as any)) return;
    if (sandboxPortalRelayMessage(ws, message as any)) return;
    let msg: any;
    try {
      msg = JSON.parse(String(message));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    // A throw anywhere below used to escape as an unhandled rejection and
    // kill the whole process (2026-07-27: four crash-restarts from a prompt
    // message missing `content` — every in-process run died each time). One
    // malformed or unlucky message must never take down the server, so the
    // entire dispatch is fenced; the switch body keeps its indentation to
    // avoid a 1500-line re-indent in the shared checkout.
    try {
      // GitHub web sign-in active (web-auth.ts): re-resolve the verified login
      // on every message. A roster rename follows an already-open socket, while
      // removing someone closes it instead of leaving a cached identity active.
      if (ws.data?.authLogin) {
        const identity = refreshWebIdentity({
          login: ws.data.authLogin,
          name: ws.data.authUser || ws.data.authLogin,
          ...(ws.data.authAutomation ? { automation: true } : {}),
        });
        if (
          !identity ||
          (!identity.automation && githubReconnectRequired(identity.login))
        ) {
          ws.close(
            4001,
            identity
              ? "GitHub reconnect required"
              : "Roster membership changed",
          );
          return;
        }
        const firstName = identity.name.split(" ")[0] || identity.name;
        ws.data.authUser = firstName;
        ws.data.user = firstName;
        msg.user = firstName;
      }
      // Anything that isn't a heartbeat is a person doing something, so it
      // refreshes this socket's attention (ws-hub's idle window — a face means
      // "here now"). `away` carries its own stamp.
      markClientSeen(ws, msg.type !== "ping" && msg.type !== "away");

      // Every session mutation enters one per-session mailbox. The recursive
      // call carries the private marker and executes the existing handler only
      // after earlier commands for this session have committed. Read/watch and
      // terminal frames stay outside the kernel because they do not own session
      // lifecycle state.
      const kernelCommands = new Set([
        "prompt",
        "interrupt_prompt",
        "delete_queued_prompt",
        "take_queued_prompt",
        "take_steered_prompt",
        "update_queued_prompt",
        "steer_queued_prompt",
        "interrupt_queued_prompt",
        "reorder_queued_prompt",
        "cancel",
        "answer_question",
      ]);
      // Creation already has its own durable FSM and outbox. Wrapping it in a
      // websocket_command holds the per-session mailbox while the opening effect
      // tries to enter session_file_updated, so neither command can finish.
      const requestId =
        typeof msg.requestId === "string" && msg.requestId
          ? msg.requestId.slice(0, 200)
          : crypto.randomUUID();
      const commandSessionId =
        msg.type === "create_session"
          ? typeof msg.clientSessionId === "string"
            ? msg.clientSessionId
            : sessionIdForRequest(
                ws.data?.authLogin || msg.user || "anonymous",
                requestId,
              )
          : typeof msg.sessionId === "string"
            ? msg.sessionId
            : msg.type === "cancel" &&
                typeof ws.data?.watchingSessionId === "string"
              ? ws.data.watchingSessionId
              : typeof ws.data?.watchingSessionId === "string"
                ? ws.data.watchingSessionId
                : undefined;
      const internalKernelToken = isInternalKernelDispatch(
        kernelDispatchTokens,
        msg.__sessionKernelToken,
      );
      if (
        !internalKernelToken &&
        commandSessionId &&
        kernelCommands.has(msg.type)
      ) {
        const messageHash = new Bun.CryptoHasher("sha256")
          .update(String(message))
          .digest("hex");
        // Cancel and interrupt target the run that existed when the command was
        // first admitted. Replaying after a successor starts must fail payload
        // identity instead of stopping the successor.
        const targetsRun =
          msg.type === "cancel" || msg.type === "interrupt_prompt";
        const targetRun = targetsRun
          ? sessionKernel(commandSessionId).runStateProjection()
          : undefined;
        const persistedCancel =
          msg.type === "cancel"
            ? (
                await sessionTurn({
                  op: "snapshot",
                  sessionId: commandSessionId,
                })
              ).cancel
            : undefined;
        const persistedInterrupt =
          msg.type === "interrupt_prompt"
            ? deliveryInterruptForAnchor(
                await sessionDelivery({
                  op: "snapshot",
                  sessionId: commandSessionId,
                }),
                requestId,
              )
            : undefined;
        const priorCommandPayload = (
          await durableSessionCommand(commandSessionId, requestId)
        )?.payload as
          | {
              command?: string;
              targetRunId?: string | null;
              targetRunGeneration?: number;
            }
          | undefined;
        const commandTarget =
          !!priorCommandPayload &&
          priorCommandPayload.command === msg.type &&
          priorCommandPayload.targetRunId !== undefined &&
          priorCommandPayload.targetRunGeneration !== undefined
            ? {
                runId: priorCommandPayload.targetRunId,
                generation: priorCommandPayload.targetRunGeneration,
              }
            : undefined;
        const replayedTarget =
          commandTarget ||
          targetForTurnCancel(persistedCancel, `stop:${requestId}`) ||
          targetForDeliveryInterrupt(persistedInterrupt, requestId);
        const targetRunId = targetRun
          ? replayedTarget
            ? replayedTarget.runId
            : targetRun.currentRunId ||
              (targetRun.state === "starting" || targetRun.state === "preparing"
                ? currentAgentRunToken(commandSessionId)
                : undefined) ||
              null
          : undefined;
        const targetRunGeneration =
          replayedTarget?.generation ?? targetRun?.generation;
        const kernelToken = crypto.randomUUID();
        kernelDispatchTokens.add(kernelToken);
        let gatewayCommandExecuting = false;
        let gatewayPhysicalFinished = false;
        try {
          const plan = await sessionGatewayCommand({
            op: "request",
            sessionId: commandSessionId,
            requestId,
            operation: "websocket_command",
            identity: {
              command: msg.type,
              messageHash,
              ...(msg.type === "prompt" && msg.busyMode === "steer"
                ? { priority: true }
                : {}),
              ...(targetRunId !== undefined
                ? { targetRunId, targetRunGeneration }
                : {}),
            },
          });
          if (plan.status === "in_progress")
            throw Object.assign(
              new Error("Session command is already in progress"),
              {
                retryable: true,
              },
            );
          gatewayCommandExecuting = plan.status === "execute";
          const accepted =
            plan.status === "completed"
              ? { result: plan.result, duplicate: true }
              : await withSessionMutationLock(commandSessionId, async () => {
                  if (targetRunId !== undefined) {
                    const current =
                      sessionKernel(commandSessionId).runStateProjection();
                    const currentTargetId =
                      current.currentRunId ||
                      (current.state === "starting" ||
                      current.state === "preparing"
                        ? currentAgentRunToken(commandSessionId)
                        : undefined) ||
                      null;
                    if (
                      currentTargetId !== targetRunId ||
                      current.generation !== targetRunGeneration
                    ) {
                      const cancelReplayMatches =
                        persistedCancel?.cancelId === `stop:${requestId}` &&
                        persistedCancel.runId === targetRunId &&
                        persistedCancel.runGeneration === targetRunGeneration;
                      const interruptReplayMatches =
                        !!persistedInterrupt &&
                        persistedInterrupt.anchorId === requestId &&
                        persistedInterrupt.dispatchId === targetRunId &&
                        persistedInterrupt.runGeneration ===
                          targetRunGeneration;
                      if (!cancelReplayMatches && !interruptReplayMatches)
                        throw new Error(
                          "The run targeted by this command has already changed",
                        );
                    }
                  }
                  await websocketHandlers.message?.(
                    ws,
                    JSON.stringify({
                      ...msg,
                      sessionId: commandSessionId,
                      requestId,
                      ...(targetRunId !== undefined
                        ? {
                            __targetRunId: targetRunId,
                            __targetRunGeneration: targetRunGeneration,
                          }
                        : {}),
                      __sessionKernelToken: kernelToken,
                    }),
                  );
                  const dispatchError = kernelDispatchErrors.get(kernelToken);
                  if (dispatchError) throw dispatchError;
                  const result = kernelDispatchResults.get(kernelToken);
                  gatewayPhysicalFinished = true;
                  await sessionGatewayCommand({
                    op: "complete",
                    sessionId: commandSessionId,
                    requestId,
                    operation: "websocket_command",
                    result,
                  });
                  return { result, duplicate: false };
                });
          if (
            accepted.duplicate &&
            accepted.result &&
            typeof accepted.result === "object"
          )
            ws.send(JSON.stringify(markReplayedCommandResult(accepted.result)));
          ws.send(
            JSON.stringify({
              type: "command_result",
              sessionId: commandSessionId,
              requestId,
              status: "completed",
              result: accepted.result,
            }),
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const retryable = isRetryableSessionCommandError(error);
          if (gatewayCommandExecuting && !gatewayPhysicalFinished)
            await sessionGatewayCommand({
              op: "fail",
              sessionId: commandSessionId,
              requestId,
              operation: "websocket_command",
              error: message,
              retryable,
            });
          ws.send(
            JSON.stringify({
              type: "command_result",
              sessionId: commandSessionId,
              requestId,
              status: "failed",
              error: message,
              terminal: !retryable,
            }),
          );
          ws.send(
            JSON.stringify({
              type: "error",
              sessionId: commandSessionId,
              message,
            }),
          );
          if (retryable)
            setTimeout(
              () => ws.close(1012, "Retry session command"),
              50,
            ).unref?.();
        } finally {
          kernelDispatchTokens.delete(kernelToken);
          kernelDispatchResults.delete(kernelToken);
          kernelDispatchErrors.delete(kernelToken);
        }
        return;
      }

      switch (msg.type) {
        case "ping": {
          // App-level liveness probe (browsers can't send WS protocol pings).
          // The client closes + reconnects a socket whose ping goes unanswered
          // — how a half-open iOS/Safari socket gets detected.
          ws.send('{"type":"pong"}');
          break;
        }

        case "command_ack": {
          if (msg.sessionId && msg.requestId) {
            await acknowledgeSessionCommand(msg.sessionId, msg.requestId);
            ws.send(
              JSON.stringify({
                type: "command_ack_result",
                sessionId: msg.sessionId,
                requestId: msg.requestId,
              }),
            );
          }
          break;
        }

        case "away": {
          // Presence, not subscription: the tab went hidden or unfocused (or came
          // back). The watch stays put — the transcript must keep streaming so
          // unread counts and notifications still land — but an away socket
          // stops showing its owner's face to everyone else.
          const presenceSuppressed = ws.data.presenceSuppressed === true;
          setClientAway(ws, presenceSuppressed || msg.away === true);
          // Coming back to a session whose turn finished while everyone was
          // away → drop in an away-summary system chip (recap.ts).
          const returnedTo = ws.data?.watchingSessionId;
          if (!presenceSuppressed && msg.away !== true && returnedTo) {
            maybeRecapOnReturn(returnedTo, ws.data?.user || undefined);
            // Same return: offer the finished turn's choice as chips if it
            // ended one while nobody was here (reply-suggestions.ts).
            maybeSuggestRepliesOnReturn(returnedTo, ws.data?.user || undefined);
          }
          break;
        }

        case "typing": {
          if (typeof msg.sessionId !== "string") break;
          setClientTyping(ws, msg.sessionId, msg.typing === true);
          break;
        }

        case "watch": {
          const sessionId = msg.sessionId;
          const data = ws.data;
          const watchRequest = (data.watchRequest ?? 0) + 1;
          data.watchRequest = watchRequest;
          const session = await findSessionAsync(sessionId);
          if (data.watchRequest !== watchRequest) return;
          if (!session) {
            ws.send(
              JSON.stringify({ type: "error", message: "Session not found" }),
            );
            return;
          }

          // Stop watching any previous session first
          stopAllWatchesForClient(ws);
          releaseTranscriptV2(ws);
          leaveSession(ws);

          data.watchingSessionId = sessionId;
          data.supportsFeed = msg.supportsFeed === true;
          data.sinceFeedSeq =
            typeof msg.sinceFeedSeq === "number" ? msg.sinceFeedSeq : undefined;
          data.feedEpoch =
            typeof msg.feedEpoch === "string" ? msg.feedEpoch : undefined;
          if (msg.user) data.user = msg.user;
          joinSession(ws, sessionId);
          console.log(
            `[presence] watch user=${JSON.stringify(data.user || "Anonymous")} login=${JSON.stringify(data.authLogin || null)} session=${JSON.stringify(sessionId)} client=${JSON.stringify(data.presenceClient || "unknown")}`,
          );

          // Opening a session whose last turn finished with nobody watching →
          // drop in an away-summary system chip (recap.ts). Fire-and-forget;
          // the recap arrives through the transcript bus like any append.
          if (data.presenceSuppressed !== true) {
            maybeRecapOnReturn(sessionId, data.user || undefined);
            maybeSuggestRepliesOnReturn(sessionId, data.user || undefined);
          }

          // Transcript v2 (flag + supportsSeq gated): eligible watches are
          // served from the owned store + bus with seq cursors — no mirror
          // file-watcher. Ineligible/flag-off falls through byte-identical.
          // The call itself is guarded: a throw anywhere in the v2 path must
          // degrade to the legacy watch, never kill the watch silently (a
          // cold-boot binding failure did exactly that on 2026-07-23 — the
          // client got no init and no error).
          let v2Served = false;
          try {
            v2Served = await serveTranscriptV2(ws, sessionId, session, msg);
          } catch (e) {
            console.error(
              `[ws] transcript v2 serve threw for ${sessionId} — falling back to legacy watch:`,
              e,
            );
          }
          if (v2Served) {
            await sendWatchExtras(ws, sessionId, session);
            break;
          }

          // Reconnect resume: a client that still holds this session's entries
          // re-watches with the byte cursor of the last transcript frame it
          // received (sinceOffset + sinceRev from transcript_init/append). When
          // the cursor still matches the live mirror file — same rev (the
          // transcript didn't rotate to a new engine id) and an offset the file
          // still covers — skip the full-tail transcript_init replace and let
          // the file-watcher's gap-fill replay exactly the missed entries from
          // the jsonl (the client's id-keyed upsert absorbs any overlap). The
          // jsonl IS the replay buffer: append-only, restart-proof, and it
          // covers entries written while nobody was watching. Any mismatch
          // falls through to the full snapshot below.
          const sinceOffset =
            typeof msg.sinceOffset === "number" && msg.sinceOffset > 0
              ? msg.sinceOffset
              : undefined;
          if (
            sinceOffset !== undefined &&
            typeof msg.sinceRev === "string" &&
            session.transcriptPath &&
            msg.sinceRev === transcriptRev(session.transcriptPath) &&
            existsSync(session.transcriptPath) &&
            sinceOffset <= statSync(session.transcriptPath).size
          ) {
            startWatching(session.transcriptPath, ws, sinceOffset, sessionId);
            await sendWatchExtras(ws, sessionId, session);
            break;
          }

          // Send one bounded transcript tail so the loading state transitions to
          // a complete conversation instead of first painting a screenful and
          // prepending the rest a beat later. The tighter INIT wire clamp keeps
          // that snapshot manageable: the UI eagerly renders only
          // ~6KB of markdown per bubble and fetches the full entry on demand,
          // so the fat 32KB clamp only bought transfer time (a heavy tail hit
          // 1.7MB on the wire). `startOffset` is the pagination cursor for
          // "load earlier".
          let { entries, truncated, endOffset, startOffset } =
            session.transcriptPath
              ? parseTranscriptTail(session.transcriptPath)
              : { entries: [], truncated: false, endOffset: 0, startOffset: 0 };
          if (!entries.length) {
            // No mirror file yet — a fresh session, or an engine-id rotation
            // whose next run hasn't seeded the new id's file. Without this the
            // thread renders blank until the next send (which seeds the file);
            // serve history via the cross-engine fallback (old transcript file
            // merged with Pi's SQLite store) instead. No byte cursor into
            // a file here, so no "load earlier" paging — the next run's seeded
            // file restores it.
            const merged = await mergedSessionTranscriptAsync(session);
            if (data.watchRequest !== watchRequest) return;
            if (merged.length) {
              truncated = merged.length > 120;
              entries = truncated ? merged.slice(-120) : merged;
              startOffset = 0;
            }
          }
          sendTranscriptFrame(ws, {
            type: "transcript_init",
            sessionId,
            entries: entriesForWire(entries, INIT_WIRE_CLAMP_BYTES),
            truncated,
            startOffset,
            // Resume cursor (see the sinceOffset branch above): where this
            // snapshot ends in the mirror file, and which file that was.
            ...(session.transcriptPath
              ? { endOffset, rev: transcriptRev(session.transcriptPath) }
              : {}),
          });

          // Start file watcher from where the tail parse left off — bytes
          // appended between the parse and the watch would otherwise be lost.
          if (session.transcriptPath) {
            startWatching(session.transcriptPath, ws, endOffset, sessionId);
          }

          await sendWatchExtras(ws, sessionId, session);
          break;
        }

        case "unwatch": {
          // Viewer navigated away from the session (not just to another one):
          // stop streaming transcript events and clear their ghost presence.
          // Mirrors the disconnect/close cleanup; leaveSession broadcasts
          // presence to the viewers who remain.
          ws.data.watchRequest = (ws.data.watchRequest ?? 0) + 1;
          stopAllWatchesForClient(ws);
          releaseTranscriptV2(ws);
          leaveSession(ws);
          break;
        }

        case "load_transcript_index": {
          if (
            ws.data?.transcriptV2 &&
            ws.data?.watchingSessionId === msg.sessionId
          ) {
            try {
              await sendTranscriptIndex(
                ws,
                msg.sessionId,
                () =>
                  ws.data?.watchingSessionId === msg.sessionId &&
                  !!ws.data?.transcriptV2,
              );
            } catch (error) {
              console.warn(
                `[ws] transcript index refresh failed for ${msg.sessionId}:`,
                error,
              );
            }
          }
          break;
        }

        case "load_transcript_range": {
          if (
            !ws.data?.transcriptV2 ||
            ws.data?.watchingSessionId !== msg.sessionId
          )
            break;
          const firstSeq = Math.max(1, Math.floor(msg.firstSeq));
          const lastSeq = Math.max(firstSeq, Math.floor(msg.lastSeq));
          const afterSeq =
            typeof msg.afterSeq === "number"
              ? Math.floor(msg.afterSeq)
              : firstSeq - 1;
          try {
            const page = await transcript.readRange(
              msg.sessionId,
              firstSeq,
              lastSeq,
              afterSeq,
              TRANSCRIPT_ACTOR_RANGE_PAGE_LIMIT,
            );
            sendTranscriptFrame(ws, {
              type: "transcript_range",
              sessionId: msg.sessionId,
              requestId: msg.requestId,
              entries: clampV2InitEntries(classifyV2Entries(page.entries)),
              firstSeq: page.firstSeq,
              lastSeq: page.lastSeq,
              coveredThroughSeq: page.coveredThroughSeq,
              complete: page.complete,
              epoch: await transcript.getLastResetChangeSeq(msg.sessionId),
              lastChangeSeq: await transcript.getLastChangeSeq(msg.sessionId),
            });
          } catch (error) {
            console.warn(
              `[ws] transcript range failed for ${msg.sessionId}:`,
              error,
            );
          }
          break;
        }

        case "load_history": {
          // "Load earlier history": one PAGE of history — the byte window just
          // before the client's earliest offset (`beforeOffset`, threaded from
          // transcript_init/transcript_history startOffset). The old behavior
          // (re-send the ENTIRE transcript) hit ~15MB wire payloads and a
          // 600-bubble render on big transcripts; it survives only as the
          // fallback for clients that don't send an offset.
          //
          // Transcript v2 seq paging: a client in seq mode pages backwards
          // with `beforeSeq` → one ~40-entry page from the store. Legacy
          // offset paging below is untouched; a store failure falls
          // through to it.
          if (typeof msg.beforeSeq === "number" && msg.beforeSeq > 0) {
            try {
              // "Jump to the start" walks the entire backlog, so it asks for
              // fatter pages: fewer round trips, and — the real cost — fewer
              // whole-transcript reconciliations per entry recovered. Capped
              // because each visible entry can still carry 6KB on the wire.
              const page = await transcript.readBefore(
                msg.sessionId,
                Math.floor(msg.beforeSeq),
                Math.min(Math.max(1, Math.floor(msg.limit ?? 40)), 200),
              );
              sendTranscriptFrame(ws, {
                type: "transcript_history",
                sessionId: msg.sessionId,
                // Backlog pages take the same init clamp as legacy history
                // pages (see clampV2InitEntries).
                entries: clampV2InitEntries(classifyV2Entries(page.entries)),
                firstSeq: page.firstSeq,
                lastSeq: page.lastSeq,
                truncated: page.firstSeq > 1,
                v2: true,
              });
              break;
            } catch (e) {
              console.warn(
                `[ws] v2 load_history failed for ${msg.sessionId}:`,
                e,
              );
            }
          }
          const session = await findSessionAsync(msg.sessionId);
          if (!session?.transcriptPath) {
            // Same no-mirror-file state as the watch fallback: serve the merged
            // cross-engine history rather than blanking the client's view.
            sendTranscriptFrame(ws, {
              type: "transcript_init",
              sessionId: msg.sessionId,
              entries: session
                ? entriesForWire(await mergedSessionTranscriptAsync(session))
                : [],
              truncated: false,
            });
            return;
          }
          const before =
            typeof msg.beforeOffset === "number" && msg.beforeOffset > 0
              ? msg.beforeOffset
              : null;
          if (before !== null) {
            const rev = transcriptRev(session.transcriptPath);
            let fileSize: number | null = null;
            try {
              if (existsSync(session.transcriptPath)) {
                fileSize = statSync(session.transcriptPath).size;
              }
            } catch {
              fileSize = null;
            }
            if (
              msg.beforeRev !== rev ||
              fileSize === null ||
              before > fileSize
            ) {
              if (fileSize === null) {
                sendTranscriptFrame(ws, {
                  type: "transcript_init",
                  sessionId: msg.sessionId,
                  entries: entriesForWire(
                    await mergedSessionTranscriptAsync(session),
                  ),
                  truncated: false,
                });
                break;
              }
              const tail = parseTranscriptTail(session.transcriptPath);
              sendTranscriptFrame(ws, {
                type: "transcript_init",
                sessionId: msg.sessionId,
                entries: entriesForWire(tail.entries, INIT_WIRE_CLAMP_BYTES),
                truncated: tail.truncated,
                startOffset: tail.startOffset,
                endOffset: tail.endOffset,
                rev,
              });
              break;
            }
            // ~40 entries per page; the 1MB soft window cap bounds the server
            // read through fat tool-result regions, but the parser still
            // guarantees ≥10 entries per page (see parseTranscriptWindow) —
            // 2-entry pages made "load earlier" feel broken and kept the
            // infinite-scroll sentinel in range, chaining loads every ~1.6s.
            const page = parseTranscriptWindow(
              session.transcriptPath,
              before,
              undefined,
              40,
              1024 * 1024,
            );
            sendTranscriptFrame(ws, {
              type: "transcript_history",
              sessionId: msg.sessionId,
              entries: entriesForWire(page.entries, INIT_WIRE_CLAMP_BYTES),
              truncated: page.truncated,
              startOffset: page.startOffset,
            });
            break;
          }
          const entries = await parseTranscriptAsync(session.transcriptPath);
          sendTranscriptFrame(ws, {
            type: "transcript_init",
            sessionId: msg.sessionId,
            entries: entriesForWire(entries),
            truncated: false,
          });
          break;
        }

        case "prompt": {
          const { sessionId, user } = msg;
          // Non-string content (a client bug — e.g. `text` instead of
          // `content`) used to flow all the way into the run path and crash
          // the process. Coerce, and reject a send with nothing in it.
          const content = typeof msg.content === "string" ? msg.content : "";
          const images = parseImageDataUrls(msg.images);
          const imageUrls = asDataUrlList(msg.images);
          const rawContextSessions = Array.isArray(msg.contextSessions)
            ? msg.contextSessions
            : Array.isArray(msg.contextChats)
              ? msg.contextChats
              : undefined;
          const contextSessions = rawContextSessions?.filter(
            (id: unknown): id is string => typeof id === "string",
          );
          if (
            !content.trim() &&
            !images?.length &&
            !(Array.isArray(msg.files) && msg.files.length)
          ) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Empty prompt (no content/images/files)",
              }),
            );
            return;
          }
          const session = await findSessionAsync(sessionId);
          if (!session) {
            ws.send(
              JSON.stringify({ type: "error", message: "Session not found" }),
            );
            return;
          }

          // The composer's effort pill rides every send; persist a change so
          // this and future runs (queue drains, resumes) honor it.
          maybePersistEffort(session, msg.effort);
          maybePersistFastMode(session, msg.fastMode);

          // Slash commands are handled by opensession itself
          const notice = handleSlashCommand(
            session,
            String(content || "").trim(),
            user,
          );
          if (notice !== null) {
            ws.send(JSON.stringify({ type: "notice", message: notice }));
            invalidateSessionsCache();
            break;
          }

          // Codex sessions start a fresh thread on first prompt. Open Session
          // sessions with no engine id are *fresh* sessions (a new sibling from the
          // tab strip's +): runSessionPrompt starts a new conversation. Only
          // non-opensession sources genuinely need an id to resume.
          if (
            providerFor(session.model) === "claude" &&
            !session.claudeSessionId &&
            session.source !== "opensession"
          ) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "No Claude session to resume",
              }),
            );
            return;
          }

          // Sending a new human turn makes archived work active again. Do this
          // only after validation and slash-command handling have accepted the turn.
          await unarchiveForHumanTurn(session);

          // @People-mentions in a prompt ping the tagged teammates (roster
          // from the identity config, never the sender). Fires at send time
          // on every path — direct, queued, steer.
          void notifyMentions(
            String(content || ""),
            String(user || ""),
            sessionId,
            "prompt",
            session.title || "a session",
          );

          // An explicit send is the user's next action after a Stop, so it lifts the
          // stop latch here rather than inside the run the latch prevents. Without
          // this the message below queues durably and the drain parks it forever.
          await liftUserStop(sessionId);

          // Busy sends queue by default, so the user can still delete/edit or
          // manually steer the message. Settings can opt the composer into
          // steer-by-default (`busyMode: "steer"`), delivered at the next turn
          // boundary and falling back to queue when the run isn't steerable.
          if (
            isAgentSessionBusy(
              session.claudeSessionId,
              session.codexThreadId,
              session.id,
            )
          ) {
            if (msg.busyMode === "queue") {
              await enqueuePrompt(sessionId, {
                id: msg.requestId,
                content,
                user,
                images: imageUrls,
                files: msg.files,
                contextSessions,
                // Queue-by-choice: held until the agent FULLY completes
                // (including running child workers), not just until the
                // next turn boundary. Steer is the deliver-sooner path.
                hold: true,
              });
              watchExternalRunAndDrain(sessionId);
              break;
            }
            const attributed = user ? `[${user}] ${content}` : content;
            const steerItem = durableQueueItem(
              sessionId,
              queueItem({
                id: msg.requestId,
                content,
                user,
                images: imageUrls,
              }),
            );
            // Images fold into the live run as content blocks; disk-staged
            // files can't ride the steer channel, so a send carrying files
            // falls through to the queue (its drain delivers images + files
            // together at the run's next idle point).
            const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
            const hasContext = !!contextSessions?.length;
            if (
              msg.busyMode === "steer" &&
              !hasFiles &&
              !hasContext &&
              steerItem.id
            ) {
              const steerResult = await prepareAndSteerQueuedPrompt({
                sessionId,
                itemId: steerItem.id,
                item: steerItem,
                text: attributed,
                images,
              });
              if (steerResult !== "not_prepared") {
                if (steerResult === "rejected")
                  watchExternalRunAndDrain(sessionId);
                break;
              }
              const promptEntryId = steerItem.promptEntryId || steerItem.id;
              await promoteQueuedPrompt(
                sessionId,
                steerItem.id,
                promptEntryId,
                { ...steerItem, promptEntryId },
              );
              await storeAppendUserLineEarly(
                sessionId,
                transcriptLineUser(
                  attributed,
                  promptEntryId,
                  undefined,
                  images,
                ),
                { required: true },
              );
              watchExternalRunAndDrain(sessionId);
              break;
            }
            await enqueuePrompt(sessionId, {
              id: msg.requestId,
              content,
              user,
              images: imageUrls,
              files: msg.files,
              contextSessions,
            });
            watchExternalRunAndDrain(sessionId);
            break;
          }

          // A Sandbox send is durable before it can wake compute. The drain has
          // a per-session single-flight lock, so the first queued message owns
          // the wake and later messages remain FIFO behind it.
          if (
            session.sandbox?.sandboxId &&
            session.sandbox.provider !== "local"
          ) {
            await enqueuePrompt(sessionId, {
              id: msg.requestId,
              content,
              user,
              images: imageUrls,
              files: msg.files,
              contextSessions,
            });
            void drainQueue(sessionId).catch((error) =>
              console.error(
                `[queue] Sandbox wake drain failed for ${sessionId}:`,
                error,
              ),
            );
            break;
          }

          // Every accepted prompt enters the durable queue first. drainQueue moves
          // it into a dispatch record that survives a restart until the engine has
          // written its own active-run journal.
          await enqueuePrompt(sessionId, {
            id: msg.requestId,
            content,
            user,
            images: imageUrls,
            files: msg.files,
            contextSessions,
          });
          void drainQueue(sessionId).catch((error) =>
            console.error(
              `[queue] Prompt drain failed for ${sessionId}:`,
              error,
            ),
          );
          break;
        }

        case "interrupt_prompt": {
          const { sessionId, content, user } = msg;
          const images = parseImageDataUrls(msg.images);
          const imageUrls = asDataUrlList(msg.images);
          const session = await findSessionAsync(sessionId);
          if (!session) {
            ws.send(
              JSON.stringify({ type: "error", message: "Session not found" }),
            );
            return;
          }
          await unarchiveForHumanTurn(session);
          maybePersistEffort(session, msg.effort);
          maybePersistFastMode(session, msg.fastMode);
          await liftUserStop(sessionId);
          await enqueuePrompt(sessionId, {
            id: msg.requestId,
            content,
            user,
            images: imageUrls,
            files: msg.files,
          });
          if (
            isAgentSessionBusy(
              session.claudeSessionId,
              session.codexThreadId,
              session.id,
            )
          ) {
            if (
              !(await abortTurnAndDrain(
                sessionId,
                session,
                undefined,
                msg.requestId,
              ))
            )
              watchExternalRunAndDrain(sessionId);
          } else {
            void drainQueue(sessionId).catch((error) =>
              console.error(
                `[queue] Interrupt prompt failed for ${sessionId}:`,
                error,
              ),
            );
          }
          break;
        }

        case "delete_queued_prompt": {
          const { sessionId, queueId, queueIndex } = msg;
          await deleteQueuedPrompt(sessionId, queueId, queueIndex);
          break;
        }

        case "take_queued_prompt": {
          const { sessionId, queueId } = msg;
          const item = await takeQueuedPrompt(
            sessionId,
            queueId,
            ws.data.authUser || ws.data.user || undefined,
          );
          const response = {
            type: "queued_prompt_taken",
            sessionId,
            queueId,
            ...(item
              ? { item }
              : { message: "That queued message could not be edited." }),
          };
          if (typeof msg.__sessionKernelToken === "string")
            kernelDispatchResults.set(msg.__sessionKernelToken, response);
          ws.send(JSON.stringify(response));
          if (item) watchExternalRunAndDrain(sessionId);
          break;
        }

        case "take_steered_prompt": {
          const { sessionId, queueId } = msg;
          const actor = ws.data.authUser || ws.data.user || undefined;
          const session = await findSessionAsync(sessionId);
          const receipt = editableSteerReceipt(sessionId, queueId, actor);
          const retracted =
            !!session &&
            !!receipt &&
            (await retractAgentSteer(
              [session.claudeSessionId, session.codexThreadId, session.id],
              queueId,
            ));
          const item = retracted
            ? ((await takeSteeredPrompt(sessionId, queueId, actor)) ?? receipt)
            : undefined;
          const response = {
            type: "queued_prompt_taken",
            sessionId,
            queueId,
            ...(item
              ? { item }
              : { message: "That steering message has already been sent." }),
          };
          if (typeof msg.__sessionKernelToken === "string")
            kernelDispatchResults.set(msg.__sessionKernelToken, response);
          ws.send(JSON.stringify(response));
          break;
        }

        case "update_queued_prompt": {
          const { sessionId, queueId, queueIndex, content } = msg;
          const images = Array.isArray(msg.images)
            ? (asDataUrlList(msg.images) ?? [])
            : undefined;
          await updateQueuedPrompt(
            sessionId,
            queueId,
            queueIndex,
            String(content || "").trim(),
            images,
          );
          break;
        }

        case "steer_queued_prompt": {
          const { sessionId, queueId, queueIndex } = msg;
          if (!(await steerQueuedPrompt(sessionId, queueId, queueIndex))) {
            ws.send(
              JSON.stringify({
                type: "notice",
                sessionId,
                message:
                  "Could not steer that queued message right now. It is still queued.",
              }),
            );
          }
          break;
        }

        case "interrupt_queued_prompt": {
          const { sessionId, queueId, queueIndex } = msg;
          if (!(await interruptQueuedPrompt(sessionId, queueId, queueIndex))) {
            ws.send(
              JSON.stringify({
                type: "notice",
                sessionId,
                message:
                  "Could not interrupt with that message right now. It is still queued.",
              }),
            );
          }
          break;
        }

        case "reorder_queued_prompt": {
          const { sessionId, order } = msg;
          if (
            Array.isArray(order) &&
            order.every((x) => typeof x === "string")
          ) {
            await reorderQueuedPrompt(sessionId, order);
          }
          break;
        }

        case "cancel": {
          const data = ws.data;
          const sessionId = msg.sessionId || data.watchingSessionId;
          if (sessionId) {
            const session = await findSessionAsync(sessionId);
            const target = msg as typeof msg & {
              __targetRunId?: string | null;
              __targetRunGeneration?: number;
            };
            const expectedRunId = target.__targetRunId;
            const expectedGeneration = target.__targetRunGeneration;
            let requeued = 0;
            if (session && expectedRunId && expectedGeneration !== undefined) {
              ({ requeued } = await requestTurnCancel(sessionId, session, {
                cancelId: `stop:${msg.requestId}`,
                expectedRunId,
                expectedGeneration,
                source: "ui_stop",
                user: data.user || undefined,
              }));
              console.log(
                `[ws] run stop prepared on ${sessionId} by ${data.user || "unknown"}`,
              );
              audit({
                msg: "run_cancelled",
                session_id: sessionId,
                source: "ui_stop",
                user: data.user,
              });
              // Projection remains idempotent by its stable request-derived id.
              if (session.claudeSessionId) {
                try {
                  await appendTranscriptEntries(session.claudeSessionId, [
                    transcriptLineRunnerNotice(
                      `Stopped by ${data.user || "someone"}.`,
                      `stop-${msg.requestId}`,
                    ),
                  ]);
                } catch {}
              }
            }
            if (requeued > 0) {
              broadcastToSession(sessionId, {
                type: "notice",
                message: `Stopped — ${requeued} steered message${requeued === 1 ? "" : "s"} returned to the queue.`,
              });
            }
          }
          break;
        }

        case "answer_question": {
          const { sessionId, questionId, answers } = msg;
          const pending = await pendingAskAwaitingAnswer(sessionId);
          if (pending && pending.questionId === questionId) {
            await pending.resolve(
              answers && typeof answers === "object" ? answers : null,
            );
          }
          break;
        }

        // ── Interactive shell (Shell tab) — multiple PTYs per socket, one
        // per shell tab, keyed by the client's termId ("0" for legacy
        // clients that predate multi-tab shells). Outbound frames are
        // tagged with the termId so the client routes them to the right tab.
        case "term_start": {
          const termId = typeof msg.termId === "string" ? msg.termId : "0";
          // Sandbox-aware: docker/daytona sessions get the shell INSIDE
          // their sandbox; host worktree shell otherwise (terminals.ts).
          void startSessionTerminal(
            ws,
            termId,
            await findSessionAsync(msg.sessionId),
            {
              cols: Number(msg.cols) || undefined,
              rows: Number(msg.rows) || undefined,
              send: (m) => {
                try {
                  ws.send(JSON.stringify({ ...m, termId }));
                } catch {}
              },
            },
          );
          break;
        }
        case "term_input": {
          if (typeof msg.data === "string")
            writeTerminal(
              ws,
              typeof msg.termId === "string" ? msg.termId : "0",
              msg.data,
            );
          break;
        }
        case "term_resize": {
          resizeTerminal(
            ws,
            typeof msg.termId === "string" ? msg.termId : "0",
            Number(msg.cols),
            Number(msg.rows),
          );
          break;
        }
        case "term_stop": {
          stopTerminal(ws, typeof msg.termId === "string" ? msg.termId : "0");
          break;
        }

        case "create_session": {
          const response = await handleCreateSessionMessage(ws, msg);
          if (typeof msg.__sessionKernelToken === "string" && response)
            kernelDispatchResults.set(msg.__sessionKernelToken, response);
          break;
        }
      }
    } catch (e) {
      console.error(`[ws] ${msg?.type || "unknown"} handler failed:`, e);
      const kernelToken = isInternalKernelDispatch(
        kernelDispatchTokens,
        msg?.__sessionKernelToken,
      )
        ? msg.__sessionKernelToken
        : undefined;
      if (kernelToken) {
        kernelDispatchErrors.set(
          kernelToken,
          e instanceof Error ? e : new Error(String(e)),
        );
      } else if (
        msg?.type === "create_session" &&
        isCreationEffectPendingError(e)
      ) {
        // No terminal response: the deterministic create is still durable.
        // Reconnect makes the client replay it instead of reopening the modal
        // while the actor completes the same session in the background.
        setTimeout(() => ws.close(1012, "Retry session create"), 50).unref?.();
      } else {
        const errorSessionId =
          msg?.type === "create_session"
            ? typeof msg.clientSessionId === "string"
              ? msg.clientSessionId
              : undefined
            : typeof msg?.sessionId === "string"
              ? msg.sessionId
              : undefined;
        try {
          ws.send(
            JSON.stringify({
              type: "error",
              ...(errorSessionId ? { sessionId: errorSessionId } : {}),
              message: `Internal error handling "${msg?.type || "message"}" — see server log`,
            }),
          );
        } catch {}
      }
    }
  },

  close(ws) {
    if (sandboxWsClose(ws)) return;
    if (runnerWsClose(ws)) return;
    if (sandboxPortalRelayClose(ws)) return;
    ws.data.watchRequest = (ws.data.watchRequest ?? 0) + 1;
    allClients.delete(ws);
    stopAllWatchesForClient(ws);
    releaseTranscriptV2(ws);
    leaveSession(ws);
    stopAllTerminals(ws); // the Shell tabs' PTYs die with their socket
    console.log("WebSocket client disconnected");
  },
};
