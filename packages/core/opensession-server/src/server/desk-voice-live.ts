/**
 * Desk voice mode on GPT-Live — the web Desk's voice engine.
 *
 * GPT-Live splits a call in two: a full-duplex voice model that only talks,
 * and a backend it delegates to whenever the user needs real state read or
 * changed. Here the backend is OpenAI's Responses delegation (gpt-5.6-terra
 * by default; Settings → Desk voice can pick gpt-5.6-luna instead) carrying
 * the Desk's voice tool facade, and this server executes every tool call it
 * makes. The browser never sees a credential and its data channel is
 * locked down to transcript/lifecycle events plus `session.close`.
 *
 * Call lifecycle:
 * 1. The browser posts its WebRTC SDP offer to routes/desk-voice.ts.
 * 2. createLiveVoiceCall() builds the server-owned session config, creates
 *    the Live session with the instance API key (the SDP exchange happens in
 *    that same request), then attaches a sideband WebSocket to it before
 *    handing the SDP answer back. Nothing the model does is missed.
 * 3. The sideband receives every session event: transcript deltas are
 *    grouped into rows and mirrored into the Desk transcript; nested
 *    Responses events surface function calls, which run as the verified user
 *    and are answered with `response.item.create` + `response.create`.
 * 4. `session.closed` (or a dead sideband) finalizes the call: rows flush,
 *    timers clear, the registry entry goes away.
 *
 * Typed text during a call is queued as a user message on the Responses
 * backend, exactly as the Live docs prescribe for exact values.
 *
 * Module invariants: no sockets or timers at import time (everything hangs
 * off a request), and nothing here touches the gateway thread synchronously
 * beyond what desk-voice.ts already does for mirroring.
 */

import { ensureDeskSession } from "./desk";
import { VoiceReferenceLedger, linkSpokenReferences } from "./desk-voice-refs";
import { REPOS } from "./worktree";
import {
  DESK_LIVE_BACKEND_MODEL,
  VOICE_TOOLS,
  executeVoiceTool,
  listVoiceMcpTools,
  mirrorVoiceEntries,
  mirrorVoiceToolCall,
  recentDeskTurns,
  recordVoiceDiag,
  requireVoiceApiKey,
  truncate,
  voiceBackendModel,
  type LiveBackendModel,
} from "./desk-voice";

export const DESK_LIVE_MODEL = "gpt-live-1";
/** The default backend (Terra). The instance-wide choice between it and Luna
 * is stored beside the API key; see voiceBackendModel() in desk-voice.ts. */
export { DESK_LIVE_BACKEND_MODEL };
const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";

/** Session timeline gap (ms) between two fragments of the same speaker that
 * starts a new transcript row. Rows are a record, not captions, so this is
 * tuned toward whole utterances rather than reactive display. */
export const LIVE_ROW_GAP_MS = 2000;
/** Wall-clock quiet period after which an open row is mirrored anyway. */
const LIVE_ROW_IDLE_MS = 2500;
/** Server-side backstops: the browser has its own idle timer, but the server
 * pays per second, so a call whose client silently vanished must not run
 * until OpenAI's own expiry. */
const LIVE_IDLE_CLOSE_MS = 3 * 60 * 1000;
const LIVE_MAX_CALL_MS = 30 * 60 * 1000;
const LIVE_ATTACH_TIMEOUT_MS = 10_000;
/** How long to wait for `session.closed` after asking for a close before
 * treating the call as finished anyway. */
const LIVE_CLOSE_GRACE_MS = 10_000;

// ---------------------------------------------------------------------------
// Prompts. Live wants a short voice prompt (speech, turn-taking, when to
// delegate) and a separate backend prompt carrying the actual rules.

export const LIVE_VOICE_INSTRUCTIONS = `You are the user's Desk, their standing concierge for the Open Session workspace, on a voice call. You are the same Desk they type to; this call continues that conversation.

How to talk: short, natural sentences, one or two per reply. No markdown, no lists. Never read ids aloud; refer to sessions by title. If the user pauses mid-thought, wait. If they interrupt, stop and listen.

You know nothing about real state yourself. Anything about sessions, todos, repos, automations, or what is running comes from the backend: delegate, say briefly that you're checking or doing it, and keep the conversation going while it works. Never guess or invent state. If the backend reports a failure, say so plainly.

Delegate actions too: capturing a todo, starting a worker session, sending a message into a session. Before starting or steering a session, confirm in one line what you're about to do; don't over-confirm reads. When a result comes back, paraphrase it naturally instead of reading it out.`;

