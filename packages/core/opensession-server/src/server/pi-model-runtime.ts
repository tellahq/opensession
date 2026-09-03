/**
 * In-process Anthropic provider for the pi engine.
 *
 * Each pi session keeps one Claude Agent SDK streaming-input query alive across
 * model steps. Client tools are real in-process SDK MCP tools whose handlers
 * park until pi returns the matching result. The provider exposes the complete
 * assistant tool batch to pi, returns that batch as the pi step boundary, then
 * resolves the parked handlers on the next step. Claude Code therefore keeps
 * one native conversation and one prompt-cache chain instead of resuming from
 * disk and rewriting the post-prefix context after every tool call.
 *
 * The live query is keyed by pi session plus the exact model, system prompt,
 * and tool configuration. A changed history or account closes it and falls
 * back to the durable SDK resume/replay plan. Completed conversations remain
 * warm for 15 minutes, bounded to 24 idle processes. In-use turns are never
 * evicted; abandoned pending tools close after two hours. Per-account config
 * directories keep credentials isolated. Account selection remains sticky
 * while usable and still walks the pool on a limit
 * before any visible output.
 *
 * Token-level text and thinking events pass through unchanged. SDK usage is
 * cumulative inside a tool loop, so each pi step reports only the unreported
 * delta. Images ride as structured content. Unknown SDK tool names are handed
 * to pi, then the live query is discarded so Claude Code cannot continue on
 * its own synthetic error branch.
 *
 * The bridge transport remains the rollback path. This module has no import-
 * time sockets, timers, or subprocesses; queries start only from stream().
 */

import { mkdirSync } from "fs";
import {
  query,
  createSdkMcpServer,
  tool,
  type Query,
  type SDKUserMessage,
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

// ── Passthrough capture and durable fallback checkpoints ────────────────────

/** Internal text used only by the facade's synthetic pi-side tool boundary.
 * It never enters either the pi transcript or the live SDK conversation. */
export const PI_PASSTHROUGH_BLOCK_REASON =
  "This tool call has been forwarded to the client for execution.";

type EarlyStopTracker = ReturnType<typeof createEarlyStopTracker>;

/** SDK-internal tools that really execute inside the SDK. Never forward these to pi. */
const SDK_INTERNAL_TOOLS = new Set(["ToolSearch"]);

/** Forward tool names the SDK cannot dispatch, including observed manglings
 * such as `mcp__ocuser__bash`. Pi returns its normal unknown-tool result, and
 * the provider then discards the live query before Claude Code can continue on
 * a different synthetic-error history. Call after noteAssistantMessage. */
export function captureUnforwardedToolUses(
  tracker: EarlyStopTracker,
  message: unknown,
  captured: CapturedToolUse[],
): number {
  const m = message as {
    type?: unknown;
    uuid?: unknown;
    message?: { content?: unknown };
  } | null;
  const content = m?.message?.content;
  if (m?.type !== "assistant" || !Array.isArray(content)) return 0;
  let added = 0;
  for (const block of content) {
    const b = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    } | null;
    if (b?.type !== "tool_use") continue;
    if (typeof b.id !== "string" || !b.id) continue;
    if (typeof b.name !== "string" || SDK_INTERNAL_TOOLS.has(b.name)) continue;
    if (tracker.expected.has(b.id)) continue;
    if (captured.some((c) => c.id === b.id)) continue;
    tracker.expected.add(b.id);
    if (typeof m.uuid === "string" && m.uuid) {
      tracker.toolCallAssistantUuid = m.uuid;
    }
    captured.push({
      id: b.id,
      name: b.name.startsWith(PASSTHROUGH_PREFIX)
        ? b.name.slice(PASSTHROUGH_PREFIX.length)
        : b.name,
      input: (b.input as Record<string, unknown> | undefined) ?? {},
    });
    added++;
  }
  return added;
}

/** Capture every client-owned SDK tool call from the complete assistant
 * envelope. Live MCP handlers park on these calls, so the envelope, rather
 * than hook timing, is the authoritative parallel batch. */
