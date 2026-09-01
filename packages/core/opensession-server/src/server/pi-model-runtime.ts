/**
 * In-process Anthropic provider for the pi engine — the meridian trick
 * (blocked passthrough tools over the first-party @anthropic-ai/claude-agent-sdk)
 * implemented as a pi-ai NATIVE provider instead of the loopback HTTP bridge.
 * pi-runner registers it via `runtime.registerNativeProvider` when
 * `~/.opensession-pi.json` has `anthropicTransport: "inprocess"` (the
 * default; "bridge" keeps the pre-2026-08 loopback path as rollback), so
 * `pi/anthropic/*` turns reach pi/meridian's level: native token-level
 * streaming (SDK partial message events → pi text/thinking deltas), no
 * end-of-request replay assembly, and Meridian's durable passthrough
 * checkpoint protocol without a loopback HTTP hop.
 *
 * How a stream call maps onto the SDK (the anthropic-bridge.ts recipe, HTTP
 * hop removed — the shared helpers are imported from there so the two stay
 * one implementation):
 *  - pi hands `streamSimple(model, context, options)` the FULL pi-side
 *    conversation each turn. Messages convert to the bridge's Anthropic wire
 *    shape (piMessagesToAnthropic) and the bridge's session store logic
 *    decides continuation vs replay (planSdkTurn): history strictly grew past
 *    what the SDK session has seen → resume with only the new tail flattened;
 *    a durable passthrough checkpoint instead resumes at its tool-bearing
 *    assistant UUID with the exact real tool results as structured content.
 *    Anything else (first turn,
 *    edited/compacted history, or the designated walk moving to a DIFFERENT
 *    account — SDK sessions live in per-account isolated config dirs, so a
 *    cross-account resume cannot work) → fresh SDK session with a full flat
 *    replay.
 *    The pi→SDK session map is keyed by the stream option `sessionId` (the
 *    pi session id on agent turns — pi's compaction/branch-summary one-shots
 *    deliberately carry a fresh uuid per request and so take the stateless
 *    full-replay path instead of contaminating the conversation's SDK
 *    session), unified id as fallback, parked on globalThis: hot reloads
 *    keep it, a real restart just replays — correct, only slower.
 *  - The request's tools become no-op SDK-MCP passthrough tools; a PreToolUse
 *    hook captures {id, name, input} and blocks with Meridian's explicit stop
 *    instruction. Once every denial reaches the iterator, Pi receives its
 *    terminal toolUse event immediately. `maxTurns: 1` prevents the discarded,
 *    billed digest turn while still letting the SDK emit the terminal
 *    `error_max_turns` result that durably commits the checkpoint. Only then is
 *    the tool-bearing assistant UUID published as resumable. The next Pi step
 *    waits for that terminal drain and resumes there with real results.
 *  - Text/thinking stream token-level via `includePartialMessages` stream
 *    events; if the CLI ever yields no stream events, whole assistant
 *    messages fall back to one delta per text block on arrival — still
 *    strictly better than end-of-request replay.
 *  - Abort: the pi stream's AbortSignal drives the SDK's abortController
 *    (claude-direct's pattern); an abort ends the stream with reason
 *    "aborted", which runPi's user-cancel path swallows quietly.
 *
 * Containment (all enforced here, not in prompts):
 *  - Account pick mirrors pi/meridian: pickBridgeAccount (exported by
 *    the bridge) draws from the general claude-accounts pool with the run
 *    user's personal-first routing, honoring run-level pins (accountId/
 *    accountStrict/usageCredits). An pi bridgeAccountIds designation,
 *    when set, still contains serving to exactly those ids (legacy override).
 *    Building the provider throws bridgeDesignationError()'s exact message
 *    when the engine is disabled or no account exists, so the run fails as
 *    early and as clearly as the bridge path did.
 *  - Usage-limit-shaped SDK failures markExhausted the picked account and
 *    then ROTATE: the turn is replayed across every usable account, and only
 *    a dry pool surfaces the error (whose
 *    original message isPiUsageLimitShape's anthropic arm classifies:
 *    isClaudeUsageLimitError shapes, 429, "no designated bridge account").
 *    This is the account-walk discipline pi lacked: it sidelined the account
 *    and surfaced the failure, so one capped
 *    account ended the run while the rest of the pool sat idle and the
 *    sideline only helped the next prompt. agent-runner cannot rescue that
 *    either, because an explicit engine choice pins preferredFallback to
 *    "none" rather than crossing into an pi fallback. The per-account
 *    rolling hourly cap (admitBridgeRequest, shared counter with the bridge)
 *    refuses 429-worded for the same classifier, and rotates too, but is
 *    exempt from the sideline: it is local admission control that frees
 *    within the hour, and the sideline map is shared with pi.
 *    Rotation is bounded to a turn that has streamed NOTHING yet, so a
 *    failure mid-answer still surfaces plainly instead of replaying text the
 *    reader already saw. Known gap: the provider has no channel back to
 *    pi-runner's transcript, so a switch is visible in the audit log and the
 *    server log, not as a runner_notice the way pi's is.
 *  - Audit parity with the bridge (this replaces its per-request audit for pi
 *    traffic): `pi_anthropic_request` in/out with summarizeText, unified
 *    session attribution, account, tokens, duration — never raw text dumps,
 *    never tokens/secrets.
 *  - Env hygiene: the SDK subprocess env is PATH/HOME/LANG +
 *    CLAUDE_CODE_OAUTH_TOKEN + an ISOLATED per-account CLAUDE_CONFIG_DIR
 *    under stateDir("pi")/claude-cfg (claude-direct's stricter pattern — the
 *    subprocess can never fall back to host ~/.claude credentials), cwd is
 *    the bridge's empty BRIDGE_CWD (every tool is a blocked passthrough, no
 *    worktree must ever be visible), and the SDK's own built-ins are
 *    removed (`tools: []` via SDK_BUILTIN_TOOLS, DISALLOWED_BUILTINS, and the
 *    block-everything hook backstop).
 *
 * Known approximations (bridge parity, documented): `temperature`/`maxTokens`
 * /`timeoutMs` and pi's `reasoning` thinking level are ignored (the SDK does
 * not expose them); thinking blocks stream out but are dropped from replay
 * (signatures cannot round-trip through flat text). Images are NOT dropped:
 * the flat replay cannot carry them, so planSdkTurn lifts the delivered
 * slice's image blocks out and the turn goes to the SDK as a structured user
 * message (see sdkPromptContent). They used to be filtered away here, which
 * meant a person's screenshot reached the transcript and then vanished before
 * the model, with no error on either side.
 *
 * pi-ai is not a direct dependency (only @earendil-works/pi-coding-agent is),
 * so the Provider surface is structurally typed: types derive from
 * ModelRuntime's own signatures and the one cast lives in
 * buildPiAnthropicProvider. Returning a plain async generator from stream()
 * is contract-safe — ModelRuntime wraps every provider stream in pi-ai's
 * lazyStream, which forwards any AsyncIterable<AssistantMessageEvent> into a
 * real event stream and converts generator throws into terminal error events.
 */

