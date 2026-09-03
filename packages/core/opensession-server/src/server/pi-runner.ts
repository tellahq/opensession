/**
 * Pi coding-agent runner. Every production model id routes here.
 *
 * Security invariants:
 *  - run kinds are denied by default and unattended tools are stripped before registration;
 *  - built-in local tools are replaced with cwd-contained, minimal-environment overrides;
 *  - Anthropic and ChatGPT traffic use the server-managed account pools;
 *  - third-party providers receive only their configured API key;
 *  - sessions, transcript writes, steering, cancellation, retries and audit events all use
 *    Open Session's owned stores and detached run-host protocol.
 */

import {
  mkdirSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
  constants as fsConstants,
} from "fs";
import {
  access as fsAccess,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "path";
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** The extension-registration config shape ModelRuntime.registerProvider
 *  accepts (ProviderConfigInput — not re-exported by the package index). */
type PiProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];
import { stateDir } from "./paths";
import { audit, summarizeText } from "./audit";
import {
  journalSet,
  buildRunJournalRecord,
  journalClear,
  registerActiveRunProbe,
} from "./run-journal";
import {
  askBashDenyReason,
  isClaudeSubscriptionError,
  isClaudeUsageLimitError,
  isCodexUsageLimitError,
} from "./runner-shared";
import { ensureAnthropicBridge } from "./anthropic-bridge";
import {
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  configuredProviderCatalog,
  modelProviders,
  piProviderCatalog,
  readModelProviderConfig,
  type ModelProviderConfig,
  type PiProviderCatalog,
} from "./model-providers";
import { markCodexExhausted, type CodexAccount } from "./codex-accounts";
import { pickAccount as pickClaudeAccount } from "./claude-accounts";
import {
  bindXaiAccount,
  markXaiExhausted,
  maskXaiAccount,
  pickXaiAccount,
  xaiSubscriptionModelEfforts,
  type XaiAccount,
} from "./xai-accounts";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";
import { enableXaiProxyPayload } from "./xai-payload";
import {
  enableOpenaiFastMode,
  pickOpenaiAccount,
  buildSeededOpenaiAuth,
  maskOpenaiAccount,
} from "./openai-auth";
import {
  INTERACTIVE_KINDS,
  isUnattendedKind,
  baseJournalKind,
  runToolPolicy,
  readLocalInstructions,
} from "./run-policy";
import {
  assembleRunSystemPrompt,
  buildRunInstructions,
  buildSessionContext,
} from "./run-instructions";
import {
  logInjectedContext,
  logStandingContext,
  logStandingJson,
  sessionStartContext,
} from "./context-log";
import { wrapContext } from "./prompt-context";
import { EMPTY_REPLY_RETRY_PROMPT } from "./auto-continue";
import {
  bashAskPolicyReply,
  publicationPolicyDenyReason,
  type PublicationPolicy,
} from "./command-policy";
import {
  appendTranscriptEntries,
  recordEngineSessionOwner,
  transcriptLineForEntry,
  transcriptLineRunnerNotice,
  transcriptLineCompactionSummary,
  transcriptLineUser,
  storeAppendUserLineEarly,
} from "./transcript-persistence";
import { transcript } from "./actor-transcript";
import { transcriptForwarder } from "./transcript-forward";
import { gitIdentityEnv } from "./shared/user-mappings";
import { providerAccountUser } from "./session-actors";
import {
  GITHUB_RUN_AUTH_FILE_ENV,
  githubRunEnv,
  githubUserLoginForRun,
  projectedGithubRunEnv,
} from "./github-auth";
import { ensureAgentAwsCredsFile } from "./aws-creds";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { piAnthropicTransport, piEngineEnabled } from "./pi-config";
import { buildPiAnthropicProvider } from "./pi-anthropic-provider";
import {
  createPiRuntimeBinding,
  prewarmPiSdk as prewarmPiSdkBinding,
} from "./pi-runtime-binding";
import { createPiMcpBridge, type PiMcpBridge } from "./pi-mcp-bridge";
import { controlPlaneWorkloadCommand, stopUserScope } from "./systemd-scopes";
import {
  createMcpRuntime,
  splitMcpMigrationBoundary,
  type McpRuntime,
} from "./mcp-runtime";
import {
  DIAL_ORACLE_AGENTS,
  DIAL_ORACLE_FALLBACKS,
  ORCHESTRATOR_WORKER_AGENTS,
  dialPreset,
  piModelLabel,
  orchestratorPreset,
  orchestratorWorkerForBridge,
  sameBridgeDialOracle,
  toPiModel,
} from "./models";
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";
import { expandSkillCommand, skillSearchPaths } from "./skill-paths";
import type { ResolvedWorkspaceModelPreset } from "./workspace-model-presets";
import type { TranscriptEntry } from "./types";
import type { RunAgentOpts } from "./agent-runner";
import type { StreamEvent, ImageInput, TurnUsage } from "./run-events";

const g = globalThis as any;

const PROVIDER = "pi" as const;
export const PI_MODEL_PREFIX = "pi/";

/** Fresh authority for an unattended GitHub code run. Host recovery resolves
 * the selected service credential from the registered cwd; remote runners can
 * consume only the private run-scoped file projected by their launcher. */
export async function githubCodeRunEnv(
  cwd: string,
): Promise<Record<string, string>> {
  if (process.env[GITHUB_RUN_AUTH_FILE_ENV]) return projectedGithubRunEnv();
  const { repoForPathOrNull } = await import("./worktree");
  const repo = repoForPathOrNull(cwd);
  if (!repo || repo.host === "codestorage" || !repo.ghRepo) return {};
  const { githubServiceCredentialEnv } = await import("./github-app");
  return githubServiceCredentialEnv(repo.ghRepo);
}

/** State root: server-owned agentDir, per-unified-session pi session dirs,
 *  and the smoke-turn scratch cwd. Never ~/.pi. */
export const PI_STATE_DIR = stateDir("pi");

/** How many content blocks of an assistant message a reader could actually
 *  see: non-empty text or thinking blocks and tool calls. Truly empty content
 *  counts zero — that is the empty-completion shape the pump loop retries. */
export function assistantRenderableBlockCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const block = b as {
      type?: string;
      text?: unknown;
      thinking?: unknown;
      id?: unknown;
    };
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim()
    )
      n++;
    else if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.trim()
    )
      n++;
    else if (block.type === "toolCall" && block.id) n++;
  }
  return n;
}

/** Preserve every model-authored prose block in provider order. Pi exposes
 * reasoning as `thinking` blocks and ordinary output as `text`; both become
 * visible assistant transcript entries, while tool calls keep their own rows. */
export function piAssistantTranscriptEntries(
  content: unknown,
  timestamp: string,
  model: string,
  messageId: string = crypto.randomUUID(),
): TranscriptEntry[] {
  if (!Array.isArray(content)) return [];
  const entries: TranscriptEntry[] = [];
  let proseIndex = 0;
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as {
      type?: string;
      text?: unknown;
      thinking?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    const reasoning =
      block.type === "thinking" && typeof block.thinking === "string"
        ? block.thinking
        : "";
    const isReasoning = reasoning.length > 0;
    const prose =
      block.type === "text" && typeof block.text === "string"
        ? block.text
        : reasoning;
    if (prose.trim()) {
      entries.push({
        id: proseIndex === 0 ? messageId : `${messageId}-b${proseIndex}`,
        type: "assistant",
        content: prose,
        timestamp,
        model,
        ...(isReasoning ? { isReasoning: true } : {}),
      });
      proseIndex++;
    } else if (block.type === "toolCall" && block.id) {
      entries.push({
        id: String(block.id),
        type: "tool_use",
        content: "",
        timestamp,
        toolName: String(block.name || "tool"),
        toolInput: block.arguments ?? {},
        toolUseId: String(block.id),
      });
    }
  }
  return entries;
}

/** Split `pi/<provider>/<model>` (model may itself contain slashes). */
export function parsePiModel(
  model: string,
): { providerID: string; modelID: string } | null {
  if (!model.startsWith(PI_MODEL_PREFIX)) return null;
  const rest = model.slice(PI_MODEL_PREFIX.length);
  const sep = rest.indexOf("/");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { providerID: rest.slice(0, sep), modelID: rest.slice(sep + 1) };
}

/** Resolve a Pi model or preset to the concrete model that executes its main
 * turn. The stored preset id stays intact so its effort and companion tools
 * remain attached across continuation turns.
 *
 * `storedModel` is the session's stored id (`opts.model`). It matters for
 * workspace ("Custom") presets: agent-runner dispatches those as their
 * concrete LEAD model, so the preset id — and with it an `enginePresetId`'s
 * oracle/worker wiring and the preset's pinned effort — survives only on the
 * stored id. Resolving over both ids is the codex-direct recipe
 * (resolveCodexDirectPreset). */
export function resolvePiRoutedModel(
  model: string,
  storedModel?: string | null,
): PiResolvedModel | null {
  const ids = [model, storedModel || ""].filter(Boolean);
  const ws = ids
    .map((id) => resolveWorkspaceModelPreset(id))
    .find((hit): hit is ResolvedWorkspaceModelPreset => !!hit);
  return resolvePiPresetWiring(model, ws, ids);
}

export interface PiResolvedModel {
  providerID: string;
  modelID: string;
  dial?: NonNullable<ReturnType<typeof dialPreset>>;
  orchestrator?: NonNullable<ReturnType<typeof orchestratorPreset>>;
  workspacePreset?: ResolvedWorkspaceModelPreset;
  /** The preset's effort override (workspace preset first — it is what the
   *  person configured — then the built-in preset's); undefined on a
   *  non-preset run, where the session's own effort stands. */
  effort?: string;
}

/** Pure half of resolvePiRoutedModel (exported for tests): the preset wiring
 * given an already-resolved workspace preset — the workspace-store read is the
 * only impure step, exactly the split claude-direct-policy makes. */