function captureSdkToolUses(
  tracker: EarlyStopTracker,
  message: unknown,
  captured: CapturedToolUse[],
): number {
  const before = captured.length;
  captureUnforwardedToolUses(tracker, message, captured);
  const envelope = message as {
    uuid?: unknown;
    message?: { content?: unknown };
  } | null;
  if (!Array.isArray(envelope?.message?.content))
    return captured.length - before;
  for (const block of envelope.message.content) {
    const toolUse = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    } | null;
    if (
      toolUse?.type !== "tool_use" ||
      typeof toolUse.id !== "string" ||
      !toolUse.id ||
      typeof toolUse.name !== "string" ||
      SDK_INTERNAL_TOOLS.has(toolUse.name) ||
      captured.some((call) => call.id === toolUse.id)
    ) {
      continue;
    }
    tracker.expected.add(toolUse.id);
    if (typeof envelope.uuid === "string" && envelope.uuid) {
      tracker.toolCallAssistantUuid = envelope.uuid;
    }
    captured.push({
      id: toolUse.id,
      name: toolUse.name.startsWith(PASSTHROUGH_PREFIX)
        ? toolUse.name.slice(PASSTHROUGH_PREFIX.length)
        : toolUse.name,
      input: (toolUse.input as Record<string, unknown> | undefined) ?? {},
    });
  }
  return captured.length - before;
}

/** Capture the next visible assistant tool batch. A live SDK continuation
 * echoes the previous batch's tool results before emitting this assistant
 * message, so `tracker.resolved` can legitimately be non-empty here. Those
 * unrelated ids are harmless: early-stop settlement only checks ids present
 * in `tracker.expected`. The durable checkpoint, not resolved history, is the
 * boundary that stops us from observing a later hidden assistant message. */
export function captureVisibleSdkAssistantToolUses(
  tracker: EarlyStopTracker,
  message: unknown,
  captured: CapturedToolUse[],
  checkpointed: boolean,
): boolean {
  if (checkpointed) return false;
  const expectedBefore = tracker.expected.size;
  noteAssistantMessage(tracker, message);
  captureSdkToolUses(tracker, message, captured);
  return tracker.expected.size > expectedBefore;
}

/** Map the live facade's synthetic boundary marker onto pi stop reasons. */
export function recoverSyntheticSdkStopReason(
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
  /** Durable assistant boundary for a visible passthrough tool turn. A cold
   * fallback resumes here with exact tool results when no live query remains. */
  passthroughToolCallAssistantUuid?: string;
  passthroughToolCallIds?: string[];
  lastUsedAt: number;
}