import { mkdirSync } from "fs";
import {
  query,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stateDir } from "./paths";
import { audit, summarizeText } from "./audit";
import {
  DISALLOWED_BUILTINS,
  SDK_BUILTIN_TOOLS,
  PASSTHROUGH_MCP,
  PASSTHROUGH_PREFIX,
  admitBridgeRequest,
  bridgeDesignationError,
  ensureAnthropicBridgeCwd,
  flattenMessageText,
  jsonSchemaToZodShape,
  pickBridgeAccount,
  replayConversation,
  type AnthropicMessage,
  type ContentBlock,
} from "./anthropic-bridge";
import { markExhausted, type ClaudeAccount } from "./claude-accounts";
import {
  coalesceCompleteToolResultContinuation,
  createEarlyStopTracker,
  noteAssistantMessage,
  noteUserContent,
  settledToolCallAssistantUuid,
  shouldEarlyStop,
} from "./meridian-passthrough";
import {
  CLAUDE_CODE_BIN,
  describeUsageLimitReset,
  isClaudeSubscriptionError,
  isClaudeUsageLimitError,
  usageLimitResetAt,
} from "./runner-shared";

const g = globalThis as any;

const ACCOUNT_NOTICE_PROBE_CHARS = 64;

function isClaudeAccountUnavailable(
  message: string,
  isErrorResult: boolean,
): boolean {
  return (
    isClaudeUsageLimitError(message, isErrorResult) ||
    isClaudeSubscriptionError(message)
  );
}

/** Hold a small prefix until provider account notices can be distinguished from a real answer. */
export function shouldDeferClaudeText(text: string): boolean {
  return (
    text.length < ACCOUNT_NOTICE_PROBE_CHARS ||
    isClaudeAccountUnavailable(text, false)
  );
}

// ── Types (derived from the SDK so pi-ai never becomes a value import) ───────

/** The pi-ai Provider shape registerNativeProvider accepts. */
export type PiNativeProvider = Parameters<
  ModelRuntime["registerNativeProvider"]
>[0];
/** The pi-ai Model shape the runtime resolves and streams with. */
export type PiCatalogModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** Minimal structural view of pi's Message union — only the fields the
 *  converter reads (pi-ai is type-only reachable; these are its stable wire
 *  shapes). */
export interface PiWireMessage {
  role: "user" | "assistant" | "toolResult";
  content: string | Array<Record<string, any>>;
  toolCallId?: string;
  [key: string]: unknown;
}

interface PiToolShape {
  name: string;
  description: string;
  parameters?: unknown;
}

interface PiStreamContext {
  systemPrompt?: string;
  messages: PiWireMessage[];
  tools?: PiToolShape[];
}

interface PiStreamCallOptions {
  signal?: AbortSignal;
  sessionId?: string;
  [key: string]: unknown;
}

interface PiUsageShape {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface PiAssistantMessageShape {
  role: "assistant";
  content: Array<Record<string, any>>;
  api: string;
  provider: string;
  model: string;
  usage: PiUsageShape;
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
}

type PiStreamEvent =
  | { type: "start"; partial: PiAssistantMessageShape }
  | {
      type: "text_start" | "thinking_start" | "toolcall_start";
      contentIndex: number;
      partial: PiAssistantMessageShape;
    }
  | {
      type: "text_delta" | "thinking_delta" | "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: PiAssistantMessageShape;
    }
  | {
      type: "text_end" | "thinking_end";
      contentIndex: number;
      content: string;
      partial: PiAssistantMessageShape;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: Record<string, any>;
      partial: PiAssistantMessageShape;
    }
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse";
      message: PiAssistantMessageShape;
    }
  | {
      type: "error";
      reason: "aborted" | "error";
      error: PiAssistantMessageShape;
    };

// ── Passthrough capture and durable checkpoint drain ─────────────────────────

/** Meridian's model-facing denial. It is never part of Pi's transcript: once
 *  the visible tool batch settles, the provider closes Pi's stream and drains
 *  only the SDK's capped terminal result. */
export const PI_PASSTHROUGH_BLOCK_REASON =
  "This tool call has been forwarded to the client for execution. " +
  "The result will be delivered in a future turn. " +
  "Do not retry, do not call additional tools, and do not generate further text. End your turn now.";

/** Stop at the client-owned tool handoff. The SDK still emits its terminal
 *  `error_max_turns` result and flushes the transcript, but it never starts the
 *  discarded, billed digest turn. Ported from rynfar/meridian#860. */
export const PI_SDK_MAX_TURNS = 1;

/** Recover the two usable outcomes from the SDK's capped terminal result. */
export function recoverCappedSdkStopReason(
  subtype: unknown,
  capturedToolCalls: number,
  contentBlocks: number,
): "toolUse" | "length" | undefined {
  if (subtype !== "error_max_turns") return undefined;
  if (capturedToolCalls > 0) return "toolUse";
  if (contentBlocks > 0) return "length";
  return undefined;
}

// ── pi messages → the bridge's Anthropic wire shape ──────────────────────────

/** Media types the Anthropic messages API reads as an image. Anything else
 *  (bmp, svg, a missing mime) is dropped rather than sent as a block the API
 *  would reject for the whole request. */
const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * pi's `{type:"image", data, mimeType}` → Anthropic's base64 image block, or
 * null when it is not an image this API can read. Exported for the tests.
 */
export function piImageBlockToAnthropic(
  block: Record<string, any>,
): ContentBlock | null {
  if (!block || block.type !== "image") return null;
  if (typeof block.data !== "string" || !block.data) return null;
  const mediaType =
    typeof block.mimeType === "string" ? block.mimeType.toLowerCase() : "";
  if (!ANTHROPIC_IMAGE_MEDIA_TYPES.has(mediaType)) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: block.data },
  };
}

/**
 * Convert pi's Message[] into the AnthropicMessage[] the bridge helpers
 * (flattenMessageText / replayConversation) understand: assistant ToolCall
 * blocks become tool_use, toolResult messages become user tool_result
 * messages, thinking blocks are dropped (signatures cannot round-trip through
 * a flat-text replay). User images are KEPT: they do not survive the flat
 * replay either, so planSdkTurn lifts them out and rides them to the SDK as
 * real content blocks. Dropping them here was silent data loss — the model
 * answered as if the person had never attached a screenshot, with no error on
 * either side. Exported for the unit tests.
 */