export function resolvePiPresetWiring(
  model: string,
  ws: ResolvedWorkspaceModelPreset | undefined,
  candidateIds: readonly string[] = [model],
): PiResolvedModel | null {
  const candidates = [...candidateIds, ws?.enginePresetId];
  const dial = candidates
    .map((id) => dialPreset(id))
    .find((hit): hit is NonNullable<ReturnType<typeof dialPreset>> => !!hit);
  const orchestrator = candidates
    .map((id) => orchestratorPreset(id))
    .find(
      (hit): hit is NonNullable<ReturnType<typeof orchestratorPreset>> => !!hit,
    );
  const lower = model.toLowerCase();
  if (lower.startsWith("pi/dial/") && !dial) return null;
  if (lower.startsWith("pi/orchestrator/") && !orchestrator) return null;
  if (lower.startsWith("pi/workspace-preset/") && !ws) return null;
  // A workspace preset id resolves to its (already pi-routed) lead; everything
  // else routes through toPiModel as before.
  const concrete =
    ws && lower.startsWith("pi/workspace-preset/")
      ? ws.model
      : toPiModel(model);
  const parsed = concrete ? parsePiModel(concrete) : null;
  if (!parsed) return null;
  const effort = ws?.effort ?? dial?.effort ?? orchestrator?.effort;
  return {
    ...parsed,
    ...(dial ? { dial } : {}),
    ...(orchestrator ? { orchestrator } : {}),
    ...(ws ? { workspacePreset: ws } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** @deprecated Dial was generalized to routed presets. Keep the focused name
 * for callers/tests that only exercise the Dial family. */
export const resolvePiDialModel = resolvePiRoutedModel;

/** The oracle agent a pi dial run actually consults: the preset's oracle when
 * its account family matches the run's provider, else the same-bridge
 * substitute — the rule every other engine applies (sameBridgeDialOracle).
 * Pi's oracle executes out-of-band through oneShot, so a cross-family
 * oracle would technically work; the substitution is account-pool POLICY
 * parity — a dial run must not consult (and bill) a second account family the
 * same preset would not consult on any other engine. Third-party providers
 * (wafer, cerebras) keep the preset's own choice, also like the others. */
export function piDialOracleAgent(
  oracleAgent: string,
  providerID: string,
): string {
  return sameBridgeDialOracle(oracleAgent, providerID);
}

/**
 * Registration plan for a third-party (non-anthropic/openai) provider — the
 * pure half of the runner's provider branch, exported for tests.
 *
 * Model metadata comes from Pi's built-in provider catalog when Pi knows the
 * provider (Cerebras, Moonshot, xAI, and others). piProviderCatalog supplies a
 * provider Pi does not know (Wafer) and models newer than its bundled snapshot
 * (GLM-5.3 on OpenRouter). The operator's config adds a third layer: a
 * declared `api` makes a slug unknown to both catalogs runnable as a plain
 * OpenAI-compatible provider at its `baseURL`, and its catalog rows (inline,
 * file, or discovered) override the other layers per model id. A provider in
 * no catalog fails clearly rather than guessing a protocol. A model id in none
 * of them gets a conservative fallback entry: zero cost because unknown
 * pricing must under-report, plus safe window and output floors. It inherits
 * the provider's API and base URL, so catalog lag never blocks a run.
 */
export function buildPiThirdPartyProviderPlan(input: {
  providerID: string;
  modelID: string;
  apiKey: string;
  baseURL?: string;
  /** The provider's stored config beyond the key and base URL. */
  configured?: ModelProviderConfig;
  /** Model ids pi's built-in catalog holds for this provider (may be empty). */
  builtinModelIds: readonly string[];
}): { config: PiProviderConfigInput } | { error: string } {
  const ours = piProviderCatalog(input.providerID);
  const custom = configuredProviderCatalog(input.providerID, input.configured);
  const builtin = new Set(input.builtinModelIds);
  const declared = !!input.configured?.api;
  if (!ours && !builtin.size && !declared) {
    return {
      error:
        `Provider "${input.providerID}" is in neither Pi's built-in catalog nor ours, ` +
        "so the Pi engine cannot guess its protocol. Set its api to openai-completions " +
        "with a base URL, or configure a supported provider for this model.",
    };
  }
  if (declared && !input.baseURL) {
    return {
      error: `Provider "${input.providerID}" declares an api but no base URL. Set its base URL first.`,
    };
  }
  const configuredRow = custom?.models.find((m) => m.id === input.modelID);
  const builtinKnown = builtin.has(input.modelID) && !configuredRow;
  const catalogKnown =
    !!configuredRow || !!ours?.models.some((m) => m.id === input.modelID);
  // Registering `models` REPLACES the provider's model list in Pi's extension
  // layer. Preserve Pi's full built-in list when it already knows the selected
  // model and the operator pinned nothing for it. Otherwise the table carries
  // our rows, the configured rows on top (same id wins), and a conservative
  // fallback row when the selected model is in none of them.
  const table = new Map<string, PiProviderCatalog["models"][number]>();
  for (const m of ours?.models ?? []) table.set(m.id, m);
  for (const m of custom?.models ?? []) table.set(m.id, m);
  const models = builtinKnown
    ? []
    : [
        ...table.values(),
        ...(catalogKnown
          ? []
          : [
              {
                id: input.modelID,
                name: input.modelID,
                reasoning: true,
                input: ["text"] as Array<"text" | "image">,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: FALLBACK_CONTEXT_WINDOW,
                maxTokens: FALLBACK_MAX_TOKENS,
              },
            ]),
      ];
  const api = custom?.api ?? ours?.api;
  const name = input.configured?.name || ours?.name;
  return {
    config: {
      apiKey: input.apiKey,
      ...(api && (declared || ours) ? { api } : {}),
      ...(name && (declared || ours) ? { name } : {}),
      ...(input.baseURL
        ? { baseUrl: input.baseURL }
        : ours
          ? { baseUrl: ours.baseUrl }
          : {}),
      ...(models.length ? { models } : {}),
    },
  };
}

const ORACLE_SYSTEM =
  "You are a read-only senior engineering advisor. Give a concise, concrete second opinion. " +
  "Do not claim to inspect files or run tools. State assumptions, tradeoffs, and recommended next steps.";

/** Which one-shot failures earn a hop to the next oracle on the ladder.
 *  An availability failure (dry pool, disabled subscription, timeout, a
 *  provider blip) is exactly what a peer on another provider can answer
 *  through. A malformed prompt or an unresolvable model id is not: the peer
 *  would fail the same way, and the caller would wait another two minutes to
 *  learn it. An empty answer with no stated reason gets one hop, since a
 *  silent empty completion is more often the pool than the prompt. */
const ORACLE_FALLOVER_SHAPES =
  /usage[-_ ]?limit|weekly limit|no usable|exhausted|sidelined|rate[-_ ]?limit|quota|subscription access|disabled Claude|timed out|overloaded|too many requests|\b(429|500|502|503|529)\b|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i;

function oracleShouldFallOver(error: string | null): boolean {
  if (!error) return true;
  return ORACLE_FALLOVER_SHAPES.test(error);
}

function makePiDialOracleTool(
  oracleAgent: string,
  user?: string,
): ToolDefinition<any, any, any> {
  const oracle = DIAL_ORACLE_AGENTS[oracleAgent];
  return {
    name: "oracle",
    label: "Oracle",
    description:
      `Consult ${oracle?.label || oracleAgent} for a read-only senior-engineering second opinion. ` +
      "Use it for hard plans, significant reviews, architecture tradeoffs, or stubborn debugging, not routine searches or edits.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Precise question with the relevant context, file paths, constraints, and options under consideration",
        },
      },
      required: ["prompt"],
    } as any,
    async execute(_toolCallId, params, signal) {
      const prompt = String(
        (params as { prompt?: unknown })?.prompt ?? "",
      ).trim();
      if (!prompt) throw new Error("oracle requires a prompt");
      if (signal?.aborted) throw new Error("Oracle request aborted");
      if (!oracle)
        throw new Error(`Dial oracle "${oracleAgent}" is not configured`);
      // Dynamic import avoids a module cycle: one-shot.ts drives runPi, while
      // Pi's Dial oracle delegates its out-of-band consultation back to it.
      const { oneShotDetailed } = await import("./one-shot");
      // Walk this oracle's cross-provider ladder, the same courtesy
      // interactiveFallbackModel does for a full session. A dry pool is a
      // provider-wide condition, so the hop has to change bridges to be worth
      // taking (DIAL_ORACLE_FALLBACKS).
      const ladder = [
        oracleAgent,
        ...(DIAL_ORACLE_FALLBACKS[oracleAgent] || []),
      ];
      const failures: string[] = [];
      for (let i = 0; i < ladder.length; i++) {
        const name = ladder[i]!;
        const agent = DIAL_ORACLE_AGENTS[name];
        if (!agent) continue;
        if (signal?.aborted) throw new Error("Oracle request aborted");
        const { text, error } = await oneShotDetailed(prompt, {
          model: agent.model,
          effort: agent.variant,
          user,
          label: i === 0 ? "pi-dial-oracle" : `pi-dial-oracle-fallback`,
          system: ORACLE_SYSTEM,
        });
        if (signal?.aborted) throw new Error("Oracle request aborted");
        if (text) {
          // Say who actually answered. A second opinion whose author is not
          // the one the preset named is still useful, but the reader has to
          // know which model's judgement they are weighing.
          const note =
            i === 0
              ? ""
              : `[${oracle.label} was unavailable (${failures[0]}). Answered by ${agent.label}.]\n\n`;
          return {
            content: [{ type: "text", text: note + text }],
            details: undefined,
          };
        }
        failures.push(error || "no answer");
        if (!oracleShouldFallOver(error)) break;
      }
      // The reason is the useful part: "every Claude account is usage-limited
      // until Friday" tells the caller to stop asking, where a bare
      // "unavailable" sends whoever reads it to journalctl.
      throw new Error(
        `The Dial oracle was unavailable: ${failures.join("; ") || "no answer"}. ` +
          "Continue using your own judgment.",
      );
    },
  };
}

// ── SDK loading ──────────────────────────────────────────────────────────────

/**
 * Idempotent Pi SDK warm-up for the eventual boot call site. Boot wiring is
 * intentionally deferred until this extraction is reviewed; turns still load
 * the SDK on demand through createPiRuntimeBinding.
 */
export function prewarmPiSdk() {
  return prewarmPiSdkBinding();
}

// ── Live-run registry ────────────────────────────────────────────────────────

interface PiRunHandle {
  abort: AbortController;
  /** Distinct-run identity: every alias key maps to the same handle object. */

  steer?: (text: string, images?: ImageInput[], steerId?: string) => void;
  retractSteer?: (steerId: string) => boolean;
  acceptedSteerIds?: Set<string>;
}

// Alias keys (runKey, unified session id, pi session id) → shared handle,
// parked on globalThis so hot reloads keep cancel/steer/isBusy working for
// in-flight turns — same pattern as the previous runner runner's activeRuns.
const activeRuns: Map<string, PiRunHandle> = (g.__piActiveRuns ??= new Map());

registerActiveRunProbe((runKey) => activeRuns.has(runKey));

export function isPiSessionBusy(id: string): boolean {
  return activeRuns.has(id);
}

export function activePiRunCount(): number {
  return new Set(activeRuns.values()).size;
}

/** Activate exactly the tools backed by custom definitions. Pi falls back to
 * its unrestricted built-ins for enabled names without a custom override, so
 * the enabled-name list must never be maintained separately. */
export function piToolNames(
  customTools: readonly Pick<ToolDefinition<any, any, any>, "name">[],
): string[] {
  return customTools.map((tool) => tool.name);
}

export const PI_STEER_TOOL_SKIP =
  "Skipped because new steering instructions arrived. Read them before choosing the next tool.";

/**
 * Pi polls its steer queue after an assistant message's whole tool batch. That
 * is too late for Open Session's step-boundary contract: a model can emit a
 * long batch, leaving a steer parked behind several not-yet-started tools.
 *
 * Force each batch to execute sequentially and turn every not-yet-started call
 * into a cheap result once a steer is waiting. Pi can then satisfy the model
 * protocol's one-result-per-call requirement and inject the steer without
 * starting stale work.
 */
export function piSteeringBoundaryTools(
  tools: readonly ToolDefinition<any, any, any>[],
  steeringPending: () => boolean,
): ToolDefinition<any, any, any>[] {
  return tools.map((tool) => ({
    ...tool,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (steeringPending()) {
        return {
          content: [{ type: "text", text: PI_STEER_TOOL_SKIP }],
          details: {},
        };
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  }));
}

export function cancelPiRun(id: string): boolean {
  const handle = activeRuns.get(id);
  if (!handle) return false;
  handle.abort.abort();
  return true;
}

/** Native mid-turn steer: session.steer() queues the text for delivery at the
 *  next completed tool or assistant-message boundary, before the next LLM
 *  call. True = a live run accepted it; false = nothing steerable (caller
 *  queues for the next turn instead). */
export function acceptSteerOnce(
  accepted: Set<string>,
  steerId: string,
  accept: () => void,
): boolean {
  if (accepted.has(steerId)) return true;
  accept();
  accepted.add(steerId);
  return true;
}

export function steerPiRun(
  id: string,
  text: string,
  images?: ImageInput[],
  steerId?: string,
): boolean {
  const handle = activeRuns.get(id);
  if (!handle?.steer) return false;
  if (!steerId) {
    handle.steer(text, images);
    return true;
  }
  return acceptSteerOnce((handle.acceptedSteerIds ??= new Set()), steerId, () =>
    handle.steer!(text, images, steerId),
  );
}

export function retractPiSteer(id: string, steerId: string): boolean {
  const handle = activeRuns.get(id);
  const retracted = handle?.retractSteer?.(steerId) === true;
  if (retracted) handle?.acceptedSteerIds?.delete(steerId);
  return retracted;
}

/** Remove one exact pending steer, then let the caller rebuild the engine queue.
 * The synchronous mutation is the race boundary: delivery either removed the
 * item first, or retraction does, never both. */
export function retractPendingSteer<T extends { steerId?: string }>(
  pending: T[],
  steerId: string,
  replay: (remaining: readonly T[]) => void,
): boolean {
  const index = pending.findIndex((item) => item.steerId === steerId);
  if (index < 0) return false;
  const remaining = pending.filter((_, candidate) => candidate !== index);
  pending.splice(0, pending.length, ...remaining);
  replay(remaining);

  return true;
}

// ── Gate ─────────────────────────────────────────────────────────────────────

// Armed only inside runPiSmokeTurn (a counter, so overlapping smoke calls
// can't disarm each other). The "pi-smoke" kind passes the gate only while
// armed — request/automation data can name the kind but never arm the bypass.
let smokeGateBypass = 0;

/** Non-null = the reason this run may not use the pi engine. Same deny-by-
 *  default semantics as previous runnerGateReason: interactive + unattended journal
 *  kinds only, kind-less runs refused. */
export function piGateReason(opts: {
  journal?: { kind?: string };
}): string | null {
  const base = baseJournalKind(opts.journal?.kind);
  if (base === "pi-smoke" && smokeGateBypass > 0) return null;
  if (INTERACTIVE_KINDS.has(base) || isUnattendedKind(base)) return null;
  return base
    ? `The Pi engine is not available to "${base}" runs. Interactive sessions and automations only.`
    : "The Pi engine requires an explicit run kind (journal.kind). Deny by " +
        "default; interactive sessions and automations only.";
}

// ── Small helpers ────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Pi ImageContent from our wire shape. */
function piImages(
  images?: ImageInput[],
): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  if (!images?.length) return undefined;
  return images.map((im) => ({
    type: "image" as const,
    data: im.data,
    mimeType: im.mediaType,
  }));
}

/** Flatten pi tool-result content to text + renderable image srcs. */
function contentToTextAndImages(content: unknown): {
  text: string;
  images: string[];
} {
  const texts: string[] = [];
  const images: string[] = [];
  if (Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "image" && typeof b.data === "string") {
        images.push(
          `data:${String(b.mimeType || "image/png")};base64,${b.data}`,
        );
      }
    }
  } else if (typeof content === "string") {
    texts.push(content);
  }
  return { text: texts.join("\n"), images };
}

/** Raw codex error codes that can surface in a pi/openai error before pi's
 *  friendly "You have hit your ChatGPT usage limit…" message is built — cheap
 *  insurance on top of isCodexUsageLimitError's message matching. Quota
 *  shapes are provider-spelled (insufficient_quota / "exceeded your current
 *  quota"), never a bare `quota` alternation: this classifier also sees
 *  non-provider throws in the catch, and infrastructure errors like
 *  "EDQUOT: disk quota exceeded" must not read as account exhaustion. The
 *  placeholder-refresh failure ("OAuth refresh failed for openai-codex")
 *  is included: pi refreshes only inside the final 5 minutes of the access
 *  token, so that failure means "this account can't serve until the codex
 *  CLI refreshes it" — dry-pool semantics. */
const CODEX_USAGE_LIMIT_CODE_SHAPES =
  /usage_limit_reached|usage_not_included|rate_limit_exceeded|insufficient_quota|usage_quota|exceeded your current quota|GoUsageLimitError|FreeUsageLimitError|OAuth refresh failed for openai-codex/i;

/** SuperGrok shapes: the cli-chat-proxy's quota and rate-limit answers, plus
 *  a rejected or unrefreshable token ("this account can't serve until someone
 *  signs in again" is dry-pool semantics for the walk). Never a bare `quota`:
 *  infrastructure errors like EDQUOT must not read as exhaustion. */
const XAI_USAGE_LIMIT_SHAPES =
  /\b429\b|too many requests|rate[ _-]?limit|usage[ _-]?limit|insufficient_quota|exceeded your (?:current )?quota|credits? (?:exhausted|depleted|limit)|out of credits|\b401\b|authentication rejected|invalid_grant|token refresh failed|no usable SuperGrok|no SuperGrok accounts|not currently usable/i;

/** One pool account as the runner's walk sees it, whichever pool it came from. */
interface PoolAccountRef {
  id: string;
  name: string;
  masked: string;
  pool: "openai" | typeof XAI_OAUTH_PROVIDER;
  /** How the pool reads in logs: "codex" or "SuperGrok". */
  label: string;
}

function codexPoolRef(account: CodexAccount): PoolAccountRef {
  return {
    id: account.id,
    name: account.name,
    masked: maskOpenaiAccount(account),
    pool: "openai",
    label: "codex",
  };
}

function xaiPoolRef(account: XaiAccount): PoolAccountRef {
  return {
    id: account.id,
    name: account.name,
    masked: maskXaiAccount(account),
    pool: XAI_OAUTH_PROVIDER,
    label: "SuperGrok",
  };
}

/** Provider-aware usage-limit classification for terminal errors — "this
 *  model's pool can't serve right now", which is exactly what
 *  usageLimitExhausted tells agent-runner's fallback walk. Anthropic runs see
 *  the loopback bridge's shapes: 429 (per-account hourly cap) and 529 (no
 *  usable designated account) plus the standard Claude limit messages. OpenAI
 *  runs match the codex classifier shared with the previous runner engine
 *  (isCodexUsageLimitError) plus the raw code shapes above — never the
 *  bridge-only shapes (529/overload is transient there, not exhaustion).
 *  Exported for the classifier tests. */