// unified session id → SDK session mapping; globalThis-parked for hot reloads
// (a real restart replays — correct, only slower). Exported for tests.
export function piSdkSessionStore(): Map<string, PiSdkSessionState> {
  return (g.__piAnthropicSdkSessions ??= new Map<string, PiSdkSessionState>());
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
  /** Steering that arrived after a complete live tool-result batch. It is
   * queued before parked handlers resume, matching Claude Code's live input. */
  liveFollowUp?: { prompt: string; images: ContentBlock[] };
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

/** Keep a live tool turn alive when steering follows its complete results.
 * A cold resume cannot safely inject both pieces, so this path is used only
 * while the original streaming-input query still exists. */
export function planLiveSdkTurn(
  stored: PiSdkSessionState | undefined,
  messages: AnthropicMessage[],
): PiSdkTurnPlan | null {
  if (
    !stored?.passthroughToolCallAssistantUuid ||
    messages.length <= stored.messageCount
  ) {
    return null;
  }
  const delivered = messages.slice(stored.messageCount);
  const resultMessages: AnthropicMessage[] = [];
  let consumed = 0;
  for (const message of delivered) {
    if (
      message.role !== "user" ||
      !Array.isArray(message.content) ||
      !message.content.every((block) => block?.type === "tool_result")
    ) {
      break;
    }
    resultMessages.push(message);
    consumed += 1;
  }
  const toolResults = resumedToolResults(
    resultMessages,
    stored.passthroughToolCallIds || [],
  );
  if (!toolResults) return null;
  const followUp = delivered.slice(consumed);
  if (followUp.some((message) => message.role !== "user")) return null;
  return {
    resume: stored.sdkSessionId,
    resumeSessionAt: stored.passthroughToolCallAssistantUuid,
    prompt: "",
    toolResults,
    images: [],
    ...(followUp.length
      ? {
          liveFollowUp: {
            prompt: replayConversation(followUp),
            images: turnImages(followUp),
          },
        }
      : {}),
    continuation: true,
  };
}

/** Durable continuation decision. A checkpointed cold resume accepts only the
 * exact tool results. Edits, compaction, steering, and stale counts replay. */
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

const MAX_LIVE_SDK_CONVERSATIONS = 24;
const LIVE_SDK_IDLE_MS = 15 * 60_000;
const LIVE_SDK_PENDING_MAX_MS = 2 * 60 * 60_000;
const LIVE_MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60_000;

type SdkToolReply = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

class SdkInputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #items: SDKUserMessage[] = [];
  readonly #waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> =
    [];
  #closed = false;

  push(message: SDKUserMessage): void {
    if (this.#closed) throw new Error("Claude SDK input is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.#items.push(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.#items.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

interface LiveSdkConversation {
  key: string;
  accountId: string;
  query: Query;
  input: SdkInputQueue;
  controller: AbortController;
  pendingToolIds: string[];
  suppliedToolResults: Map<string, SdkToolReply>;
  toolWaiters: Map<string, (reply: SdkToolReply) => void>;
  lastUsedAt: number;
  inUse: boolean;
  disposed: boolean;
}

function liveSdkConversations(): Map<string, LiveSdkConversation> {
  return (g.__piAnthropicLiveSdkConversations ??= new Map<
    string,
    LiveSdkConversation
  >());
}

function disposeLiveSdkConversation(
  live: LiveSdkConversation,
  reason: string,
): void {
  if (live.disposed) return;
  live.disposed = true;
  if (liveSdkConversations().get(live.key) === live) {
    liveSdkConversations().delete(live.key);
  }
  const reply: SdkToolReply = {
    content: [
      { type: "text", text: `Open Session ended this tool turn: ${reason}` },
    ],
    isError: true,
  };
  for (const resolve of live.toolWaiters.values()) resolve(reply);
  live.toolWaiters.clear();
  live.suppliedToolResults.clear();
  live.input.close();
  live.controller.abort();
  live.query.close();
}

function pruneLiveSdkConversations(now = Date.now()): void {
  const conversations = liveSdkConversations();
  for (const live of conversations.values()) {
    if (
      !live.inUse &&
      live.pendingToolIds.length > 0 &&
      now - live.lastUsedAt > LIVE_SDK_PENDING_MAX_MS
    ) {
      disposeLiveSdkConversation(live, "stale tool turn evicted");
    }
  }
  const idle = [...conversations.values()]
    .filter((live) => !live.inUse && live.pendingToolIds.length === 0)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  for (const live of idle) {
    if (
      now - live.lastUsedAt > LIVE_SDK_IDLE_MS ||
      conversations.size > MAX_LIVE_SDK_CONVERSATIONS
    ) {
      disposeLiveSdkConversation(live, "idle conversation evicted");
    }
  }
}

function shortStableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function liveConfigHash(
  modelId: string,
  system: string,
  tools: readonly PiToolShape[],
): string {
  return shortStableHash(JSON.stringify([modelId, system, tools]));
}

function sdkUserMessage(content: string | ContentBlock[]): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content } as SDKUserMessage["message"],
    parent_tool_use_id: null,
  };
}

const SDK_USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

/** Usage for one pi step, keyed by Anthropic message id. Each SDK `assistant`
 * message and stream event carries the usage of the API request that produced
 * it, and the SDK repeats one `assistant` message per content block, so
 * entries merge per id and sum across ids (an internal ToolSearch round trip
 * adds a second request to the same step). The SDK `result` usage is not a
 * per-step figure: its output count spans every step of the turn. */