export const LIVE_BACKEND_INSTRUCTIONS = `## Voice conversation context
You are the backend for the user's Desk, their standing concierge for the Open Session workspace, during a live voice call. The voice model handles speech and delegates to you whenever the user needs real state read or changed. Transcripts can contain mistakes, unfinished phrases, and later corrections: use the latest context and verified tool results. If a needed detail is still unclear, return a question instead of guessing.

## Task instructions
- Use the tools for anything about real state: sessions, todos, repos, automations. Never invent state or a successful action.
- You are an orchestrator, not the worker. For anything beyond a quick answer or a list edit, start a scoped worker session (start_session) with a self-contained prompt and report that you did. Use mode "code" when it should edit files or open a PR, "ask" for read-only investigation.
- Capture todos the moment the user mentions wanting or needing to do something. Never drop a todo unprompted.
- Run independent lookups together. Do not repeat an action that already ran.

## Return the result
Return two or three plain sentences the voice model can say aloud: the relevant facts, whether the task is done, and what comes next. Refer to sessions by title, never by id. State a pull request as its repo and number in digits (e.g. "tella-fusion PR 6474"). No markdown, no lists, no raw tool output.`;

/** The browser's data channel may only ask to hang up. Tool results, session
 * updates, and typed text all travel through this server. */
export const LIVE_CLIENT_ALLOWED_EVENTS = ["session.close"] as const;
/** What the browser gets to see: enough for call state and captions, none of
 * the nested backend traffic (tool arguments and results stay server-side). */
export const LIVE_CLIENT_VISIBLE_EVENTS = [
  "session.started",
  "session.closed",
  "session.input_transcript.delta",
  "session.output_transcript.delta",
  "session.delegation.created",
  "error",
] as const;

// ---------------------------------------------------------------------------
// Session config — server-owned, so the client can't widen the tool list or
// its own data-channel permissions.