export function isPiUsageLimitShape(
  message: string,
  providerID: string,
): boolean {
  if (providerID === "openai") {
    return (
      isCodexUsageLimitError(message) ||
      CODEX_USAGE_LIMIT_CODE_SHAPES.test(message)
    );
  }
  if (providerID === XAI_OAUTH_PROVIDER) {
    return XAI_USAGE_LIMIT_SHAPES.test(message);
  }
  if (
    isClaudeUsageLimitError(message, true) ||
    isClaudeSubscriptionError(message)
  )
    return true;
  const s = message.toLowerCase();
  return (
    s.includes("overloaded_error") ||
    /\b529\b/.test(s) ||
    /\b429\b/.test(s) ||
    s.includes("no designated bridge account") ||
    // Pool-mode pickBridgeAccount: exhausted pool (not the empty-pool config
    // error, which deliberately says "no Claude accounts configured").
    s.includes("no usable claude account")
  );
}

/** First jsonl line of a pi session file (the v3 header), bounded read. */
function readSessionHeader(
  path: string,
): { type?: string; id?: string } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString("utf-8", 0, n).split("\n")[0];
    if (!firstLine) return null;
    return JSON.parse(firstLine);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Find the session jsonl whose header id matches — resume-by-piSessionId. */
function findPiSessionFile(
  sessionDir: string,
  piSessionId: string,
): string | null {
  try {
    const names = readdirSync(sessionDir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const name of names) {
      const path = join(sessionDir, name);
      const header = readSessionHeader(path);
      if (header?.type === "session" && header.id === piSessionId) return path;
    }
  } catch {}
  return null;
}

// ── Transcript integration (the claude-direct recipe) ────────────────────────

/** One transcript append, routed. In the server process this writes the
 *  store directly (appendTranscriptEntries). Inside a run host a forwarder
 *  is registered (transcript-forward.ts): the batch is relayed to the server
 *  over the run-host protocol instead, keeping transcripts.db single-writer
 *  and giving sandboxed/detached pi runs host-side persistence. */
function piAppend(
  engineSessionId: string,
  lines: Record<string, unknown>[],
): void {
  const forward = transcriptForwarder();
  if (forward) {
    forward(engineSessionId, lines);
    return;
  }
  void appendTranscriptEntries(engineSessionId, lines).catch((error) => {
    console.error(
      `[pi] Transcript append failed for ${engineSessionId}:`,
      error,
    );
  });
}

/** Store one batch of normalized entries under the pi session id. Requires
 *  recordEngineSessionOwner to have mapped pi→unified first (see runPi); system
 *  entries ride runner-notice lines. Best-effort — a transcript write must
 *  never take the run down. */
function persistEntries(
  engineSessionId: string | undefined,
  entries: TranscriptEntry[],
): void {
  if (!entries.length || !engineSessionId) return;
  try {
    const lines = entries
      .map((e) =>
        e.type === "system"
          ? transcriptLineRunnerNotice(e.content, e.id, e.timestamp)
          : transcriptLineForEntry(e),
      )
      .filter((l): l is Record<string, unknown> => !!l);
    piAppend(engineSessionId, lines);
  } catch (e) {
    console.warn("[pi-runner] transcript persist failed:", e);
  }
}

// ── Guarded local tools (the containment invariant) ──────────────────────────
//
// Pi's built-in fs tools run in-process with no path containment and their
// rg/fd children inherit process.env (the server env). We never activate the
// built-ins; the model gets same-name customTools overrides instead: pi's own
// tool factories (createReadToolDefinition & co) wrapped with the guarded
// operations below — identical schema/description/truncation behavior, ours
// only where the filesystem or a subprocess is touched.

/** Directory roots no tool may touch even when a symlink or bind mount would
 *  bring them under the workspace realpath check. /proc/self/environ is the
 *  server-env exfiltration vector that motivated the guard. */
const BLOCKED_PATH_ROOTS = ["/proc", "/sys", "/dev"];

/**
 * Realpath-based workspace containment: resolve `rawPath`, symlink-resolve it
 * through its nearest EXISTING ancestor (so not-yet-created write targets are
 * checked too — a symlinked parent can't smuggle them out), and require the
 * result to sit under `realRoot`. Throws with a model-facing message on
 * escape. Returns the fully-resolved path it validated.
 */
export function assertContainedPiPath(
  rawPath: string,
  realRoot: string,
): string {
  const resolved = resolve(rawPath);
  let probe = resolved;
  const pendingSuffix: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = realpathSync(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        real = probe;
        break;
      }
      pendingSuffix.unshift(basename(probe));
      probe = parent;
    }
  }
  const full = pendingSuffix.length ? join(real, ...pendingSuffix) : real;
  for (const blocked of BLOCKED_PATH_ROOTS) {
    if (full === blocked || full.startsWith(blocked + sep)) {
      throw new Error(`Path is not accessible to this session: ${rawPath}`);
    }
  }
  if (full !== realRoot && !full.startsWith(realRoot + sep)) {
    throw new Error(
      `Path is outside the session workspace (${rawPath}). ` +
        "Local file tools are contained to the session's working directory.",
    );
  }
  return full;
}

/** Magic-byte image sniff for the guarded read tool (pi's default detector is
 *  not importable standalone; same formats: png/jpeg/gif/webp/bmp). */