export type SdkStepUsage = Map<string, Record<string, number>>;

export function recordSdkStepUsage(
  step: SdkStepUsage,
  id: string,
  usage: Readonly<Record<string, unknown>>,
): void {
  const entry = step.get(id) ?? {};
  for (const field of SDK_USAGE_FIELDS) {
    const value = usage[field];
    if (typeof value === "number") entry[field] = value;
  }
  step.set(id, entry);
}

export function sumSdkStepUsage(
  step: SdkStepUsage,
): Record<string, number> | undefined {
  if (step.size === 0) return undefined;
  const total: Record<string, number> = {};
  for (const field of SDK_USAGE_FIELDS) total[field] = 0;
  for (const entry of step.values()) {
    for (const field of SDK_USAGE_FIELDS) total[field] += entry[field] ?? 0;
  }
  return total;
}

function sdkToolReply(block: ContentBlock): SdkToolReply {
  const raw = Array.isArray(block.content)
    ? block.content
    : [{ type: "text", text: String(block.content ?? "") }];
  const content: SdkToolReply["content"] = [];
  for (const item of raw) {
    if (item?.type === "text" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
    } else if (
      item?.type === "image" &&
      item.source?.type === "base64" &&
      typeof item.source.data === "string" &&
      typeof item.source.media_type === "string"
    ) {
      content.push({
        type: "image",
        data: item.source.data,
        mimeType: item.source.media_type,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return { content, ...(block.is_error === true ? { isError: true } : {}) };
}

function supplyLiveToolResults(
  live: LiveSdkConversation,
  blocks: readonly ContentBlock[],
): void {
  for (const block of blocks) {
    if (
      block?.type !== "tool_result" ||
      typeof block.tool_use_id !== "string"
    ) {
      continue;
    }
    const reply = sdkToolReply(block);
    const waiter = live.toolWaiters.get(block.tool_use_id);
    if (waiter) {
      live.toolWaiters.delete(block.tool_use_id);
      waiter(reply);
    } else {
      live.suppliedToolResults.set(block.tool_use_id, reply);
    }
  }
  live.pendingToolIds = [];
}

function awaitLiveToolResult(
  live: LiveSdkConversation,
  toolUseId: string,
): Promise<SdkToolReply> {
  const supplied = live.suppliedToolResults.get(toolUseId);
  if (supplied) {
    live.suppliedToolResults.delete(toolUseId);
    return Promise.resolve(supplied);
  }
  if (live.disposed) {
    return Promise.resolve({
      content: [{ type: "text", text: "Open Session closed this tool turn" }],
      isError: true,
    });
  }
  return new Promise((resolve) => live.toolWaiters.set(toolUseId, resolve));
}

function sdkToolUseId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const metadata = (extra as { _meta?: unknown })._meta;
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)["claudecode/toolUseId"];
  return typeof value === "string" && value ? value : undefined;
}

function inputForPlan(plan: PiSdkTurnPlan): SDKUserMessage {
  return sdkUserMessage(sdkPromptContent(plan) ?? plan.prompt);
}

interface LiveQueryFacade extends AsyncIterable<Record<string, any>> {
  readonly live: LiveSdkConversation;
}

function queryFacade(live: LiveSdkConversation): LiveQueryFacade {
  const synthetic: Array<Record<string, any>> = [];
  return {
    live,
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<Record<string, any>>> => {
          const queued = synthetic.shift();
          if (queued) {
            if (queued.__disposeLive === true) {
              disposeLiveSdkConversation(live, "unsupported SDK tool call");
              piSdkSessionStore().delete(live.key);
              delete queued.__disposeLive;
            }
            return { value: queued, done: false };
          }
          const next = await live.query.next();
          if (next.done) return { value: undefined, done: true };
          const message = next.value as Record<string, any>;
          if (
            message.type === "assistant" &&
            Array.isArray(message.message?.content)
          ) {
            const calls = message.message.content.filter(
              (block: Record<string, any>) =>
                block?.type === "tool_use" &&
                typeof block.id === "string" &&
                !SDK_INTERNAL_TOOLS.has(String(block.name || "")),
            );
            if (calls.length) {
              live.pendingToolIds = calls.map(
                (block: Record<string, any>) => block.id,
              );
              synthetic.push({
                type: "user",
                message: {
                  role: "user",
                  content: calls.map((block: Record<string, any>) => ({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: PI_PASSTHROUGH_BLOCK_REASON,
                    is_error: true,
                  })),
                },
                session_id: message.session_id,
              });
              synthetic.push({
                type: "result",
                subtype: "error_max_turns",
                is_error: true,
                result: "Reached client tool boundary",
                usage: message.message.usage,
                session_id: message.session_id,
                __disposeLive: calls.some(
                  (block: Record<string, any>) =>
                    !String(block.name || "").startsWith(PASSTHROUGH_PREFIX),
                ),
              });
            }
          }
          return { value: message, done: false };
        },
        return: async () => ({ value: undefined, done: true }),
      };
    },
  };
}