export interface LiveFunctionTool {
  type: string;
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export async function buildLiveSessionConfig(
  sessionId: string,
  user = "Open Session",
) {
  // Read per call: the setting can change between calls, and a running call
  // keeps whatever backend it started on.
  const backendModel: LiveBackendModel = await voiceBackendModel();
  const turns = await recentDeskTurns(sessionId);
  const tools: LiveFunctionTool[] = [
    ...VOICE_TOOLS,
    ...((await listVoiceMcpTools(
      user,
      sessionId,
    )) as unknown as LiveFunctionTool[]),
    // Responses function tools default to strict schemas, which the MCP
    // inventory's schemas do not satisfy; strict mode buys nothing here.
  ].map((tool) => ({ ...tool, strict: false }));
  return {
    model: DESK_LIVE_MODEL,
    instructions: LIVE_VOICE_INSTRUCTIONS,
    ...(turns.length
      ? {
          input: turns.map((t) => ({
            type: "message",
            role: t.role,
            content: [
              {
                type: t.role === "user" ? "input_text" : "text",
                text: t.text,
              },
            ],
          })),
        }
      : {}),
    audio: { output: { voice: "marin" } },
    delegation: {
      type: "responses",
      responses: {
        model: backendModel,
        instructions: LIVE_BACKEND_INSTRUCTIONS,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: true,
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
      },
    },
    client: {
      data_channel: {
        allowed_client_events: [...LIVE_CLIENT_ALLOWED_EVENTS],
        allowed_server_events: LIVE_CLIENT_VISIBLE_EVENTS.map((type) => ({
          type,
        })),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Transcript rows. Live emits timed fragments per speaker with no turn
// boundary, so rows are grouped by session-timeline gap and flushed on a
// wall-clock idle. Each flushed row is one mirrored transcript entry.
//
// Both speakers may have a row open at once (full duplex), so ordering is
// decided on the session timeline, not on arrival or idle order: a row is
// flushed before any fragment or row that starts after it ended, and
// `flushAll` goes by start time. User fragments arrive later than assistant
// ones (speech recognition lags playback), which is why arrival order alone
// would put the reply ahead of the question it answers.

export type VoiceRole = "user" | "assistant";

export interface TranscriptFragment {
  role: VoiceRole;
  delta: string;
  startMs: number;
  endMs: number;
}

interface OpenRow {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

function otherRole(role: VoiceRole): VoiceRole {
  return role === "user" ? "assistant" : "user";
}

export class VoiceTranscriptRows {
  private open: Record<VoiceRole, OpenRow | null> = {
    user: null,
    assistant: null,
  };
  private idleTimers: Record<VoiceRole, ReturnType<typeof setTimeout> | null> =
    { user: null, assistant: null };

  constructor(
    private readonly opts: {
      gapMs: number;
      idleMs: number;
      rowId: (role: VoiceRole, startMs: number) => string;
      onRow: (row: {
        id: string;
        role: VoiceRole;
        text: string;
        /** Timeline span of the fragments joined into this row. */
        startMs: number;
        endMs: number;
      }) => void;
    },
  ) {}

  push(fragment: TranscriptFragment): void {
    const { role } = fragment;
    // Every open row this fragment closes goes out first, in start order:
    // the same speaker's row when the gap is too long, the other speaker's
    // when it ended before this fragment began (that turn is over and belongs
    // ahead of this one). Whichever closed, the earlier-started row leads.
    const done: VoiceRole[] = [];
    const current = this.open[role];
    if (current && fragment.startMs - current.endMs > this.opts.gapMs)
      done.push(role);
    const other = this.open[otherRole(role)];
    if (other && other.endMs <= fragment.startMs) done.push(otherRole(role));
    this.flushInStartOrder(done);
    const row = this.open[role];
    if (row) {
      // Concatenate exactly as received: fragments carry their own spacing.
      row.text += fragment.delta;
      row.endMs = Math.max(row.endMs, fragment.endMs);
    } else {
      this.open[role] = {
        id: this.opts.rowId(role, fragment.startMs),
        text: fragment.delta,
        startMs: fragment.startMs,
        endMs: fragment.endMs,
      };
    }
    this.armIdle(role);
  }

  /** Flushes one speaker's row (its idle fired). A row of the other speaker
   * that ended before this one started goes out first, whichever idle timer
   * happened to fire. */
  flush(role: VoiceRole): void {
    const row = this.open[role];
    if (!row) {
      this.clearIdle(role);
      return;
    }
    const other = this.open[otherRole(role)];
    if (other && other.endMs <= row.startMs) this.flushRow(otherRole(role));
    this.flushRow(role);
  }

  /** Flushes every open row in start order. */
  flushAll(): void {
    this.flushInStartOrder(["user", "assistant"]);
  }

  private flushInStartOrder(roles: VoiceRole[]) {
    const open = roles.filter((r) => this.open[r]);
    open.sort((a, b) => this.open[a]!.startMs - this.open[b]!.startMs);
    for (const role of open) this.flushRow(role);
  }

  private flushRow(role: VoiceRole) {
    this.clearIdle(role);
    const row = this.open[role];
    this.open[role] = null;
    if (row && row.text.trim())
      this.opts.onRow({
        id: row.id,
        role,
        text: row.text.trim(),
        startMs: row.startMs,
        endMs: row.endMs,
      });
  }

  private clearIdle(role: VoiceRole) {
    const timer = this.idleTimers[role];
    if (timer) {
      clearTimeout(timer);
      this.idleTimers[role] = null;
    }
  }

  private armIdle(role: VoiceRole) {
    const existing = this.idleTimers[role];
    if (existing) clearTimeout(existing);
    this.idleTimers[role] = setTimeout(
      () => this.flush(role),
      this.opts.idleMs,
    );
  }
}

// ---------------------------------------------------------------------------
// Responses delegation loop. Nested Responses events arrive wrapped in
// `response.event`; completed function calls are read from
// `response.output_item.done` (the only event carrying call_id + name +
// arguments together), executed, answered with `response.item.create`, and
// the response is continued with `response.create` once every call of that
// response has an output and the response itself has finished streaming.

export interface LiveResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface LiveResponseEvent {
  type: string;
  response?: { id?: string; usage?: LiveResponseUsage };
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
}

interface DelegationState {
  /** Function calls of the current response still awaiting an output. */
  open: Set<string>;
  /** Function calls seen in the current response, answered or not. */
  calls: number;
  finished: boolean;
}

export class LiveResponseLoop {
  private delegations = new Map<string, DelegationState>();
  /** A continue requested (typed text) while calls were still open. */
  private continueWanted = false;
  /** A `response.create` sent whose `response.created` has not arrived.
   * Busy from the moment it is sent, so two typed messages in quick
   * succession cannot both see an idle loop and open colliding responses. */
  private createPending = false;

  constructor(
    private readonly io: {
      send: (event: Record<string, unknown>) => void;
      runTool: (
        callId: string,
        name: string,
        args: Record<string, unknown>,
      ) => Promise<unknown>;
    },
  ) {}

  /** A response is streaming or still owes tool outputs. Only one response
   * runs per delegation, and this loop keeps one state per delegation, so a
   * `response.create` issued now would reset the counters of the one in
   * flight; typed text waits for its terminal event instead. */
  get busy(): boolean {
    if (this.createPending) return true;
    for (const d of this.delegations.values())
      if (!d.finished || d.open.size) return true;
    return false;
  }

  handle(delegationId: string, event: LiveResponseEvent): void {
    const state = this.delegations.get(delegationId) ?? {
      open: new Set<string>(),
      calls: 0,
      finished: false,
    };
    this.delegations.set(delegationId, state);
    switch (event.type) {
      case "response.created":
        // A fresh response under this delegation (first, or the one our
        // response.create continued). Its own calls start from zero.
        this.createPending = false;
        state.open.clear();
        state.calls = 0;
        state.finished = false;
        break;
      case "response.output_item.done": {
        const item = event.item;
        if (item?.type !== "function_call" || !item.call_id || !item.name)
          break;
        const callId = item.call_id;
        state.open.add(callId);
        state.calls += 1;
        void this.execute(
          delegationId,
          state,
          callId,
          item.name,
          item.arguments,
        );
        break;
      }
      case "response.completed":
      case "response.done":
        state.finished = true;
        this.maybeContinue(delegationId, state);
        break;
      case "response.failed":
      case "response.incomplete":
      case "response.cancelled":
        this.createPending = false;
        state.finished = true;
        state.open.clear();
        this.delegations.delete(delegationId);
        // Typed text that waited on this response is still unanswered.
        if (this.continueWanted) this.requestContinue();
        break;
      default:
        break;
    }
  }

  /** Ask the backend to run (typed text): immediate when idle, otherwise
   * deferred until the outstanding tool results have been submitted. */
  requestContinue(): void {
    if (this.busy) {
      this.continueWanted = true;
      return;
    }
    this.continueWanted = false;
    this.createResponse();
  }

  private createResponse() {
    this.createPending = true;
    this.io.send({ type: "response.create" });
  }

  private async execute(
    delegationId: string,
    state: DelegationState,
    callId: string,
    name: string,
    rawArgs: string | undefined,
  ) {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(rawArgs || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>;
    } catch {}
    let output: unknown;
    try {
      output = await this.io.runTool(callId, name, args);
    } catch (e) {
      output = { error: e instanceof Error ? e.message : String(e) };
    }
    if (!state.open.has(callId)) return; // response failed meanwhile
    this.io.send({
      type: "response.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output) ?? "",
      },
    });
    state.open.delete(callId);
    this.maybeContinue(delegationId, state);
  }

  private maybeContinue(delegationId: string, state: DelegationState) {
    if (!state.finished || state.open.size) return;
    // Nothing to answer: the response finished without tool calls. Only a
    // deferred typed-text continue still needs a response.create.
    if (state.calls === 0 && !this.continueWanted) {
      this.delegations.delete(delegationId);
      return;
    }
    this.continueWanted = false;
    state.finished = false;
    state.calls = 0;
    this.createResponse();
  }
}

// ---------------------------------------------------------------------------
// Backend token usage. The voice model bills per second (reported once in
// `session.closed`); the backend bills per token, reported on each nested
// response's terminal event. Summing those here is the only place a call's
// whole cost is visible, so it goes in the end-of-call log and diag line.

export interface LiveUsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Part of inputTokens served from the prompt cache (cheaper). */
  cachedInputTokens: number;
  /** Part of outputTokens spent on reasoning. */
  reasoningTokens: number;
  /** Backend responses that reported usage. */
  responses: number;
}

export class LiveUsageMeter {
  readonly totals: LiveUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    responses: 0,
  };
  /** Both `response.completed` and `response.done` can name the same
   * response; whichever arrives first is the one counted. */
  private counted = new Set<string>();

  /** Adds the usage of a nested Responses event, if it is a terminal event
   * carrying one. Returns whether anything was added. */
  handle(event: LiveResponseEvent): boolean {
    if (event.type !== "response.completed" && event.type !== "response.done")
      return false;
    const usage = event.response?.usage;
    if (!usage) return false;
    const id = event.response?.id;
    if (id) {
      if (this.counted.has(id)) return false;
      this.counted.add(id);
    }
    this.totals.inputTokens += usage.input_tokens ?? 0;
    this.totals.outputTokens += usage.output_tokens ?? 0;
    this.totals.cachedInputTokens +=
      usage.input_tokens_details?.cached_tokens ?? 0;
    this.totals.reasoningTokens +=
      usage.output_tokens_details?.reasoning_tokens ?? 0;
    this.totals.responses += 1;
    return true;
  }
}

/** `tokens in=1200 (cached 800) out=340 (reasoning 120)`; the parentheses
 * only when there is something to say. */
export function formatLiveUsage(t: LiveUsageTotals): string {
  const cached = t.cachedInputTokens ? ` (cached ${t.cachedInputTokens})` : "";
  const reasoning = t.reasoningTokens
    ? ` (reasoning ${t.reasoningTokens})`
    : "";
  return `tokens in=${t.inputTokens}${cached} out=${t.outputTokens}${reasoning}`;
}

// ---------------------------------------------------------------------------
// Call registry.

interface LiveCall {
  id: string;
  user: string;
  deskSessionId: string;
  backendModel: LiveBackendModel;
  socket: WebSocket;
  rows: VoiceTranscriptRows;
  loop: LiveResponseLoop;
  /** PRs and sessions the call's tool calls surfaced, so a spoken "six four
   * seven four" or a session named only by title gets its chip. */
  ledger: VoiceReferenceLedger;
  usage: LiveUsageMeter;
  /** `session.delegation.created` events seen: how often the voice model
   * reached for the backend. */
  delegations: number;
  startedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  finalized: boolean;
}

const calls = new Map<string, LiveCall>();

/** Exported for tests and diagnostics; never exposes sockets. */
export function activeLiveCalls(): Array<{
  id: string;
  user: string;
  startedAt: number;
}> {
  return [...calls.values()].map((c) => ({
    id: c.id,
    user: c.user,
    startedAt: c.startedAt,
  }));
}

/** True when the event went out on the sideband; false when the socket is
 * not open (closing, before `onclose` finalizes the call) or send threw. */
function sendEvent(call: LiveCall, event: Record<string, unknown>): boolean {
  if (call.socket.readyState !== WebSocket.OPEN) return false;
  try {
    call.socket.send(JSON.stringify(event));
    return true;
  } catch (e) {
    console.error(`[desk-voice-live] send failed for ${call.id}:`, e);
    return false;
  }
}

function requestClose(call: LiveCall): void {
  if (call.finalized) return;
  sendEvent(call, { type: "session.close" });
  if (!call.closeTimer)
    call.closeTimer = setTimeout(
      () => finalize(call, "close timeout"),
      LIVE_CLOSE_GRACE_MS,
    );
}

function touch(call: LiveCall): void {
  if (call.idleTimer) clearTimeout(call.idleTimer);
  call.idleTimer = setTimeout(() => {
    console.log(`[desk-voice-live] ${call.id} idle, closing`);
    requestClose(call);
  }, LIVE_IDLE_CLOSE_MS);
}

function finalize(call: LiveCall, reason: string, seconds?: number): void {
  if (call.finalized) return;
  call.finalized = true;
  calls.delete(call.id);
  for (const t of [call.idleTimer, call.maxTimer, call.closeTimer])
    if (t) clearTimeout(t);
  call.rows.flushAll();
  try {
    if (
      call.socket.readyState === WebSocket.OPEN ||
      call.socket.readyState === WebSocket.CONNECTING
    )
      call.socket.close();
  } catch {}
  const usage = call.usage.totals;
  console.log(
    `[desk-voice-live] ${call.id} ended (${reason})${
      seconds !== undefined ? ` after ${Math.round(seconds)}s` : ""
    } user=${call.user} backend=${call.backendModel} ${formatLiveUsage(usage)}`,
  );
  // The server's own diag line. The browser posts a separate one at teardown
  // (lib/desk-voice-client.ts) rather than the two being merged: both are
  // triggered by the same `session.closed`, so a merge would need a holding
  // buffer with its own expiry for whichever half arrives first, while two
  // lines sharing a liveSessionId join with a grep. Counters only; nothing
  // spoken or transcribed goes in here.
  void recordVoiceDiag(call.user, {
    engine: "live",
    origin: "server",
    liveSessionId: call.id,
    backendModel: call.backendModel,
    reason,
    seconds: seconds !== undefined ? Math.round(seconds) : undefined,
    wallSeconds: Math.round((Date.now() - call.startedAt) / 1000),
    delegations: call.delegations,
    responses: usage.responses,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
  });
}

interface LiveServerEvent {
  type: string;
  delta?: string;
  start_ms?: unknown;
  end_ms?: unknown;
  delegation_id?: string | null;
  event?: LiveResponseEvent;
  reason?: string;
  usage?: { seconds?: number };
  error?: { message?: string; code?: string };
  message?: string;
  code?: string;
}

export function liveTranscriptSpan(event: {
  start_ms?: unknown;
  end_ms?: unknown;
}): { startMs: number; endMs: number } {
  const startMs =
    typeof event.start_ms === "number" && Number.isFinite(event.start_ms)
      ? event.start_ms
      : 0;
  const endMs =
    typeof event.end_ms === "number" && Number.isFinite(event.end_ms)
      ? event.end_ms
      : startMs;
  return { startMs, endMs };
}

function handleSidebandEvent(call: LiveCall, event: LiveServerEvent): void {
  switch (event.type) {
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      if (typeof event.delta === "string") {
        call.rows.push({
          role:
            event.type === "session.input_transcript.delta"
              ? "user"
              : "assistant",
          delta: event.delta,
          ...liveTranscriptSpan(event),
        });
        touch(call);
      }
      break;
    case "session.delegation.created":
      call.delegations += 1;
      touch(call);
      break;
    case "response.event":
      if (event.event && typeof event.delegation_id === "string") {
        call.usage.handle(event.event);
        call.loop.handle(event.delegation_id, event.event);
      }
      break;
    case "session.closed":
      finalize(call, event.reason ?? "closed", event.usage?.seconds);
      break;
    case "error":
      console.error(
        `[desk-voice-live] ${call.id} error: ${
          event.error?.message ?? event.message ?? JSON.stringify(event)
        }`,
      );
      break;
    default:
      break;
  }
}

function attachSideband(apiKey: string, liveId: string): Promise<WebSocket> {
  // Bun's WebSocket accepts request headers; the DOM lib signature doesn't
  // know about them, hence the narrow cast.
  const Ctor = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const socket = new Ctor(
    `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(liveId)}/attach`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  return new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out attaching to the Live session"));
    }, LIVE_ATTACH_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Could not attach to the Live session"));
    };
    socket.onclose = (ev) => {
      clearTimeout(timer);
      reject(
        new Error(`Live session sideband closed before it opened (${ev.code})`),
      );
    };
  });
}