function sniffImageMime(path: string): string | undefined {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(16);
      const n = readSync(fd, buf, 0, 16, 0);
      if (n < 4) return undefined;
      if (
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47
      )
        return "image/png";
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return "image/jpeg";
      if (buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
      if (
        n >= 12 &&
        buf.toString("ascii", 0, 4) === "RIFF" &&
        buf.toString("ascii", 8, 12) === "WEBP"
      )
        return "image/webp";
      if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * The guarded operations pi's read/ls/find/edit/write factories accept —
 * every path realpath-contained to `cwd` before any fs call. `find.glob`
 * replaces the factory's default fd SUBPROCESS entirely (pi only uses fd when
 * no custom glob is provided), walking with Bun.Glob in-process instead:
 * no child, no env, `followSymlinks: false` so a symlinked dir can't be
 * traversed out of. Exported for the containment unit tests.
 */
export function makeGuardedToolOps(cwd: string) {
  let realRoot: string;
  try {
    realRoot = realpathSync(cwd);
  } catch {
    realRoot = resolve(cwd);
  }
  const guard = (p: string) => assertContainedPiPath(p, realRoot);
  const exists = async (p: string) => {
    guard(p);
    try {
      await fsAccess(p, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  return {
    guard,
    read: {
      readFile: async (p: string) => {
        guard(p);
        return fsReadFile(p);
      },
      access: async (p: string) => {
        guard(p);
        await fsAccess(p, fsConstants.R_OK);
      },
      detectImageMimeType: async (p: string) => {
        guard(p);
        return sniffImageMime(p);
      },
    },
    ls: {
      exists,
      stat: async (p: string) => {
        guard(p);
        return fsStat(p);
      },
      readdir: async (p: string) => {
        guard(p);
        return fsReaddir(p);
      },
    },
    find: {
      exists,
      glob: async (
        pattern: string,
        searchPath: string,
        options: { ignore: string[]; limit: number },
      ): Promise<string[]> => {
        guard(searchPath);
        // fd (pi's default) matches bare patterns against basenames while
        // globbing relative paths — mirror that with a `**/` prefix.
        const effective = pattern.includes("/") ? pattern : `**/${pattern}`;
        const limit = Math.max(1, options.limit || 1000);
        const ignore = (options.ignore || []).map((ig) => new Bun.Glob(ig));
        const out: string[] = [];
        const scanner = new Bun.Glob(effective);
        for await (const rel of scanner.scan({
          cwd: searchPath,
          dot: true,
          onlyFiles: false,
          followSymlinks: false,
        })) {
          if (ignore.some((ig) => ig.match(rel))) continue;
          out.push(join(searchPath, rel));
          if (out.length >= limit) break;
        }
        return out.sort();
      },
    },
    edit: {
      readFile: async (p: string) => {
        guard(p);
        return fsReadFile(p);
      },
      writeFile: async (p: string, content: string) => {
        guard(p);
        await fsWriteFile(p, content, "utf-8");
      },
      access: async (p: string) => {
        guard(p);
        await fsAccess(p, fsConstants.R_OK | fsConstants.W_OK);
      },
    },
    write: {
      writeFile: async (p: string, content: string) => {
        guard(p);
        await fsWriteFile(p, content, "utf-8");
      },
      mkdir: async (dir: string) => {
        guard(dir);
        await fsMkdir(dir, { recursive: true });
      },
    },
  };
}

const GREP_DEFAULT_LIMIT = 100;
const GREP_OUTPUT_CAP = 50 * 1024;

/**
 * Guarded grep execute: pi's grep factory hard-codes an rg spawn that
 * inherits process.env and takes an uncontained search path, so unlike the
 * other fs tools its execute is replaced wholesale (the tool keeps pi's
 * name/schema/description via the factory's definition). rg runs with the
 * run's minimal env, cwd-contained, match-capped, byte-capped. Exported for
 * the containment unit tests.
 */
export function makeGuardedGrepExecute(
  cwd: string,
  env: Record<string, string>,
  guard: (p: string) => string,
) {
  return async function execute(
    _toolCallId: string,
    params: {
      pattern?: unknown;
      path?: unknown;
      glob?: unknown;
      ignoreCase?: unknown;
      literal?: unknown;
      context?: unknown;
      limit?: unknown;
    },
    signal?: AbortSignal,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: undefined;
  }> {
    const pattern = String(params?.pattern ?? "");
    if (!pattern) throw new Error("grep: pattern is required");
    if (signal?.aborted) throw new Error("Operation aborted");
    const rawPath =
      typeof params?.path === "string" && params.path ? params.path : ".";
    const searchPath = resolve(cwd, rawPath);
    guard(searchPath);
    const rgPath = Bun.which("rg");
    if (!rgPath) throw new Error("ripgrep (rg) is not available on this host");
    const st = await fsStat(searchPath).catch(() => null);
    if (!st) throw new Error(`Path not found: ${searchPath}`);
    const isDir = st.isDirectory();

    const args = [
      "--line-number",
      "--color=never",
      "--hidden",
      "--with-filename",
    ];
    if (params?.ignoreCase) args.push("--ignore-case");
    if (params?.literal) args.push("--fixed-strings");
    if (typeof params?.glob === "string" && params.glob)
      args.push("--glob", params.glob);
    const ctxN = Number(params?.context);
    if (Number.isFinite(ctxN) && ctxN > 0)
      args.push("--context", String(Math.floor(ctxN)));
    const limit = Math.max(1, Number(params?.limit) || GREP_DEFAULT_LIMIT);
    // Directory searches run from the search root with "." so rg prints
    // workspace-relative paths (pi's output shape); file targets run from the
    // file's dir with its basename for the same reason.
    args.push("--", pattern, isDir ? "." : basename(searchPath));

    const proc = Bun.spawn([rgPath, ...args], {
      cwd: isDir ? searchPath : dirname(searchPath),
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const onAbort = () => {
      try {
        proc.kill();
      } catch {}
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let out = "";
    let stderr = "";
    let matches = 0;
    let matchLimitReached = false;
    try {
      const dec = new TextDecoder();
      // stderr drains concurrently: a stderr flood (permission errors on a
      // big tree) must not fill its pipe and block rg while stdout is open.
      const errDrain = (async () => {
        const errReader = proc.stderr.getReader();
        try {
          while (true) {
            const { done, value } = await errReader.read();
            if (done) break;
            if (value && stderr.length < 8_192) {
              stderr += dec.decode(value, { stream: true });
            }
          }
        } finally {
          errReader.releaseLock();
        }
      })();
      const reader = proc.stdout.getReader();
      try {
        let buffered = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, nl);
            buffered = buffered.slice(nl + 1);
            if (/^(.+?):(\d+):/.test(line)) {
              if (matches >= limit) continue;
              matches++;
              if (matches >= limit) matchLimitReached = true;
            } else if (matches >= limit) {
              continue;
            }
            out += `${line}\n`;
            if (matchLimitReached || out.length > GREP_OUTPUT_CAP * 2) {
              try {
                proc.kill();
              } catch {}
            }
          }
        }
        if (buffered && matches < limit) out += buffered;
      } finally {
        reader.releaseLock();
      }
      await errDrain;
      const code = await proc.exited;
      if (signal?.aborted) throw new Error("Operation aborted");
      if (code !== 0 && code !== 1 && !matchLimitReached && !matches) {
        throw new Error(stderr.trim() || `ripgrep exited with code ${code}`);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    let text = out.trimEnd();
    if (!text)
      return {
        content: [{ type: "text", text: "No matches found" }],
        details: undefined,
      };
    if (text.length > GREP_OUTPUT_CAP) {
      text = `${text.slice(0, GREP_OUTPUT_CAP)}\n\n[Truncated: 50KB limit reached]`;
    }
    if (matchLimitReached) {
      text += `\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]`;
    }
    return { content: [{ type: "text", text }], details: undefined };
  };
}

// ── Custom bash tool (the env-hygiene invariant) ─────────────────────────────

const BASH_OUTPUT_CAP = 40_000;
const BASH_DEFAULT_TIMEOUT_S = 120;
const BASH_MAX_TIMEOUT_S = 600;

/** A non-sensitive command shape for audit events. Command text never belongs
 * in the audit log: it commonly contains bearer tokens, customer data, and
 * shell-expanded credentials. The hash still joins a start to its finish and
 * lets an authorized investigator correlate a command with its source. */
export interface PiBashAuditEvent {
  phase: "start" | "finish";
  command_sha256: string;
  command_bytes: number;
  command_kind: string;
  sleep_calls?: number;
  sleep_seconds?: number;
  timeout_s: number;
  duration_ms?: number;
  exit_code?: number | null;
  timed_out?: boolean;
  cancelled?: boolean;
  outcome?: "ok" | "failed" | "timed_out" | "cancelled";
}

const AUDITED_COMMAND_KINDS = new Set([
  "bun",
  "cat",
  "cd",
  "curl",
  "echo",
  "find",
  "git",
  "gh",
  "ls",
  "printf",
  "rg",
  "sed",
  "sleep",
]);

/** Keep command observability useful without recording arguments or text. */
function summarizeBashAuditCommand(
  command: string,
): Omit<
  PiBashAuditEvent,
  | "phase"
  | "timeout_s"
  | "duration_ms"
  | "exit_code"
  | "timed_out"
  | "cancelled"
  | "outcome"
> {
  const firstWord = command
    .trim()
    .match(/^(?:[A-Za-z_]\w*=[^\s]+\s+)*([A-Za-z][\w.-]*)/)?.[1];
  const commandKind =
    firstWord && AUDITED_COMMAND_KINDS.has(firstWord) ? firstWord : "shell";
  let sleepCalls = 0;
  let sleepSeconds = 0;
  for (const match of command.matchAll(
    /(?:^|[;&|]\s*|\n\s*)sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=\s|[;&|]|$)/g,
  )) {
    sleepCalls++;
    const factor = { s: 1, m: 60, h: 3_600, d: 86_400 }[match[2] || "s"] ?? 1;
    sleepSeconds += Number(match[1]) * factor;
  }
  return {
    command_sha256: createHash("sha256").update(command).digest("hex"),
    command_bytes: new TextEncoder().encode(command).byteLength,
    command_kind: commandKind,
    ...(sleepCalls > 0
      ? { sleep_calls: sleepCalls, sleep_seconds: sleepSeconds }
      : {}),
  };
}

export function piBashHomeEnv(input: {
  runKey: string;
  scratchDir?: string;
  isolated: boolean;
  hostHome?: string;
}): Record<string, string> {
  if (!input.isolated) return input.hostHome ? { HOME: input.hostHome } : {};
  const home = `${input.scratchDir || "/tmp"}/automation-home-${input.runKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return {
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    AWS_CONFIG_FILE: `${home}/.aws/config`,
    AWS_SHARED_CREDENTIALS_FILE: `${home}/.aws/credentials`,
    GH_CONFIG_DIR: `${home}/.config/gh`,
  };
}

/** The custom `bash` tool: same name/schema surface as pi's built-in (so the
 *  model needs no new habits) but execution is ours — Bun.spawn with the
 *  MINIMAL env only, never the server process env. `gated` additionally
 *  screens every command through the org command policy (unattended code
 *  mode), throwing the policy message on a block. Completion is EXIT-gated,
 *  not drain-gated: a backgrounded grandchild inheriting the stdout pipe
 *  (`bun run dev &`) must never hold the tool — and with it the whole agent
 *  loop, prompt(), and cancel — open forever, so after exit the drains get a
 *  short grace and are then cancelled. The command runs in its own process
 *  group (setsid) so timeout/abort can kill the whole tree, not just bash.
 *  Exported for the wedge-regression tests. */
export function makePiBashTool(input: {
  cwd: string;
  env: Record<string, string>;
  gated: boolean;
  /** Ask mode: every command must pass the read-only allowlist
   *  (askBashDenyReason over ASK_BASH_PERMISSIONS, runner-shared.ts). */
  askReadOnly?: boolean;
  unattended: boolean;
  sessionId?: string;
  runKind?: string;
  publicationPolicy?: PublicationPolicy;
  /** Immutable Open Session run cancellation. Kept separate from Pi's tool
   * signal because AgentSession.abort() can leave an active tool signal live. */
  runSignal?: AbortSignal;
  onAudit?: (event: PiBashAuditEvent) => void;
}): ToolDefinition<any, any, any> {
  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the session workspace. Output is merged stdout+stderr, " +
      `tail-truncated at ${BASH_OUTPUT_CAP} characters.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: {
          type: "number",
          description: `Timeout in seconds (default ${BASH_DEFAULT_TIMEOUT_S}, max ${BASH_MAX_TIMEOUT_S})`,
        },
      },
      required: ["command"],
    } as any,
    async execute(_toolCallId, params, signal, onUpdate) {
      const command = String((params as { command?: unknown })?.command ?? "");
      if (!command.trim()) throw new Error("Empty command");
      if (input.askReadOnly) {
        const reason = askBashDenyReason(command);
        if (reason) throw new Error(reason);
      }
      const publicationDenial = input.publicationPolicy
        ? publicationPolicyDenyReason(command, input.publicationPolicy)
        : undefined;
      if (publicationDenial) throw new Error(publicationDenial);
      if (input.gated) {
        const reply = bashAskPolicyReply(
          { permission: "bash", metadata: { command } },
          {
            unattended: input.unattended,
            gated: true,
            sessionId: input.sessionId,
            runKind: input.runKind,
          },
        );
        if (reply !== "once") {
          throw new Error(
            "This command was blocked by the org command policy for unattended runs. " +
              "Propose the exact command in your note or summary and let a human run it.",
          );
        }
      }
      const rawTimeout = Number((params as { timeout?: unknown })?.timeout);
      const timeoutS =
        Number.isFinite(rawTimeout) && rawTimeout > 0
          ? Math.min(rawTimeout, BASH_MAX_TIMEOUT_S)
          : BASH_DEFAULT_TIMEOUT_S;

      const aborted = () =>
        Boolean(signal?.aborted || input.runSignal?.aborted);
      if (aborted()) throw new Error("Command aborted");
      const commandAudit = summarizeBashAuditCommand(command);
      const commandStartedAt = Date.now();
      input.onAudit?.({ phase: "start", ...commandAudit, timeout_s: timeoutS });
      // setsid makes bash a process-group leader, so kill(-pid) reaches the
      // grandchildren a plain proc.kill() misses (bash may already be gone
      // when the timeout fires). Absent setsid (macOS), degrade to the
      // direct-child kill.
      const setsidPath = Bun.which("setsid");
      const directCommand = setsidPath
        ? [setsidPath, "/bin/bash", "-c", command]
        : ["/bin/bash", "-c", command];
      const scoped = controlPlaneWorkloadCommand(
        directCommand,
        `opensession-agent-cmd-${crypto.randomUUID().slice(0, 13)}`,
        { env: input.env },
      );
      let timedOut = false;
      let exitCode: number | null = null;
      try {
        const proc = Bun.spawn(scoped.command, {
          cwd: input.cwd,
          env: scoped.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const killTree = () => {
          if (scoped.unit) stopUserScope(scoped.unit);
          const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
            try {
              if (!scoped.unit && setsidPath) process.kill(-proc.pid, sig);
              else proc.kill(sig);
            } catch {}
          };
          killGroup("SIGTERM");
          // Escalate for SIGTERM-ignorers; unref'd so a dead group never holds
          // the process (or this tool's return) open.
          const escalate = setTimeout(() => killGroup("SIGKILL"), 1_500);
          (escalate as unknown as { unref?: () => void }).unref?.();
        };

        let out = "";
        let droppedChars = 0;
        let lastUpdate = 0;
        const emitPartial = () => {
          const now = Date.now();
          if (now - lastUpdate < 250) return;
          lastUpdate = now;
          onUpdate?.({ content: [{ type: "text", text: out }], details: {} });
        };
        const append = (chunk: string) => {
          out += chunk;
          if (out.length > BASH_OUTPUT_CAP) {
            droppedChars += out.length - BASH_OUTPUT_CAP;
            out = out.slice(out.length - BASH_OUTPUT_CAP);
          }
          emitPartial();
        };
        const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
        const drain = async (stream: ReadableStream<Uint8Array> | null) => {
          if (!stream) return;
          const dec = new TextDecoder();
          const reader = stream.getReader();
          readers.push(reader);
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) append(dec.decode(value, { stream: true }));
            }
          } catch {
            // reader.cancel() below lands here — captured output stands.
          } finally {
            try {
              reader.releaseLock();
            } catch {}
          }
        };

        const timer = setTimeout(() => {
          timedOut = true;
          killTree();
        }, timeoutS * 1000);
        const onAbort = () => killTree();
        const abortSignals = [
          ...new Set(
            [signal, input.runSignal].filter(
              (candidate): candidate is AbortSignal => !!candidate,
            ),
          ),
        ];
        for (const abortSignal of abortSignals)
          abortSignal.addEventListener("abort", onAbort, { once: true });
        // addEventListener does not replay an abort that raced spawn/listener
        // installation, so close that window before awaiting process exit.
        if (aborted()) killTree();
        try {
          // Exit-gated completion: the drains alone can outlive bash forever
          // when a backgrounded child inherited the pipes, so wait for exit
          // first, then give the drains a short grace to flush and cut them.
          const drains = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
          exitCode = await proc.exited;
          await Promise.race([drains, Bun.sleep(250)]);
        } finally {
          clearTimeout(timer);
          for (const abortSignal of abortSignals)
            abortSignal.removeEventListener("abort", onAbort);
          for (const reader of readers) {
            // cancel() rejects (async) when the drain already released the
            // reader — swallow both the sync throw and the rejection.
            try {
              reader.cancel().catch(() => {});
            } catch {}
          }
        }

        const text =
          (droppedChars > 0
            ? `[output truncated: first ${droppedChars} characters dropped]\n`
            : "") + out;
        if (aborted()) throw new Error("Command aborted");
        if (timedOut)
          throw new Error(
            `${text}\nCommand timed out after ${timeoutS}s`.trim(),
          );
        if (exitCode !== 0)
          throw new Error(
            `${text}\nCommand exited with code ${exitCode}`.trim(),
          );
        return {
          content: [{ type: "text", text: text || "(no output)" }],
          details: { exitCode, truncatedChars: droppedChars || undefined },
        };
      } finally {
        const cancelled = Boolean(signal?.aborted || input.runSignal?.aborted);
        input.onAudit?.({
          phase: "finish",
          ...commandAudit,
          timeout_s: timeoutS,
          duration_ms: Date.now() - commandStartedAt,
          exit_code: exitCode,
          timed_out: timedOut,
          cancelled,
          outcome: cancelled
            ? "cancelled"
            : timedOut
              ? "timed_out"
              : exitCode === 0
                ? "ok"
                : "failed",
        });
      }
    },
  };
}

// ── The turn ─────────────────────────────────────────────────────────────────

const THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** State carried ACROSS the attempts of one logical pi turn. */
interface PiAccountWalk {
  /** Provider account ids this turn has already burned, fed into the picker
   *  so a replay lands somewhere new. The sideline alone cannot drive this:
   *  it is shared cross-engine with previous runner, and some refusals deliberately
   *  do not set it (local admission control that frees within the hour). */
  excluded: Set<string>;
  /** Set by an attempt that wants to be replayed on another account. */
  rotate: boolean;
  /** The first attempt's user-line uuid, reused by every replay so the
   *  transcript row upserts instead of duplicating the person's message. */
  promptEntryId?: string;
}

/** An init can repeat, and a live usage snapshot is replaced by the next
 * attempt. Everything else has user-visible or durable meaning and makes
 * replay unsafe. Exported so the in-band usage-limit regression stays pinned. */
export function piStreamEventBlocksAccountRotation(
  event: Pick<StreamEvent, "type">,
): boolean {
  return event.type !== "init" && event.type !== "usage_snapshot";
}

/**
 * One logical pi turn, across however many provider accounts it takes.
 *
 * This is previous runner-runner's account-rotation discipline, which pi lacked: a
 * usage limit ended the whole run while the rest of the pool sat idle, and
 * the sideline it recorded only helped the NEXT prompt. agent-runner cannot
 * rescue that either, because an explicit engine choice pins the model
 * fallback to "none" rather than silently crossing into an previous runner fallback,
 * so one capped account was simply the end of the turn.
 *
 * The anthropic side runs the same walk one level down, inside
 * pi-anthropic-provider's stream, because it picks its account per REQUEST.
 * pi/openai picks once at bind time (the seeded credential is built before
 * the SDK is even imported), so there is no per-request catch to rotate from
 * and the loop belongs here. Both sides share one contract: an exclusion set
 * threaded into the picker, rotation only while
 * nothing has streamed, and a strict pin that refuses rather than moving onto
 * an account the person did not choose.
 */
export async function* runPi(
  opts: RunAgentOpts,
  model: string,
): AsyncGenerator<StreamEvent> {
  const walk: PiAccountWalk = { excluded: new Set(), rotate: false };
  for (;;) {
    walk.rotate = false;
    yield* runPiAttempt(opts, model, walk);
    if (!walk.rotate) return;
  }
}

