/**
 * Anthropic bridge: a loopback HTTP endpoint that speaks the Anthropic
 * Messages API (`POST /v1/messages`, streaming included) but is served by the
 * official Claude Agent SDK running on designated Max-subscription accounts
 * from the claude-accounts layer. It exists so the Pi engine
 * (pi-runner.ts) can run `pi/anthropic/*` models on subscription
 * capacity instead of raw API keys (docs/self-hosting-sandboxes.md).
 *
 * This is OUR reimplementation of the mapping pioneered by
 * github.com/ianjwhite99/Pi-with-claude + @rynfar/meridian (both MIT —
 * studied, not copied). The core trick, same as theirs:
 *
 *  - The client's `tools` (Pi's bash/edit/etc.) are registered as an
 *    in-process SDK MCP server with no-op handlers, so the model emits real
 *    tool_use blocks for them.
 *  - A PreToolUse hook BLOCKS every tool call and captures {id, name, input};
 *    the captured calls are returned to the HTTP client as Anthropic
 *    `tool_use` content blocks with stop_reason "tool_use" — the client
 *    (Pi) executes the tool itself.
 *  - Statelessness is bridged with an SDK-session store: each Pi
 *    session maps to one SDK session (keyed by the `x-opensession-session`
 *    header the reference plugin also uses, else a fingerprint of the first
 *    message). A follow-up request resumes that session and delivers only the
 *    NEW tail (tool results flattened to plain text — the model reads them as
 *    the natural outcome of its forwarded call). A diverged/edited history
 *    starts a fresh SDK session with a full flat-text replay.
 *
 * Containment (all enforced here, not in prompts):
 *  - Never starts unless an engine that uses it is enabled (Pi's
 *    ~/.opensession-model-providers.json or pi's ~/.opensession-pi.json) and at
 *    least one Claude account exists to serve on.
 *  - Account pick per request (pickBridgeAccount): when Pi's
 *    `bridgeAccountIds` designates accounts, ONLY those serve (legacy
 *    containment override); otherwise the general claude-accounts pool
 *    serves, picked exactly like subscription bridge runs (personal-first by
 *    user, utilization-gated).
 *  - Binds 127.0.0.1 only, and every request must present the per-boot bridge
 *    key (x-api-key) that only the Pi-runner hands out — so another
 *    local process can't quietly burn subscription capacity through it.
 *  - Every request lands in the audit log (audit.ts): accepted ones with
 *    session attribution (`anthropic_bridge_request` in/out), rejected ones
 *    (bad key, malformed body, size cap, rate limit, no usable account) as
 *    `anthropic_bridge_rejected` with status + reason — never the presented
 *    key — so local probing/hammering always leaves a trail.
 *  - Request hygiene: bodies over 10MB are refused (413), and a per-boot
 *    rolling per-account counter caps requests/hour (`bridgeMaxRequestsPerHour`
 *    in ~/.opensession-model-providers.json, default 300 → 429 past it; estimated
 *    tokens are tracked alongside for the audit trail). Account selection stops
 *    at plan limits by default. A run may continue on paid credits only when it
 *    explicitly enables `usageCredits` and the account has credit headroom.
 *
 * Billing behavior (verified live, 2026-08-06): this SDK mapping is accepted as
 * Claude Code plan traffic on an account with extra usage disabled. It uses the
 * same no-op tool registration and PreToolUse capture pattern as Meridian.
 *
 * Known approximations (documented, acceptable for a bridge):
 *  - No token-level streaming: streamed responses open the SSE immediately,
 *    heartbeat-ping while the SDK works, then replay the finished message as
 *    synthesized Anthropic SSE events. (Protects against client idle
 *    timeouts, e.g. Bun's hard 300s fetch cap, without partial-delta code.)
 *  - `max_tokens` / `temperature` from the request are ignored (the SDK does
 *    not expose them); thinking blocks are not round-tripped.
 *  - The SDK's own built-in tools are disallowed; only client tools exist.
 *
 * The pi engine's in-process sibling (pi-anthropic-provider.ts) reimplements
 * this same SDK mapping without the HTTP hop; it imports the exported helpers
 * here (flatten/replay, schema conversion, account pick, designation check,
 * DISALLOWED_BUILTINS, the rolling admit counter) so the two stay one
 * implementation of the trick. HTTP concerns (bridge key, SSE synthesis,
 * body caps) remain bridge-only.
 */