export function piMessagesToAnthropic(
  messages: readonly PiWireMessage[],
): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
      } else if (Array.isArray(m.content)) {
        const blocks: ContentBlock[] = [];
        for (const b of m.content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && typeof b.text === "string") {
            blocks.push({ type: "text", text: b.text });
            continue;
          }
          const image = piImageBlockToAnthropic(b);
          if (image) blocks.push(image);
        }
        out.push({ role: "user", content: blocks });
      }
    } else if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && b.text)
            blocks.push({ type: "text", text: b.text });
          else if (b.type === "toolCall" && b.id) {
            blocks.push({
              type: "tool_use",
              id: b.id,
              name: b.name,
              input: b.arguments ?? {},
            });
          }
          // thinking: dropped — signatures cannot round-trip through flat replay.
        }
      }
      out.push({ role: "assistant", content: blocks });
    } else if (m.role === "toolResult") {
      const inner: ContentBlock[] = [];
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block?.type === "text" && typeof block.text === "string") {
            inner.push({ type: "text", text: block.text });
            continue;
          }
          const image = piImageBlockToAnthropic(block);
          if (image) inner.push(image);
        }
      } else {
        inner.push({ type: "text", text: String(m.content ?? "") });
      }
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: inner,
            ...(m.isError === true ? { is_error: true } : {}),
          },
        ],
      });
    }
  }
  return out;
}

// ── Per-unified-session SDK session store (the bridge's continuation logic) ──

export interface PiSdkSessionState {
  sdkSessionId: string;
  /** How many pi-side messages the SDK session has already seen. */
  messageCount: number;
  /** Account whose isolated CLAUDE_CONFIG_DIR holds the SDK session. A later
   *  turn served by a DIFFERENT designated account cannot resume it (the
   *  bridge shared host ~/.claude and could; isolation trades that for
   *  never-touching-host-creds) — the caller treats an account mismatch as
   *  divergence and replays fresh. */
  accountId: string;
  /** Durable assistant boundary for a visible passthrough tool turn. When set,
   *  the next exact tool-result continuation resumes here rather than after
   *  the SDK's capped terminal result. */
  passthroughToolCallAssistantUuid?: string;
  passthroughToolCallIds?: string[];
  lastUsedAt: number;
}

// unified session id → SDK session mapping; globalThis-parked for hot reloads
// (a real restart replays — correct, only slower). Exported for tests.
export function piSdkSessionStore(): Map<string, PiSdkSessionState> {
  return (g.__piAnthropicSdkSessions ??= new Map<string, PiSdkSessionState>());
}

/** Canonical SDK drains still running after Pi received a terminal toolUse
 *  event. The next step for that session waits here before reading its mapping. */
function piSdkCanonicalDrains(): Map<string, Promise<void>> {
  return (g.__piAnthropicCanonicalDrains ??= new Map<string, Promise<void>>());
}

function beginPiSdkCanonicalDrain(key: string): () => void {
  const drains = piSdkCanonicalDrains();
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  drains.set(key, promise);
  return () => {
    if (drains.get(key) === promise) drains.delete(key);
    resolve();
  };
}

export interface PiSdkTurnPlan {
  /** SDK session to resume; undefined = fresh session. */
  resume: string | undefined;
  /** Assistant checkpoint to resume from for an exact tool-result delta. */
  resumeSessionAt: string | undefined;
  /** Flat-text prompt: the new tail on an ordinary continuation, the full
   *  replay on divergence, or empty for a structured tool-result delta. */
  prompt: string;
  /** Structured tool results delivered after resumeSessionAt. */
  toolResults: ContentBlock[] | null;
  /** Image blocks from the delivered slice, oldest first. Empty = a plain-text
   *  turn, which rides the SDK's string prompt exactly as it always has. */
  images: ContentBlock[];
  continuation: boolean;
}

/** Per-turn image ceiling. A fresh replay delivers the whole conversation, so
 *  without a cap a session that had traded a dozen screenshots would re-upload
 *  all of them on every divergence. The newest are the ones the turn is about. */
export const MAX_TURN_IMAGES = 8;

/** The image blocks a delivered slice carries, newest kept. */
export function turnImages(messages: AnthropicMessage[]): ContentBlock[] {
  const images: ContentBlock[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === "image") images.push(b);
  }
  return images.length > MAX_TURN_IMAGES
    ? images.slice(-MAX_TURN_IMAGES)
    : images;
}

/** Merge an exact resumed tool-result delta into the one structured user
 *  message the SDK expects after resumeSessionAt. */
export function resumedToolResults(
  messages: AnthropicMessage[],
  expectedIds: readonly string[],
): ContentBlock[] | null {
  const blocks: ContentBlock[] = [];
  for (const message of messages) {
    // Pi stores parallel tool results as sibling toolResult messages. Meridian's
    // Anthropic wire input carries them as blocks in one user message, so merge
    // that representation before asking its exact-continuation validator.
    if (message.role !== "user" || !Array.isArray(message.content)) return null;
    blocks.push(...message.content);
  }
  const merged = [{ role: "user", content: blocks }];
  return coalesceCompleteToolResultContinuation(merged, expectedIds)
    ? blocks
    : null;
}

/** Meridian's continuation decision, factored pure for tests. A checkpointed
 *  tool turn resumes only when the new tail contains exactly its real tool
 *  results. Partial results, extra user content, edits, compaction, and stale
 *  counts full-replay into a fresh SDK session. */
export function planSdkTurn(
  stored: PiSdkSessionState | undefined,
  messages: AnthropicMessage[],
): PiSdkTurnPlan {
  if (stored && messages.length > stored.messageCount) {
    const delivered = messages.slice(stored.messageCount);
    const checkpointUuid = stored.passthroughToolCallAssistantUuid;
    const checkpointIds = stored.passthroughToolCallIds || [];
    if (checkpointUuid) {
      const toolResults = resumedToolResults(delivered, checkpointIds);
      if (toolResults) {
        return {
          resume: stored.sdkSessionId,
          resumeSessionAt: checkpointUuid,
          prompt: "",
          toolResults,
          images: [],
          continuation: true,
        };
      }
    } else {
      return {
        resume: stored.sdkSessionId,
        resumeSessionAt: undefined,
        prompt: replayConversation(delivered),
        toolResults: null,
        images: turnImages(delivered),
        continuation: true,
      };
    }
  }
  return {
    resume: undefined,
    resumeSessionAt: undefined,
    prompt: replayConversation(messages),
    toolResults: null,
    images: turnImages(messages),
    continuation: false,
  };
}

/** Placeholder for a turn whose only content is an image: replayConversation
 *  skips a message with no text, and an empty prompt reads to the SDK as an
 *  empty turn. */
export const IMAGE_ONLY_PROMPT = "(see the attached image)";