/** Call creation in flight per user. Starts for one user run one at a time
 * so the one-call-per-user rule holds across the awaits below: a second tab
 * or a double press waits for the first start, then supersedes it. */
const starting = new Map<string, Promise<unknown>>();

export interface LiveCallStarted {
  liveSessionId: string;
  sdp: string;
  sessionId: string;
  /** What this call delegates to, so the browser's diag line can name it. */
  backendModel: LiveBackendModel;
}

export function createLiveVoiceCall(
  user: string,
  offerSdp: string,
): Promise<LiveCallStarted> {
  const previous = starting.get(user) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(() => createLiveVoiceCallNow(user, offerSdp));
  starting.set(user, run);
  void run
    .catch(() => {})
    .then(() => {
      if (starting.get(user) === run) starting.delete(user);
    });
  return run;
}

async function createLiveVoiceCallNow(
  user: string,
  offerSdp: string,
): Promise<LiveCallStarted> {
  const key = await requireVoiceApiKey();
  const { sessionId } = ensureDeskSession(user);

  // One call per user: a reload or a second tab must not leave the old call
  // (and its per-second billing) running headless.
  for (const existing of calls.values())
    if (existing.user === user) requestClose(existing);

  const session = await buildLiveSessionConfig(sessionId, user);
  const backendModel = session.delegation.responses.model;
  const res = await fetch(LIVE_SESSIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session,
      transport: { type: "webrtc", sdp: offerSdp },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenAI rejected the voice session (${res.status}): ${truncate(text, 300)}`,
    );
  }
  const data = (await res.json()) as {
    session?: { id?: string };
    transport?: { sdp?: string };
  };
  const liveId = data.session?.id;
  const answer = data.transport?.sdp;
  if (!liveId || !answer)
    throw new Error("OpenAI returned no Live session id or SDP answer");

  const socket = await attachSideband(key, liveId);
  const ledger = new VoiceReferenceLedger();
  const call: LiveCall = {
    id: liveId,
    user,
    deskSessionId: sessionId,
    backendModel,
    socket,
    rows: new VoiceTranscriptRows({
      gapMs: LIVE_ROW_GAP_MS,
      idleMs: LIVE_ROW_IDLE_MS,
      rowId: (role, startMs) => `voice-${liveId}-${role}-${startMs}`,
      // Only what the Desk said is rewritten: a spoken PR number becomes
      // `repo#N` and a session it started gets named, so the mirrored row
      // renders chips. The user's words stay exactly as transcribed.
      // The mirrored id carries the row's end too (`-end-<endMs>`), so the
      // browser's captions (frontend/lib/voice-captions.ts) can take down
      // exactly the fragments this row covers without matching its text.
      onRow: (row) =>
        mirrorVoiceEntries(user, [
          {
            id: `${row.id}-end-${row.endMs}`,
            role: row.role,
            text:
              row.role === "assistant"
                ? linkSpokenReferences(row.text, ledger)
                : row.text,
          },
        ]),
    }),
    loop: new LiveResponseLoop({
      send: (event) => sendEvent(call, event),
      runTool: async (callId, name, args) => {
        let result: unknown;
        try {
          result = await executeVoiceTool(user, name, args);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : String(e) };
        }
        mirrorVoiceToolCall(user, callId, name, args, result);
        ledger.collect(name, args, result, knownRepos());
        return result;
      },
    }),
    ledger,
    usage: new LiveUsageMeter(),
    delegations: 0,
    startedAt: Date.now(),
    idleTimer: null,
    maxTimer: null,
    closeTimer: null,
    finalized: false,
  };
  calls.set(liveId, call);
  socket.onopen = null;
  socket.onerror = (ev) => {
    console.error(`[desk-voice-live] ${liveId} sideband error`, ev);
  };
  socket.onclose = () => finalize(call, "sideband closed");
  socket.onmessage = (ev) => {
    let event: LiveServerEvent;
    try {
      event = JSON.parse(String(ev.data)) as LiveServerEvent;
    } catch {
      return;
    }
    handleSidebandEvent(call, event);
  };
  touch(call);
  call.maxTimer = setTimeout(() => {
    console.log(`[desk-voice-live] ${liveId} hit the call length cap`);
    requestClose(call);
  }, LIVE_MAX_CALL_MS);
  console.log(
    `[desk-voice-live] ${liveId} started user=${user} backend=${backendModel}`,
  );
  return { liveSessionId: liveId, sdp: answer, sessionId, backendModel };
}