import { homeDir } from "./paths";
import { stateDir } from "./paths";
import {
  query,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { audit, summarizeText } from "./audit";
import {
  hasAccounts,
  resolveAccount,
  type ClaudeAccount,
} from "./claude-accounts";
import { CLAUDE_CODE_BIN } from "./runner-shared";
import {
  bridgePort,
  bridgeMaxRequestsPerHour,
  readModelProviderConfig,
} from "./model-providers";
import { readPiEngineConfig } from "./pi-config";
import { mkdirSync } from "fs";

const HOME = homeDir();
// Empty, dedicated cwd for the SDK subprocess: the bridge never touches files
// (every tool is a blocked passthrough), so no worktree must ever be visible.
export const BRIDGE_CWD = `${stateDir("anthropic-bridge")}/bridge-cwd`;

/** Create the SDK cwd on the call path. The in-process provider uses the same
 * directory without starting the HTTP bridge, so bridge startup cannot own it. */
export function ensureAnthropicBridgeCwd(dir = BRIDGE_CWD): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

const g = globalThis as any;

interface StoredBridgeSession {
  sdkSessionId: string;
  /** How many client messages the SDK session has already seen. */
  messageCount: number;
  lastUsedAt: number;
}

// Pi-session key → SDK session mapping. In-memory (parked on globalThis
// for hot reloads); a real restart just means the next request replays the
// conversation into a fresh SDK session — correct, only slower.
const sessions: Map<string, StoredBridgeSession> =
  (g.__anthropicBridgeSessions ??= new Map());

/** Per-boot shared secret between Pi-runner and this bridge. */
export function bridgeKey(): string {
  return (g.__anthropicBridgeKey ??= crypto.randomUUID());
}

export interface BridgeInfo {
  url: string;
  key: string;
}

/** Non-null = the reason no config designates serving accounts right now —
 *  the same gate ensureAnthropicBridge throws on, exported so the in-process
 *  pi provider can refuse with the identical message without starting the
 *  HTTP listener. Serving is allowed when EITHER Pi is enabled with
 *  bridgeAccountIds OR the pi engine is enabled with bridgeAccounts. */
export function bridgeDesignationError(): string | null {
  const cfg = readModelProviderConfig();
  const piCfg = readPiEngineConfig();
  if (!cfg?.enabled && !piCfg?.enabled) {
    return (
      "The Anthropic bridge is disabled. Enable it in ~/.opensession-model-providers.json " +
      '({"enabled": true}) or, for pi/anthropic/* models, in ~/.opensession-pi.json ' +
      '({"enabled": true}) — or use an API-key provider configured via `Pi auth login` instead.'
    );
  }
  const ocIds = cfg?.enabled ? cfg.bridgeAccountIds || [] : [];
  if (ocIds.length || hasAccounts()) return null;
  return (
    "The Anthropic bridge has no accounts to serve on: add a Claude account in " +
    "Settings → Providers (or designate bridgeAccountIds in ~/.opensession-model-providers.json)."
  );
}

/**
 * Start the bridge (idempotent) and return its URL + access key. Throws when
 * no config designates serving accounts — callers surface that as a clear
 * model-level error (see bridgeDesignationError; pickBridgeAccount applies
 * the same precedence per request).
 */
export function ensureAnthropicBridge(): BridgeInfo {
  const designationError = bridgeDesignationError();
  if (designationError) throw new Error(designationError);
  const port = bridgePort();
  if (g.__anthropicBridgeServer) {
    return {
      url: `http://127.0.0.1:${g.__anthropicBridgeServer.port}`,
      key: bridgeKey(),
    };
  }
  ensureAnthropicBridgeCwd();
  g.__anthropicBridgeHandler = handleBridgeRequest;
  g.__anthropicBridgeServer = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // SDK turns can run for many minutes; Bun's default 10s idleTimeout would
    // kill the non-streamed path. 0 = no idle limit (streamed responses also
    // heartbeat, see below).
    idleTimeout: 0,
    fetch: (req: Request) =>
      (g.__anthropicBridgeHandler as typeof handleBridgeRequest)(req),
  } as unknown as Parameters<typeof Bun.serve>[0]);
  console.log(`[anthropic-bridge] listening on 127.0.0.1:${port}`);
  return { url: `http://127.0.0.1:${port}`, key: bridgeKey() };
}