/** The structured user content for a turn carrying images, or null when the
 *  turn is plain text and should keep using the string prompt. */
export function sdkPromptContent(plan: PiSdkTurnPlan): ContentBlock[] | null {
  if (plan.toolResults) return plan.toolResults;
  if (!plan.images.length) return null;
  const text = plan.prompt.trim();
  return [...plan.images, { type: "text", text: text || IMAGE_ONLY_PROMPT }];
}

export const MAX_PI_SDK_SESSIONS = 500;

/** Record the post-turn mapping (+1: the assistant message this turn returns
 *  will be in pi's history on the next call) and prune oldest past the cap. */
export function rememberSdkTurn(
  key: string,
  sdkSessionId: string,
  wireMessageCount: number,
  accountId: string,
  checkpoint?: { assistantUuid: string; toolCallIds: string[] },
): void {
  const store = piSdkSessionStore();
  store.set(key, {
    sdkSessionId,
    messageCount: wireMessageCount + 1,
    accountId,
    ...(checkpoint
      ? {
          passthroughToolCallAssistantUuid: checkpoint.assistantUuid,
          passthroughToolCallIds: [...checkpoint.toolCallIds],
        }
      : {}),
    lastUsedAt: Date.now(),
  });
  if (store.size <= MAX_PI_SDK_SESSIONS) return;
  const byAge = [...store.entries()].sort(
    (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
  );
  for (const [k] of byAge.slice(0, store.size - MAX_PI_SDK_SESSIONS))
    store.delete(k);
}

// ── Model catalog ────────────────────────────────────────────────────────────

/**
 * The native provider's catalog: pi's builtin anthropic models passed through
 * untouched (ids, cost tables, context windows, compat — registerNativeProvider
 * REPLACES the builtin provider, so the catalog must ride along), plus a
 * zero-cost fallback entry when the run's model id is newer than the installed
 * catalog (subscription-billed; safe Anthropic defaults — the same fallback
 * registration the bridge path used). Exported for tests.
 */
export function buildPiAnthropicModels(
  builtin: readonly PiCatalogModel[],
  ensureModelId?: string,
): PiCatalogModel[] {
  const models = builtin.map((m) => ({ ...m }));
  if (ensureModelId && !models.some((m) => m.id === ensureModelId)) {
    models.push({
      id: ensureModelId,
      name: ensureModelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    } as PiCatalogModel);
  }
  return models;
}

// ── Usage / cost ─────────────────────────────────────────────────────────────

function zeroUsage(): PiUsageShape {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** SDK result usage → pi Usage with cost from the model's cost table —
 *  pi-ai's calculateCost math (request-wide tiers included; the SDK reports
 *  no 1h-write split, so every cache write prices at the base write rate). */
export function usageFromSdkResult(
  model: PiCatalogModel,
  sdkUsage: Record<string, number | undefined> | null | undefined,
): PiUsageShape {
  const u = sdkUsage || {};
  const usage = zeroUsage();
  usage.input = u.input_tokens || 0;
  usage.output = u.output_tokens || 0;
  usage.cacheRead = u.cache_read_input_tokens || 0;
  usage.cacheWrite = u.cache_creation_input_tokens || 0;
  usage.totalTokens =
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } = model.cost;
  let matchedThreshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (
      inputTokens > tier.inputTokensAbove &&
      tier.inputTokensAbove > matchedThreshold
    ) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  usage.cost.input = (rates.input / 1_000_000) * usage.input;
  usage.cost.output = (rates.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (rates.cacheWrite / 1_000_000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input +
    usage.cost.output +
    usage.cost.cacheRead +
    usage.cost.cacheWrite;
  return usage;
}

// ── The provider ─────────────────────────────────────────────────────────────

export interface PiAnthropicProviderOpts {
  /** Unified session id — the SDK session-store key and audit attribution. */
  unifiedSessionId: string;
  user?: string;
  /** Run-level account pin, honored only within the bridge designation. */
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  /** pi's builtin anthropic catalog (runtime.getModels("anthropic") BEFORE
   *  registration — the native provider replaces the builtin one). */
  builtinModels?: readonly PiCatalogModel[];
  /** The run's model id; appended as a zero-cost fallback when the builtin
   *  catalog lacks it. */
  ensureModelId?: string;
}

/** Per-account isolated SDK config dir — never host ~/.claude. */
function claudeConfigDirFor(accountId: string): string {
  const dir = `${stateDir("pi")}/claude-cfg/${accountId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build the native provider for one run. Throws bridgeDesignationError()'s
 * message when no config designates serving accounts (the same early, clear
 * failure ensureAnthropicBridge gave the bridge path — without starting any
 * HTTP listener). The returned object is registered with
 * runtime.registerNativeProvider under the builtin id "anthropic", replacing
 * the HTTP-bound builtin for this run's runtime only.
 */
export function buildPiAnthropicProvider(
  opts: PiAnthropicProviderOpts,
): PiNativeProvider {
  const designationError = bridgeDesignationError();
  if (designationError) throw new Error(designationError);
  const models = buildPiAnthropicModels(
    opts.builtinModels || [],
    opts.ensureModelId,
  );
  const stream = (
    model: PiCatalogModel,
    context: PiStreamContext,
    options?: PiStreamCallOptions,
  ) => runSdkStream(opts, model, context, options);
  const provider = {
    id: "anthropic",
    name: "Anthropic (in-process Claude Agent SDK)",
    baseUrl: "https://api.anthropic.com",
    // Always configured: accounts are picked per request from the bridge
    // designation; there is no API key. An empty ModelAuth keeps ModelRuntime's
    // prepareRequest/checkAuth satisfied without inventing a secret.
    auth: {
      apiKey: {
        name: "Open Session designated Claude accounts (in-process)",
        resolve: async () => ({
          auth: {},
          source: "in-process claude-agent-sdk",
        }),
      },
    },
    getModels: () => models,
    stream,
    // pi's agent loop calls streamSimple (reasoning level rides the options);
    // the SDK exposes no thinking-budget control, so both entry points map to
    // the same run (bridge parity — thinking level was ignored there too).
    streamSimple: stream,
  };
  return provider as unknown as PiNativeProvider;
}

// ── The SDK turn ─────────────────────────────────────────────────────────────

interface CapturedToolUse {
  id: string;
  name: string;
  input: unknown;
}

async function* runSdkStream(
  opts: PiAnthropicProviderOpts,
  model: PiCatalogModel,
  context: PiStreamContext,
  options: PiStreamCallOptions | undefined,
): AsyncGenerator<PiStreamEvent> {
  // Shared across attempts: a rotation replays the turn from scratch, so the
  // assistant message under construction is the one thing that must survive.
  // Its emptiness is also what makes a replay safe (see the catch).
  const partial: PiAssistantMessageShape = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  yield { type: "start", partial };

  const fail = (
    reason: "aborted" | "error",
    message: string,
  ): PiStreamEvent => ({
    type: "error",
    reason,
    error: {
      ...partial,
      stopReason: reason === "aborted" ? "aborted" : "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  });

  // Accounts this turn has already burned. The sideline alone cannot drive
  // the walk: the rolling-cap refusal deliberately does not sideline, so
  // without an explicit exclusion the re-pick hands back the same account.
  const excluded = new Set<string>();
  for (;;) {
    const rotate = { retry: false };
    yield* runSdkAttempt(
      opts,
      model,
      context,
      options,
      partial,
      fail,
      excluded,
      rotate,
    );
    if (!rotate.retry) return;
  }
}

/** One attempt on one account. Sets `rotate.retry` instead of yielding a
 *  terminal error when the failure is a usage limit, nothing has streamed
 *  yet, and another account can serve. */
async function* runSdkAttempt(
  opts: PiAnthropicProviderOpts,
  model: PiCatalogModel,
  context: PiStreamContext,
  options: PiStreamCallOptions | undefined,
  partial: PiAssistantMessageShape,
  fail: (reason: "aborted" | "error", message: string) => PiStreamEvent,
  excluded: Set<string>,
  rotate: { retry: boolean },
): AsyncGenerator<PiStreamEvent> {
  const signal = options?.signal;
  const requestId = crypto.randomUUID();
  const started = Date.now();

  // Store key: the stream option sessionId is the pi session id on agent
  // turns (stable across a conversation) and a FRESH uuid on pi's
  // summarization one-shots (completeSummarization isolates routing per
  // request) — so summaries never resume, and never corrupt, the
  // conversation's SDK-session mapping. Unified id is the fallback.
  const sessionKey =
    typeof options?.sessionId === "string" && options.sessionId
      ? options.sessionId
      : opts.unifiedSessionId;
  const storeKey = `pi:${sessionKey}`;
  // Set once the turn plan exists; the catch evicts the stored mapping on a
  // failed continuation so the NEXT turn replays fresh instead of resuming a
  // dead SDK session forever (count-based divergence never triggers while
  // history keeps growing — meridian evicts on resume failure the same way).
  let plannedContinuation = false;
  const wireMessages = piMessagesToAnthropic(context.messages || []);
  const requestTools = context.tools || [];
  const system = context.systemPrompt || "";

  const auditBase = {
    msg: "pi_anthropic_request",
    request_id: requestId,
    session: opts.unifiedSessionId,
    user: opts.user,
    model: model.id,
    tools: requestTools.length,
  };

  let account: ClaudeAccount | undefined;
  const captured: CapturedToolUse[] = [];
  let clientDone = false;
  let finishCanonicalDrain: (() => void) | undefined;
  try {
    if (signal?.aborted) {
      yield fail("aborted", "Request aborted");
      return;
    }

    const picked = pickBridgeAccount(model.id, {
      accountId: opts.accountId,
      accountStrict: opts.accountStrict,
      usageCredits: opts.usageCredits,
      user: opts.user,
      excludeIds: excluded.size ? [...excluded] : undefined,
    });
    if ("error" in picked) throw new Error(picked.error);
    account = picked;

    // Pi can begin executing a visible tool call while the preceding SDK query
    // drains its capped terminal result. Serialize only this session boundary
    // so the follow-up cannot read the mapping before its checkpoint is durable.
    await piSdkCanonicalDrains().get(storeKey);

    // Continuation planning happens with the account known: a stored SDK
    // session lives in ITS account's isolated CLAUDE_CONFIG_DIR, so a turn
    // the designated walk moved to a different account treats the mapping as
    // divergence and replays fresh instead of failing a cross-dir resume.
    const stored = piSdkSessionStore().get(storeKey);
    const plan = planSdkTurn(
      stored && stored.accountId === account.id ? stored : undefined,
      wireMessages,
    );
    plannedContinuation = plan.continuation;

    // Rolling per-account hourly cap — the SAME per-boot counter the bridge
    // admits against, so pi traffic and any residual bridge traffic share one
    // ceiling per designated account. "429" keeps the refusal
    // usage-limit-shaped for isPiUsageLimitShape (fallback walk engages), but
    // the tag keeps the catch from markExhausted-ing the account: the cap is
    // OUR local admission control, it frees within the hour, and the
    // exhaustion sideline is shared with the pi bridge — a synthetic
    // refusal must never bench the account cross-engine until the 5h reset.
    // ~1.6k tokens is a typical screenshot. The estimate only feeds our local
    // rolling cap, so rough is the right amount of precision here.
    const estTokens =
      Math.ceil((plan.prompt.length + system.length) / 4) +
      plan.images.length * 1600;
    const rate = admitBridgeRequest(account.id, estTokens);
    if (!rate.allowed) {
      const rateErr = new Error(
        `pi-anthropic 429: account "${account.name}" exceeded ${rate.limit} requests/hour ` +
          "(bridgeMaxRequestsPerHour)",
      );
      (rateErr as any).piLocalRateCap = true;
      throw rateErr;
    }

    audit({
      ...auditBase,
      direction: "in",
      account: account.name,
      continuation: plan.continuation,
      ...summarizeText(plan.prompt),
    });

    const passthroughTools = requestTools.map((t) =>
      tool(
        t.name,
        t.description || t.name,
        jsonSchemaToZodShape(t.parameters),
        async () => ({
          content: [{ type: "text" as const, text: "forwarded to client" }],
        }),
      ),
    );
    const mcpServers =
      passthroughTools.length > 0
        ? {
            [PASSTHROUGH_MCP]: createSdkMcpServer({
              name: PASSTHROUGH_MCP,
              tools: passthroughTools,
            }),
          }
        : {};

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let sdkSessionId: string | undefined;
    let sdkUsage: Record<string, number> | undefined;
    let reachedResult = false;
    let cappedStopReason: "toolUse" | "length" | undefined;
    let checkpoint:
      | { assistantUuid: string; toolCallIds: string[] }
      | undefined;
    const earlyStop = createEarlyStopTracker();

    // PreToolUse hooks can resolve before the stream iterator has delivered
    // every tool_use block in a parallel batch. Hold each block result until
    // the assistant message ends, then let the SDK persist all denials before
    // the tracker aborts the otherwise automatic digest turn.
    const pendingDenyReleases: Array<() => void> = [];
    let turnGenerating = false;
    const releaseHeldDenies = () => {
      turnGenerating = false;
      for (const release of pendingDenyReleases.splice(0)) release();
    };
    const holdDenyUntilTurnEnd = () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 8_000);
        pendingDenyReleases.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    // Stream-event bookkeeping: SDK content-block index (per SDK message) →
    // index into `partial.content`; -1 marks a block we deliberately skip
    // (tool_use streams are ignored — the post-hook captures are authoritative
    // and a blocked-then-retried call must not double).
    let idxMap = new Map<number, number>();
    let pendingText = new Map<
      number,
      { text: string; accountUnavailable: boolean }
    >();
    let deferredAccountUnavailable: string | undefined;
    let sawStreamContent = false;
    let emittedCaptures = 0;

    // A turn carrying images goes in as one streaming-input user message whose
    // content holds the real image blocks; a plain-text turn keeps the string
    // prompt unchanged. Everything else about the turn (resume, hooks, partial
    // streaming, the passthrough tools) is indifferent to which shape it gets.
    const promptContent = sdkPromptContent(plan);
    const sdkPrompt = promptContent
      ? (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: promptContent },
            parent_tool_use_id: null,
          };
        })()
      : plan.prompt;

    const q = query({
      prompt: sdkPrompt as any,
      options: {
        cwd: ensureAnthropicBridgeCwd(),
        model: model.id,
        resume: plan.resume,
        ...(plan.resumeSessionAt
          ? { resumeSessionAt: plan.resumeSessionAt }
          : {}),
        abortController: controller,
        includePartialMessages: true,
        maxTurns: PI_SDK_MAX_TURNS,
        systemPrompt: system || " ",
        settingSources: [],
        mcpServers: mcpServers as any,
        strictMcpConfig: true,
        tools: SDK_BUILTIN_TOOLS,
        disallowedTools: DISALLOWED_BUILTINS,
        allowedTools: requestTools.map((t) => `${PASSTHROUGH_PREFIX}${t.name}`),
        pathToClaudeCodeExecutable: CLAUDE_CODE_BIN,
        executable: "bun" as const,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          CLAUDE_CODE_OAUTH_TOKEN: account.token,
          CLAUDE_CONFIG_DIR: claudeConfigDirFor(account.id),
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "",
              hooks: [
                async (input: any) => {
                  const name = String(input.tool_name || "");
                  const bare = name.startsWith(PASSTHROUGH_PREFIX)
                    ? name.slice(PASSTHROUGH_PREFIX.length)
                    : name;
                  // Calls after the visible checkpoint belong to the hidden
                  // digest branch. Block them, but never expose them to Pi.
                  if (!checkpoint) {
                    captured.push({
                      id: input.tool_use_id,
                      name: bare,
                      input: input.tool_input ?? {},
                    });
                  }
                  if (turnGenerating && !controller.signal.aborted) {
                    await holdDenyUntilTurnEnd();
                  }
                  return {
                    decision: "block" as const,
                    reason: checkpoint
                      ? "This tool call has already been handled by the client-facing turn. " +
                        "Do not repeat it, do not call additional tools, and do not generate further text. End your turn now."
                      : PI_PASSTHROUGH_BLOCK_REASON,
                  };
                },
              ],
            },
          ],
        },
      },
    });

    /** Emit toolcall events for captures the hook recorded since last drain.
     *  Captures happen after the model finished emitting that tool_use block,
     *  so appending at the next SDK message keeps content order coherent. */
    function* drainCaptures(): Generator<PiStreamEvent> {
      if (clientDone) return;
      while (emittedCaptures < captured.length) {
        const c = captured[emittedCaptures];
        // Hook capture can run ahead of the iterator. Emit only calls the
        // upstream tracker has attached to the visible assistant message.
        if (!earlyStop.expected.has(c.id)) break;
        emittedCaptures += 1;
        const toolCall = {
          type: "toolCall",
          id: c.id,
          name: c.name,
          arguments: c.input ?? {},
        };
        const contentIndex = partial.content.push(toolCall) - 1;
        yield { type: "toolcall_start", contentIndex, partial };
        yield {
          type: "toolcall_delta",
          contentIndex,
          delta: JSON.stringify(c.input ?? {}),
          partial,
        };
        yield { type: "toolcall_end", contentIndex, toolCall, partial };
      }
    }

    const finishVisibleToolTurn = (): PiStreamEvent | undefined => {
      if (clientDone || !shouldEarlyStop(earlyStop)) return undefined;
      const assistantUuid = settledToolCallAssistantUuid(earlyStop);
      if (!assistantUuid) return undefined;
      checkpoint = { assistantUuid, toolCallIds: [...earlyStop.expected] };
      for (let i = captured.length - 1; i >= 0; i--) {
        if (!earlyStop.expected.has(captured[i].id)) captured.splice(i, 1);
      }
      emittedCaptures = Math.min(emittedCaptures, captured.length);
      finishCanonicalDrain = beginPiSdkCanonicalDrain(storeKey);
      clientDone = true;
      const usage = usageFromSdkResult(model, sdkUsage);
      partial.usage = usage;
      const message: PiAssistantMessageShape = {
        ...partial,
        stopReason: "toolUse",
        usage,
        timestamp: Date.now(),
      };
      return { type: "done", reason: "toolUse", message };
    };

    try {
      for await (const msg of q) {
        yield* drainCaptures();
        const m = msg as Record<string, any>;
        if (m.session_id) sdkSessionId = String(m.session_id) || sdkSessionId;
        if (m.type === "system" && m.subtype === "init") {
          continue;
        }
        if (m.type === "stream_event") {
          // Token-level path: raw Anthropic stream events (BetaRawMessageStreamEvent).
          // Nested (subagent) streams carry parent_tool_use_id; Task/Agent are
          // disallowed so none should occur — skip them as a double-count guard.
          if (m.parent_tool_use_id) continue;
          const ev = m.event as Record<string, any> | undefined;
          if (!ev) continue;
          if (
            ev.type === "message_delta" ||
            ev.type === "message_stop" ||
            (ev.type === "message_start" && turnGenerating)
          ) {
            releaseHeldDenies();
          }
          // Pi has already received its terminal toolUse event. Continue only
          // the bookkeeping needed to receive the SDK's capped terminal result.
          // maxTurns=1 prevents another model request from starting.
          if (clientDone) {
            if (ev.type === "message_start") {
              turnGenerating = true;
              if (ev.message?.usage)
                sdkUsage = { ...sdkUsage, ...ev.message.usage };
            } else if (ev.type === "message_delta" && ev.usage) {
              sdkUsage = { ...sdkUsage, ...ev.usage };
            }
            continue;
          }
          if (ev.type === "message_start") {
            turnGenerating = true;
            idxMap = new Map();
            pendingText = new Map();
            if (ev.message?.usage)
              sdkUsage = { ...sdkUsage, ...ev.message.usage };
          } else if (ev.type === "message_delta") {
            if (ev.usage) sdkUsage = { ...sdkUsage, ...ev.usage };
          } else if (ev.type === "content_block_start") {
            const block = ev.content_block as Record<string, any> | undefined;
            const sdkIdx = Number(ev.index);
            if (block?.type === "text") {
              sawStreamContent = true;
              pendingText.set(sdkIdx, { text: "", accountUnavailable: false });
            } else if (block?.type === "thinking") {
              sawStreamContent = true;
              const contentIndex =
                partial.content.push({ type: "thinking", thinking: "" }) - 1;
              idxMap.set(sdkIdx, contentIndex);
              yield { type: "thinking_start", contentIndex, partial };
            } else {
              // tool_use / redacted_thinking / anything else: not streamed —
              // tool calls arrive via the capture hook.
              idxMap.set(sdkIdx, -1);
            }
          } else if (ev.type === "content_block_delta") {
            const sdkIdx = Number(ev.index);
            const pending = pendingText.get(sdkIdx);
            const delta = ev.delta as Record<string, any> | undefined;
            if (
              pending &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              pending.text += delta.text;
              pending.accountUnavailable ||= isClaudeAccountUnavailable(
                pending.text,
                false,
              );
              if (
                pending.accountUnavailable ||
                shouldDeferClaudeText(pending.text)
              )
                continue;
              const contentIndex =
                partial.content.push({ type: "text", text: pending.text }) - 1;
              idxMap.set(sdkIdx, contentIndex);
              pendingText.delete(sdkIdx);
              yield { type: "text_start", contentIndex, partial };
              yield {
                type: "text_delta",
                contentIndex,
                delta: pending.text,
                partial,
              };
              continue;
            }
            const contentIndex = idxMap.get(sdkIdx);
            if (contentIndex === undefined || contentIndex === -1) continue;
            const blk = partial.content[contentIndex];
            if (
              delta?.type === "text_delta" &&
              typeof delta.text === "string" &&
              blk?.type === "text"
            ) {
              blk.text += delta.text;
              yield {
                type: "text_delta",
                contentIndex,
                delta: delta.text,
                partial,
              };
            } else if (
              delta?.type === "thinking_delta" &&
              typeof delta.thinking === "string" &&
              blk?.type === "thinking"
            ) {
              blk.thinking += delta.thinking;
              yield {
                type: "thinking_delta",
                contentIndex,
                delta: delta.thinking,
                partial,
              };
            } else if (
              delta?.type === "signature_delta" &&
              blk?.type === "thinking"
            ) {
              blk.thinkingSignature = `${blk.thinkingSignature || ""}${delta.signature || ""}`;
            }
          } else if (ev.type === "content_block_stop") {
            const sdkIdx = Number(ev.index);
            const pending = pendingText.get(sdkIdx);
            if (pending) {
              pendingText.delete(sdkIdx);
              if (
                pending.accountUnavailable ||
                isClaudeAccountUnavailable(pending.text, false)
              ) {
                deferredAccountUnavailable = pending.text;
                continue;
              }
              const contentIndex =
                partial.content.push({ type: "text", text: pending.text }) - 1;
              idxMap.set(sdkIdx, contentIndex);
              yield { type: "text_start", contentIndex, partial };
              yield {
                type: "text_delta",
                contentIndex,
                delta: pending.text,
                partial,
              };
              yield {
                type: "text_end",
                contentIndex,
                content: pending.text,
                partial,
              };
              continue;
            }
            const contentIndex = idxMap.get(sdkIdx);
            if (contentIndex === undefined || contentIndex === -1) continue;
            const blk = partial.content[contentIndex];
            if (blk?.type === "text") {
              yield {
                type: "text_end",
                contentIndex,
                content: blk.text,
                partial,
              };
            } else if (blk?.type === "thinking") {
              yield {
                type: "thinking_end",
                contentIndex,
                content: blk.thinking,
                partial,
              };
            }
          }
          continue;
        }
        if (m.type === "assistant") {
          let assistantAddedForwardedCall = false;
          if (!checkpoint && earlyStop.resolved.size === 0) {
            const expectedBefore = earlyStop.expected.size;
            noteAssistantMessage(earlyStop, m);
            assistantAddedForwardedCall =
              earlyStop.expected.size > expectedBefore;
          }
          if (m.message?.usage) sdkUsage = { ...sdkUsage, ...m.message.usage };
          if (!clientDone && !sawStreamContent) {
            // Fallback (no partial stream events from the CLI): emit each text
            // block as one delta on arrival, per-message, not end-of-request.
            const blocks = m.message?.content;
            if (Array.isArray(blocks)) {
              for (const b of blocks) {
                if (!b || typeof b !== "object" || b.type !== "text" || !b.text)
                  continue;
                if (isClaudeAccountUnavailable(b.text, false)) {
                  deferredAccountUnavailable = b.text;
                  continue;
                }
                const contentIndex =
                  partial.content.push({ type: "text", text: b.text }) - 1;
                yield { type: "text_start", contentIndex, partial };
                yield {
                  type: "text_delta",
                  contentIndex,
                  delta: b.text,
                  partial,
                };
                yield {
                  type: "text_end",
                  contentIndex,
                  content: b.text,
                  partial,
                };
              }
            }
          }
          // Usually the user envelope arrives last. The SDK can invert those
          // two messages, so recheck after each assistant fragment too.
          if (assistantAddedForwardedCall) yield* drainCaptures();
          const terminal = finishVisibleToolTurn();
          if (terminal) yield terminal;
          continue;
        }
        if (m.type === "user") {
          if (!checkpoint) noteUserContent(earlyStop, m.message?.content);
          yield* drainCaptures();
          const terminal = finishVisibleToolTurn();
          if (terminal) yield terminal;
          continue;
        }
        if (m.type === "result") {
          sdkSessionId = String(m.session_id || "") || sdkSessionId;
          if (deferredAccountUnavailable)
            throw new Error(deferredAccountUnavailable);
          // maxTurns=1 makes error_max_turns the normal passthrough handoff:
          // the terminal result proves the SDK flushed the tool checkpoint,
          // so preserve it and resume from the assistant UUID next turn. A
          // capped turn with visible content but no tool is truncated rather
          // than failed, matching Meridian's honest max_tokens degradation.
          cappedStopReason = recoverCappedSdkStopReason(
            m.subtype,
            captured.length,
            partial.content.length,
          );
          if ((m.is_error || m.subtype !== "success") && !cappedStopReason) {
            const detail =
              (typeof m.result === "string" && m.result) ||
              partial.content
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join("\n") ||
              (Array.isArray(m.errors) && m.errors.join(", ")) ||
              m.subtype ||
              "SDK run failed";
            throw new Error(String(detail));
          }
          sdkUsage = m.usage || undefined;
          reachedResult = true;
          break;
        }
        // Every other SDK message kind (status, hooks, task notifications,
        // user tool-result replays) is engine-internal — ignored.
      }
      yield* drainCaptures();
    } finally {
      releaseHeldDenies();
      signal?.removeEventListener("abort", onAbort);
      // Abandonment backstop: a consumer that stops iterating this generator
      // (early .return()/throw upstream) must not leave the SDK subprocess
      // running unattended — abort it whenever the run never reached its
      // result message (a completed run's subprocess is already exiting).
      if (!reachedResult) controller.abort();
    }

    if (signal?.aborted) {
      piSdkSessionStore().delete(storeKey);
      audit({
        ...auditBase,
        direction: "out",
        ok: false,
        account: account.name,
        duration_ms: Date.now() - started,
        error: "aborted",
      });
      if (!clientDone) yield fail("aborted", "Request aborted");
      return;
    }
    if (!reachedResult) {
      // Subprocess died without a result message (claude-direct's rule): an
      // error, never a silent empty completion.
      throw new Error("SDK stream ended without a result message");
    }

    if (sdkSessionId) {
      rememberSdkTurn(
        storeKey,
        sdkSessionId,
        wireMessages.length,
        account.id,
        checkpoint,
      );
    }

    const usage = usageFromSdkResult(model, sdkUsage);
    partial.usage = usage;
    const stopReason: "toolUse" | "stop" | "length" =
      cappedStopReason ?? (captured.length ? "toolUse" : "stop");
    const message: PiAssistantMessageShape = {
      ...partial,
      stopReason,
      usage,
      timestamp: Date.now(),
    };
    audit({
      ...auditBase,
      direction: "out",
      ok: true,
      account: account.name,
      continuation: plan.continuation,
      duration_ms: Date.now() - started,
      stop_reason: stopReason,
      tool_uses: captured.length,
      checkpoint_drain: !!checkpoint,
      sdk_session_id: sdkSessionId,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_input_tokens: usage.cacheRead,
      ...summarizeText(
        partial.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n"),
      ),
    });
    if (!clientDone) yield { type: "done", reason: stopReason, message };
  } catch (e: any) {
    if (signal?.aborted) {
      piSdkSessionStore().delete(storeKey);
      audit({
        ...auditBase,
        direction: "out",
        ok: false,
        ...(account ? { account: account.name } : {}),
        duration_ms: Date.now() - started,
        error: "aborted",
      });
      if (!clientDone) yield fail("aborted", "Request aborted");
      return;
    }
    const message: string = e?.message || String(e);
    // A failed hidden drain occurs after Pi already received a successful tool
    // turn. Evict its unpublished checkpoint and let the next step replay; a
    // second terminal event would corrupt the already-finished Pi turn.
    if (clientDone) {
      piSdkSessionStore().delete(storeKey);
      audit({
        ...auditBase,
        direction: "out",
        ok: false,
        ...(account ? { account: account.name } : {}),
        duration_ms: Date.now() - started,
        error: `checkpoint drain failed: ${message}`,
      });
      return;
    }
    // A failed continuation may mean the resumed SDK session is dead (config
    // dir swept/wiped): evict the mapping so the next turn replays fresh.
    if (plannedContinuation) piSdkSessionStore().delete(storeKey);
    const localCap = e?.piLocalRateCap === true;
    const accountUnavailable = isClaudeAccountUnavailable(message, true);
    // Account-level death: sideline the picked designated account before
    // surfacing (claude-direct's markExhausted discipline); the preserved
    // message is what isPiUsageLimitShape classifies upstream. The local
    // rolling-cap refusal is exempt (tagged at the throw): it is 429-worded
    // for the classifier but is not account exhaustion.
    if (account && !localCap && accountUnavailable) {
      // Bench it until the reset the account itself named, when it named one:
      // a weekly limit otherwise came back into the pool in an hour and failed
      // again, every hour, until it genuinely reset.
      markExhausted(account.id, model.id, usageLimitResetAt(message));
    }
    // Rotate rather than fail, when another account can serve. Gated on an
    // empty `partial.content`: every content event pushes there before it is
    // yielded, so this is an exact "has the reader seen anything yet" test,
    // and a failure mid-answer surfaces instead of replaying what they saw.
    // A cross-account move is already handled downstream: SDK sessions live
    // in per-account config dirs, so planSdkTurn treats it as divergence and
    // replays the conversation fresh on the new account.
    let rotateTo: ClaudeAccount | undefined;
    // Why the pool could not serve, when it could not. Dropping this refusal
    // (the original bug) made a dry pool indistinguishable from a walk that
    // never ran: multiple accounts were consulted and the reader was shown the
    // last one's sentence, so working rotation read as no rotation at all.
    let poolRefusal: string | undefined;
    if (
      account &&
      (accountUnavailable || localCap) &&
      partial.content.length === 0
    ) {
      excluded.add(account.id);
      const next = pickBridgeAccount(model.id, {
        accountId: opts.accountId,
        accountStrict: opts.accountStrict,
        usageCredits: opts.usageCredits,
        user: opts.user,
        excludeIds: [...excluded],
      });
      if ("error" in next) poolRefusal = next.error;
      else rotateTo = next;
    }
    audit({
      ...auditBase,
      direction: "out",
      ok: false,
      ...(account ? { account: account.name } : {}),
      duration_ms: Date.now() - started,
      error: message,
      ...(rotateTo ? { account_switch_to: rotateTo.name } : {}),
    });
    if (rotateTo && account) {
      console.warn(
        `[pi-anthropic] usage limit on "${account.name}" (${model.id}): ` +
          `retrying this turn on "${rotateTo.name}"`,
      );
      rotate.retry = true;
      return;
    }
    // A strict pin is deliberately excluded: nothing but the pinned account
    // was ever going to be tried, so reporting the POOL as dry would be false.
    // Its own refusal (below) names the account the person chose.
    if (poolRefusal && account && !(opts.accountId && opts.accountStrict)) {
      // Rotation was tried and the pool had nothing left. Say that, rather
      // than echoing one account's limit as if nothing had been attempted.
      // The original message stays inside the sentence so isPiUsageLimitShape
      // still classifies this as exhaustion upstream.
      console.warn(
        `[pi-anthropic] usage limit on "${account.name}" (${model.id}) and no other ` +
          `account can serve it: ${poolRefusal}`,
      );
      const reset = describeUsageLimitReset(message);
      yield fail(
        "error",
        `every Claude account is usage-limited for ${model.id}` +
          (reset ? `, the soonest resets ${reset}` : "") +
          `. Last account tried ("${account.name}") said: ${message}`,
      );
      return;
    }
    yield fail("error", message);
  } finally {
    finishCanonicalDrain?.();
  }
}