/** The instance's repos, as the ledger needs them to resolve a PR mention:
 * the id a chip links by and the GitHub name a URL in a result carries. */
function knownRepos() {
  return Object.values(REPOS).map((r) => ({ id: r.id, ghRepo: r.ghRepo }));
}

function ownedCall(user: string, liveSessionId: string): LiveCall | undefined {
  const call = calls.get(liveSessionId);
  return call && call.user === user ? call : undefined;
}

/** Typed text during a call goes to the Responses backend as a user message
 * and is mirrored like a spoken turn. False when the call is not live. */
export function sendLiveVoiceText(
  user: string,
  liveSessionId: string,
  text: string,
): boolean {
  const call = ownedCall(user, liveSessionId);
  if (!call || call.finalized) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Acknowledge only what the backend actually received: a false here keeps
  // the browser's draft instead of mirroring a message nobody heard.
  const sent = sendEvent(call, {
    type: "response.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: trimmed }],
    },
  });
  if (!sent) return false;
  call.loop.requestContinue();
  mirrorVoiceEntries(user, [
    { id: `voice-typed-${crypto.randomUUID()}`, role: "user", text: trimmed },
  ]);
  touch(call);
  return true;
}

/** Hang up from the server side (browser backstop when its data channel is
 * already gone). Returns false when there is no such call for this user. */
export function closeLiveVoiceCall(
  user: string,
  liveSessionId: string,
): boolean {
  const call = ownedCall(user, liveSessionId);
  if (!call) return false;
  requestClose(call);
  return true;
}