/** Optional account pin for pickBridgeAccount — only the in-process pi
 *  provider passes it (the HTTP bridge has no channel for a pin); a pin never
 *  widens serving beyond what the pick mode allows. */
export interface BridgeAccountPin {
  accountId?: string;
  /** Strict pin: never fall back to the other eligible accounts. */
  accountStrict?: boolean;
  /** Run user, for the pool pick's personal-account preference (same identity
   *  matching as pickAccount everywhere else). */
  user?: string;
  /** Allow extra-usage credits when judging the pin/walk usability. */
  usageCredits?: boolean;
  /** Accounts this turn already burned, skipped on every path. Drives the pi
   *  provider's in-turn account walk (see resolveAccount's excludeIds). */
  excludeIds?: readonly string[];
  /** The account whose isolated config dir already holds this session's SDK
   *  conversation. Preferred over the least-used pick while it is usable, so
   *  a session keeps its SDK resume and prompt cache instead of replaying the
   *  whole context onto a different subscription every request. */
  stickyId?: string;
}

/** Pick the account to serve a bridge/pi request (utilization-gated).
 *
 *  Two modes:
 *  - Designated: when Pi's `bridgeAccountIds` names accounts, ONLY
 *    those may serve (walked in order) — the legacy containment for the
 *    loopback bridge era, kept as an explicit override.
 *  - Pool (the default, matching how subscription bridge picks): no
 *    designation → pickAccount over the general claude-accounts pool, with
 *    the same personal-first/user routing as every other run. Pi traffic is
 *    first-party Claude Agent SDK traffic billed to plan limits (verified
 *    live on a credits-off account, 2026-08-06), so there is no billing
 *    reason to fence it off from the pool.
 *
 *  A `pin` (in-process pi runs only) is tried first; with accountStrict the
 *  walk never widens past it. Another user's personal subscription never
 *  serves, on any path — the ordered policy and that owner gate both live in
 *  resolveAccount; this only renders its refusals. The "no designated bridge
 *  account" / "no usable Claude account" wordings are load-bearing:
 *  isPiUsageLimitShape's anthropic arm keys on them. */
export function pickBridgeAccount(
  model: string | undefined,
  pin?: BridgeAccountPin,
): ClaudeAccount | { error: string } {
  const cfg = readModelProviderConfig();
  const ids = cfg?.enabled ? cfg.bridgeAccountIds || [] : [];
  const resolved = resolveAccount({
    user: pin?.user,
    model,
    pinnedId: pin?.accountId,
    strictPin: pin?.accountStrict,
    stickyId: pin?.stickyId,
    designatedIds: ids,
    allowExtraUsage: pin?.usageCredits,
    excludeIds: pin?.excludeIds,
  });
  if ("account" in resolved) return resolved.account;
  const refusal = resolved.refusal;
  if (refusal.kind === "pin-not-designated") {
    // Config error, deliberately NOT exhaustion-shaped — hopping models would
    // not fix a pin that names a non-designated account.
    return {
      error:
        `pinned account "${refusal.pinName}" is not a designated bridge account ` +
        "(bridgeAccountIds is set, so only those ids may serve bridge traffic) — " +
        "strict pin, refusing to widen",
    };
  }
  if (refusal.kind === "pin-unusable") {
    return ids.length
      ? {
          error:
            `no designated bridge account is currently usable (pinned "${refusal.pinName}" is ` +
            "exhausted or disabled; strict pin — not widening to the other designated accounts)",
        }
      : {
          error:
            `no usable Claude account (pinned "${refusal.pinName}" is exhausted, disabled or ` +
            "unknown; strict pin — not widening to the pool)",
        };
  }
  if (refusal.kind === "designated-dry") {
    return {
      error: `no designated bridge account is currently usable (tried: ${refusal.tried})`,
    };
  }
  if (refusal.kind === "none-configured") {
    // Deliberately NOT usage-limit-shaped: an empty pool is a config problem,
    // and hopping models would not fix it.
    return {
      error: "no Claude accounts configured (add one in Settings → Providers)",
    };
  }
  return {
    error: "no usable Claude account in the pool (all exhausted or sidelined)",
  };
}

// ── Anthropic request → SDK prompt mapping ───────────────────────────────────

export type ContentBlock = Record<string, any>;
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/** Flatten one message to plain text for replay/continuation (tool_results
 *  unwrap to their raw output so the model reads a natural outcome, not
 *  `[tool_result toolu_x]` noise — same choice the reference makes). */