function createLiveSdkConversation(input: {
  key: string;
  account: ClaudeAccount;
  model: PiCatalogModel;
  system: string;
  tools: readonly PiToolShape[];
  plan: PiSdkTurnPlan;
}): LiveSdkConversation {
  const prompt = new SdkInputQueue();
  const controller = new AbortController();
  let live: LiveSdkConversation;
  const passthroughTools = input.tools.map((definition) =>
    tool(
      definition.name,
      definition.description || definition.name,
      jsonSchemaToZodShape(definition.parameters),
      async (_arguments, extra) => {
        const toolUseId = sdkToolUseId(extra);
        if (!toolUseId) {
          return {
            content: [
              { type: "text" as const, text: "Missing Claude tool call id" },
            ],
            isError: true,
          };
        }
        return awaitLiveToolResult(live, toolUseId);
      },
    ),
  );
  const mcpServers = passthroughTools.length
    ? {
        [PASSTHROUGH_MCP]: createSdkMcpServer({
          name: PASSTHROUGH_MCP,
          tools: passthroughTools,
        }),
      }
    : {};
  const sdkQuery = query({
    prompt,
    options: {
      cwd: ensureAnthropicBridgeCwd(),
      model: input.model.id,
      resume: input.plan.resume,
      ...(input.plan.resumeSessionAt
        ? { resumeSessionAt: input.plan.resumeSessionAt }
        : {}),
      abortController: controller,
      includePartialMessages: true,
      systemPrompt: input.system || " ",
      settingSources: [],
      mcpServers: mcpServers as any,
      strictMcpConfig: true,
      tools: SDK_BUILTIN_TOOLS,
      disallowedTools: DISALLOWED_BUILTINS,
      allowedTools: input.tools.map(
        (definition) => `${PASSTHROUGH_PREFIX}${definition.name}`,
      ),
      pathToClaudeCodeExecutable: CLAUDE_CODE_BIN,
      executable: "bun" as const,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        CLAUDE_CODE_OAUTH_TOKEN: input.account.token,
        CLAUDE_CONFIG_DIR: claudeConfigDirFor(input.account.id),
        MCP_TOOL_TIMEOUT: String(LIVE_MCP_TOOL_TIMEOUT_MS),
      },
    },
  });
  live = {
    key: input.key,
    accountId: input.account.id,
    query: sdkQuery,
    input: prompt,
    controller,
    pendingToolIds: [],
    suppliedToolResults: new Map(),
    toolWaiters: new Map(),
    lastUsedAt: Date.now(),
    inUse: false,
    disposed: false,
  };
  liveSdkConversations().set(input.key, live);
  prompt.push(inputForPlan(input.plan));
  return live;
}