async function* runPiAttempt(
  opts: RunAgentOpts,
  model: string,
  walk: PiAccountWalk,
): AsyncGenerator<StreamEvent> {
  // Config gate first: the clearest refusal when the engine is off entirely.
  if (!piEngineEnabled()) {
    yield {
      type: "error",
      content:
        'The Pi engine is not enabled (~/.opensession-pi.json). Set {"enabled": true} there to turn it on.',
      provider: PROVIDER,
      model,
    };
    return;
  }
  const gateReason = piGateReason(opts);
  if (gateReason) {
    audit({
      msg: "pi_gate_denied",
      run_kind: opts.journal?.kind,
      session_id: opts.journal?.osSessionId,
      reason: gateReason,
    });
    yield { type: "error", content: gateReason, provider: PROVIDER, model };
    return;
  }
  // The routed id plus the session's stored id: a workspace preset's wiring
  // (enginePresetId oracle, pinned effort) survives only on the stored one.
  const resolved = resolvePiRoutedModel(model, opts.model);
  const parsed = resolved
    ? { providerID: resolved.providerID, modelID: resolved.modelID }
    : null;
  if (!parsed) {
    yield {
      type: "error",
      content:
        `Not a pi model id: "${model}" ` +
        "(expected pi/<provider>/<model>, pi/dial/<preset>, pi/orchestrator/<preset>, " +
        "or pi/workspace-preset/<workspace>/<preset>)",
      provider: PROVIDER,
      model,
    };
    return;
  }
  // The oracle this run's dial preset actually consults (same-bridge rule).
  const dialOracleAgent = resolved?.dial
    ? piDialOracleAgent(resolved.dial.oracleAgent, parsed.providerID)
    : undefined;
  const configuredProvider = modelProviders()[parsed.providerID];
  if (
    parsed.providerID !== "anthropic" &&
    parsed.providerID !== "openai" &&
    parsed.providerID !== XAI_OAUTH_PROVIDER &&
    !configuredProvider?.apiKey
  ) {
    yield {
      type: "error",
      content:
        `The Pi engine has no credentials for provider "${parsed.providerID}" ` +
        `(got "${model}"). Configure that model provider first.`,
      provider: PROVIDER,
      model,
    };
    return;
  }

  const { prompt, cwd, mode, mcpServers, confirmTools, journal, user, author } =
    opts;
  // `user` remains the exact prompt sender for MCP/GitHub policy and audit.
  // Provider accounts are different: synthetic continuation senders inherit
  // the interactive session owner's personal subscription.
  const accountUser = providerAccountUser(user, opts.mcpGrantUser);
  const isAsk = mode === "ask";
  const isScratch = mode === "scratch";

  // The start token is the immutable physical dispatch identity. Engine and
  // Open Session ids are reusable aliases, so they must never fence a delayed
  // cancel against a successor turn.
  const runKey =
    opts.startToken ||
    opts.sessionId ||
    journal?.osSessionId ||
    crypto.randomUUID();
  const registeredKeys = new Set<string>([runKey]);
  if (opts.sessionId) registeredKeys.add(opts.sessionId);
  if (journal?.osSessionId) registeredKeys.add(journal.osSessionId);
  if (opts.transcriptSessionId) registeredKeys.add(opts.transcriptSessionId);
  if ([...registeredKeys].some((key) => activeRuns.has(key))) {
    yield { type: "error", content: "Session is busy" };
    return;
  }
  const abort = new AbortController();
  const handle: PiRunHandle = { abort };
  for (const key of registeredKeys) activeRuns.set(key, handle);

  // The unified session id every transcript row keys on; kind-only loop runs
  // may pass transcriptSessionId instead (map-only, never journaled).
  const unifiedSessionId = journal?.osSessionId || opts.transcriptSessionId;

  const requestId = crypto.randomUUID();
  const started = Date.now();
  const auditBase = {
    msg: "pi_turn",
    request_id: requestId,
    run_key: runKey,
    session: journal?.osSessionId,
    run_kind: journal?.kind,
    resume: opts.sessionId,
    model,
    mode: mode || "code",
  };
  // First-call-wins run closer + finally backstop (the bridgeRunEnd pattern).
  let turnEnded = false;
  const endTurn = (fields: Record<string, unknown>) => {
    if (turnEnded) return;
    turnEnded = true;
    audit({
      ...auditBase,
      direction: "out",
      duration_ms: Date.now() - started,
      ...fields,
    });
  };

  let piSessionId: string | undefined;
  // Cumulative usage across every assistant request in this attempt. Keep it
  // outside the run body so failures and cancellations retain the work they
  // completed before their terminal path.
  const usageTotal: TurnUsage = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextTokens: 0,
  };
  let usageRequests = 0;
  let sawUsage = false;
  const usageAuditFields = () =>
    sawUsage
      ? {
          input_tokens: usageTotal.inputTokens,
          output_tokens: usageTotal.outputTokens,
          cache_read_input_tokens: usageTotal.cacheReadTokens,
          cache_creation_input_tokens: usageTotal.cacheCreationTokens,
          total_cost_usd: usageTotal.costUsd,
          steps: usageRequests,
        }
      : {};
  // Utility callers such as oneShot deliberately have no unified session.
  // They still use Pi's native JSONL while alive, but must not emit degraded
  // transcript writes or create a ghost Open Session transcript.
  const persistRunEntries = (entries: TranscriptEntry[]) => {
    if (unifiedSessionId) persistEntries(piSessionId, entries);
  };
  const appendRunLines = (lines: Record<string, unknown>[]) => {
    if (unifiedSessionId && piSessionId) piAppend(piSessionId, lines);
  };
  let reachedTerminal = false;
  let session: AgentSession | undefined;
  let mcpRuntime: McpRuntime | undefined;
  let mcpBridge: PiMcpBridge | undefined;
  let sawSettled = false;
  // Pool-backed providers only (pi/openai: Codex pool, pi/xai-oauth: SuperGrok
  // pool): the picked account — visible to the catch/terminal paths so the
  // account walk can rotate off it. Set as soon as the pick succeeds, BEFORE
  // the seed and refresh-window checks, because those two failures are exactly
  // the ones worth trying another account for.
  let pickedAccount: PoolAccountRef | undefined;
  // The same account, but only once it is genuinely serving this turn. The
  // SIDELINE keys on this rather than on the pick: markCodexExhausted benches
  // an account for hours, cross-engine, shared with previous runner, and a local
  // auth.json we could not read (or a token inside pi's refresh window) is a
  // fault of this box, not a verdict on the account's usage. Rotating off it
  // is right; benching it globally is not.
  let sidelineableAccount: PoolAccountRef | undefined;
  const sidelineAccount = (account: PoolAccountRef) => {
    if (account.pool === "openai")
      markCodexExhausted(account.id, parsed.modelID);
    else markXaiExhausted(account.id, parsed.modelID);
  };
  // Has the reader seen replay-unsafe output yet? A rotation replays the whole
  // attempt, so it may only run before model text or tool activity has escaped.
  // `usage_snapshot` does NOT close the walk: Pi emits a zero-token snapshot
  // with an in-band usage-limit terminal, and treating that bookkeeping event
  // as model output strands the rest of the account pool. (The Anthropic side's
  // equivalent gate is `partial.content.length === 0`.)
  let sawStreamedOutput = false;

  /** Another account in the same pool that could serve this turn, or
   *  undefined when the pool is dry. Both ChatGPT OAuth and standard OpenAI
   *  API-key accounts are executable. A STRICT pin never rotates: excluding
   *  the pinned id would make the picker skip its pin branch and widen into
   *  the pool, which is the one thing a hard pin exists to prevent. */
  const nextPoolAccount = (): PoolAccountRef | undefined => {
    if (!pickedAccount) return undefined;
    if (opts.accountStrict && opts.accountId) return undefined;
    const excluded = new Set([...walk.excluded, pickedAccount.id]);
    const affinity = opts.accountAffinityKey || journal?.osSessionId || cwd;
    if (pickedAccount.pool === "openai") {
      const next = pickOpenaiAccount(
        parsed.modelID,
        readModelProviderConfig()?.openaiAccounts,
        affinity,
        undefined,
        accountUser,
        opts.accountId,
        opts.accountStrict,
        excluded,
      );
      return "error" in next ? undefined : codexPoolRef(next);
    }
    const next = pickXaiAccount({
      model: parsed.modelID,
      sessionKey: affinity,
      user: accountUser,
      pinnedId: opts.accountId,
      strict: opts.accountStrict,
      restrictIds: readModelProviderConfig()?.xaiAccounts,
      exclude: excluded,
    });
    return "error" in next ? undefined : xaiPoolRef(next);
  };

  /** Take the rotation, or return false and let the caller surface the
   *  failure. Records the burn, audits the switch and closes this attempt's
   *  audit; runPi replays the attempt on the next account. */
  const takeAccountRotation = (errorText: string): boolean => {
    if (sawStreamedOutput || !pickedAccount) return false;
    const next = nextPoolAccount();
    if (!next) return false;
    console.warn(
      `[pi-runner] usage limit on ${pickedAccount.label} account "${pickedAccount.name}" ` +
        `(${parsed.modelID}): retrying this turn on "${next.name}"`,
    );
    audit({
      ...auditBase,
      direction: "out",
      kind: "account_switch",
      account: pickedAccount.masked,
      account_switch_to: next.masked,
    });
    walk.excluded.add(pickedAccount.id);
    walk.rotate = true;
    reachedTerminal = true;
    endTurn({ ok: false, pi_session_id: piSessionId, error: errorText });
    return true;
  };

  // Everything from here on runs inside the try: a throw anywhere after the
  // registry writes above must still deregister in the finally, or the
  // session would report busy until the next restart.
  try {
    // Durability before the engine exists (the previous runner two-stage): journal
    // the run with its original prompt — no engine id and NO serverKey, so a
    // death here re-runs from scratch and a restart mid-turn takes the
    // continuation re-prompt path (nothing in-process survives to reattach) —
    // and persist the user line under the unified id with a stable uuid.
    // A replay must reuse the FIRST attempt's uuid: the store upserts by id,
    // so a freshly minted one would show the person's message twice.
    const userLine = transcriptLineUser(
      prompt,
      opts.promptEntryId || walk.promptEntryId,
      undefined,
      opts.images,
    );
    walk.promptEntryId ??= String(userLine.uuid);
    if (journal?.osSessionId) {
      await journalSet(
        buildRunJournalRecord(opts, {
          runKey,
          osSessionId: journal.osSessionId,
          claudeSessionId: opts.sessionId || undefined,
          prompt,
          promptEntryId: String(userLine.uuid),
          cwd,
          mode,
          mcpServers,
          user,
          confirmTools,
          model,
          effort: opts.effort,
          fastMode: opts.fastMode,
          accountId: opts.accountId,
          accountStrict: opts.accountStrict,
          usageCredits: opts.usageCredits,
          kind: journal.kind,
        }),
      );
      await storeAppendUserLineEarly(journal.osSessionId, userLine, {
        required: true,
      });
    }

    const policy = runToolPolicy({
      deniedTools: opts.deniedTools,
      confirmTools,
      journalKind: journal?.kind,
    });
    // Command-policy gate: kind-based like previous runner (NOT policy.unattended) —
    // the trusted-human loops carry deniedTools but shouldn't trip the gate.
    const bashGated =
      isUnattendedKind(baseJournalKind(journal?.kind)) && !isAsk;
    const interactiveGithub =
      !policy.unattended &&
      INTERACTIVE_KINDS.has(baseJournalKind(journal?.kind));
    const githubUserLogin = interactiveGithub
      ? githubUserLoginForRun(user || author?.name)
      : null;
    // Only the dedicated GitHub code workflows may inject a service
    // credential into an unattended run. Other automations remain credential-
    // free even if a caller accidentally supplies githubEnv.
    const githubCodeRun =
      mode === "code" && baseJournalKind(journal?.kind).startsWith("github-");
    const githubEnv = githubCodeRun
      ? opts.githubEnv?.GH_TOKEN
        ? opts.githubEnv
        : await githubCodeRunEnv(cwd)
      : interactiveGithub
        ? githubRunEnv(user || author?.name)
        : {};

    const binding = await createPiRuntimeBinding({
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      configuredProvider,
      affinityKey: opts.accountAffinityKey || journal?.osSessionId || cwd,
      unifiedSessionId: unifiedSessionId || runKey,
      accountUser,
      accountId: opts.accountId,
      accountStrict: opts.accountStrict,
      usageCredits: opts.usageCredits,
      excludedOpenaiAccountIds: walk.excluded,
      onAccountEvidence: (evidence) => {
        pickedAccount = evidence.pickedOpenai
          ? codexPoolRef(evidence.pickedOpenai)
          : evidence.pickedXai
            ? xaiPoolRef(evidence.pickedXai)
            : undefined;
        sidelineableAccount = evidence.sidelineableOpenai
          ? codexPoolRef(evidence.sidelineableOpenai)
          : evidence.sidelineableXai
            ? xaiPoolRef(evidence.sidelineableXai)
            : undefined;
      },
      beforeRuntimeLoad: (evidence) => {
        const picked = evidence.pickedOpenai
          ? codexPoolRef(evidence.pickedOpenai)
          : evidence.pickedXai
            ? xaiPoolRef(evidence.pickedXai)
            : undefined;
        audit({
          ...auditBase,
          direction: "in",
          ...(picked
            ? {
                account: picked.masked,
                account_id: picked.id.slice(0, 8),
                pick_reason:
                  evidence.openaiPickReason ?? evidence.xaiPickReason,
              }
            : {}),
          ...(policy.unattended
            ? { denied_tools: policy.noteGroups.flatMap((grp) => grp.tools) }
            : {}),
          ...summarizeText(prompt),
        });
      },
      dependencies: {
        readOpenaiAccounts: () => readModelProviderConfig()?.openaiAccounts,
        readXaiAccounts: () => readModelProviderConfig()?.xaiAccounts,
        pickOpenaiAccount,
        buildSeededOpenaiAuth,
        anthropicTransport: piAnthropicTransport,
        buildAnthropicProvider: buildPiAnthropicProvider,
        ensureAnthropicBridge,
        buildThirdPartyProviderPlan: buildPiThirdPartyProviderPlan,
        bindXaiAccount,
      },
    });
    const { sdk, runtime, model: piModel } = binding;

    // Optional pool credentials for tools the run itself spawns (currently
    // deepsec's Claude Agent SDK and Codex CLI workers). These are explicit
    // additions to the minimal environment, never inherited server secrets.
    const cliEnv: Record<string, string> = {};
    if (opts.claudeCliEnv) {
      const cliAccount = pickClaudeAccount(
        undefined,
        accountUser,
        undefined,
        opts.usageCredits,
      );
      if (cliAccount) {
        const cliCfgDir = `${PI_STATE_DIR}/cli/claude/${cliAccount.id}`;
        mkdirSync(cliCfgDir, { recursive: true, mode: 0o700 });
        cliEnv.CLAUDE_CODE_OAUTH_TOKEN = cliAccount.token;
        cliEnv.CLAUDE_CONFIG_DIR = cliCfgDir;
        audit({
          msg: "claude_cli_env_account",
          run_kind: journal?.kind,
          session_id: journal?.osSessionId,
          account: cliAccount.name,
          account_id: cliAccount.id.slice(0, 8),
          engine: "pi",
        });
      } else {
        console.warn(
          "[pi-runner] claudeCliEnv requested but no usable Claude account in the pool; run proceeds without it",
        );
      }
    }
    if (opts.codexCliEnv) {
      const cfg = readModelProviderConfig();
      const picked = pickOpenaiAccount(
        "",
        cfg?.openaiAccounts,
        journal?.osSessionId || runKey,
        undefined,
        accountUser,
      );
      if ("error" in picked) {
        console.warn(
          `[pi-runner] codexCliEnv requested but no usable Codex account (${picked.error}); run proceeds without it`,
        );
      } else {
        Object.assign(
          cliEnv,
          picked.kind === "home"
            ? { CODEX_HOME: picked.value }
            : { OPENAI_API_KEY: picked.value },
        );
        audit({
          msg: "codex_cli_env_account",
          run_kind: journal?.kind,
          session_id: journal?.osSessionId,
          account: picked.name,
          account_id: picked.id.slice(0, 8),
          engine: "pi",
        });
      }
    }

    // Minimal bash env, the security invariant this engine hangs on. The
    // server env is NEVER inherited; every entry is explicit.
    const awsEnv = opts.aws ? await ensureAgentAwsCredsFile() : {};
    const homeEnv = piBashHomeEnv({
      runKey,
      scratchDir: opts.scratchDir,
      isolated: Boolean(opts.publicationPolicy),
      hostHome: process.env.HOME,
    });
    if (opts.publicationPolicy && homeEnv.HOME)
      mkdirSync(homeEnv.HOME, { recursive: true, mode: 0o700 });
    const bashEnv: Record<string, string> = {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...homeEnv,
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      // Session-scoped scratch (session-scratch.ts): temp files follow the
      // session's lifecycle instead of accumulating in shared /tmp.
      ...(opts.scratchDir
        ? { TMPDIR: opts.scratchDir, OPENSESSION_SCRATCH: opts.scratchDir }
        : {}),
      ...gitIdentityEnv(author),
      ...githubEnv,
      ...awsEnv,
      ...cliEnv,
    };

    // One engine-neutral MCP runtime owns all connections for this logical
    // turn. Pi only adapts its exact catalog into mcp_search/mcp_call. The
    // detached runner-host proxy shape remains solely at this named migration
    // boundary until Agent operation routing replaces it.
    const mcpMounts = splitMcpMigrationBoundary(opts.inProcessMcp);
    mcpRuntime = await createMcpRuntime({
      mcpServers,
      user,
      mcpGrantUser: opts.mcpGrantUser,
      deniedToolIds: new Set(Object.keys(policy.disables)),
      inProcessMcp: mcpMounts.sdk,
      legacyProxyMcp: mcpMounts.legacyProxy,
      onAudit: (e) =>
        audit({
          msg: "pi_mcp_call",
          request_id: requestId,
          session: journal?.osSessionId,
          server: e.server,
          tool: e.tool,
          ok: e.ok,
          ms: e.ms,
        }),
    });
    mcpBridge = await createPiMcpBridge(mcpRuntime);
    // Tool policy: ask mode is read-only — no edit/write, and bash screened
    // through ASK_BASH_PERMISSIONS (askBashDenyReason), the same allowlist
    // previous runner's ask agent enforces engine-side. Shipping ask without bash at
    // all was tried first and it blinded every automation that assumed a
    // shell for jq/git/gh reads (the health-monitor incident, 2026-08-19).
    // Code/scratch get the read set + edit/write + the ungated custom bash.
    // disableLocalWorkspaceTools (engine-outside-sandbox) strips all local
    // tools — pi has no sandbox mode, but fail closed if a caller passes it.
    const localTools = opts.disableLocalWorkspaceTools
      ? []
      : isAsk
        ? ["read", "grep", "find", "ls", "bash"]
        : ["read", "grep", "find", "ls", "edit", "write", "bash"];
    // Every enabled name is derived from a custom definition below. Pi falls
    // back to its in-process built-ins for a name without an override, so a
    // separately maintained enabled-name list would be a containment escape.
    const guardedOps = makeGuardedToolOps(cwd);
    let steeringBoundaryPending = false;
    const baseCustomTools: ToolDefinition<any, any, any>[] = [
      ...mcpBridge.discoveryTools,
      ...(dialOracleAgent ? [makePiDialOracleTool(dialOracleAgent, user)] : []),
    ];
    for (const name of localTools) {
      switch (name) {
        case "read":
          baseCustomTools.push(
            sdk.createReadToolDefinition(cwd, {
              operations: guardedOps.read,
            }) as ToolDefinition<any, any, any>,
          );
          break;
        case "grep": {
          const base = sdk.createGrepToolDefinition(cwd);
          baseCustomTools.push({
            ...base,
            execute: makeGuardedGrepExecute(cwd, bashEnv, guardedOps.guard),
          } as ToolDefinition<any, any, any>);
          break;
        }
        case "find":
          baseCustomTools.push(
            sdk.createFindToolDefinition(cwd, {
              operations: guardedOps.find,
            }) as ToolDefinition<any, any, any>,
          );
          break;
        case "ls":
          baseCustomTools.push(
            sdk.createLsToolDefinition(cwd, {
              operations: guardedOps.ls,
            }) as ToolDefinition<any, any, any>,
          );
          break;
        case "edit":
          baseCustomTools.push(
            sdk.createEditToolDefinition(cwd, {
              operations: guardedOps.edit,
            }) as ToolDefinition<any, any, any>,
          );
          break;
        case "write":
          baseCustomTools.push(
            sdk.createWriteToolDefinition(cwd, {
              operations: guardedOps.write,
            }) as ToolDefinition<any, any, any>,
          );
          break;
        case "bash":
          baseCustomTools.push(
            makePiBashTool({
              cwd,
              env: bashEnv,
              gated: bashGated,
              askReadOnly: isAsk,
              unattended: policy.unattended,
              sessionId: journal?.osSessionId,
              runKind: journal?.kind,
              publicationPolicy: opts.publicationPolicy,
              runSignal: abort.signal,
              onAudit: (event) =>
                audit({
                  msg: `pi_command_${event.phase}`,
                  request_id: requestId,
                  run_key: runKey,
                  session_id: journal?.osSessionId,
                  run_kind: journal?.kind,
                  model,
                  ...event,
                }),
            }),
          );
          break;
      }
    }
    const customTools = piSteeringBoundaryTools(
      baseCustomTools,
      () => steeringBoundaryPending,
    );

    // The repo owning this run's cwd, or undefined for a repo-less one (a
    // scratch dir, a repo-less ask session). Dynamic import to avoid a static
    // module-init cycle through "./worktree".
    const cwdRepo = await (async () => {
      try {
        return (await import("./worktree")).repoForPathOrNull(cwd);
      } catch {
        return undefined;
      }
    })();
    const instructions = buildRunInstructions({
      isAsk,
      isScratch,
      isRepoLess: !cwdRepo,
      reposNote: opts.reposNote,
      prReviewer: opts.prReviewer,
      // Same host-awareness as the previous runner runner: code.storage repos get
      // push-the-branch instructions instead of `gh pr create`.
      repoHost: isScratch ? undefined : cwdRepo?.host,
      localInstructions: readLocalInstructions(cwd),
      inProcessMcp: opts.inProcessMcp,
      hasSession: !!journal?.osSessionId,
      dialOracle:
        resolved?.dial && dialOracleAgent
          ? {
              agent: "oracle",
              // A workspace preset that restated a built-in tier keeps its
              // own label — that is the name the person picked.
              presetLabel:
                resolved.workspacePreset?.label || resolved.dial.label,
              mainLabel: parsed.modelID,
              oracleLabel:
                DIAL_ORACLE_AGENTS[dialOracleAgent]?.label || dialOracleAgent,
              tool: true,
            }
          : undefined,
      // Named only when the run actually carries the delegation surface
      // (opensession-sessions rides inProcessMcp on interactive runs) —
      // instructions naming a tool the run does not have read as a broken
      // tool (the codex-direct rule). An orchestrator preset without it
      // still keeps its effort override.
      orchestrator:
        resolved?.orchestrator && opts.inProcessMcp?.["opensession-sessions"]
          ? {
              presetLabel:
                resolved.workspacePreset?.label || resolved.orchestrator.label,
              mainLabel: piModelLabel(resolved.orchestrator.model),
              workers: resolved.orchestrator.workerAgents.flatMap((name) => {
                const worker = orchestratorWorkerForBridge(
                  name,
                  parsed.providerID,
                );
                return worker
                  ? [
                      {
                        role: ORCHESTRATOR_WORKER_AGENTS[name]?.label || name,
                        model: toPiModel(worker.model) || worker.model,
                        modelLabel: worker.label,
                      },
                    ]
                  : [];
              }),
            }
          : undefined,
    });

    // The resolution of the `tools` scope runOnModel already logged: what
    // this engine actually put in front of the model. Pi assembles its tool
    // list in-process rather than declaring it in an engine config, so this
    // record is the only account of it (previous runner's equivalent can be read
    // back from its config file). Recorded once per session, then again only
    // when the content hash moves.
    await logStandingJson({
      sessionId: unifiedSessionId,
      turnId: opts.promptEntryId || opts.startToken,
      source: "mcp-servers",
      value: {
        engine: "pi",
        // Same contract as the choke point's: a non-array scope reads as
        // "all" and must never be spread.
        mcpScope: Array.isArray(mcpServers)
          ? [...mcpServers].sort()
          : (mcpServers ?? "all"),
        inProcess: Object.keys(opts.inProcessMcp || {}).sort(),
        // Post-policy catalog: denied ids are dropped before a definition is
        // ever built (pi-mcp-bridge), so these are the MCP tools the model
        // can actually reach through the two discovery tools.
        mcpTools: mcpBridge.tools.map((t) => t.name).sort(),
        discovery: mcpBridge.discoveryTools.map((t) => t.name).sort(),
        // Pi's local tools are enabled by name and every name is backed by a
        // guarded custom definition (see the enabled-name list above).
        local: [...localTools].sort(),
        strip: Object.keys(policy.disables).sort(),
        ...(dialOracleAgent ? { oracleTool: dialOracleAgent } : {}),
      },
    });
    await logStandingContext({
      sessionId: unifiedSessionId,
      turnId: opts.promptEntryId || opts.startToken,
      source: "instructions",
      content: instructions,
    });

    const agentDir = `${PI_STATE_DIR}/agent`;
    const sessionDir = `${PI_STATE_DIR}/sessions/${sanitizeId(unifiedSessionId || runKey)}`;
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    // Pi's `auto` transport tries the experimental ChatGPT WebSocket first.
    // A mid-response 1006 cannot safely fall back in-place after output has
    // streamed, so Pi has to replay the whole LLM step through its visible
    // auto-retry path. Start subscription-backed Codex turns on SSE instead:
    // it keeps the same session prompt-cache key without the fragile persistent
    // socket. Raw OpenAI API keys use Pi's ordinary provider and retain its
    // default transport selection.
    const settingsManager = sdk.SettingsManager.inMemory(
      binding.usesOpenaiOAuth ? { transport: "sse" } : {},
    );
    const workspaceRoot = resolve(cwd);
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      // Pi's own skill resolution stays off, like extensions and themes. A
      // turn loads the allowlist in skill-paths.ts: what this server ships,
      // plus the session checkout's own skills, never whatever the host
      // account has enabled. The paths are what make it non-empty. noSkills
      // with no additionalSkillPaths loaded nothing at all, which left every
      // shipped skill dead in the product.
      noSkills: true,
      additionalSkillPaths: skillSearchPaths(cwd),
      noPromptTemplates: true,
      noThemes: true,
      // Pi's context-file discovery walks every ancestor of cwd up to /
      // (plus the agentDir global) — an AGENTS.md dropped in /home/ubuntu
      // would silently join every pi system prompt on the box. Bound it to
      // the workspace: keep only cwd-level files (previous runner parity).
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: agentsFiles.filter((f) => {
          const p = resolve(f.path);
          return p === workspaceRoot || p.startsWith(workspaceRoot + sep);
        }),
      }),
      systemPromptOverride: (base) =>
        assembleRunSystemPrompt({ base, cwd, instructions }),
    });
    // What the system prompt leaves out so it stays byte-identical across
    // sessions (prompt-cache sharing): session link, requester, checkout path.
    const sessionContext = buildSessionContext({
      osSessionId: journal?.osSessionId,
      cwd,
      isAsk,
      isScratch,
      repoHost: isScratch ? undefined : cwdRepo?.host,
      user,
      author,
      githubUserLogin,
    });
    await loader.reload();

    // Resume: the journaled engine id is pi's session-header uuid — find its
    // jsonl in this unified session's dir. Not found (rotated dir, pruned
    // file) → fresh session; the store already holds the unified history and
    // Cross-engine handoff notes ride the prompt. A detached host also gets a
    // server-read seed snapshot for the resume-miss case because it must never
    // open transcripts.db itself.
    const resumePath = opts.sessionId
      ? findPiSessionFile(sessionDir, opts.sessionId)
      : null;
    // Resume-miss bridge: pi's SessionManager buffers a session's jsonl until
    // its first ASSISTANT message, so a turn that died before any assistant
    // output (bridge 429 pre-token, instant cancel) journaled a piSessionId
    // that has NO file. Same engine ⇒ run-session builds no handoff note, and
    // a silently-fresh session would drop the model's context while the store
    // still shows the turns. Bridge it from the store ourselves.
    let resumeMissNote: string | null = null;
    if (opts.sessionId && !resumePath && unifiedSessionId) {
      try {
        const tail = (
          transcriptForwarder()
            ? opts.seedTranscriptEntries || []
            : (await transcript.readTail(unifiedSessionId, 200)).entries
        )
          // This turn's own prompt was already early-persisted — the model
          // gets it as the actual prompt, not as history.
          .filter((e) => e.id !== String(userLine.uuid));
        if (tail.length) {
          resumeMissNote = buildEngineSwitchHandoffNote({
            fromModel: model,
            fromProvider: PROVIDER,
            toProvider: PROVIDER,
            sameEngineRestart: true,
            entries: tail,
            maxEntries: 200,
            maxChars: 60_000,
          });
        }
      } catch (e) {
        console.warn("[pi-runner] resume-miss handoff build failed:", e);
      }
    }
    const sessionManager = resumePath
      ? sdk.SessionManager.open(resumePath, sessionDir)
      : sdk.SessionManager.create(cwd, sessionDir);

    // Preset effort override (workspace preset's pin first, then the built-in
    // preset's) falls back to the session's own effort.
    const selectedEffort = resolved?.effort ?? opts.effort;
    const thinkingLevel =
      selectedEffort && THINKING_LEVELS.has(selectedEffort)
        ? (selectedEffort as "low" | "medium" | "high" | "xhigh" | "max")
        : undefined;

    const created = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model: piModel,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      tools: piToolNames(customTools),
      customTools,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    session = created.session;
    // Pi's provider supports `service_tier`, but its simple-stream adapter
    // drops that option before building the Codex request. Patch the final
    // payload instead. Restrict this to seeded ChatGPT OAuth credentials: API
    // key accounts use ordinary OpenAI billing and are not the subscription
    // fast mode exposed by the clients.
    if (opts.fastMode && binding.usesOpenaiOAuth) {
      enableOpenaiFastMode(session.agent);
    }
    // SuperGrok turns ride the cli-chat-proxy, which rejects several stock
    // Responses fields (xai-payload.ts). Same hook, no host extension.
    if (binding.usesXaiProxy) {
      enableXaiProxyPayload(session.agent, {
        modelId: parsed.modelID,
        sessionId: unifiedSessionId || runKey,
        reasoning: piModel.reasoning,
        effortCapable: xaiSubscriptionModelEfforts(parsed.modelID).length > 0,
      });
    }
    // The first complete provider input only exists after Pi has combined its
    // base prompt with Open Session instructions, AGENTS.md, skills and active
    // tool guidance. Record it once for the collapsed transcript-start audit
    // row. Later turns can change ambient memory, but this row deliberately
    // answers what preceded the session's initial message.
    if (!opts.sessionId) {
      const activeToolNames = new Set(session.getActiveToolNames());
      await logStandingContext({
        sessionId: unifiedSessionId,
        turnId: opts.promptEntryId || opts.startToken,
        source: "session-start",
        content: sessionStartContext(
          session.systemPrompt,
          customTools
            .filter((tool) => activeToolNames.has(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
        ),
      });
    }
    // previous runner appends every pending noReply steer before its next LLM step.
    // Match that behavior instead of Pi's one-message-per-step default.
    session.setSteeringMode("all");
    piSessionId = session.sessionId;

    // Map pi→unified BEFORE any engine-keyed append (the W1 import-first gate
    // resolves through this map; unmapped appends are dropped + degraded).
    if (unifiedSessionId)
      recordEngineSessionOwner(piSessionId, unifiedSessionId);

    // Journal upgrade: the record now carries the engine id (still no
    // serverKey — boot must take the continuation re-prompt path).
    if (journal?.osSessionId) {
      await journalSet(
        buildRunJournalRecord(opts, {
          runKey,
          osSessionId: journal.osSessionId,
          claudeSessionId: piSessionId,
          prompt,
          promptEntryId: String(userLine.uuid),
          cwd,
          mode,
          mcpServers,
          user,
          confirmTools,
          model,
          effort: opts.effort,
          fastMode: opts.fastMode,
          accountId: opts.accountId,
          accountStrict: opts.accountStrict,
          usageCredits: opts.usageCredits,
          kind: journal.kind,
        }),
      );
    }

    // Register the engine-id alias + the steer surface on the shared handle.
    if (!registeredKeys.has(piSessionId)) {
      registeredKeys.add(piSessionId);
      activeRuns.set(piSessionId, handle);
    }
    const liveSession = session;
    // Steer contract: accept = enqueue + receipt. The transcript user line is
    // written only when the queued message is actually DELIVERED (its user
    // message_end below) — session.steer() resolves at enqueue time, so a
    // .then() would confirm nothing, and an optimistically-persisted line
    // marks an undelivered steer as said (queue-state reconciles receipts
    // against transcript user texts, so it would never be requeued). An
    // undelivered steer keeps its run-session receipt as the recovery
    // affordance — previous runner's failed-POST semantics.
    const pendingSteers: Array<{
      text: string;
      images?: ImageInput[];
      steerId?: string;
    }> = [];
    handle.steer = (text, images, steerId) => {
      // Same skill expansion as the prompt path. The queue holds the expanded
      // text so the delivery match stays exact; the audit line below still
      // records what the person typed.
      const steerText = expandSkillCommand(text, loader.getSkills().skills);
      steeringBoundaryPending = true;
      pendingSteers.push({ text: steerText, images, steerId });
      void liveSession.steer(steerText, piImages(images)).catch((e) => {
        console.warn("[pi-runner] steer failed:", e);
      });
      audit({
        ...auditBase,
        direction: "in",
        kind: "steer_queued",
        ...summarizeText(text),
      });
    };
    handle.retractSteer = (steerId) =>
      retractPendingSteer(pendingSteers, steerId, (remaining) => {
        // Pi exposes exact delivery identity only in our wrapper. Rebuild its
        // whole queue from our richer copy so duplicate text and images keep
        // their original order while the selected id disappears.
        steeringBoundaryPending = remaining.length > 0;
        liveSession.clearQueue();
        for (const steer of remaining) {
          void liveSession
            .steer(steer.text, piImages(steer.images))
            .catch((e) => {
              console.warn("[pi-runner] steer replay failed:", e);
            });
        }
        audit({
          ...auditBase,
          direction: "in",
          kind: "steer_retracted",
          steer_id: steerId,
        });
      });

    // Cancellation: our registry AbortController drives session.abort().
    const onAbort = () => {
      void liveSession.abort().catch(() => {});
    };
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener("abort", onAbort, { once: true });

    // ── Event pump: callback subscription → this generator's queue ──────────
    const queue: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (ev: StreamEvent) => {
      if (piStreamEventBlocksAccountRotation(ev)) sawStreamedOutput = true;
      queue.push(ev);
      const w = wake;
      wake = null;
      w?.();
    };

    push({ type: "init", sessionId: piSessionId, provider: PROVIDER, model });
    // Engine-keyed write of the turn's user line — same uuid as the early
    // store write, so the row upserts instead of duplicating the bubble.
    appendRunLines([userLine]);

    if (resumeMissNote) {
      const notice =
        "Pi couldn't resume the previous engine session. " +
        "Continuing in a fresh one with the recent transcript.";
      push({ type: "runner_notice", text: notice });
      persistRunEntries([
        {
          id: crypto.randomUUID(),
          type: "system",
          content: notice,
          timestamp: nowIso(),
        },
      ]);
    }
    // What the ENGINE receives; journal/store keep the raw prompt. Fenced the
    // way every other injection is (prompt-context.ts): the fence is what
    // makes the payload readable to the context log, and it keeps the note
    // from reading as something the human typed.
    // "/bro" (or "/skill:bro") becomes the skill's body before the engine sees
    // it. Expanded here rather than by pi for two reasons: a bare "/name"
    // works, which is what the composer's "/" menu inserts, and this text
    // stays identical to the user message pi echoes back, which the
    // steer-delivery check below compares against.
    const promptWithSkill = expandSkillCommand(
      prompt,
      loader.getSkills().skills,
    );
    const promptForEngine = [
      wrapContext(sessionContext, "session"),
      ...(resumeMissNote ? [wrapContext(resumeMissNote, "handoff")] : []),
      promptWithSkill,
    ].join("\n\n");
    // Injected BELOW runOnModel's choke point, so that call never saw this
    // payload — log it here, exactly as the previous runner runner does for its own
    // same-engine-restart handoff. Re-logging is free: entry ids are
    // content-derived, so an overlap upserts one row instead of duplicating.
    if (promptForEngine !== prompt) {
      logInjectedContext({
        sessionId: unifiedSessionId,
        turnId: opts.promptEntryId || opts.startToken,
        prompt: promptForEngine,
        model,
      });
    }

    // Final assistant outcome (stopReason error/aborted → terminal error).
    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;
    // Renderable content blocks (real text or tool calls) of the LATEST
    // assistant message; -1 = none seen yet. Providers occasionally return a
    // well-formed completion with ZERO content blocks and stopReason "stop"
    // (2026-08-21 os-01a02486: GLM-5.3's pre-release OpenRouter route ended a
    // 10-minute turn on content:[] with all-zero usage). pi settles that as a
    // clean turn, so the session goes idle with no summary and the user has
    // to ask "done?". The pump loop retries such finishes once.
    let lastAssistantRenderableBlocks = -1;

    // Content persistence rides message_end/compaction_end. entry_appended is
    // deliberately unhandled: in 0.83.0 it fires ONLY for extension custom
    // entries (dist agent-session.js emits it solely from the extension
    // runtime's appendEntry helper) — never for messages or compactions — and
    // this runner disables extensions, so a handler would be dead code that
    // could double-persist against these paths if a future SDK widened it.
    const unsubscribe = session.subscribe((ev: AgentSessionEvent) => {
      try {
        switch (ev.type) {
          case "message_update": {
            const ame = (ev as any).assistantMessageEvent;
            if (
              (ame?.type === "text_delta" || ame?.type === "thinking_delta") &&
              typeof ame.delta === "string"
            ) {
              // The live transcript has one prose stream. Thinking and ordinary
              // model output both ride it rather than leaving reasoning blank
              // until message_end persists the provider's separate blocks.
              push({ type: "text_chunk", text: ame.delta });
            }
            break;
          }
          case "tool_execution_start": {
            const t = ev as any;
            push({
              type: "tool_use",
              toolName: String(t.toolName || "tool"),
              toolInput: t.args ?? {},
              toolUseId: String(t.toolCallId),
            });
            break;
          }
          case "tool_execution_end": {
            const t = ev as any;
            const { text, images } = contentToTextAndImages(t.result?.content);
            // `content`, not `result`: stream consumers read event.content
            // (run-session's stream_tool_result). 500-char preview like
            // previous runner — the full text reaches the store via the toolResult
            // message_end below and upserts over the streamed copy.
            push({
              type: "tool_result",
              toolUseId: String(t.toolCallId),
              content: text.length > 500 ? `${text.slice(0, 500)}...` : text,
              ...(images.length ? { images } : {}),
            });
            break;
          }
          case "message_end": {
            const msg = (ev as any).message;
            if (!msg) break;
            const ts = new Date(
              typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
            ).toISOString();
            if (msg.role === "assistant") {
              lastStopReason = msg.stopReason;
              lastErrorMessage = msg.errorMessage;
              lastAssistantRenderableBlocks = assistantRenderableBlockCount(
                msg.content,
              );
              const u = msg.usage;
              if (u && typeof u.input === "number") {
                sawUsage = true;
                usageRequests++;
                usageTotal.inputTokens += u.input || 0;
                usageTotal.outputTokens += u.output || 0;
                usageTotal.cacheReadTokens += u.cacheRead || 0;
                usageTotal.cacheCreationTokens += u.cacheWrite || 0;
                usageTotal.costUsd =
                  (usageTotal.costUsd || 0) + (u.cost?.total || 0);
                usageTotal.contextTokens =
                  (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
                push({ type: "usage_snapshot", usage: { ...usageTotal } });
              }
              // Persist thinking, text, and tool calls now (messages have no
              // SDK id, while block ids are the model's and stay stable).
              // Error-stopped attempts are skipped: auto-retry replays them
              // and the terminal error carries the failure text — persisting
              // each attempt would stack duplicate partial bubbles. Aborted
              // partials DO persist (parity with pi's own jsonl).
              if (msg.stopReason !== "error") {
                persistRunEntries(
                  piAssistantTranscriptEntries(msg.content, ts, parsed.modelID),
                );
              }
            } else if (msg.role === "toolResult" && msg.toolCallId) {
              const { text, images } = contentToTextAndImages(msg.content);
              persistRunEntries([
                {
                  id: `${msg.toolCallId}-result`,
                  type: "tool_result",
                  content: text,
                  timestamp: ts,
                  toolUseId: String(msg.toolCallId),
                  ...(msg.isError ? { isError: true } : {}),
                  ...(images.length ? { images } : {}),
                },
              ]);
            } else if (msg.role === "user") {
              // A user message_end is the DELIVERY signal for a steer (the
              // agent loop emits message_start/end when it injects a queued
              // steering message; the turn's own prompt also lands here and
              // is skipped — it was persisted with its stable uuid up front).
              const { text, images } = contentToTextAndImages(msg.content);
              if (text && text !== promptForEngine && text !== prompt) {
                let idx = pendingSteers.findIndex((s) => s.text === text);
                // Skill/template expansion can rewrite a queued steer's text;
                // any user message that isn't the prompt is a delivery, so
                // fall back to the oldest pending steer but persist what was
                // actually delivered.
                if (idx === -1 && pendingSteers.length > 0) idx = 0;
                if (idx !== -1) {
                  const steer = pendingSteers.splice(idx, 1)[0];
                  steeringBoundaryPending = pendingSteers.length > 0;
                  // Transcript parsing deliberately strips fenced system
                  // context. A background-wait steer can therefore be fully
                  // delivered yet leave no visible user entry for receipt
                  // reconciliation. Acknowledge the exact queue id at the
                  // engine boundary instead of making UI state infer delivery
                  // from display-sanitized transcript text.
                  if (steer.steerId) {
                    push({ type: "steer_delivered", steerId: steer.steerId });
                  }
                  audit({
                    ...auditBase,
                    direction: "in",
                    kind: "steer_injected",
                    ...summarizeText(text),
                  });
                  const srcs = images.length
                    ? images
                    : (steer.images || []).map(
                        (im) => `data:${im.mediaType};base64,${im.data}`,
                      );
                  persistRunEntries([
                    {
                      // Steering admission already wrote the visible user row.
                      // Reuse its id so engine delivery upserts that bubble
                      // instead of appending a duplicate.
                      id: steer.steerId || crypto.randomUUID(),
                      type: "user",
                      content: text,
                      timestamp: ts,
                      ...(srcs.length ? { images: srcs } : {}),
                    },
                  ]);
                }
              }
            }
            break;
          }
          case "compaction_end": {
            const ce = ev as any;
            if (!ce.aborted && ce.result?.summary) {
              try {
                appendRunLines([
                  transcriptLineCompactionSummary(
                    String(ce.result.summary),
                    crypto.randomUUID(),
                    nowIso(),
                  ),
                ]);
              } catch {}
              // The summarization LLM call is billed like any other — fold it
              // so usage_snapshot/done don't under-report on exactly the most
              // expensive turns. contextTokens is left alone: it tracks live
              // conversation context and the next assistant message_end
              // re-derives it post-compaction.
              const cu = ce.result.usage;
              if (cu && typeof cu.input === "number") {
                sawUsage = true;
                usageRequests++;
                usageTotal.inputTokens += cu.input || 0;
                usageTotal.outputTokens += cu.output || 0;
                usageTotal.cacheReadTokens += cu.cacheRead || 0;
                usageTotal.cacheCreationTokens += cu.cacheWrite || 0;
                usageTotal.costUsd =
                  (usageTotal.costUsd || 0) + (cu.cost?.total || 0);
                push({ type: "usage_snapshot", usage: { ...usageTotal } });
              }
            }
            break;
          }
          case "auto_retry_start": {
            const r = ev as any;
            const errText = String(r.errorMessage || "");
            if (isPiUsageLimitShape(errText, parsed.providerID)) {
              // Usage-limit shapes mean the pool can't serve right now —
              // retrying only delays the fallback walk. abortRetry() cancels
              // the backoff sleep; the microtask matters: the SDK arms the
              // retry AbortController right AFTER emitting this event, so a
              // synchronous call would find nothing to abort.
              queueMicrotask(() => {
                try {
                  liveSession.abortRetry();
                } catch {}
              });
            } else {
              // Make the silent wait visible — pi retries transient provider
              // errors (3x, exponential from 2s) with no output in between.
              const notice = `pi auto-retry ${r.attempt}/${r.maxAttempts} in ${Math.round(
                (r.delayMs || 0) / 1000,
              )}s — ${errText.slice(0, 300)}`;
              push({ type: "runner_notice", text: notice });
              persistRunEntries([
                {
                  id: crypto.randomUUID(),
                  type: "system",
                  content: notice,
                  timestamp: nowIso(),
                },
              ]);
            }
            break;
          }
          case "agent_settled":
            sawSettled = true;
            break;
        }
      } catch (err) {
        console.warn("[pi-runner] event mapping failed:", err);
      }
    });

    // prompt() resolves after the full accepted run (steers + retries
    // included) — the authoritative end; pre-flight failures reject. A cancel
    // that landed before this point must not start the run at all —
    // session.abort() only stops a run already in flight.
    let promptOutcome: { ok: boolean; error?: unknown } | null = null;
    const settlePrompt = (outcome: { ok: boolean; error?: unknown }) => {
      promptOutcome = outcome;
      // Same tick as the outcome, BEFORE the pump wakes: steers accepted from
      // here on could only queue into a settling/soon-disposed session, so
      // steerPiRun must return false and let run-session queue them for the
      // next turn instead.
      handle.steer = undefined;
      const w = wake;
      wake = null;
      w?.();
    };
    if (abort.signal.aborted) {
      promptOutcome = { ok: true };
      handle.steer = undefined;
    } else {
      void session
        .prompt(promptForEngine, {
          images: piImages(opts.images),
          expandPromptTemplates: false,
        })
        .then(
          () => settlePrompt({ ok: true }),
          (e: unknown) => settlePrompt({ ok: false, error: e }),
        );
    }

    // Tail-race drain budget: a steer accepted between the agent loop's final
    // steering poll and settlePrompt sits in the in-memory queue that
    // dispose() would discard — while steerPiRun already returned true and
    // run-session dropped the message from its own queue. Drive it through a
    // real continuation run (the same agent.continue() the SDK uses for
    // agent_end-queued messages; the constructor-lifetime event subscription
    // keeps streaming/persisting) instead of losing it.
    let steerDrains = 0;
    // One bounded continuation for an empty final completion (see
    // lastAssistantRenderableBlocks). The nudge is fenced like every other
    // injection, so the transcript never shows it as a user bubble.
    let emptyFinishRetries = 0;
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (promptOutcome) {
        if (
          promptOutcome.ok &&
          !abort.signal.aborted &&
          liveSession.pendingMessageCount > 0 &&
          steerDrains < 2
        ) {
          steerDrains++;
          promptOutcome = null;
          void Promise.resolve()
            .then(() => liveSession.agent.continue())
            .then(
              () => settlePrompt({ ok: true }),
              (e: unknown) => settlePrompt({ ok: false, error: e }),
            );
          continue;
        }
        if (
          promptOutcome.ok &&
          !abort.signal.aborted &&
          emptyFinishRetries < 1 &&
          lastStopReason === "stop" &&
          lastAssistantRenderableBlocks === 0
        ) {
          emptyFinishRetries++;
          const notice =
            "Model returned an empty response — asking it once more to finish its reply";
          push({ type: "runner_notice", text: notice });
          promptOutcome = null;
          void session
            .prompt(wrapContext(EMPTY_REPLY_RETRY_PROMPT, "auto-continue"), {
              expandPromptTemplates: false,
            })
            .then(
              () => settlePrompt({ ok: true }),
              (e: unknown) => settlePrompt({ ok: false, error: e }),
            );
          continue;
        }
        break;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    while (queue.length) yield queue.shift()!;
    unsubscribe();
    if (pendingSteers.length > 0) {
      // Accepted but never delivered (drain budget exhausted or the run
      // failed): no transcript line was written, so on the failure paths the
      // receipt survives as the recovery affordance; on a done terminal the
      // loss is at least audited instead of silent.
      audit({
        ...auditBase,
        direction: "out",
        kind: "steer_undelivered",
        count: pendingSteers.length,
      });
    }

    // ── Terminal (at most one; user cancels end with none) ──────────────────
    const failed: { ok: boolean; error?: unknown } = promptOutcome!;
    if (
      failed.ok &&
      lastStopReason === "stop" &&
      lastAssistantRenderableBlocks === 0
    ) {
      // The retry (if it ran) also came back empty — never end silently on a
      // provider glitch; leave a visible chip explaining the missing reply.
      persistRunEntries([
        {
          id: crypto.randomUUID(),
          type: "system",
          content:
            "The model ended this turn with an empty response (no text or tool calls)" +
            (emptyFinishRetries > 0
              ? " and an automatic retry produced nothing too. Send another message to continue."
              : "."),
          timestamp: nowIso(),
        },
      ]);
    }
    if (abort.signal.aborted) {
      // User cancel ends QUIETLY — no terminal event, the generator just
      // returns (previous runner-runner's MessageAbortedError exemption). A terminal
      // error here would take run-session's full failure path: a persisted
      // "Run failed" chip, lastRunError/Needs-input state, and a parent
      // notified its worker FAILED because a human pressed Stop. The finally
      // records the cancelled audit closer and clears the journal; the
      // already-fired session.abort() stopped the engine.
      reachedTerminal = true;
      return;
    }
    // Usage-limit terminal on a pi/openai run: sideline the picked codex
    // account BEFORE yielding, so the fallback walk's next hop (and every
    // other engine's pick) skips it — shared sideline state with previous runner,
    // same per-(account, model) key.
    const sidelineOnUsageLimit = (usageLimit: boolean) => {
      if (usageLimit && sidelineableAccount) {
        sidelineAccount(sidelineableAccount);
      }
    };
    let terminal: StreamEvent;
    let terminalUsageLimit = false;
    if (!failed.ok) {
      const message = String((failed.error as Error)?.message || failed.error);
      const usageLimit = isPiUsageLimitShape(message, parsed.providerID);
      terminalUsageLimit = usageLimit;
      sidelineOnUsageLimit(usageLimit);
      terminal = {
        type: "error",
        content: `pi: ${message}`,
        provider: PROVIDER,
        model,
        ...(sawUsage ? { usage: { ...usageTotal } } : {}),
        ...(usageLimit ? { usageLimitExhausted: true } : {}),
      };
    } else if (lastStopReason === "error" || lastStopReason === "aborted") {
      const message =
        lastErrorMessage || `run ended with stopReason ${lastStopReason}`;
      const usageLimit = isPiUsageLimitShape(message, parsed.providerID);
      terminalUsageLimit = usageLimit;
      sidelineOnUsageLimit(usageLimit);
      terminal = {
        type: "error",
        content: `pi: ${message}`,
        provider: PROVIDER,
        model,
        ...(sawUsage ? { usage: { ...usageTotal } } : {}),
        ...(usageLimit ? { usageLimitExhausted: true } : {}),
      };
    } else {
      terminal = {
        type: "done",
        sessionId: piSessionId,
        result: session.getLastAssistantText() || undefined,
        provider: PROVIDER,
        model,
        ...(sawUsage ? { usage: { ...usageTotal } } : {}),
      };
    }
    // Rotate rather than end the turn. This is the COMMON half of the walk:
    // a provider usage limit normally arrives as an in-band terminal (pi's
    // own error result), not as a throw, so without this the openai walk
    // would only ever engage on pre-init failures. takeAccountRotation is a
    // no-op once anything has streamed, so a limit that lands mid-answer
    // still surfaces here instead of replaying what the reader already saw.
    if (terminalUsageLimit && takeAccountRotation(String(terminal.content))) {
      return;
    }
    reachedTerminal = true;
    endTurn({
      ok: terminal.type === "done",
      pi_session_id: piSessionId,
      saw_settled: sawSettled,
      ...usageAuditFields(),
      ...(terminal.type === "done" ? {} : { error: terminal.content }),
    });
    yield terminal;
  } catch (e: any) {
    if (abort.signal.aborted) {
      // A cancel that surfaced as a throw (abort mid-setup) is still a user
      // cancel — same quiet end as the terminal branch above.
      reachedTerminal = true;
      return;
    }
    const message: string = e?.message || String(e);
    // Honor the flag on pre-init throws (dry pool, expired seed): their
    // distinctive text never matches the classifier — previous runner-runner's
    // catch parity.
    const usageLimit =
      e?.usageLimitExhausted === true ||
      isPiUsageLimitShape(message, parsed.providerID);
    // Sideline ONLY on provider-attributed exhaustion (the explicit flag).
    // A classifier match alone is not enough here: this catch also sees
    // non-provider throws from the run body (fs, journal, SDK init), and a
    // stray shape in one of those must not sideline a healthy account for
    // 60 min across both engines. The in-band terminal branches (provider
    // messages only) keep classifier-driven sidelines.
    if (e?.usageLimitExhausted === true && sidelineableAccount) {
      sidelineAccount(sidelineableAccount);
    }
    // Rotate rather than end the turn. Gated on the explicit flag for the
    // same reason the sideline above is: this catch also sees non-provider
    // throws from the run body (fs, journal, SDK init), and a stray
    // usage-limit shape in one of those must not burn a healthy account.
    if (e?.usageLimitExhausted === true && takeAccountRotation(message)) return;
    reachedTerminal = true;
    endTurn({
      ok: false,
      pi_session_id: piSessionId,
      ...usageAuditFields(),
      error: message,
    });
    yield {
      type: "error",
      content: `pi: ${message}`,
      provider: PROVIDER,
      model,
      ...(sawUsage ? { usage: { ...usageTotal } } : {}),
      ...(usageLimit ? { usageLimitExhausted: true } : {}),
    };
  } finally {
    endTurn({
      ok: false,
      pi_session_id: piSessionId,
      ...usageAuditFields(),
      status: abort.signal.aborted ? "cancelled" : "abandoned",
    });
    // Consumer teardown without a terminal (hot-reload chaos, shutdown):
    // nothing survives a restart, so stop the orphaned in-process turn
    // instead of letting it burn tokens with no consumer.
    if (!reachedTerminal && session) {
      try {
        void session.abort();
      } catch {}
    }
    if (mcpRuntime) {
      try {
        await mcpRuntime.close();
      } catch {}
    }
    if (session) {
      try {
        session.dispose();
      } catch {}
    }
    for (const key of registeredKeys) {
      if (activeRuns.get(key) === handle) activeRuns.delete(key);
    }
    // Journal survives ONLY a mid-turn teardown (boot's continuation
    // re-prompt); a reached terminal or a user cancel clears it.
    if (journal?.osSessionId && (reachedTerminal || abort.signal.aborted)) {
      journalClear(runKey);
    }
  }
}

// ── Scripted smoke harness ───────────────────────────────────────────────────

/** Cheap + widest designated-account coverage on the bridge. */
const SMOKE_MODEL = "pi/anthropic/claude-sonnet-5";

export interface PiSmokeResult {
  /** True only for a real turn that reached `done` in time — or an explicit
   *  dryRun probe with the engine enabled. */
  ok: boolean;
  reason?: string;
  /** Throwaway unified session id (`os-test-pi-*`): never gets a session
   *  file, so it can't appear in the UI session list. */
  sessionId: string;
  text: string;
  usage?: TurnUsage;
  durationMs: number;
  enabled: boolean;
  dryRun: boolean;
  engineSessionId?: string;
  model: string;
  eventTypes: string[];
  error?: string;
  timedOut: boolean;
  /** transcript_events rows for the throwaway session after the turn — proves
   *  the store-write path end to end; 0 on dry runs. */
  storeRows: number;
}

/**
 * One tiny scripted turn against a throwaway `os-test-pi-*` session id
 * (mirrors runClaudeDirectSmokeTurn). Config-gated on piEngineEnabled() — with
 * the engine disabled this is a pure dry run: runPi yields its config-gate
 * error before touching the bridge or the SDK. The "pi-smoke" journal kind
 * passes the run gate only while the module-scoped bypass is armed here.
 * Never throws; real turns are wall-capped via cancelPiRun.
 */
export async function runPiSmokeTurn(
  opts: {
    dryRun?: boolean;
    timeoutMs?: number;
    prompt?: string;
    model?: string;
  } = {},
): Promise<PiSmokeResult> {
  const prompt = opts.prompt || "Reply with exactly the single word: ok";
  const timeoutMs = Math.max(
    5_000,
    Math.min(opts.timeoutMs ?? 120_000, 600_000),
  );
  // Optional model override so the smoke can exercise either provider path
  // (pi/anthropic via the bridge, pi/openai via the codex pool). A provided
  // id that doesn't parse is an explicit error, never a silent fallback —
  // an operator probing pi/openai must not read a default-model turn as
  // proof the openai path works.
  if (opts.model && !parsePiModel(opts.model)) {
    return {
      ok: false,
      enabled: piEngineEnabled(),
      dryRun: !!opts.dryRun,
      reason: `not a pi/<provider>/<model> id: ${opts.model}`,
      sessionId: "",
      model: opts.model,
      eventTypes: [],
      text: "",
      timedOut: false,
      durationMs: 0,
      storeRows: 0,
    };
  }
  const smokeModel = opts.model || SMOKE_MODEL;
  const enabled = piEngineEnabled();
  const sessionId = `os-test-pi-${Date.now().toString(36)}`;
  const started = Date.now();
  const storeRowsFor = async (id: string): Promise<number> => {
    try {
      return await transcript.getLastSeq(id);
    } catch {
      return 0;
    }
  };

  if (enabled && opts.dryRun) {
    return {
      ok: true,
      enabled,
      dryRun: true,
      reason:
        "dry run requested — engine is enabled but no turn was executed (no bridge, no SDK)",
      sessionId,
      model: smokeModel,
      eventTypes: [],
      text: "",
      timedOut: false,
      durationMs: Date.now() - started,
      storeRows: 0,
    };
  }

  const cwd = `${PI_STATE_DIR}/smoke`;
  if (enabled) {
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {}
  }
  const eventTypes: string[] = [];
  let text = "";
  let error: string | undefined;
  let usage: TurnUsage | undefined;
  let engineSessionId: string | undefined;
  let done = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancelPiRun(sessionId);
  }, timeoutMs);
  smokeGateBypass++;
  try {
    for await (const ev of runPi(
      {
        prompt,
        cwd,
        mode: "ask",
        mcpServers: [],
        journal: { osSessionId: sessionId, kind: "pi-smoke" },
      },
      smokeModel,
    )) {
      eventTypes.push(ev.type);
      if (ev.type === "init") engineSessionId = ev.sessionId;
      if (ev.type === "text_chunk") text += ev.text || "";
      if (ev.type === "error") error = ev.content;
      if (ev.type === "done") {
        usage = ev.usage;
        done = true;
      }
    }
  } catch (e) {
    // runPi yields errors rather than throwing; belt-and-braces so the admin
    // route can never blow up off this path.
    error = String((e as Error)?.message || e);
  } finally {
    smokeGateBypass--;
    clearTimeout(timer);
  }
  return {
    ok: done && !timedOut && !error,
    enabled,
    dryRun: !enabled,
    reason: !enabled
      ? "The Pi engine is disabled (~/.opensession-pi.json missing or enabled:false). The gate error below is the expected dry-run result; no bridge or SDK use happened"
      : timedOut
        ? `smoke turn exceeded the ${timeoutMs}ms wall cap and was cancelled`
        : undefined,
    sessionId,
    engineSessionId,
    model: smokeModel,
    eventTypes,
    text,
    error,
    usage,
    timedOut,
    durationMs: Date.now() - started,
    // Store rows prove the write path for REAL turns only; the disabled dry
    // path must not open the transcript store at all (a test/scratch process
    // would otherwise cold-open the live DB just to read a zero).
    storeRows: enabled ? await storeRowsFor(sessionId) : 0,
  };
}