export function flattenMessageText(
  content: AnthropicMessage["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "tool_use") {
      parts.push(
        `[called tool ${block.name} with ${JSON.stringify(block.input ?? {})}]`,
      );
    } else if (block.type === "tool_result") {
      const inner = block.content;
      if (typeof inner === "string") parts.push(inner);
      else if (Array.isArray(inner)) {
        for (const ib of inner)
          if (ib?.type === "text" && ib.text) parts.push(ib.text);
      }
    }
  }
  return parts.join("\n");
}

/** Flat-text replay of a whole conversation (fresh-session path). */
export function replayConversation(messages: AnthropicMessage[]): string {
  const turns: string[] = [];
  for (const m of messages) {
    const text = flattenMessageText(m.content).trim();
    if (!text) continue;
    turns.push(
      m.role === "assistant" ? `[Your previous reply]\n${text}` : text,
    );
  }
  return turns.join("\n\n");
}

/** Minimal JSON Schema → zod conversion for client tool registration. The
 *  schema only shapes what the model emits — Pi revalidates on its side,
 *  so unknown constructs safely degrade to z.any(). */
export function jsonSchemaToZodShape(
  schema: any,
): Record<string, z.ZodTypeAny> {
  if (!schema || typeof schema !== "object" || !schema.properties) return {};
  const required = new Set<string>(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    let t = jsonSchemaToZod(prop);
    if (prop?.description && typeof prop.description === "string")
      t = t.describe(prop.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();
  switch (schema.type) {
    case "string":
      return Array.isArray(schema.enum) && schema.enum.length
        ? z.enum(schema.enum as [string, ...string[]])
        : z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(jsonSchemaToZod(schema.items));
    case "object":
      return schema.properties
        ? z.object(jsonSchemaToZodShape(schema))
        : z.record(z.string(), z.any());
    default:
      return z.any();
  }
}

export const PASSTHROUGH_MCP = "oc";
export const PASSTHROUGH_PREFIX = `mcp__${PASSTHROUGH_MCP}__`;

/** Primary switch: an empty `tools` list removes every SDK built-in from the
 *  model's context, including ones added by SDK bumps after the denylist
 *  below was written (CronCreate, ScheduleWakeup, Monitor, ...). Without it a
 *  new built-in leaks into context, the model calls it, and the client
 *  answers "Tool X not found". */
export const SDK_BUILTIN_TOOLS: string[] = [];

/** Built-in SDK tools the bridge must never let run — the client owns all
 *  execution. Belt-and-braces under `SDK_BUILTIN_TOOLS`; the PreToolUse hook
 *  blocks everything as a final backstop. */
export const DISALLOWED_BUILTINS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Task",
  "TaskOutput",
  "TaskStop",
  "Agent",
  "Skill",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ToolSearch",
  "Workflow",
];

interface CapturedToolUse {
  id: string;
  name: string;
  input: unknown;
}

function anthropicError(
  status: number,
  type: string,
  message: string,
): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

/** Audit a rejected request (module doc: rejections leave a trail too). Never
 *  include the presented key or other secrets in `fields`. */
function auditReject(
  requestId: string,
  status: number,
  reason: string,
  fields: Record<string, unknown> = {},
): void {
  audit({
    msg: "anthropic_bridge_rejected",
    request_id: requestId,
    status,
    reason,
    ...fields,
  });
}

// ── Per-boot rolling rate limit (per designated account) ─────────────────────

const BRIDGE_MAX_BODY_BYTES = 10 * 1024 * 1024;
const RATE_WINDOW_MS = 60 * 60 * 1000;

interface BridgeUsageEvent {
  at: number;
  estTokens: number;
}

// account id → request events in the trailing hour. Per-boot (parked on
// globalThis for hot reloads); the extra-usage credit ceiling (module doc) is
// the durable backstop.
const bridgeUsage: Map<string, BridgeUsageEvent[]> =
  (g.__anthropicBridgeUsage ??= new Map());

/** Admit-or-reject under the rolling per-account ceiling; admits record their
 *  estimated input tokens so the audit trail can track spend pressure. */
export function admitBridgeRequest(
  accountId: string,
  estTokens: number,
  now = Date.now(),
): { allowed: boolean; requests: number; tokens: number; limit: number } {
  const cutoff = now - RATE_WINDOW_MS;
  const events = (bridgeUsage.get(accountId) || []).filter(
    (e) => e.at > cutoff,
  );
  const limit = bridgeMaxRequestsPerHour();
  const allowed = events.length < limit;
  if (allowed) events.push({ at: now, estTokens });
  bridgeUsage.set(accountId, events);
  return {
    allowed,
    requests: events.length,
    tokens: events.reduce((sum, e) => sum + e.estTokens, 0),
    limit,
  };
}

/** Session key: the reference plugin sends x-opensession-session; otherwise
 *  fingerprint the first message so retries of the same conversation reuse
 *  the SDK session. */
function sessionKeyFor(req: Request, messages: AnthropicMessage[]): string {
  const header = req.headers.get("x-opensession-session");
  if (header) return `oc:${header}`;
  const first = messages[0] ? flattenMessageText(messages[0].content) : "";
  return `fp:${Bun.hash(first).toString(16)}`;
}

async function handleBridgeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  const requestId = crypto.randomUUID();
  const engineSessionHeader =
    req.headers.get("x-opensession-session") || undefined;
  if (req.method !== "POST" || url.pathname !== "/v1/messages") {
    return anthropicError(
      404,
      "not_found_error",
      `no such endpoint: ${req.method} ${url.pathname}`,
    );
  }
  const presented =
    req.headers.get("x-api-key") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (presented !== bridgeKey()) {
    auditReject(requestId, 401, "invalid_bridge_key", {
      key_presented: !!presented,
      engine_session: engineSessionHeader,
    });
    return anthropicError(401, "authentication_error", "invalid bridge key");
  }

  let body: any;
  let rawBody: string;
  try {
    const declared = Number(req.headers.get("content-length") || 0);
    if (declared > BRIDGE_MAX_BODY_BYTES) throw new RangeError("too large");
    rawBody = await req.text();
    if (rawBody.length > BRIDGE_MAX_BODY_BYTES)
      throw new RangeError("too large");
  } catch (e) {
    const tooLarge = e instanceof RangeError;
    auditReject(
      requestId,
      tooLarge ? 413 : 400,
      tooLarge ? "body_too_large" : "unreadable_body",
      {
        engine_session: engineSessionHeader,
      },
    );
    return tooLarge
      ? anthropicError(
          413,
          "request_too_large",
          `request body exceeds ${BRIDGE_MAX_BODY_BYTES} bytes`,
        )
      : anthropicError(400, "invalid_request_error", "unreadable request body");
  }
  try {
    body = JSON.parse(rawBody);
  } catch {
    auditReject(requestId, 400, "invalid_json", {
      engine_session: engineSessionHeader,
    });
    return anthropicError(400, "invalid_request_error", "invalid JSON body");
  }
  const messages: AnthropicMessage[] = Array.isArray(body?.messages)
    ? body.messages
    : [];
  if (!messages.length) {
    auditReject(requestId, 400, "empty_messages", {
      engine_session: engineSessionHeader,
      model: typeof body?.model === "string" ? body.model : undefined,
    });
    return anthropicError(
      400,
      "invalid_request_error",
      "messages[] is required",
    );
  }
  const model: string = typeof body?.model === "string" ? body.model : "";
  const wantsStream = body?.stream === true;
  const requestTools: Array<{
    name: string;
    description?: string;
    input_schema?: any;
  }> = Array.isArray(body?.tools) ? body.tools : [];
  const system =
    typeof body?.system === "string"
      ? body.system
      : Array.isArray(body?.system)
        ? body.system
            .map((b: any) => (b?.type === "text" ? b.text : ""))
            .filter(Boolean)
            .join("\n\n")
        : "";

  const account = pickBridgeAccount(model);
  if ("error" in account) {
    auditReject(requestId, 529, "no_usable_account", {
      engine_session: engineSessionHeader,
      model,
      detail: account.error,
    });
    return anthropicError(529, "overloaded_error", `bridge: ${account.error}`);
  }

  const key = sessionKeyFor(req, messages);
  const stored = sessions.get(key);
  // Continuation = the client's history strictly grew past what the SDK
  // session has seen. Anything else (first request, edited/compacted history)
  // gets a fresh SDK session with a full replay.
  const isContinuation = !!stored && messages.length > stored.messageCount;
  const prompt = isContinuation
    ? replayConversation(messages.slice(stored.messageCount))
    : replayConversation(messages);

  // Rolling per-account ceiling (see module doc). Counted at admission — a
  // request that later fails still spent an SDK attempt.
  const estTokens = Math.ceil(rawBody.length / 4);
  const rate = admitBridgeRequest(account.id, estTokens);
  if (!rate.allowed) {
    auditReject(requestId, 429, "rate_limited", {
      engine_session: engineSessionHeader,
      model,
      account: account.name,
      requests_last_hour: rate.requests,
      est_tokens_last_hour: rate.tokens,
      limit_per_hour: rate.limit,
    });
    return anthropicError(
      429,
      "rate_limit_error",
      `bridge: account "${account.name}" exceeded ${rate.limit} requests/hour (bridgeMaxRequestsPerHour)`,
    );
  }

  const captured: CapturedToolUse[] = [];
  const passthroughTools = requestTools.map((t) =>
    tool(
      t.name,
      t.description || t.name,
      jsonSchemaToZodShape(t.input_schema),
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

  const started = Date.now();
  const auditBase = {
    msg: "anthropic_bridge_request",
    request_id: requestId,
    session_key: key,
    engine_session: engineSessionHeader,
    model,
    stream: wantsStream,
    tools: requestTools.length,
    continuation: isContinuation,
    account: account.name,
  };
  audit({ ...auditBase, direction: "in", ...summarizeText(prompt) });

  const run = async () => {
    const contentOut: ContentBlock[] = [];
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    let sdkSessionId = isContinuation ? stored!.sdkSessionId : undefined;

    const q = query({
      prompt,
      options: {
        cwd: ensureAnthropicBridgeCwd(),
        model: model || undefined,
        resume: sdkSessionId,
        // Turn 1 is the real answer; turn 2 exists because blocked tool calls
        // count as a turn boundary (the hook's reason tells the model to
        // stop). Models that keep going anyway are handled at the result:
        // error_max_turns with captured calls returns them as tool_use.
        maxTurns: 2,
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
                  captured.push({
                    id: input.tool_use_id,
                    name: bare,
                    input: input.tool_input ?? {},
                  });
                  return {
                    decision: "block" as const,
                    reason:
                      "This tool call was forwarded to the client for execution; its result arrives " +
                      "in a future turn. Do not retry it, do not call more tools, do not add text — " +
                      "end your turn now.",
                  };
                },
              ],
            },
          ],
        },
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && (msg as any).subtype === "init") {
        sdkSessionId = (msg as any).session_id;
      }
      if (msg.type === "assistant") {
        const blocks = (msg as any).message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            // Text only: tool_use blocks are appended from `captured` below
            // (post-hook, so a blocked-then-retried call is never doubled),
            // and thinking blocks can't round-trip without their signatures.
            if (b.type === "text" && b.text)
              contentOut.push({ type: "text", text: b.text });
          }
        }
      }
      if (msg.type === "result") {
        const rm = msg as any;
        sdkSessionId = rm.session_id || sdkSessionId;
        // error_max_turns WITH captured calls is a SUCCESS for this bridge:
        // sequential-tool models (sonnet especially) often answer a blocked
        // call by trying the next tool — a fresh turn each time — and blow
        // the cap before "ending" cleanly. The captured calls are the whole
        // point; return them as tool_use and let the client execute. Only a
        // capture-less max-turns (model never called a tool) stays an error.
        const maxTurnsWithCaptures =
          rm.subtype === "error_max_turns" && captured.length > 0;
        // Surface SDK/API failures as provider errors, not assistant text —
        // the CLI narrates errors (e.g. "API Error: 400 …") as a message,
        // which would otherwise read as a normal model reply in Pi.
        if (
          (rm.is_error || rm.subtype !== "success") &&
          !maxTurnsWithCaptures
        ) {
          const detail =
            (typeof rm.result === "string" && rm.result) ||
            contentOut
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n") ||
            rm.errors?.join(", ") ||
            rm.subtype ||
            "SDK run failed";
          throw new Error(detail);
        }
        usage = {
          input_tokens: rm.usage?.input_tokens || 0,
          output_tokens: rm.usage?.output_tokens || 0,
          cache_read_input_tokens: rm.usage?.cache_read_input_tokens || 0,
          cache_creation_input_tokens:
            rm.usage?.cache_creation_input_tokens || 0,
        };
        break;
      }
    }

    if (sdkSessionId) {
      sessions.set(key, {
        sdkSessionId,
        // +1: the assistant message we are about to return will be in the
        // client's history on its next request.
        messageCount: messages.length + 1,
        lastUsedAt: Date.now(),
      });
      pruneSessions();
    }

    for (const t of captured) {
      contentOut.push({
        type: "tool_use",
        id: t.id,
        name: t.name,
        input: t.input ?? {},
      });
    }
    const stopReason = captured.length ? "tool_use" : "end_turn";
    const response = {
      id: `msg_bridge_${requestId.replace(/-/g, "").slice(0, 20)}`,
      type: "message",
      role: "assistant",
      model,
      content: contentOut,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    };
    audit({
      ...auditBase,
      direction: "out",
      ok: true,
      duration_ms: Date.now() - started,
      stop_reason: stopReason,
      tool_uses: captured.length,
      sdk_session_id: sdkSessionId,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      ...summarizeText(
        contentOut
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
      ),
    });
    return response;
  };

  if (!wantsStream) {
    try {
      return Response.json(await run());
    } catch (e: any) {
      const message = e?.message || String(e);
      audit({
        ...auditBase,
        direction: "out",
        ok: false,
        duration_ms: Date.now() - started,
        error: message,
      });
      // 400/invalid_request_error: SDK failures here are configuration/policy
      // shaped (e.g. Anthropic's third-party extra-usage billing rejection),
      // and a non-retryable status keeps clients from retry-looping them.
      return anthropicError(400, "invalid_request_error", message);
    }
  }

  // Streaming: open the SSE right away, ping while the SDK works (keeps any
  // client-side idle timeout at bay), then replay the finished message as
  // synthesized Anthropic stream events.
  const enc = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(sse("ping", { type: "ping" }));
        } catch {}
      }, 15_000);
      void run().then(
        (message) => {
          clearInterval(heartbeat);
          try {
            const { content, ...head } = message as any;
            controller.enqueue(
              sse("message_start", {
                type: "message_start",
                message: {
                  ...head,
                  content: [],
                  usage: { ...message.usage, output_tokens: 0 },
                  stop_reason: null,
                },
              }),
            );
            content.forEach((block: ContentBlock, index: number) => {
              if (block.type === "text") {
                controller.enqueue(
                  sse("content_block_start", {
                    type: "content_block_start",
                    index,
                    content_block: { type: "text", text: "" },
                  }),
                );
                controller.enqueue(
                  sse("content_block_delta", {
                    type: "content_block_delta",
                    index,
                    delta: { type: "text_delta", text: block.text },
                  }),
                );
              } else if (block.type === "tool_use") {
                controller.enqueue(
                  sse("content_block_start", {
                    type: "content_block_start",
                    index,
                    content_block: {
                      type: "tool_use",
                      id: block.id,
                      name: block.name,
                      input: {},
                    },
                  }),
                );
                controller.enqueue(
                  sse("content_block_delta", {
                    type: "content_block_delta",
                    index,
                    delta: {
                      type: "input_json_delta",
                      partial_json: JSON.stringify(block.input ?? {}),
                    },
                  }),
                );
              }
              controller.enqueue(
                sse("content_block_stop", {
                  type: "content_block_stop",
                  index,
                }),
              );
            });
            controller.enqueue(
              sse("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: message.stop_reason,
                  stop_sequence: null,
                },
                usage: { output_tokens: message.usage.output_tokens },
              }),
            );
            controller.enqueue(sse("message_stop", { type: "message_stop" }));
            controller.close();
          } catch {}
        },
        (e) => {
          clearInterval(heartbeat);
          const message = e?.message || String(e);
          audit({
            ...auditBase,
            direction: "out",
            ok: false,
            duration_ms: Date.now() - started,
            error: message,
          });
          try {
            controller.enqueue(
              sse("error", {
                type: "error",
                error: { type: "api_error", message },
              }),
            );
            controller.close();
          } catch {}
        },
      );
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

const MAX_BRIDGE_SESSIONS = 500;

function pruneSessions(): void {
  if (sessions.size <= MAX_BRIDGE_SESSIONS) return;
  const byAge = [...sessions.entries()].sort(
    (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
  );
  for (const [key] of byAge.slice(0, sessions.size - MAX_BRIDGE_SESSIONS))
    sessions.delete(key);
}