function acquireLiveSdkQuery(input: {
  key: string;
  account: ClaudeAccount;
  model: PiCatalogModel;
  system: string;
  tools: readonly PiToolShape[];
  plan: PiSdkTurnPlan;
}): LiveQueryFacade {
  pruneLiveSdkConversations();
  let live = liveSdkConversations().get(input.key);
  if (live && (live.accountId !== input.account.id || live.inUse)) {
    disposeLiveSdkConversation(
      live,
      live.inUse ? "concurrent turn" : "account changed",
    );
    live = undefined;
  }
  if (live && !input.plan.continuation) {
    disposeLiveSdkConversation(live, "conversation diverged");
    live = undefined;
  }
  if (!live) return queryFacade(createLiveSdkConversation(input));

  if (input.plan.toolResults) {
    if (input.plan.liveFollowUp) {
      const followUp = input.plan.liveFollowUp;
      live.input.push(
        sdkUserMessage(
          followUp.images.length
            ? [
                ...followUp.images,
                {
                  type: "text",
                  text: followUp.prompt.trim() || IMAGE_ONLY_PROMPT,
                },
              ]
            : followUp.prompt,
        ),
      );
    }
    supplyLiveToolResults(live, input.plan.toolResults);
  } else {
    live.input.push(inputForPlan(input.plan));
  }
  live.lastUsedAt = Date.now();
  return queryFacade(live);
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
  // Include the exact model/system/tool configuration so compaction and other
  // one-shot requests never evict an interactive conversation that happens to
  // carry the same routing session id.
  const wireMessages = piMessagesToAnthropic(context.messages || []);
  const requestTools = context.tools || [];
  const system = context.systemPrompt || "";
  const storeKey = `pi:${sessionKey}:${liveConfigHash(model.id, system, requestTools)}`;
  // Set once the turn plan exists; the catch evicts the stored mapping on a
  // failed continuation so the NEXT turn replays fresh instead of resuming a
  // dead SDK session forever (count-based divergence never triggers while
  // history keeps growing — meridian evicts on resume failure the same way).
  let plannedContinuation = false;

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
  try {
    if (signal?.aborted) {
      yield fail("aborted", "Request aborted");
      return;
    }

    // Stay on the account that already holds this session's SDK conversation
    // while it is usable. Every request re-picks, and the least-used tiebreak
    // round-robins equal accounts, so without this a session hopped
    // subscriptions on nearly every step and replayed its full context (a
    // cache write, not a read) each time. The sticky step sits below the pin
    // and above the least-used pool pick; exhaustion, sidelining, and the
    // in-turn walk (excludeIds) still move the session off it.
    const stickyId =
      liveSdkConversations().get(storeKey)?.accountId ??
      piSdkSessionStore().get(storeKey)?.accountId;
    const picked = pickBridgeAccount(model.id, {
      accountId: opts.accountId,
      accountStrict: opts.accountStrict,
      usageCredits: opts.usageCredits,
      user: opts.user,
      excludeIds: excluded.size ? [...excluded] : undefined,
      stickyId,
    });
    if ("error" in picked) throw new Error(picked.error);
    account = picked;

    // Continuation planning happens with the account known: a stored SDK
    // session lives in ITS account's isolated CLAUDE_CONFIG_DIR, so a turn
    // the designated walk moved to a different account treats the mapping as
    // divergence and replays fresh instead of failing a cross-dir resume.
    const stored = piSdkSessionStore().get(storeKey);
    const usableStored =
      stored && stored.accountId === account.id ? stored : undefined;
    const plan =
      (liveSdkConversations().has(storeKey)
        ? planLiveSdkTurn(usableStored, wireMessages)
        : null) ?? planSdkTurn(usableStored, wireMessages);
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

    const q = acquireLiveSdkQuery({
      key: storeKey,
      account,
      model,
      system,
      tools: requestTools,
      plan,
    });
    const controller = q.live.controller;
    q.live.inUse = true;
    const onAbort = () => disposeLiveSdkConversation(q.live, "request aborted");
    signal?.addEventListener("abort", onAbort, { once: true });

    let sdkSessionId: string | undefined;
    const stepUsage: SdkStepUsage = new Map();
    let streamMessageId: string | undefined;
    const noteStreamUsage = (ev: Record<string, any>) => {
      if (ev.type === "message_start") {
        streamMessageId = String(ev.message?.id || "") || undefined;
        if (ev.message?.usage)
          recordSdkStepUsage(
            stepUsage,
            streamMessageId ?? "stream",
            ev.message.usage,
          );
      } else if (ev.type === "message_delta" && ev.usage) {
        recordSdkStepUsage(stepUsage, streamMessageId ?? "stream", ev.usage);
      }
    };
    let reachedResult = false;
    let cappedStopReason: "toolUse" | "length" | undefined;
    let checkpoint:
      | { assistantUuid: string; toolCallIds: string[] }
      | undefined;
    const earlyStop = createEarlyStopTracker();
    // The live-query facade supplies the synthetic blocked-result boundary.
    // These names remain in the stream parser so its message ordering stays
    // identical to the durable-resume fallback.
    let turnGenerating = false;
    const releaseHeldDenies = () => {
      turnGenerating = false;
    };
    let idxMap = new Map<number, number>();
    let pendingText = new Map<
      number,
      { text: string; accountUnavailable: boolean }
    >();
    let deferredAccountUnavailable: string | undefined;
    let sawStreamContent = false;
    let emittedCaptures = 0;

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
      clientDone = true;
      const usage = usageFromSdkResult(model, sumSdkStepUsage(stepUsage));
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
          noteStreamUsage(ev);
          // Pi has already received its terminal toolUse event. Consume only
          // the facade's synthetic boundary result; the real SDK handler stays parked.
          if (clientDone) {
            if (ev.type === "message_start") turnGenerating = true;
            continue;
          }
          if (ev.type === "message_start") {
            turnGenerating = true;
            idxMap = new Map();
            pendingText = new Map();
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
          const assistantAddedForwardedCall =
            captureVisibleSdkAssistantToolUses(
              earlyStop,
              m,
              captured,
              !!checkpoint,
            );
          if (m.message?.usage)
            recordSdkStepUsage(
              stepUsage,
              String(m.message.id || m.uuid || "") || "assistant",
              m.message.usage,
            );
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
          // The facade uses error_max_turns as an internal compatibility marker
          // so the existing pi event parser closes this step at the tool boundary.
          cappedStopReason = recoverSyntheticSdkStopReason(
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
          // Only fall back to the turn-wide result usage when this step saw
          // no per-request usage at all (see SdkStepUsage).
          if (stepUsage.size === 0 && m.usage)
            recordSdkStepUsage(stepUsage, "result", m.usage);
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
      q.live.inUse = false;
      q.live.lastUsedAt = Date.now();
      // Abandonment backstop: a consumer that stops iterating this generator
      // (early .return()/throw upstream) must not leave the SDK subprocess
      // running unattended — abort it whenever the run never reached its
      // result message (a completed run's subprocess is already exiting).
      if (!reachedResult) {
        disposeLiveSdkConversation(q.live, "stream abandoned");
      }
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

    if (sdkSessionId && !q.live.disposed) {
      rememberSdkTurn(
        storeKey,
        sdkSessionId,
        wireMessages.length,
        account.id,
        checkpoint,
      );
    }

    const usage = usageFromSdkResult(model, sumSdkStepUsage(stepUsage));
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
      live_tool_boundary: !!checkpoint,
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
    const failedLive = liveSdkConversations().get(storeKey);
    if (failedLive) disposeLiveSdkConversation(failedLive, "SDK turn failed");
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
    // A facade failure after pi received the tool turn must not emit a second
    // terminal event. Evict the live query and let the next step replay.
    if (clientDone) {
      piSdkSessionStore().delete(storeKey);
      audit({
        ...auditBase,
        direction: "out",
        ok: false,
        ...(account ? { account: account.name } : {}),
        duration_ms: Date.now() - started,
        error: `live tool boundary failed: ${message}`,
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
  }
}
