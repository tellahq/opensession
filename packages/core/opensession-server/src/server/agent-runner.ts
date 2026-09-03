/**
 * Agent runner dispatcher: one entry point for every model turn.
 * All production turns run on Pi. The dispatcher owns the fallback walk,
 * transcript handoffs, cancellation and restart recovery around Pi's shared
 * StreamEvent contract.
 */

import {
  journalClear,
  journalClearIfLineage,
  hasActiveRunFor,
  journalQuarantine,
  journalMarkRecoveryAttached,
  journalStartRecovery,
  activeRunRecords,
  takeInterruptedRuns,
  type ActiveRunRecord,
  type QuarantinedRun,
} from "./run-journal";
import {
  decideRunStateTransition,
  getRunState,
  isRunStateUnsettled,
  transitionRunState,
} from "./run-state";
import type { StreamEvent, ImageInput } from "./run-events";
import { isShuttingDown } from "./shutdown-state";
import { hasPendingOpening } from "./session-state-events";
import {
  sessionQuarantineSnapshot,
  sessionTurn,
  sessionTurnSnapshot,
} from "./session-kernel/kernel";
// Type-only, so the direct engines stay lazily loaded (see the dispatch table
// below): this pulls in the contract's signatures, never the SDKs.
// Static import is deliberate: the pi-runner module itself is cheap (the
// heavy @earendil-works SDK import stays dynamic inside it, prewarmed only
// when the engine is enabled), and the dispatchers below need its registry
// checks on every busy/steer/cancel call.
import {
  runPi,
  isPiSessionBusy,
  steerPiRun,
  retractPiSteer,
  cancelPiRun,
  activePiRunCount,
} from "./pi-runner";
import {
  providerFor,
  nextFallbackModel,
  modelLabel,
  routeModel,
  BEST_AVAILABLE_CODEX_MODEL,
  getDefaultModel,
  resolveConcreteModel,
  resolveModel,
  toPiModel,
} from "./models";
import { INTERACTIVE_KINDS, baseJournalKind } from "./run-policy";
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";
import {
  isProviderOverloadError,
  isTransientRunError,
  TOOL_RESULT_ENVELOPE_RE,
  type McpScope,
} from "./runner-shared";
import {
  hostRunBusy,
  hostSteer,
  hostRetractSteer,
  hostInterruptSteer,
  hostCancel,
  hostRunCount,
} from "./host-registry";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { personaName } from "./config";
import { wrapContext } from "./prompt-context";
import { logInjectedContext, logStandingJson } from "./context-log";
import {
  beginTurn,
  endTurn,
  isCheckedKind,
  observeToolCall,
  turnKeyFor,
} from "./turn-outcome";
import {
  readEngineHandoffTranscriptAsync,
  readEngineTranscriptAsync,
} from "./sessions";
import { ensureSessionScratch } from "./session-scratch";
import type { GitIdentity } from "./shared/user-mappings";
import type { TranscriptEntry } from "./types";
import { audit } from "./audit";

export type { StreamEvent };

export const EMPTY_COMPLETION_RESULT = "Done! (no text output)";

export interface RunAgentOpts {
  prompt: string;
  /** Engine session id to resume (claude session id or codex thread id). */
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code" | "scratch";
  /** Ephemeral GitHub capability for a narrowly scoped trusted GitHub code run.
   * Never persist this value in a host spec, journal, or session file. */
  githubEnv?: Record<string, string>;
  /** Session-scoped scratch dir (session-scratch.ts). runAgent ensures it for
   *  any run with an osSessionId; engines export it (pi sets TMPDIR +
   *  OPENSESSION_SCRATCH in the bash env) and the run instructions name it,
   *  so temporary files follow the session's lifecycle instead of piling up
   *  in shared /tmp. */
  scratchDir?: string;
  /** MCP OAuth identity override: the session CREATOR — shared sessions run
   *  MCP calls as their creator so teammates see the same objects (their own
   *  grant is the fallback, then the workspace grant). TODO(sandbox): the
   *  sandboxed-run path doesn't thread this yet. */
  mcpGrantUser?: string;
  /** Model id; decides the backend. Omitted = default Claude model. */
  model?: string;
  /** User-selected model retained while a transient fallback drives this turn. */
  selectedModel?: string;
  /** Internal recovery marker: the effective model is only a per-turn fallback. */
  transientFallback?: boolean;
  /** Pi reasoning variant for this run; unset = the model default. */
  effort?: string;
  /** Use OpenAI's priority service tier when this is a ChatGPT OAuth Codex run. */
  fastMode?: boolean;
  /**
   * External MCP servers this run may mount. REQUIRED and with no implicit
   * default: pass an allowlist, `[]` for none, or `"all"` to mount every
   * configured connector — a wide grant a reviewer can see in the diff. See
   * McpScope for why "just omit it" is no longer an option.
   */
  mcpServers: McpScope;
  /**
   * In-process SDK MCP servers (opensession-sessions / opensession-admin) for trusted
   * interactive runs only — never automations. Claude receives them directly;
   * Codex receives stdio proxy configs that forward to the same in-process
   * servers through Open Session's run RPC socket.
   */
  inProcessMcp?: Record<string, unknown>;
  /**
   * The model loop is running outside its coding sandbox. Strip Pi's
   * built-in local bash/read/write/edit/search tools so the run can only touch
   * the workspace through the session-scoped remote-workspace MCP server.
   */
  disableLocalWorkspaceTools?: boolean;
  /**
   * System-prompt note describing the session's repos (primary + attached) and
   * their worktree paths, so the agent works in the right isolated checkout for
   * cross-repo sessions. Claude receives it as system context; Codex via the
   * developer_instructions config channel.
   */
  reposNote?: string;
  /**
   * Reviewer to request on PRs this run opens (GitHub login, `org/team` slug,
   * or a comma-separated list). Set from the owning automation's `prReviewer`
   * — unattended PRs otherwise land with no reviewer and never surface in
   * anyone's review queue. Preserved across model fallback and restart resume.
   */
  prReviewer?: string;
  /** Images attached to the opening message. */
  images?: ImageInput[];
  /**
   * Stable uuid for the prompt's user transcript line. Callers that persist
   * the user line at intake pass it so the runner's own transcript write
   * upserts the same entry. When omitted, runAgent derives it from the stable
   * run token so every model attempt still writes one user bubble.
   */
  promptEntryId?: string;
  /**
   * Prior-engine transcript entries accompanying a cross-engine handoff (the
   * same entries the handoff note was built from). The pi runner seeds a
   * freshly-created session's persisted transcript file with them, so the UI
   * transcript stays continuous across the engine switch. Other runners ignore
   * this (their engines own their transcript files).
   */
  seedTranscriptEntries?: TranscriptEntry[];
  /** Fork the resumed session into a new id (optionally from `resumeSessionAt`). Claude only. */
  forkSession?: boolean;
  resumeSessionAt?: string;
  deniedTools?: Record<string, string>;
  /** Server-enforced publication boundary for automation descendants. */
  publicationPolicy?: { repo: string; branch: string; headBranch: string };
  confirmTools?: Record<string, string>;
  aws?: boolean;
  /**
   * Provision the run's env with a Claude-CLI credential from the
   * claude-accounts pool (CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_CONFIG_DIR), so
   * tooling the agent itself spawns — deepsec's `--agent claude` Agent-SDK
   * subprocess — runs on Open Session's account pool instead of the host
   * CLI's own login (which scans must never depend on; it logged out
   * 2026-08-08 and every scan silently analyzed zero batches). Set by
   * security scans and pool-cli-flagged automations only; pi engine,
   * per-session servers only (a meridian-backed run already carries the
   * same-class token and wins).
   */
  claudeCliEnv?: boolean;
  /**
   * Codex sibling of claudeCliEnv: point the run's env at a codex-accounts
   * pool credential (CODEX_HOME for ChatGPT-subscription accounts,
   * OPENAI_API_KEY for api-key ones) so run-spawned tooling — deepsec's
   * `--agent codex` — runs on the ChatGPT pool. Same trust gate and
   * per-session-server containment as claudeCliEnv; the two flags are
   * independent so a caller grants only the pools its tooling uses.
   */
  codexCliEnv?: boolean;
  /** Git identity for commits this run makes, attributing them to the prompt's author. */
  author?: GitIdentity | null;
  /**
   * The run's user (prompt author / UI user). Gates per-user MCP servers
   * (mcp-config.json `allowedUsers`) — e.g. a server restricted to specific teammates.
   * Omitted = anonymous, which sees only unrestricted servers.
   */
  user?: string;
  /**
   * Model to switch to when the primary model dies on usage limits with no
   * account left in its pool (claude-runner/codex-runner rotate their own
   * account pools first — this fires only once a whole pool is exhausted).
   * Cross-provider fallback starts a fresh native engine session. The previous
   * engine's internal history cannot carry over, so the runner injects a recent
   * transcript handoff when one is available; cwd/worktree state carries over.
   */
  fallbackModel?: string;
  /** Stable provider-account affinity for internal fan-out workers. Distinct
   * workers should use distinct keys while retries of one worker reuse it. */
  accountAffinityKey?: string;
  /**
   * Pinned account in the active model provider's Claude or Codex pool. The
   * provider runner prefers it and falls back to the pool on exhaustion.
   * Journaled for resume.
   */
  accountId?: string;
  /**
   * Hard accountId pin (automation cost cap): the run only ever uses that
   * account — an exhausted pin kills the run with usageLimitExhausted so the
   * fallback-model chain takes over instead of the shared pool.
   */
  accountStrict?: boolean;
  /**
   * Allow runs to keep going on accounts billing usage-credits past their
   * subscription limits (extra usage enabled with credit headroom). Off =
   * never intentionally spend paid credits. Claude only.
   */
  usageCredits?: boolean;
  journal?: {
    osSessionId?: string;
    kind?: string;
    firstJournaledAt?: string;
    resumeAttempts?: number;
    lastResumeAt?: string;
  };
  /** Exact admission reservation for a UI-created turn. Internal only: Stop
   * latches this token, so a replacement prompt cannot revive the old turn. */
  startToken?: string;
  /** Run-lifetime cancellation predicate threaded through engine retries. */
  shouldCancel?: () => boolean;
  /**
   * Unified session id (e.g. `linear-<branch>`) for the transcript-v2 oc→
   * unified map ONLY (pi-transcript.ts recordEngineSessionOwner) — lets loop
   * runs whose journal is deliberately kind-only (no crash journal; the loop
   * re-drives its own turns) still key their store appends on their unified
   * session. Never journaled, never used for resume/run-state/MCP identity —
   * runs that journal a osSessionId don't need this (it wins when both are
   * set, since they must agree anyway).
   */
  transcriptSessionId?: string;
  onAskUser?: (
    input: Record<string, unknown>,
  ) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  >;
}

/** The engine call signature runOnModel dispatches to — what a test fake
 *  must implement (the INNER contract: emit init → chunks/tools → one
 *  terminal done/error; runAgent's fallback walk wraps it). */
export type EngineRunner = (
  opts: RunAgentOpts,
  model: string,
) => AsyncGenerator<StreamEvent>;

// Test seam: lets a deterministic fake engine stand in for Pi so the
// consumer stack (runAgent's fallback walk, runSessionPrompt's event loop,
// queue drain, run-state transitions) is testable without spending model
// tokens or touching a live engine. Never set outside tests — parked on a
// plain module local, NOT globalThis, so a hot reload always clears it.
let engineForTest: EngineRunner | null = null;
export function __setEngineForTest(fn: EngineRunner | null): void {
  engineForTest = fn;
}

type LocalHostResume = (
  run: ActiveRunRecord,
  callbacks: { onAskUser?: RunAgentOpts["onAskUser"] },
) => Promise<AsyncGenerator<StreamEvent> | "uncertain" | null>;

/** Test seam for the local detached-host half of restart recovery. */
let localHostResumeForTest: LocalHostResume | null = null;
export function __setLocalHostResumeForTest(fn: LocalHostResume | null): void {
  localHostResumeForTest = fn;
}

type ModelAvailabilityProbe = (
  opts: RunAgentOpts,
  model: string,
) => string | null;
let modelAvailabilityForTest: ModelAvailabilityProbe | null = null;
export function __setModelAvailabilityForTest(
  fn: ModelAvailabilityProbe | null,
): void {
  modelAvailabilityForTest = fn;
}

function modelUnavailableReason(
  opts: RunAgentOpts,
  model: string,
): string | null {
  const mapped = toPiModel(model) || model;
  return modelAvailabilityForTest
    ? modelAvailabilityForTest(opts, mapped)
    : null;
}

function recordPoolDryShortCircuit(
  opts: RunAgentOpts,
  model: string,
  reason: string,
): void {
  audit({
    msg: "account_pool_short_circuit",
    run_kind: opts.journal?.kind,
    session_id: opts.journal?.osSessionId,
    model,
    reason,
  });
}

async function* runOnModel(
  opts: RunAgentOpts,
  model: string | undefined,
): AsyncGenerator<StreamEvent> {
  // All production turns route to Pi. The fake seam stays before dispatch so
  // consumer tests exercise the same context logging and fallback walk.
  const requested = model || getDefaultModel();
  const mapped = toPiModel(requested) || requested;
  // Model-visible means logged (context-log.ts). This is the single dispatch
  // point for every engine and every hop of the fallback walk, so recording
  // the injected context here covers all of them with the prompt each one
  // actually receives — including the handoff the walk prepends on a
  // cross-provider hop. Before the test seam, so fake-engine tests exercise it.
  logInjectedContext({
    sessionId: opts.journal?.osSessionId || opts.transcriptSessionId,
    turnId: opts.promptEntryId || opts.startToken,
    prompt: opts.prompt,
    reposNote: opts.reposNote,
    model: mapped,
  });
  // Standing context, same choke point: the tool surface the run was scoped
  // to. Model-visible on every turn and identical across them, so it is
  // recorded once per session and again only when the scoping moves. Written
  // here rather than in a runner because this is where the decision is final
  // for EVERY engine — the direct SDK adapters assemble their own tool lists
  // and would each need their own call otherwise. What the runner adds below
  // it (`mcp-servers`) is the resolution of this scope, not a second copy.
  await logStandingJson({
    sessionId: opts.journal?.osSessionId || opts.transcriptSessionId,
    turnId: opts.promptEntryId || opts.startToken,
    source: "tools",
    value: {
      // `mcpServers` is typed as required, and the create path passes it
      // through a cast that can still be undefined at runtime — which reads
      // as "all" per McpScope's own contract, and must never be spread.
      mcpScope: Array.isArray(opts.mcpServers)
        ? [...opts.mcpServers].sort()
        : (opts.mcpServers ?? "all"),
      inProcess: Object.keys(opts.inProcessMcp || {}).sort(),
      // Names, not the refusal messages: those are model-visible through the
      // instructions record, and folding them in here would churn this hash
      // on a wording change that altered no tool.
      deniedTools: Object.keys(opts.deniedTools || {}).sort(),
      publicationPolicy: opts.publicationPolicy || null,
      confirmTools: Object.keys(opts.confirmTools || {}).sort(),
      mode: opts.mode || null,
      localWorkspaceToolsDisabled: !!opts.disableLocalWorkspaceTools,
    },
  });
  if (engineForTest) {
    yield* engineForTest(opts, mapped);
    return;
  }
  const route = routeModel(requested, { interactive: isInteractiveRun(opts) });
  yield* runPi(opts, route.model);
}

/** Pi owns every live engine session transcript. */
export function transcriptProviderFor(_engineModel: string): "pi" {
  return "pi";
}

/** Whether the per-model default engine applies to this run. Automations and
 *  the other unattended kinds stay on their current routing for now — moving
 *  their default is a separate, deliberate step. */
export function isInteractiveRun(opts: {
  journal?: { kind?: string };
}): boolean {
  return INTERACTIVE_KINDS.has(baseJournalKind(opts.journal?.kind));
}

/**
 * Watch a run's event stream for whether it ever reached anybody, and settle
 * the verdict when it ends (src/server/turn-outcome.ts). Only unattended kinds
 * carry a ledger; for everything else this is two branch predictions per run.
 */
export async function* runAgent(
  opts: RunAgentOpts,
): AsyncGenerator<StreamEvent> {
  const osSessionId = opts.journal?.osSessionId;
  const runAliases = new Set(
    [osSessionId, opts.transcriptSessionId, opts.sessionId].filter(
      (id): id is string => !!id,
    ),
  );
  const runToken =
    opts.startToken ||
    (osSessionId
      ? pendingStarts.get(osSessionId)?.values().next().value
      : undefined) ||
    crypto.randomUUID();
  const effectiveOpts: RunAgentOpts = {
    ...opts,
    scratchDir:
      opts.scratchDir ??
      (osSessionId ? ensureSessionScratch(osSessionId) : undefined),
    journal: opts.journal
      ? {
          ...opts.journal,
          firstJournaledAt:
            opts.journal.firstJournaledAt || new Date().toISOString(),
        }
      : undefined,
    startToken: runToken,
    // A create-path prompt has no early transcript row to name. Give it the
    // logical run's stable id here, before the fallback walk forks opts, so a
    // model switch upserts the opening message instead of appending it again.
    promptEntryId: opts.promptEntryId || runToken,
    shouldCancel: () =>
      cancelledRunTokens.has(runToken) || opts.shouldCancel?.() === true,
  };
  if (
    osSessionId &&
    ["idle", "stopped", "failed", "starting"].includes(getRunState(osSessionId))
  )
    await transitionRunState(osSessionId, "prompt", { run_key: runToken });
  for (const alias of runAliases) {
    let tokens = activeSessionRunTokens.get(alias);
    if (!tokens) activeSessionRunTokens.set(alias, (tokens = new Set()));
    tokens.add(runToken);
  }
  if (osSessionId) {
    if (!sessionRunOwners.has(osSessionId))
      sessionRunOwners.set(osSessionId, runToken);
  }
  let terminalEvent: StreamEvent | undefined;
  const observe = (event: StreamEvent) => {
    if (event.type === "done" || event.type === "error") terminalEvent = event;
    return event;
  };
  const key = isCheckedKind(opts.journal?.kind)
    ? turnKeyFor({ osSessionId: opts.journal?.osSessionId })
    : undefined;
  try {
    if (!key) {
      for await (const event of runAgentInner(effectiveOpts))
        yield observe(event);
      return;
    }
    beginTurn({
      key,
      kind: opts.journal?.kind || "unknown",
      sessionId: opts.journal?.osSessionId,
    });
    try {
      for await (const event of runAgentInner(effectiveOpts)) {
        observe(event);
        // Pi reports every bridged MCP call as the `mcp_call` dispatcher with
        // the real tool inside its input, so the ledger is fed the unwrapped
        // call rather than the envelope (observeToolCall, turn-outcome.ts).
        // It also picks up a declared silence here, because on a hosted run
        // the opensession-turn tool body executes in the SERVER process and
        // cannot reach this host's ledger.
        if (event.type === "tool_use") {
          observeToolCall(key, event);
        }
        yield event;
      }
    } finally {
      // `finally`, not after the loop: a consumer that breaks out early (a
      // cancel, a steer) still closes the ledger, so a later run reusing the
      // same session id starts clean instead of inheriting stale effects.
      endTurn(key, { model: opts.model, by: opts.user });
    }
  } finally {
    if (
      osSessionId &&
      terminalEvent &&
      sessionRunOwners.get(osSessionId) === runToken &&
      !(
        terminalEvent.type === "error" &&
        terminalEvent.content === "Session is busy"
      ) &&
      isRunStateUnsettled(getRunState(osSessionId))
    ) {
      const failed =
        terminalEvent.type === "error" || !!terminalEvent.usageLimitExhausted;
      await transitionRunState(
        osSessionId,
        failed ? "run_failed" : "turn_end",
        {
          run_key: runToken,
          source: "runner_terminal",
        },
      );
    }
    cancelledRunTokens.delete(runToken);
    for (const alias of runAliases) {
      const tokens = activeSessionRunTokens.get(alias);
      tokens?.delete(runToken);
      if (!tokens?.size) activeSessionRunTokens.delete(alias);
    }
    if (osSessionId) {
      if (sessionRunOwners.get(osSessionId) === runToken)
        sessionRunOwners.delete(osSessionId);
    }
  }
}

async function* runAgentInner(opts: RunAgentOpts): AsyncGenerator<StreamEvent> {
  const wasCancelled = () => opts.shouldCancel?.() === true;
  if (wasCancelled()) return;
  // Workspace presets stay as their picker id on the session. Resolve their
  // lead only for dispatch, so the session never loses its preset identity.
  const workspacePreset = resolveWorkspaceModelPreset(opts.model);
  const requestedModel = resolveModel(
    workspacePreset?.model || opts.model || getDefaultModel(),
  );
  const wantsBestCodex = requestedModel?.id === BEST_AVAILABLE_CODEX_MODEL;
  const primaryModel =
    workspacePreset?.model || resolveConcreteModel(opts.model);
  const preferredFallback = /^(?:claude|codex)\//.test(primaryModel)
    ? "none"
    : wantsBestCodex
      ? BEST_AVAILABLE_CODEX_MODEL
      : opts.fallbackModel;
  // No fallback configured (interactive auto-switch off, or an automation with
  // fallbackModel:"none") ⇒ run the primary and surface whatever it does.
  if (!preferredFallback || preferredFallback === "none") {
    const dry = modelUnavailableReason(opts, primaryModel);
    if (dry) {
      recordPoolDryShortCircuit(opts, primaryModel, dry);
      yield {
        type: "error",
        content: `Claude account pool is unavailable: ${dry}`,
        provider: providerFor(primaryModel),
        model: primaryModel,
        usageLimitExhausted: true,
      };
      return;
    }
    yield* runOnModel(opts, primaryModel);
    return;
  }

  let currentOpts = {
    ...opts,
    // One human turn keeps one transcript identity across every fallback hop.
    // Callers such as Slack do not early-persist their own id, so mint it here
    // before the walk rather than inside each provider attempt.
    promptEntryId: opts.promptEntryId ?? crypto.randomUUID(),
    selectedModel: opts.selectedModel ?? opts.model,
  };
  let currentModel = primaryModel;
  const exhaustedModels = new Set<string>();
  let consecutiveTransient = 0;
  for (;;) {
    if (wasCancelled()) return;
    let currentEngineId = currentOpts.sessionId;
    // Why this turn ended, if it did: a usage cap (pool drained), a transient
    // infrastructure failure, or an upstream provider overload. The first two
    // route into the fallback graph; a provider overload surfaces plainly
    // because changing models immediately usually hits the same outage.
    let failure: {
      transient: boolean;
      providerOverloaded?: boolean;
      content?: string;
    } | null = null;

    const dry = modelUnavailableReason(currentOpts, currentModel);
    if (dry) {
      recordPoolDryShortCircuit(currentOpts, currentModel, dry);
      failure = { transient: false, content: dry };
    } else {
      for await (const event of runOnModel(currentOpts, currentModel)) {
        if (event.type === "init") {
          currentEngineId = event.sessionId || currentEngineId;
        }
        if (event.type === "done" && event.usageLimitExhausted === true) {
          failure = { transient: false };
          break;
        }
        if (event.type === "error") {
          if (event.usageLimitExhausted === true) {
            failure = { transient: false, content: event.content };
            break;
          }
          if (isProviderOverloadError(event.content)) {
            failure = {
              transient: false,
              providerOverloaded: true,
              content: event.content,
            };
            break;
          }
          // A non-usage error that looks like infra (server death, wedge, 5xx,
          // network, SQLite contention): the pi runner already spent its own
          // in-attempt retry, so escalate to the next model rather than failing.
          if (isTransientRunError(event.content)) {
            failure = { transient: true, content: event.content };
            break;
          }
        }
        yield event;
      }
    }

    if (!failure || wasCancelled()) return;

    if (failure.providerOverloaded) {
      yield {
        type: "error",
        content:
          "The model provider is temporarily overloaded. Your session and completed work are preserved. " +
          "Retry this prompt in a minute.",
        provider: providerFor(currentModel),
        model: currentModel,
      };
      return;
    }

    // Two models in a row dying the TRANSIENT way is an infrastructure
    // problem (dead rpc socket, wedged bridge, network) — every further rung
    // would burn its own liveness window and fail identically, and the walk
    // would end by blaming usage for what is an outage. Stop and say what
    // actually happened. (2026-07-17 stolen-socket outage: the walk burned
    // Fable→Sol→Opus→GPT-5.5 for ~12 min per prompt, then told users the
    // models were "out of usage".)
    if (failure.transient) {
      consecutiveTransient++;
      if (consecutiveTransient >= 2) {
        yield {
          type: "error",
          content:
            `${modelLabel(currentModel)} also failed with a transient engine error. ` +
            `${consecutiveTransient} models in a row failed the same way, so this looks like ` +
            `infrastructure (engine bridge, MCP socket, or network). Stopping the fallback ` +
            `walk; retry in a minute or ping ${personaName()}. ` +
            `Last error: ${failure.content || "unknown"}`,
          provider: providerFor(currentModel),
          model: currentModel,
        };
        return;
      }
    } else {
      consecutiveTransient = 0;
    }

    const currentGraphModel = toPiModel(currentModel) || currentModel;
    exhaustedModels.add(currentGraphModel);
    const hop = nextFallbackModel(
      currentGraphModel,
      exhaustedModels,
      preferredFallback,
    );
    if (!hop) {
      // Nothing left to try — surface the terminal error we were suppressing.
      yield {
        type: "error",
        content: failure.transient
          ? failure.content ||
            `${modelLabel(currentModel)} failed and no fallback models remain.`
          : `${modelLabel(currentModel)} is out of usage, and no fallback models remain.`,
        provider: providerFor(currentModel),
        model: currentModel,
        usageLimitExhausted: failure.transient ? undefined : true,
      };
      return;
    }
    const nextModel = toPiModel(hop.id);
    if (!nextModel) {
      yield {
        type: "error",
        content: `${modelLabel(currentModel)} is out of usage, and its fallback cannot run on Pi.`,
        provider: providerFor(currentModel),
        model: currentModel,
        usageLimitExhausted: true,
      };
      return;
    }

    // Downgrade to a dumber model (Fable→Opus, Opus→Sonnet, Sol→Opus): a human
    // decides. Interactive runs get an AskUserQuestion; headless runs
    // (automations, workflow sub-agents, restart resumes without an ask handler)
    // auto-proceed — stalling them would defeat "continue without failing".
    if (hop.mode === "ask") {
      const approved = await askFallbackApproval(
        opts.onAskUser,
        currentModel,
        nextModel,
        failure.transient,
      );
      if (!approved) {
        // Name the real cause — a transient engine failure declined here must
        // NOT read as "out of usage" (that mislabel sent people chasing
        // billing during the 2026-07-17 infra outage).
        yield {
          type: "error",
          content: failure.transient
            ? `${modelLabel(currentModel)} hit a transient engine failure. ` +
              `Declined the fallback to ${modelLabel(nextModel)}. Retry this prompt, or use /model to switch.`
            : `${modelLabel(currentModel)} is out of usage. ` +
              `Declined the fallback to ${modelLabel(nextModel)}. Use /model to switch when ready.`,
          provider: providerFor(currentModel),
          model: currentModel,
          usageLimitExhausted: failure.transient ? undefined : true,
        };
        return;
      }
    }
    if (wasCancelled()) return;

    // Everything runs on the pi engine, so `providerFor` reports
    // "pi" for both sides and can't tell a same-family switch from a
    // cross-family one. The decision that matters — resume the partial session
    // vs. start fresh with a handoff — turns on the UNDERLYING provider
    // (anthropic ↔ openai): same family resumes the pi session; a family
    // switch needs a fresh session seeded with the prior transcript.
    const fromFamily = engineFamily(currentModel);
    const toFamily = engineFamily(nextModel);
    const crossProvider = fromFamily !== toFamily;
    const reason = failure.transient
      ? "hit a transient failure"
      : "is out of usage on all accounts";
    console.warn(
      `[runner] ${currentModel} ${reason}; falling back to ${nextModel} (${hop.mode})`,
    );
    const transientFallback =
      !!currentOpts.transientFallback || failure.transient;
    // Structured cue: usage exhaustion becomes a durable selection change;
    // transient recovery is explicitly marked as current-turn-only.
    yield {
      type: "model_switch",
      fromModel: currentModel,
      toModel: nextModel,
      switchReason: failure.transient
        ? "hit a transient engine error"
        : "out of credits",
      temporaryFallback: transientFallback,
    };

    let prompt = currentOpts.prompt;
    let handoffEntries: TranscriptEntry[] = [];
    if (crossProvider) {
      // Read the prior turn from the CURRENT engine's store: an pi
      // session id reads from Pi's store regardless of which model
      // family produced it; a pi run's history is served from the owned
      // transcript store via the "pi" branch (the id is a pi session uuid —
      // the old hardcoded "pi" arg would return nothing for it).
      // Gate on currentEngineId (present when resuming an existing session),
      // NOT on sawInit: an account pool that is dry *at pick time* throws
      // usageLimitExhausted BEFORE any init event, so sawInit stays false — yet
      // the resumed session on disk still holds the full history to hand off.
      // Requiring sawInit here dropped that history and started the fallback
      // model on a blank session (the "history lost after fallback" bug).
      const entries = currentEngineId
        ? await readEngineHandoffTranscriptAsync(
            currentOpts.cwd,
            currentEngineId,
            transcriptProviderFor(currentModel),
          )
        : [];
      handoffEntries = entries;
      if (entries.length) {
        const handoff = buildEngineSwitchHandoffNote({
          fromModel: currentModel,
          fromProvider: familyLabel(fromFamily),
          toProvider: familyLabel(toFamily),
          targetResuming: false,
          entries,
        });
        // The handoff already contains the person's request and the partial
        // response. Sending the original prompt below it creates a second user
        // turn and tells the fallback model to start over. A context-only turn
        // instead asks the fresh provider to continue while rendering no new
        // user bubble. Image turns retain the original prompt because the new
        // provider still needs the image-bearing user message; the stable
        // promptEntryId above makes that an upsert rather than a duplicate.
        prompt = fallbackContinuationPrompt(
          handoff,
          prompt,
          !!currentOpts.images?.length,
        );
      } else if (currentEngineId) {
        // The source engine existed but yielded no readable handoff. Keep the
        // recovery hint model-only: appending it as visible user text changes
        // the opening row that was already persisted at intake, so the client
        // can no longer reconcile its optimistic prompt and shows both copies.
        prompt = fallbackMissingHandoffPrompt(prompt);
      }
    }
    if (wasCancelled()) return;

    currentOpts = {
      ...currentOpts,
      prompt,
      selectedModel: transientFallback ? currentOpts.selectedModel : nextModel,
      transientFallback,
      // Account ids are provider-local. A fallback to another family must not
      // reinterpret the source provider's pin (including a strict cost cap).
      ...(crossProvider
        ? { accountId: undefined, accountStrict: undefined }
        : {}),
      // Same family can resume the partial session; a family switch starts fresh
      sessionId: crossProvider ? undefined : currentEngineId,
      // The fresh pi session is seeded with the history the handoff covers.
      seedTranscriptEntries:
        crossProvider && handoffEntries.length ? handoffEntries : undefined,
      journal: opts.journal
        ? { ...opts.journal, kind: `${opts.journal.kind || "run"}-fallback` }
        : undefined,
    };
    currentModel = nextModel;
  }
}

/** Provider family inside Pi. A provider change starts a fresh Pi session and
 * bridges the previous transcript; a same-provider fallback can resume. */
export function engineFamily(model: string): string {
  const routed = toPiModel(model) || model;
  return `pi-${routed.match(/^pi\/([^/]+)\//)?.[1] || providerFor(routed)}`;
}

function familyLabel(_family: string): "pi" {
  return "pi";
}

/**
 * Confirm a downgrade fallback with the human. Interactive runs surface an
 * AskUserQuestion card (web UI + Slack escalation); headless runs — no
 * onAskUser — auto-approve so automations and workflow sub-agents keep going
 * rather than dead-ending on the limit. Returns false only when a human is
 * present and declined (or nobody answered).
 */
async function askFallbackApproval(
  onAskUser: RunAgentOpts["onAskUser"],
  fromModel: string,
  toModel: string,
  transient: boolean,
): Promise<boolean> {
  if (!onAskUser) return true;
  const reason = transient
    ? `**${modelLabel(fromModel)}** hit a transient failure`
    : `**${modelLabel(fromModel)}** is out of usage`;
  const switchLabel = `Switch to ${modelLabel(toModel)}`;
  let answer;
  try {
    answer = await onAskUser({
      questions: [
        {
          question: `${reason}. Fall back to the lighter **${modelLabel(toModel)}** to keep going?`,
          header: "Model fallback",
          options: [
            {
              label: switchLabel,
              description: "Continue this turn on the fallback model",
            },
            {
              label: "Stop here",
              description: "Don't switch — I'll pick a model myself",
            },
          ],
          multiSelect: false,
        },
      ],
    });
  } catch (e) {
    console.warn(
      `[runner] fallback approval ask failed for ${fromModel}→${toModel}:`,
      e,
    );
    return false;
  }
  if (answer.behavior === "deny") return false; // nobody answered / timed out
  const picked = String(
    Object.values(
      (answer.updatedInput as { answers?: Record<string, string> }).answers ||
        {},
    )[0] || "",
  ).toLowerCase();
  return picked.startsWith("switch") || picked.startsWith("yes");
}

// Sessions whose prompt run has started but isn't registered in the runner's
// activeRuns yet — runSessionPrompt awaits (worktree revive, title gen, upload
// staging) before the generator is first pulled, so two racing prompts could
// both pass the busy check and the loser's message got dropped as a "Session
// is busy" error. Marked synchronously before any await; parked on globalThis
// so a hot reload keeps it.
const runnerGlobal = globalThis as any;
const pendingStarts: Map<
  string,
  Set<string>
> = (runnerGlobal.__pendingSessionStartTokens ??= new Map());
const cancelledRunTokens: Set<string> = ((
  globalThis as any
).__cancelledRunTokens ??= new Set());
const activeSessionRunTokens: Map<string, Set<string>> = ((
  globalThis as any
).__activeSessionRunTokens ??= new Map());
const sessionRunOwners: Map<string, string> = ((
  globalThis as any
).__sessionRunOwners ??= new Map());
const cancelledRecoveries: Set<ActiveRunRecord> = ((
  globalThis as any
).__cancelledRecoveries ??= new Set());
const activeRecoveryRuns: Map<string, ActiveRunRecord> = ((
  globalThis as any
).__activeRecoveryRuns ??= new Map());
const activeRecoveryWorkerRunKeys: Set<string> = ((
  globalThis as any
).__activeRecoveryWorkerRunKeys ??= new Set());
// Hot reloads can leave the pre-token Set globals alive in old module
// closures. Keep observing them until those preparations unwind; using a new
// key for the token map avoids ever casting that Set to a Map and crashing.
function legacyPendingStarts(): Set<string> | undefined {
  const value = runnerGlobal.__pendingSessionStarts;
  return value instanceof Set ? value : undefined;
}

function legacyCancelledSessions(): Set<string> {
  const value = runnerGlobal.__cancelledSessionRuns;
  if (value instanceof Set) return value;
  return (runnerGlobal.__cancelledSessionRuns = new Set<string>());
}

function trackRecovery(run: ActiveRunRecord): void {
  for (const id of [run.runKey, run.osSessionId, run.claudeSessionId]) {
    if (id) activeRecoveryRuns.set(id, run);
  }
}

function untrackRecovery(run: ActiveRunRecord): void {
  for (const id of [run.runKey, run.osSessionId, run.claudeSessionId]) {
    if (id && activeRecoveryRuns.get(id)?.runKey === run.runKey)
      activeRecoveryRuns.delete(id);
  }
}

/** Mark a session as starting a run before launching physical work. */
export async function markSessionStarting(
  id: string,
  token = `rh-${crypto.randomUUID()}`,
): Promise<string> {
  if (sessionRunOwners.get(id) === token || pendingStarts.get(id)?.has(token)) {
    const rejected = `rh-${crypto.randomUUID()}`;
    cancelledRunTokens.add(rejected);
    return rejected;
  }
  let decision = await decideRunStateTransition(id, "prompt", {
    run_key: token,
  });
  if (
    !decision.accepted &&
    ["starting", "running", "interrupted", "reattaching"].includes(
      decision.from,
    ) &&
    !hasActiveRunFor(id) &&
    !activeRecoveryRuns.has(id) &&
    !isAgentLiveEngineBusy(id)
  ) {
    // A gateway can die after actor admission but before it records a journal
    // or process owner. A later gateway used to trust its empty local
    // projection, lose admission to that durable ghost forever, and requeue the
    // same prompt once a minute. The rejection is authoritative evidence of
    // the old owner; the three negative ownership checks prove it cannot still
    // execute. Settle that exact orphan, then retry this admission once.
    const orphanedRunId = decision.currentRunId;
    const settled = await decideRunStateTransition(id, "boot_owner_missing", {
      previous_state: decision.from,
      ...(orphanedRunId ? { orphaned_run_id: orphanedRunId } : {}),
    });
    if (settled.accepted) {
      console.warn(
        `[run-state] Settled orphaned ${decision.from} preparation for ${id}${orphanedRunId ? ` (${orphanedRunId})` : ""}`,
      );
      decision = await decideRunStateTransition(id, "prompt", {
        run_key: token,
      });
    }
  }
  if (!decision.accepted) {
    // Return a distinct rejected token so the caller can requeue without
    // sharing/unmarking the actor winner's process reservation.
    cancelledRunTokens.add(token);
    return token;
  }
  let tokens = pendingStarts.get(id);
  if (!tokens) pendingStarts.set(id, (tokens = new Set()));
  tokens.add(token);
  sessionRunOwners.set(id, token);
  return token;
}

/** Clear a starting mark (call in a `finally` once the run has ended). */
export function unmarkSessionStarting(id: string, token?: string): void {
  const tokens = pendingStarts.get(id);
  const owned =
    token || (tokens?.size === 1 ? tokens.values().next().value : undefined);
  if (owned) tokens?.delete(owned);
  if (!tokens?.size) pendingStarts.delete(id);
  if (owned && sessionRunOwners.get(id) === owned) sessionRunOwners.delete(id);
  if (owned) cancelledRunTokens.delete(owned);
}

/** Whether Stop has latched this admitted turn before its runner registered. */
export function isAgentSessionCancelled(id: string, token?: string): boolean {
  if (token) return cancelledRunTokens.has(token);
  if (legacyCancelledSessions().has(id)) return true;
  return [...(pendingStarts.get(id) || [])].some((owned) =>
    cancelledRunTokens.has(owned),
  );
}

/** Live engine/runner busy check, excluding restart-recovery FSM state. */
export function isAgentLiveEngineBusy(
  ...ids: Array<string | null | undefined>
): boolean {
  for (const id of ids) {
    if (!id) continue;
    if (
      pendingStarts.has(id) ||
      legacyPendingStarts()?.has(id) ||
      activeSessionRunTokens.has(id) ||
      isPiSessionBusy(id) ||
      hostRunBusy(id)
    )
      return true;
  }
  return false;
}

/** Live engine work plus queued/in-progress restart recovery ownership. */
export function isAgentEngineBusy(
  ...ids: Array<string | null | undefined>
): boolean {
  return (
    ids.some((id) => !!id && activeRecoveryRuns.has(id)) ||
    isAgentLiveEngineBusy(...ids)
  );
}

/** Busy check (pass any engine/backstage session id). */
export function isAgentSessionBusy(
  ...ids: Array<string | null | undefined>
): boolean {
  if (hasActiveRunFor(...ids) || isAgentEngineBusy(...ids)) return true;
  // A persisted create still owes its opening turn: a prompt admitted now
  // would run before the workspace exists, so it queues behind the opening.
  return ids.some(
    (id) =>
      !!id && (isRunStateUnsettled(getRunState(id)) || hasPendingOpening(id)),
  );
}

/**
 * How many runs this process is actively driving. Used by graceful shutdown
 * to wait for in-flight work to reach a stopping point before exiting. (Does
 * not count external CLI/tmux runs — we can't drain those.)
 */
export function activeAgentRunCount(): number {
  return activePiRunCount() + hostRunCount();
}

/** Of those, how many execute on a DETACHED engine server that survives a
 *  restart — the graceful-shutdown drain skips waiting on these (boot
 *  reattaches them via the journal instead). In-process Pi contributes 0;
 *  Pi inside a local run host contributes through hostRunCount(). */
export function activeDetachedAgentRunCount(): number {
  return hostRunCount();
}

/**
 * Steer a message into an in-flight run. Pi runs steer in-band since
 * 2026-07-12 (steerPiRun: a noReply history append the running turn
 * picks up at its next step boundary — Claude-SDK-steer semantics); pi runs
 * steer natively (session.steer folds the message in at the next step);
 * host-forwarded runs steer over RPC. False = nothing steerable — caller
 * should queue.
 */
export function steerAgentRun(
  ids: Array<string | null | undefined>,
  text: string,
  images?: ImageInput[],
  steerId?: string,
): boolean {
  for (const id of ids) {
    if (id && steerAgentRunToken(id, text, images, steerId)) return true;
  }
  return false;
}

/** Steer only one immutable dispatch token, never a reusable session alias. */
export function steerAgentRunToken(
  runToken: string,
  text: string,
  images?: ImageInput[],
  steerId?: string,
): boolean {
  if (steerPiRun(runToken, text, images, steerId)) return true;
  // Images ride the host frame too (protocol ClientToHostMsg.steer).
  return hostSteer(runToken, text, images, steerId);
}

/** Retract one accepted steer only while it remains behind the engine's next
 * step boundary. Exact ids distinguish duplicate messages. */
export async function retractAgentSteer(
  ids: Array<string | null | undefined>,
  steerId: string,
): Promise<boolean> {
  for (const id of ids) {
    if (id && retractPiSteer(id, steerId)) return true;
  }
  return hostRetractSteer(ids, steerId);
}

/**
 * NOTE for anyone reaching for a "graceful stop" here: there isn't one, and
 * two stubs that returned a constant false used to pretend otherwise
 * (`stopAgentRunTurn`, `interruptAgentRun`, removed 2026-08-19). Every call
 * site guarded on them, so the graceful branch had never executed once and
 * every audited stop recorded `graceful: false` as a constant rather than an
 * observation.
 *
 * cancelAgentRun below is not a lesser fallback, it is the real stop: the
 * abort is wired through to the engine on all three paths (pi-runner
 * installs `client.session.abort()` on the signal, pi-runner calls
 * `liveSession.abort()`, and a run host forwards a `cancel` frame to its own
 * cancelAgentRun). What it cannot promise is that the turn ends THIS instant:
 * an abort is observed at the next await, so a tool call in flight finishes
 * first (pi's bash tool does kill its process group immediately). If a real
 * cooperative stop is ever wanted, build it on pi's steer primitives and give
 * it a call site that can observe it, rather than restoring a constant.
 */

/**
 * Esc-style redirect: abort the current turn but keep the run alive,
 * continuing immediately with the given message. Host-forwarded runs only;
 * false = caller should fall back to cancel + queue.
 */
export function interruptAndSteerAgentRun(
  ids: Array<string | null | undefined>,
  text: string,
  images?: ImageInput[],
): boolean {
  for (const id of ids) {
    if (id && interruptAndSteerAgentRunToken(id, text, images)) return true;
  }
  return false;
}

/** Interrupt and steer one immutable dispatch token, never a reusable alias. */
export function interruptAndSteerAgentRunToken(
  runToken: string,
  text: string,
  images?: ImageInput[],
): boolean {
  return hostInterruptSteer(runToken, text, images);
}

/** Immutable dispatch identity for the run currently admitted under an alias.
 * Unlike engine/session ids, this token is never reused by a successor. */
export function currentAgentRunToken(id: string): string | undefined {
  const owner = sessionRunOwners.get(id);
  if (owner) return owner;
  const pending = pendingStarts.get(id);
  if (pending?.size === 1) return pending.values().next().value;
  // A detached host survives a gateway restart, while the process-local owner
  // maps do not. Boot recovery tracks the immutable journal lineage before it
  // reattaches the host; expose that exact token so steer/cancel can reach the
  // recovered run instead of silently falling back to the durable queue.
  return activeRecoveryRuns.get(id)?.runKey;
}

/** The exact journal lineage currently owned by boot recovery. This remains
 * available after recovery retires the journal before starting its fallback,
 * closing the handoff window for other process-local owners. */
export function activeAgentRecoveryRecord(
  id: string,
): ActiveRunRecord | undefined {
  return activeRecoveryRuns.get(id);
}

/** Cancel one exact physical dispatch without crossing onto a successor that
 * reused its session or engine aliases. */
function agentRunTokenPending(runToken: string): boolean {
  return [...pendingStarts.values()].some((tokens) => tokens.has(runToken));
}

function agentRunTokenLatched(runToken: string): boolean {
  return [...activeSessionRunTokens.values()].some((tokens) =>
    tokens.has(runToken),
  );
}

function agentRunTokenControlled(runToken: string): boolean {
  return (
    agentRunTokenLatched(runToken) ||
    isPiSessionBusy(runToken) ||
    hostRunBusy(runToken)
  );
}

function durableDetachedRunToken(runToken: string): boolean {
  return activeRunRecords().some(
    (run) =>
      run.runKey === runToken &&
      !!(run.hostId || run.runnerId || run.sandboxId),
  );
}

export function isAgentRunTokenAdmitted(runToken: string): boolean {
  return (
    agentRunTokenPending(runToken) ||
    agentRunTokenControlled(runToken) ||
    activeRecoveryRuns.has(runToken) ||
    durableDetachedRunToken(runToken)
  );
}

export async function cancelAgentRunToken(runToken: string): Promise<boolean> {
  const admitted = isAgentRunTokenAdmitted(runToken);
  cancelledRunTokens.add(runToken);
  const cancelled = await cancelAgentRun(runToken);
  if (!cancelled && !admitted) cancelledRunTokens.delete(runToken);
  return cancelled || admitted;
}

/** Cancel one immutable dispatch and wait until a physical control accepts
 * the request, a prepared launch observes its latch, or recovery proves the
 * owner absent. This confirmation precedes actor settlement; source completion
 * remains responsible for retiring its journal afterwards. */
export async function cancelAgentRunTokenAndWait(
  runToken: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  if (!(await cancelAgentRunToken(runToken))) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A running source owns a token-aware cancellation latch even before its
    // engine handle appears; a host control can receive the exact frame now.
    if (agentRunTokenLatched(runToken)) {
      // runAgent's immutable shouldCancel closure now owns the latch.
      await cancelAgentRun(runToken);
      return true;
    }
    if (
      (isPiSessionBusy(runToken) || hostRunBusy(runToken)) &&
      (await cancelAgentRun(runToken))
    )
      return true;
    // No pending launch and no recovery owner means setup observed the latch
    // and unwound, or recovery positively settled absence.
    if (
      !agentRunTokenPending(runToken) &&
      !activeRecoveryRuns.has(runToken) &&
      !durableDetachedRunToken(runToken)
    )
      return true;
    if (Date.now() >= deadline)
      throw new Error(`Timed out reconciling cancelled dispatch ${runToken}`);
    // Boot recovery may attach after this effect starts. Re-issue against the
    // immutable token so the newly registered control is cancelled immediately.
    await cancelAgentRun(runToken);
    await Bun.sleep(50);
  }
}

/** Cancel a run; returns true if anything was cancelled. */
export async function cancelAgentRun(
  ...ids: Array<string | null | undefined>
): Promise<boolean> {
  let cancelled = false;
  for (const id of ids) {
    if (!id) continue;
    if (cancelPiRun(id)) cancelled = true;
    if (hostCancel(id)) cancelled = true;
  }
  const wanted = new Set(ids.filter((id): id is string => !!id));
  for (const id of wanted) {
    const pendingTokens = pendingStarts.get(id) || new Set<string>();
    const activeTokens = activeSessionRunTokens.get(id) || new Set<string>();
    for (const token of pendingTokens) cancelledRunTokens.add(token);
    for (const token of activeTokens) cancelledRunTokens.add(token);
    const legacyPending = legacyPendingStarts()?.has(id) === true;
    if (legacyPending) legacyCancelledSessions().add(id);
    if (!pendingTokens.size && !activeTokens.size && !legacyPending) continue;
    if (isRunStateUnsettled(getRunState(id)))
      await transitionRunState(id, "cancel", {
        source: "run_cancelled_preparation",
      });
    cancelled = true;
  }
  const records = new Map<string, ActiveRunRecord>();
  const recoveryRunKeys = new Set<string>();
  for (const run of activeRunRecords()) {
    if (
      (run.osSessionId && wanted.has(run.osSessionId)) ||
      (run.claudeSessionId && wanted.has(run.claudeSessionId))
    )
      records.set(run.runKey, run);
  }
  for (const id of wanted) {
    const recovery = activeRecoveryRuns.get(id);
    if (recovery) {
      records.set(recovery.runKey, recovery);
      recoveryRunKeys.add(recovery.runKey);
    }
  }
  for (const run of records.values()) {
    if (recoveryRunKeys.has(run.runKey)) {
      cancelledRecoveries.add(run);
    }
    // Every physical owner keeps its journal until its source reports terminal
    // completion or recovery proves it absent. Actor Stop settlement happens
    // after this cancellation request; retiring ownership here would create a
    // window where a successor could start while the predecessor still works.
    if (run.osSessionId && isRunStateUnsettled(getRunState(run.osSessionId)))
      await transitionRunState(run.osSessionId, "cancel", {
        run_key: run.runKey,
        source: "run_cancelled",
      });
    cancelled = true;
  }
  return cancelled;
}

/** Cancel and wait until every known engine/host releases ownership. */
export async function cancelAgentRunAndWait(
  ids: Array<string | null | undefined>,
  timeoutMs = 10_000,
): Promise<boolean> {
  await cancelAgentRun(...ids);
  const deadline = Date.now() + timeoutMs;
  while (ids.some((id) => !!id && isAgentSessionBusy(id!))) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** Per-session AskUserQuestion handler, mirroring RunAgentOpts.onAskUser. */
type AskHandler = NonNullable<RunAgentOpts["onAskUser"]>;

/**
 * Resume runs that a previous process left in-flight (service restart or
 * crash). Each resumable run gets a continuation prompt against its engine
 * session, on whichever backend the journaled model belongs to.
 *
 * `askHandlerFor` re-attaches an AskUserQuestion handler (the web-UI + Slack
 * escalation handler) to interactive sessions — without it, a run that was
 * blocked on an ask comes back headless and dead-ends every question. It
 * returns undefined for sessions that should stay headless (automations).
 *
 * `inProcessMcpFor` and `reposNoteFor` rebuild trusted interactive context
 * that is deliberately not serialized into the restart journal.
 */
async function durableCancelRecoveryOwnership(
  run: ActiveRunRecord,
): Promise<"owned" | "none" | "unknown"> {
  if (!run.osSessionId) return "none";
  try {
    return (await sessionTurnSnapshot(run.osSessionId)).cancel?.runId ===
      run.runKey
      ? "owned"
      : "none";
  } catch {
    return "unknown";
  }
}

export async function durableCancelOwnsRecovery(
  run: ActiveRunRecord,
): Promise<boolean> {
  return (await durableCancelRecoveryOwnership(run)) === "owned";
}

export async function reissueDurableRecoveryCancel(
  run: ActiveRunRecord,
): Promise<boolean> {
  if (!(await durableCancelOwnsRecovery(run))) return false;
  // Keep the immutable latch live even when the original outbox already
  // settled before a gateway crash. Once recovery attaches a control under
  // this run key, repeated calls deliver cancellation to that exact owner.
  cancelledRunTokens.add(run.runKey);
  return await cancelAgentRun(run.runKey);
}

async function settleDurableCancelForAbsentOwner(
  run: ActiveRunRecord,
): Promise<boolean> {
  if (!run.osSessionId) return false;
  const cancel = (await sessionTurnSnapshot(run.osSessionId)).cancel;
  if (cancel?.runId === run.runKey && cancel.phase !== "settled") {
    await sessionTurn({
      op: "settle_cancel",
      sessionId: run.osSessionId,
      cancelId: cancel.cancelId,
      outcome: "confirmed",
    });
  }
  // A queue interrupt records its cancellation fence in delivery state rather
  // than session_kernel_turn.cancel. Once the host probe has positively proved
  // this exact journal lineage absent, a stopped actor is sufficient authority
  // to retire it; without the host proof this would be unsafe.
  if (
    cancel?.runId !== run.runKey &&
    getRunState(run.osSessionId) !== "stopped"
  )
    return false;
  journalClearIfLineage(run);
  return true;
}

export async function resumeInterruptedRuns(
  onResumed?: (
    osSessionId?: string,
    terminalEvent?: StreamEvent,
    run?: ActiveRunRecord,
  ) => void | Promise<void>,
  askHandlerFor?: (osSessionId: string) => AskHandler | undefined,
  inProcessMcpFor?: (
    osSessionId: string,
    user?: string,
  ) => Record<string, unknown> | undefined,
  reposNoteFor?: (osSessionId: string) => string | undefined,
  onEvent?: (osSessionId: string, event: StreamEvent) => void | Promise<void>,
  snapshotLocalHostRuns: ActiveRunRecord[] = [],
  deferRecovery?: (run: ActiveRunRecord) => boolean | Promise<boolean>,
): Promise<string[]> {
  const resumed: string[] = [];
  const settledRunKeys = new Set<string>();
  const settlingRunKeys = new Set<string>();
  const rememberHandledSession = (run: ActiveRunRecord) => {
    if (run.osSessionId && !resumed.includes(run.osSessionId))
      resumed.push(run.osSessionId);
  };
  const emitRecoveryEvent = async (
    run: ActiveRunRecord,
    event: StreamEvent,
  ): Promise<void> => {
    if (!run.osSessionId) return;
    try {
      await onEvent?.(run.osSessionId, event);
    } catch (e) {
      console.error(
        `[runner] Recovered event observer failed for ${run.runKey}:`,
        e,
      );
    }
  };
  const settleRecovery = async (
    run: ActiveRunRecord,
    event: StreamEvent,
  ): Promise<boolean> => {
    if (settledRunKeys.has(run.runKey) || settlingRunKeys.has(run.runKey))
      return false;
    settlingRunKeys.add(run.runKey);
    rememberHandledSession(run);
    try {
      await emitRecoveryEvent(run, event);
      try {
        await onResumed?.(run.osSessionId, event, run);
      } catch (e) {
        console.error(
          `[runner] Recovery settlement callback failed for ${run.runKey}:`,
          e,
        );
      }
      if (run.osSessionId) {
        const cancel = (await sessionTurnSnapshot(run.osSessionId)).cancel;
        if (cancel?.runId === run.runKey && cancel.phase !== "settled")
          await sessionTurn({
            op: "settle_cancel",
            sessionId: run.osSessionId,
            cancelId: cancel.cancelId,
            outcome: "confirmed",
          });
      }
      if (
        run.osSessionId &&
        isRunStateUnsettled(getRunState(run.osSessionId))
      ) {
        const failed = event.type === "error" || !!event.usageLimitExhausted;
        await transitionRunState(
          run.osSessionId,
          failed ? "run_failed" : "turn_end",
          {
            run_key: run.runKey,
            source: "recovery_fallback_settlement",
          },
        );
      }
      journalClear(run.runKey);
      settledRunKeys.add(run.runKey);
      if (!activeRecoveryWorkerRunKeys.has(run.runKey)) untrackRecovery(run);
      return true;
    } finally {
      settlingRunKeys.delete(run.runKey);
    }
  };
  const reportRecoveryFailure = async (
    run: ActiveRunRecord,
    content: string,
  ) => {
    await settleRecovery(run, {
      type: "error",
      content,
      model: run.model,
    });
  };
  const recoveryStillOwnsJournal = (run: ActiveRunRecord): boolean => {
    const expectedLineage = run.firstJournaledAt || run.startedAt;
    return activeRunRecords().some(
      (current) =>
        current.runKey === run.runKey &&
        current.osSessionId === run.osSessionId &&
        (current.firstJournaledAt || current.startedAt) === expectedLineage,
    );
  };
  const abandonStoppedRecovery = async (
    run: ActiveRunRecord,
    cancelOwnership: "owned" | "none" | "unknown",
  ): Promise<boolean> => {
    const stopped =
      !!run.osSessionId && getRunState(run.osSessionId) === "stopped";
    const detached = !!(run.hostId || run.runnerId || run.sandboxId);
    // The durable effect owns this exact physical dispatch. Keep recovery
    // attached and its journal intact until cancellation and natural source
    // completion retire it.
    if (cancelOwnership === "unknown") {
      // Actor uncertainty is neither proof of absence nor authority to cancel.
      // Park every recovery shape with its lineage intact until ownership can
      // be read; never attach or create replacement execution while ambiguous.
      return true;
    }
    if (cancelOwnership === "owned") {
      // Detached physical owners must be attached and repeatedly cancelled,
      // including after a crash that followed actor settlement but preceded
      // source completion. A pre-engine in-process journal has no surviving
      // process after this boot and must never be re-run.
      if (detached) await reissueDurableRecoveryCancel(run);
      return !detached;
    }
    const cancelled = cancelledRecoveries.delete(run);
    if (!cancelled && !stopped) return false;
    // Actor state can prove that the logical turn stopped, but it cannot prove
    // a detached physical owner exited. Reattach/probe the exact host lineage
    // before clearing its journal; otherwise a queue successor can overlap a
    // still-running predecessor.
    if (detached) return false;
    journalClearIfLineage(run);
    return true;
  };
  const checkpointStoppedRecovery = async (
    run: ActiveRunRecord,
  ): Promise<boolean> => {
    let ownershipBackoffMs = 100;
    const ownershipDeadline = Date.now() + 15_000;
    let ownership = await durableCancelRecoveryOwnership(run);
    while (ownership === "unknown" && Date.now() < ownershipDeadline) {
      // Keep the bounded worker, attached source, and lineage alive. Every
      // checkpoint retries actor ownership instead of one-shot abandoning.
      if (isShuttingDown()) return true;
      await Bun.sleep(ownershipBackoffMs);
      ownershipBackoffMs = Math.min(5_000, ownershipBackoffMs * 2);
      ownership = await durableCancelRecoveryOwnership(run);
    }
    if (ownership === "unknown") {
      console.error(
        `[runner] Parking recovery ${run.runKey}: kernel ownership remained unavailable`,
      );
      return true;
    }
    const abandoned = await abandonStoppedRecovery(run, ownership);
    if (
      !abandoned &&
      run.osSessionId &&
      getRunState(run.osSessionId) === "stopped" &&
      (run.hostId || run.runnerId || run.sandboxId)
    ) {
      // Before attach this is a harmless no-op; after attach it reaches the
      // physical owner by immutable run/host aliases. Keep consuming recovery
      // until terminal evidence arrives instead of dropping journal ownership.
      cancelRecoveredEngine(run);
    }
    return abandoned;
  };
  const recoveryTask = (
    run: ActiveRunRecord,
    task: (releaseQueueSlot: () => void) => Promise<void>,
  ): (() => Promise<void>) => {
    // A claimed journal record is intentionally durable, but the recovery
    // queue is bounded, so a run can sit here behind other recoveries. It
    // must never be declared dead for that reason: its engine turn is still
    // executing on a detached server that outlived the restart, so telling
    // the person "send the prompt again" left the predecessor working and put
    // TWO engines in one worktree (2026-08-16). Start it instead, outside the
    // queue, which is the one thing a starved recovery actually needs.
    let started = false;
    let queuedTooLong: ReturnType<typeof setTimeout> | undefined;
    const start = async () => {
      if (started || isShuttingDown()) return;
      started = true;
      clearTimeout(queuedTooLong);
      if (settledRunKeys.has(run.runKey)) {
        // Never reaches the worker's finally, so drain the stop marker here.
        cancelledRecoveries.delete(run);
        return;
      }
      activeRecoveryWorkerRunKeys.add(run.runKey);
      let releaseQueueSlot!: () => void;
      const slotFree = new Promise<void>((resolve) => {
        releaseQueueSlot = resolve;
      });
      // The task keeps running after it frees its slot; only the QUEUE's
      // accounting ends early. Its own try/finally still owns the recovery
      // lifetime (worker key, untrackRecovery), so nothing else moves.
      void (async () => {
        try {
          await task(releaseQueueSlot);
        } catch (error) {
          // Keep one unexpected recovery failure from stranding the rest of the
          // boot queue behind it. Normal recovery paths already report their own
          // failures, so this is only the last-resort guard.
          console.error(
            `[runner] Recovery worker crashed for ${run.runKey}:`,
            error,
          );
          if (!settledRunKeys.has(run.runKey))
            await reportRecoveryFailure(
              run,
              "Restart recovery stopped unexpectedly. Send the prompt again to continue.",
            );
        } finally {
          activeRecoveryWorkerRunKeys.delete(run.runKey);
          untrackRecovery(run);
          // abandonStoppedRecovery is what normally drains the stop marker,
          // but only on the paths that reach it: a recovery that ended with a
          // terminal event can stop polling first. Drain unconditionally here
          // so a cancelled recovery cannot hold its record for the process
          // lifetime. Safe after untrackRecovery: cancelAgentRun can no
          // longer find this run to mark it again.
          cancelledRecoveries.delete(run);
          releaseQueueSlot();
        }
      })();
      await slotFree;
    };
    queuedTooLong = setTimeout(() => {
      if (started || settledRunKeys.has(run.runKey)) return;
      console.warn(
        `[runner] Restart recovery for ${run.runKey} waited ${BOOT_RECOVERY_QUEUE_WAIT_MS / 60_000} minutes for a queue slot — starting it outside the queue`,
      );
      audit({
        kind: "restart_recovery_promoted",
        session_id: run.osSessionId,
        run_key: run.runKey,
        waited_ms: BOOT_RECOVERY_QUEUE_WAIT_MS,
      });
      void start();
    }, BOOT_RECOVERY_QUEUE_WAIT_MS);
    return start;
  };
  const cancelRecoveredEngine = (run: ActiveRunRecord): void => {
    for (const id of [run.claudeSessionId, run.osSessionId, run.runKey]) {
      if (!id) continue;
      cancelPiRun(id);
      hostCancel(id);
    }
  };
  const snapshotSeeds = snapshotLocalHostRuns.filter(
    (run) => !!run.hostId && !run.sandboxId && !run.runnerId,
  );
  const candidates = await takeInterruptedRuns(
    snapshotSeeds,
    async (run) =>
      !run.osSessionId || !(await sessionQuarantineSnapshot(run.osSessionId)),
  );
  const taken: ActiveRunRecord[] = [];
  for (const run of candidates) {
    if (!(await deferRecovery?.(run))) taken.push(run);
  }
  // A graceful shutdown snapshot is intentionally broader than the shared
  // run journal: it also covers turns that finish during the drain. A local
  // detached host can still be alive even when its shared record disappeared
  // during process teardown. Seed those snapshot records into the atomic boot
  // claim so resumeLocalHostRun owns them synchronously and the generic
  // drained-session wake cannot start a second host for the same turn.
  const { interrupted, quarantined } = sanitizeInterruptedRuns(taken);
  journalQuarantine(quarantined);
  for (const entry of quarantined) {
    if (!entry.notify || !entry.run.osSessionId) continue;
    await reportRecoveryFailure(entry.run, recoveryQuarantineMessage(entry));
  }
  const recoveryTasks: Array<() => Promise<void>> = [];

  for (const run of interrupted) {
    if (run.terminalFailure) {
      await reportRecoveryFailure(run, run.terminalFailure.content);
      continue;
    }
    // Detached review turns are consumed by the GitHub agent's persisted
    // activeRun workflow. Leave their journal record intact so runReview can
    // reattach the same host and continue through parsing and GitHub posting.
    // Counting the session as handled prevents the generic drained-session wake
    // from starting a second turn while that owner is recovering it.
    if (run.hostId && run.kind?.startsWith("github-review")) {
      rememberHandledSession(run);
      continue;
    }
    // Other GitHub behaviors still own their recovery (simplify re-trigger on
    // the next PR event; auto-fix loops are resumed by the GitHub startup
    // sweep). Resuming them generically would double-drive an auto-fix loop.
    if (run.kind?.startsWith("github-")) {
      rememberHandledSession(run);
      journalClear(run.runKey);
      if (run.osSessionId)
        await transitionRunState(run.osSessionId, "turn_end");
      continue;
    }
    // Slack runs journal (their bks session id feeds the in-process MCP proxy
    // path), but the Slack queue re-delivers interrupted messages itself — a
    // generic resume would double-drive the turn with no streamer attached.
    if (run.kind?.startsWith("slack")) {
      rememberHandledSession(run);
      journalClear(run.runKey);
      if (run.osSessionId)
        await transitionRunState(run.osSessionId, "turn_end");
      continue;
    }
    // Workflow fan-out agents ("workflow", plus -resume/-rerun suffixes): the
    // orchestration state (the script's Worker) died with the process — the
    // workflow store marks the run interrupted on boot, and replaying a lone
    // child agent without its script would be noise.
    if (run.kind?.startsWith("workflow")) {
      rememberHandledSession(run);
      journalClear(run.runKey);
      if (run.osSessionId)
        await transitionRunState(run.osSessionId, "turn_end");
      continue;
    }
    // Runner hosts are persistent, outbound-dial run hosts just like remote
    // Sandboxes. Reattach through their Runner control channel only. A failed
    // reattach must never fall through to an in-process server run, because
    // that would silently change the selected execution machine.
    if (run.runnerId) {
      rememberHandledSession(run);
      trackRecovery(run);
      recoveryTasks.push(
        recoveryTask(run, async (releaseQueueSlot) => {
          let terminalSeen = false;
          try {
            if (await checkpointStoppedRecovery(run)) return;
            Object.assign(run, journalStartRecovery(run));
            const events = await (
              await import("./runner-session")
            ).resumeRunnerRun(run, {
              onAskUser: run.osSessionId
                ? askHandlerFor?.(run.osSessionId)
                : undefined,
            });
            if (await checkpointStoppedRecovery(run)) return;
            if (!events) {
              await reportRecoveryFailure(
                run,
                "Restart recovery could not reconnect to the interrupted Runner. Check its connection, then send the prompt again.",
              );
              return;
            }
            // The runner is attached and will keep streaming independently of
            // boot recovery. Do not make later recoveries wait for its turn.
            releaseQueueSlot();
            for await (const event of events) {
              if (await checkpointStoppedRecovery(run)) return;
              markRecoveryProgress(run, event);
              if (event.type === "done" || event.type === "error") {
                terminalSeen =
                  (await settleRecovery(run, event)) || terminalSeen;
              } else await emitRecoveryEvent(run, event);
            }
            if (await checkpointStoppedRecovery(run)) return;
            if (!terminalSeen) {
              await reportRecoveryFailure(
                run,
                "Restart recovery ended before the Runner returned a final result. Send the prompt again to continue.",
              );
            }
          } catch (error) {
            console.error(
              `[runner] Runner resume failed for ${run.runKey}:`,
              error,
            );
            if (await checkpointStoppedRecovery(run)) return;
            if (!terminalSeen) {
              await reportRecoveryFailure(
                run,
                "Restart recovery failed while reconnecting to the Runner. Check its connection, then send the prompt again.",
              );
            }
          }
        }),
      );
      continue;
    }
    // Sandboxed runs (docs/self-hosting-sandboxes.md): the sandbox — and
    // often the in-sandbox run host itself — outlives a opensession restart.
    // Reattach/relaunch through the provider instead of running in-process;
    // the sandbox modules are imported lazily so these paths stay completely
    // out of processes that never touch them.
    if (
      run.sandboxId &&
      (run.sandboxProvider === "docker" ||
        run.sandboxProvider === "daytona" ||
        run.sandboxProvider === "e2b" ||
        run.sandboxProvider === "box" ||
        run.sandboxProvider === "modal" ||
        run.sandboxProvider === "microvm" ||
        run.sandboxProvider === "lambda-microvm")
    ) {
      const isDocker = run.sandboxProvider === "docker";
      rememberHandledSession(run);
      trackRecovery(run);
      recoveryTasks.push(
        recoveryTask(run, async (releaseQueueSlot) => {
          const recoveryStartedAt = Date.now();
          let recoveryRecorded = false;
          let terminalSeen = false;
          const recordRecovery = (
            outcome: "ok" | "failed",
            reason?: string,
          ) => {
            if (recoveryRecorded) return;
            recoveryRecorded = true;
            audit({
              kind: "sandbox_restart_survival_metric",
              session_id: run.osSessionId,
              provider: run.sandboxProvider,
              sandbox_id: run.sandboxId,
              recovery_ms: Date.now() - recoveryStartedAt,
              outcome,
              ...(reason ? { reason } : {}),
            });
          };
          try {
            if (await checkpointStoppedRecovery(run)) return;
            Object.assign(run, journalStartRecovery(run));
            const resume = isDocker
              ? (await import("./sandbox/docker")).resumeDockerSandboxRun
              : (await import("./sandbox/adapters/bootstrap"))
                  .resumeRemoteSandboxRun;
            if (await checkpointStoppedRecovery(run)) return;
            const events = await resume(run, {
              onAskUser: run.osSessionId
                ? askHandlerFor?.(run.osSessionId)
                : undefined,
            });
            if (await checkpointStoppedRecovery(run)) {
              cancelRecoveredEngine(run);
              return;
            }
            if (!events) {
              console.warn(
                `[runner] Sandbox ${run.sandboxId} for interrupted run ${run.runKey} is gone — the session's next prompt recreates it`,
              );
              await reportRecoveryFailure(
                run,
                "Restart recovery could not reconnect to the interrupted sandbox. Send the prompt again to continue.",
              );
              recordRecovery("failed", "sandbox_unavailable");
              return;
            }
            // The sandbox host is attached. Its model turn can continue while
            // the boot queue starts the next interrupted session.
            releaseQueueSlot();
            for await (const event of events) {
              if (await checkpointStoppedRecovery(run)) return;
              markRecoveryProgress(run, event);
              if (event.type === "done" || event.type === "error") {
                terminalSeen =
                  (await settleRecovery(run, event)) || terminalSeen;
                recordRecovery(
                  event.type === "done" ? "ok" : "failed",
                  event.type,
                );
              } else await emitRecoveryEvent(run, event);
            }
            if (await checkpointStoppedRecovery(run)) return;
            if (!terminalSeen) {
              await reportRecoveryFailure(
                run,
                "Restart recovery ended before the interrupted sandbox returned a final result. Send the prompt again to continue.",
              );
              recordRecovery("failed", "stream_ended_without_terminal_event");
            }
          } catch (e) {
            recordRecovery("failed", "recovery_error");
            console.error(
              `[runner] Sandbox resume failed for ${run.runKey}:`,
              e,
            );
            if (await checkpointStoppedRecovery(run)) return;
            if (!terminalSeen)
              await reportRecoveryFailure(
                run,
                "Restart recovery failed while reconnecting to the interrupted sandbox. Send the prompt again to continue.",
              );
          }
        }),
      );
      continue;
    }
    // LOCAL detached run hosts (in-process engines: pi). The host process
    // outlived the restart in its own transient systemd unit; reattach to its
    // socket and re-pump the live turn. A host that is gone (crashed mid-run,
    // dir cleaned up) falls back to the classic continuation re-prompt right
    // here: unlike sandboxes/Runners there is no execution boundary to
    // respect. The engine session lives in shared state on this machine, so
    // an in-process resume is exactly the pre-detach recovery behavior.
    if (run.hostId && !run.sandboxId && !run.runnerId) {
      rememberHandledSession(run);
      trackRecovery(run);
      recoveryTasks.push(
        recoveryTask(run, async (releaseQueueSlot) => {
          let terminalSeen = false;
          try {
            if (await checkpointStoppedRecovery(run)) return;
            Object.assign(run, journalStartRecovery(run));
            if (run.osSessionId && !(await durableCancelOwnsRecovery(run)))
              await transitionRunState(run.osSessionId, "reattach_start", {
                run_key: run.runKey,
              });
            const resumeLocalHost =
              localHostResumeForTest ??
              (await import("./host-client")).resumeLocalHostRun;
            const reattached = await resumeLocalHost(run, {
              onAskUser: run.osSessionId
                ? askHandlerFor?.(run.osSessionId)
                : undefined,
            }).catch((e) => {
              console.warn(
                `[runner] Local host reattach failed for ${run.runKey}:`,
                e,
              );
              return "uncertain" as const;
            });
            if (await checkpointStoppedRecovery(run)) {
              cancelRecoveredEngine(run);
              return;
            }
            if (reattached === "uncertain") {
              console.warn(
                `[runner] Local run host ${run.hostId} is not connectable but is not proven dead; preserving recovery state`,
              );
              return;
            }
            if (run.osSessionId && !(await durableCancelOwnsRecovery(run)))
              await transitionRunState(
                run.osSessionId,
                reattached ? "reattach_ok" : "reattach_fail",
                { run_key: run.runKey },
              );
            if (reattached) {
              Object.assign(run, journalMarkRecoveryAttached(run) || {});
              // Reaching this point proves the detached host is connected and this
              // worker owns its stream. The turn can remain quiet for minutes while
              // the model is working, so do not hold the single boot-admission slot
              // until its next event. Other already-live hosts must be allowed to
              // attach immediately as well.
              releaseQueueSlot();
            }
            let events = reattached;
            if (!events) {
              // The launcher positively proved this cancelled host absent. Settle
              // actor ownership before retiring its journal and never resurrect
              // the stopped turn as a fresh engine run.
              if (await settleDurableCancelForAbsentOwner(run)) return;
              if (!run.prompt && !run.claudeSessionId) {
                await reportRecoveryFailure(
                  run,
                  "Restart recovery could not reconnect to the detached run host and had nothing to resume. Send the prompt again to continue.",
                );
                return;
              }
              if (run.osSessionId)
                await transitionRunState(run.osSessionId, "resume_reprompt", {
                  run_key: run.runKey,
                });
              // The replacement reuses this proven-absent lineage key so terminal
              // projection remains fenced to the actor owner. Drop the host record.
              journalClear(run.runKey);
              console.log(
                `[runner] Local run host ${run.hostId} is gone; resuming ${run.osSessionId || run.runKey} in-process`,
              );
              events = runAgent({
                prompt: run.claudeSessionId
                  ? resumeContinuationPrompt(run.prompt || "")
                  : run.prompt!,
                promptEntryId: run.claudeSessionId
                  ? undefined
                  : run.promptEntryId,
                startToken: run.runKey,
                sessionId: run.claudeSessionId || undefined,
                cwd: run.cwd,
                mode: run.mode,
                model: run.model,
                selectedModel: run.selectedModel,
                transientFallback: run.transientFallback,
                effort: run.effort,
                fastMode: run.fastMode,
                mcpServers: run.mcpServers ?? "all",
                inProcessMcp: run.osSessionId
                  ? inProcessMcpFor?.(run.osSessionId, run.user)
                  : undefined,
                reposNote: run.osSessionId
                  ? reposNoteFor?.(run.osSessionId)
                  : undefined,
                user: run.user,
                deniedTools: run.deniedTools,
                publicationPolicy: run.publicationPolicy,
                confirmTools: run.confirmTools,
                aws: run.aws,
                fallbackModel: run.fallbackModel,
                accountId: run.accountId,
                accountStrict: run.accountStrict,
                usageCredits: run.usageCredits,
                journal: {
                  osSessionId: run.osSessionId,
                  kind: recoveryKind(run.kind, "resume"),
                  firstJournaledAt: run.firstJournaledAt,
                  resumeAttempts: run.resumeAttempts,
                  lastResumeAt: run.lastResumeAt,
                },
                onAskUser: run.osSessionId
                  ? askHandlerFor?.(run.osSessionId)
                  : undefined,
              });
            }
            for await (const event of events) {
              // A fallback re-prompt is lazy. Its first event proves that the
              // engine has started. A live host released the slot when attached.
              releaseQueueSlot();
              if (await checkpointStoppedRecovery(run)) return;
              markRecoveryProgress(run, event);
              if (event.type === "done" || event.type === "error") {
                terminalSeen =
                  (await settleRecovery(run, event)) || terminalSeen;
              } else await emitRecoveryEvent(run, event);
            }
            if (await checkpointStoppedRecovery(run)) return;
            if (!terminalSeen && recoveryStillOwnsJournal(run)) {
              await reportRecoveryFailure(
                run,
                "Restart recovery ended before the detached run host returned a final result. Send the prompt again to continue.",
              );
            }
          } catch (e) {
            console.error(
              `[runner] Local host resume failed for ${run.runKey}:`,
              e,
            );
            if (await checkpointStoppedRecovery(run)) return;
            if (!terminalSeen && recoveryStillOwnsJournal(run))
              await reportRecoveryFailure(
                run,
                "Restart recovery failed while reconnecting to the detached run host. Send the prompt again to continue.",
              );
          }
        }),
      );
      continue;
    }
    if (!run.claudeSessionId) {
      // No engine session id means the run died before the model produced its
      // first turn (e.g. during MCP startup) — so nothing actually ran and no
      // side effects happened. If we journaled the original prompt we can safely
      // re-run it from scratch; otherwise it's genuinely unrecoverable.
      if (!run.prompt) {
        console.warn(
          `[runner] Interrupted run ${run.runKey} (${run.kind || "unknown"}) had no engine session and no saved prompt — cannot resume`,
        );
        await reportRecoveryFailure(
          run,
          "Restart recovery could not continue this turn because it had not saved an engine session or original prompt. Send the prompt again to continue.",
        );
        continue;
      }
      rememberHandledSession(run);
      trackRecovery(run);
      console.log(
        `[runner] Re-running interrupted ${run.kind || "run"} ${run.osSessionId || run.runKey} from scratch (never got an engine session)`,
      );
      recoveryTasks.push(
        recoveryTask(run, async (releaseQueueSlot) => {
          let terminalSeen = false;
          try {
            if (await checkpointStoppedRecovery(run)) return;
            Object.assign(run, journalStartRecovery(run));
            if (run.osSessionId)
              await transitionRunState(run.osSessionId, "resume_reprompt", {
                run_key: run.runKey,
              });
            // The replacement reuses this proven-absent lineage key. Drop the
            // claimed record now (runAgent's intake journalSet is the very next step,
            // so the unprotected window is one generator start, not the whole
            // adoption+probe phase the old wipe-on-take left open).
            journalClear(run.runKey);
            for await (const event of runAgent({
              prompt: run.prompt!,
              promptEntryId: run.promptEntryId,
              startToken: run.runKey,
              cwd: run.cwd,
              mode: run.mode,
              model: run.model,
              selectedModel: run.selectedModel,
              transientFallback: run.transientFallback,
              effort: run.effort,
              fastMode: run.fastMode,
              mcpServers: run.mcpServers ?? "all",
              inProcessMcp: run.osSessionId
                ? inProcessMcpFor?.(run.osSessionId, run.user)
                : undefined,
              reposNote: run.osSessionId
                ? reposNoteFor?.(run.osSessionId)
                : undefined,
              user: run.user,
              deniedTools: run.deniedTools,
              publicationPolicy: run.publicationPolicy,
              confirmTools: run.confirmTools,
              aws: run.aws,
              claudeCliEnv: run.claudeCliEnv,
              codexCliEnv: run.codexCliEnv,
              fallbackModel: run.fallbackModel,
              accountId: run.accountId,
              accountStrict: run.accountStrict,
              usageCredits: run.usageCredits,
              prReviewer: run.prReviewer,
              journal: {
                osSessionId: run.osSessionId,
                kind: recoveryKind(run.kind, "rerun"),
                firstJournaledAt: run.firstJournaledAt,
                resumeAttempts: run.resumeAttempts,
                lastResumeAt: run.lastResumeAt,
              },
              onAskUser: run.osSessionId
                ? askHandlerFor?.(run.osSessionId)
                : undefined,
            })) {
              // `runAgent` is lazy. Free the bounded boot slot only after its
              // first event confirms the replacement engine is running.
              releaseQueueSlot();
              if (await checkpointStoppedRecovery(run)) return;
              markRecoveryProgress(run, event);
              if (event.type === "done" || event.type === "error") {
                terminalSeen =
                  (await settleRecovery(run, event)) || terminalSeen;
              } else await emitRecoveryEvent(run, event);
            }
            if (await checkpointStoppedRecovery(run)) return;
            if (!terminalSeen)
              await reportRecoveryFailure(
                run,
                "Restart recovery ended before the interrupted turn returned a final result. Send the prompt again to continue.",
              );
          } catch (e) {
            console.error(`[runner] Re-run failed for ${run.runKey}:`, e);
            if (await checkpointStoppedRecovery(run)) return;
            if (!terminalSeen)
              await reportRecoveryFailure(
                run,
                "Restart recovery failed while restarting the interrupted turn. Send the prompt again to continue.",
              );
          }
        }),
      );
      continue;
    }
    rememberHandledSession(run);
    trackRecovery(run);
    recoveryTasks.push(
      recoveryTask(run, async (releaseQueueSlot) => {
        let recoverySettled = false;
        try {
          if (await checkpointStoppedRecovery(run)) return;
          Object.assign(run, journalStartRecovery(run));
          let repairingRecoveredResult = false;
          console.log(
            repairingRecoveredResult
              ? `[runner] Repairing recovered result for ${run.osSessionId || run.runKey}`
              : `[runner] Resuming interrupted ${run.kind || "run"} ${run.osSessionId || run.runKey} (started ${run.startedAt}, model ${run.model || "default"})`,
          );
          if (run.osSessionId && !repairingRecoveredResult)
            await transitionRunState(run.osSessionId, "resume_reprompt", {
              run_key: run.runKey,
            });
          if (await checkpointStoppedRecovery(run)) return;
          // The continuation reuses this proven-absent lineage key. Drop the
          // claimed record only now, AFTER the reattach probe settled: dying
          // mid-probe used to lose the run to the wipe-on-take (2026-07-27).
          journalClear(run.runKey);
          for await (const event of runAgent({
            prompt: repairingRecoveredResult
              ? wrapContext(
                  recoveredResultContinuationPrompt(run.prompt),
                  "restart-recovery",
                )
              : restartContinuationPrompt(run.prompt),
            startToken: run.runKey,
            sessionId: run.claudeSessionId,
            cwd: run.cwd,
            mode: run.mode,
            model: run.model,
            selectedModel: run.selectedModel,
            transientFallback: run.transientFallback,
            effort: run.effort,
            fastMode: run.fastMode,
            mcpServers: run.mcpServers ?? "all",
            inProcessMcp: run.osSessionId
              ? inProcessMcpFor?.(run.osSessionId, run.user)
              : undefined,
            reposNote: run.osSessionId
              ? reposNoteFor?.(run.osSessionId)
              : undefined,
            user: run.user,
            deniedTools: run.deniedTools,
            publicationPolicy: run.publicationPolicy,
            confirmTools: run.confirmTools,
            aws: run.aws,
            claudeCliEnv: run.claudeCliEnv,
            codexCliEnv: run.codexCliEnv,
            fallbackModel: run.fallbackModel,
            accountId: run.accountId,
            accountStrict: run.accountStrict,
            usageCredits: run.usageCredits,
            prReviewer: run.prReviewer,
            journal: {
              osSessionId: run.osSessionId,
              kind: recoveryKind(run.kind, "resume"),
              firstJournaledAt: run.firstJournaledAt,
              resumeAttempts: run.resumeAttempts,
              lastResumeAt: run.lastResumeAt,
            },
            onAskUser: run.osSessionId
              ? askHandlerFor?.(run.osSessionId)
              : undefined,
          })) {
            // A recovery slot guards startup, not the whole agent turn. Once
            // the engine emits, later interrupted sessions may begin recovery.
            releaseQueueSlot();
            if (await checkpointStoppedRecovery(run)) return;
            markRecoveryProgress(run, event);
            if (event.type === "done" || event.type === "error") {
              recoverySettled =
                (await settleRecovery(run, event)) || recoverySettled;
            } else await emitRecoveryEvent(run, event);
          }
          if (await checkpointStoppedRecovery(run)) return;
          if (!recoverySettled)
            await reportRecoveryFailure(
              run,
              "Restart recovery ended before the interrupted turn returned a final result. Send the prompt again to continue.",
            );
        } catch (e) {
          console.error(`[runner] Resume failed for ${run.runKey}:`, e);
          if (await checkpointStoppedRecovery(run)) return;
          if (!recoverySettled)
            await reportRecoveryFailure(
              run,
              "Restart recovery failed while continuing the interrupted turn. Send the prompt again to continue.",
            );
        }
      }),
    );
  }

  runRecoveryQueue(recoveryTasks);

  return resumed;
}

// Recovery admission performs several synchronous compatibility calls before
// the detached engine yields its first event. More than one admission at once
// can therefore monopolize the gateway even though the turns themselves run
// out of process. Serialize only this short startup phase; each task releases
// its slot as soon as its engine is live.
export const BOOT_RECOVERY_CONCURRENCY = 1;
export const BOOT_RECOVERY_ADMISSION_DELAY_MS = 100;
// How long a recovery may wait for a queue slot before it is started anyway,
// outside the queue. Long enough that a busy restart drains its legitimate
// work first; bounded because the alternative — waiting forever — leaves a
// live engine turn nobody is following. It is deliberately NOT a deadline
// after which the run is declared dead: the engine is still executing.
export let BOOT_RECOVERY_QUEUE_WAIT_MS = 10 * 60 * 1000;

/** Test seam: shorten the queue wait so the promotion path is observable
 *  without a ten-minute test. Returns the previous value. */
export function __setRecoveryQueueWaitMsForTest(ms: number): number {
  const prev = BOOT_RECOVERY_QUEUE_WAIT_MS;
  BOOT_RECOVERY_QUEUE_WAIT_MS = ms;
  return prev;
}
export const MAX_BOOT_RESUME_ATTEMPTS = 2;
export const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;

/** Collapse the complete operational suffix chain so recovery after a model
 * fallback never grows `prompt-resume-fallback-resume`. Keep one fallback
 * marker for audit/policy consumers, regardless of how many hops preceded the
 * restart. */
export function recoveryKind(
  kind: string | undefined,
  suffix: "resume" | "rerun",
): string {
  const current = kind || "run";
  const chain = current.match(/(?:(?:-resume|-rerun|-fallback))+$/)?.[0] || "";
  const base = chain ? current.slice(0, -chain.length) : current;
  return `${base}-${suffix}${chain.includes("-fallback") ? "-fallback" : ""}`;
}

/** A recovery attempt becomes healthy once the resumed model produces
 * user-visible work. Reset the consecutive-failure fuse at that point so a
 * later service restart recovers the live turn rather than mistaking it for a
 * repeatedly failing boot loop. Transport init and notices do not count. */
export function markRecoveryProgress(
  run: ActiveRunRecord,
  event: StreamEvent,
): boolean {
  if (
    (run.resumeAttempts ?? 0) <= 0 ||
    (event.type !== "text_chunk" &&
      event.type !== "tool_use" &&
      event.type !== "tool_result")
  ) {
    return false;
  }
  const progressed = journalMarkRecoveryAttached(run);
  if (!progressed) return false;
  Object.assign(run, progressed);
  return true;
}

/** One boot recovery per owning session, newest journal record wins. Records
 * without a session id remain independently recoverable by run key. Once
 * deduplicated, recover every valid run, oldest first: a restart during a busy
 * boot must not keep inserting newer work ahead of a session that has already
 * waited through one or more recovery sweeps. Startup load stays bounded by
 * the recovery queue rather than by discarding work. */
export function sanitizeInterruptedRuns(
  runs: ActiveRunRecord[],
  now = Date.now(),
): {
  interrupted: ActiveRunRecord[];
  quarantined: QuarantinedRun[];
} {
  const newest = new Map<string, ActiveRunRecord>();
  const quarantined: QuarantinedRun[] = [];
  for (const run of runs) {
    const recoverySuffixes = run.kind?.match(/-(?:resume|rerun)/g)?.length ?? 0;
    // Older builds could interleave fallback and recovery markers even when
    // durable resumeAttempts proved the lineage was bounded. Reject only
    // legacy recursive records that have no trustworthy attempt counter.
    if (recoverySuffixes > 1 && run.resumeAttempts === undefined) {
      quarantined.push({
        run,
        reason: "recursive_recovery_kind",
        notify: true,
      });
      continue;
    }
    const resumeAttempts = run.resumeAttempts ?? recoverySuffixes;
    if (resumeAttempts >= MAX_BOOT_RESUME_ATTEMPTS) {
      quarantined.push({
        run,
        reason: "resume_attempts_exhausted",
        notify: true,
      });
      continue;
    }
    const firstJournaled = Date.parse(
      run.firstJournaledAt || run.startedAt || "",
    );
    if (
      !Number.isFinite(firstJournaled) ||
      now - firstJournaled > MAX_RECOVERY_AGE_MS
    ) {
      quarantined.push({ run, reason: "recovery_expired", notify: true });
      continue;
    }
    const key = run.osSessionId
      ? `session:${run.osSessionId}`
      : `run:${run.runKey}`;
    const prior = newest.get(key);
    if (!prior) {
      newest.set(key, run);
      continue;
    }
    const priorAt = Date.parse(prior.startedAt || "") || 0;
    const runAt = Date.parse(run.startedAt || "") || 0;
    if (runAt >= priorAt) {
      quarantined.push({
        run: prior,
        reason: "duplicate_session",
        notify: false,
      });
      newest.set(key, run);
    } else {
      quarantined.push({ run, reason: "duplicate_session", notify: false });
    }
  }
  const ordered = [...newest.values()].sort(
    (a, b) =>
      (Date.parse(a.startedAt || "") || 0) -
      (Date.parse(b.startedAt || "") || 0),
  );
  const interrupted = ordered;
  // A rejected stale record must not settle a session whose valid record will
  // still recover. When no valid record remains, notify once for the newest
  // rejected record instead of writing multiple terminal outcomes.
  const recoveringSessions = new Set(
    interrupted.flatMap((run) => (run.osSessionId ? [run.osSessionId] : [])),
  );
  const newestRejectedBySession = new Map<string, QuarantinedRun>();
  for (const entry of quarantined) {
    const sessionId = entry.run.osSessionId;
    if (!entry.notify || !sessionId) continue;
    if (recoveringSessions.has(sessionId)) {
      entry.notify = false;
      continue;
    }
    const prior = newestRejectedBySession.get(sessionId);
    const priorAt = Date.parse(prior?.run.startedAt || "") || 0;
    const entryAt = Date.parse(entry.run.startedAt || "") || 0;
    if (!prior || entryAt >= priorAt) {
      if (prior) prior.notify = false;
      newestRejectedBySession.set(sessionId, entry);
    } else {
      entry.notify = false;
    }
  }
  if (quarantined.length) {
    console.warn(
      `[runner] Restart recovery kept ${interrupted.length} unique run(s), quarantined ${quarantined.length} duplicate/unsafe record(s)`,
    );
  }
  return { interrupted, quarantined };
}

function recoveryQuarantineMessage(entry: QuarantinedRun): string {
  if (entry.reason === "resume_attempts_exhausted") {
    const attempts = entry.run.resumeAttempts ?? MAX_BOOT_RESUME_ATTEMPTS;
    const count = attempts === 2 ? "twice" : `${attempts} times`;
    return `Restart recovery failed ${count}. Send the prompt again to continue.`;
  }
  if (entry.reason === "recovery_expired") {
    return "Restart recovery expired. Send the prompt again to continue.";
  }
  return "Restart recovery could not continue safely. Send the prompt again to continue.";
}

export async function runRecoveryQueue(
  tasks: Array<() => Promise<void>>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    let admitted = false;
    while (next < tasks.length) {
      if (admitted) await Bun.sleep(BOOT_RECOVERY_ADMISSION_DELAY_MS);
      admitted = true;
      const task = tasks[next++];
      try {
        await task();
      } catch (error) {
        // A task normally reports and settles its own error. This guard keeps
        // a defensive exception from stopping the worker and starving every
        // remaining claimed recovery behind it.
        console.error("[runner] Recovery queue task failed:", error);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(BOOT_RECOVERY_CONCURRENCY, tasks.length) },
      worker,
    ),
  );
}

/** Same continuation prompt resumeInterruptedRuns uses — exported so the
 *  graceful-shutdown snapshot path can wake sessions that finished their turn
 *  during the drain (and so were cleared from the journal) with one consistent
 *  message. */
// Note: personaName() is read at module load (a persona rename needs a restart
// to reach this string — fine, runner internals need one anyway).
export const RESUME_CONTINUATION_PROMPT =
  `This session was interrupted by a ${personaName()} service restart mid-run. ` +
  "Review what you had already done, pick up where you left off, and finish the task. " +
  "If the work was actually complete, just post the final summary/answer.";

/**
 * Meridian can very occasionally close a post-restart turn with either no
 * final text or its internal tool-result envelope as assistant text (the
 * observed shape starts `[your bash …]:`) while still reporting a successful
 * `finish: stop`. Accepting either strands partial work without a conclusion.
 * Keep this deliberately narrow and bounded to one repair continuation.
 * The envelope shape lives in runner-shared (TOOL_RESULT_ENVELOPE_RE) and
 * covers any tool id — MCP tools included — not just the builtin set.
 */
export function recoveredResultNeedsContinuation(event: StreamEvent): boolean {
  if (event.type !== "done") return false;
  if (!event.result?.trim() || event.result === EMPTY_COMPLETION_RESULT)
    return true;
  return TOOL_RESULT_ENVELOPE_RE.test(event.result || "");
}

/** RESUME_CONTINUATION_PROMPT anchored to the interrupted turn's original
 *  prompt. A resume can land in a fresh engine session with no history (e.g.
 *  reattach failed and the re-prompt rotated to another account's server) —
 *  without an anchor the model reconstructs its task from repository state
 *  and can guess wrong (2026-07-24: an amnesiac ask session found its shared
 *  checkout on a teammate's PR branch and re-did that PR's review). */
export function resumeContinuationPrompt(
  originalPrompt?: string | null,
): string {
  const p = (originalPrompt || "").trim();
  if (!p) return RESUME_CONTINUATION_PROMPT;
  // A crash during a recovery journals the continuation prompt. Reusing it
  // verbatim prevents restart text nesting inside itself on every boot.
  if (p.startsWith(RESUME_CONTINUATION_PROMPT)) return p;
  const clamped = p.length > 2000 ? `${p.slice(0, 2000)}…` : p;
  return (
    `${RESUME_CONTINUATION_PROMPT}\n\n` +
    `For context, the prompt that started the interrupted turn was:\n` +
    `"""\n${clamped}\n"""\n` +
    "If you no longer see the earlier conversation, treat that prompt as the task " +
    "definition — do not infer the task from repository or checkout state."
  );
}

const RESTART_RECOVERY_OPEN = '<opensession:context source="restart-recovery">';

/** A restart continuation is harness input, not something the person said.
 * The engine receives it as a user-role turn, while transcript parsing strips
 * the fenced block and therefore keeps the conversation at one user message. */
export function restartContinuationPrompt(
  originalPrompt?: string | null,
): string {
  const p = (originalPrompt || "").trim();
  if (p.startsWith(RESTART_RECOVERY_OPEN)) return p;
  return wrapContext(
    resumeContinuationPrompt(originalPrompt),
    "restart-recovery",
  );
}

/** Build the next provider's turn without replaying the person's request.
 * Image turns are the exception: the fresh provider needs the image-bearing
 * message, and promptEntryId keeps its transcript row stable. */
export function fallbackContinuationPrompt(
  handoff: string,
  originalPrompt: string,
  hasImages: boolean,
): string {
  const context = wrapContext(handoff, "handoff");
  return hasImages ? `${context}\n\n${originalPrompt}` : context;
}

/** Preserve the original visible turn when an initialized source engine has
 * no readable transcript to hand over. The hint is runner context, not text
 * the person typed, so transcript projection strips it from the user row. */
function fallbackMissingHandoffPrompt(originalPrompt: string): string {
  return `${wrapContext(
    "A previous attempt on another model was cut short and may have left " +
      "partial work in this directory. Review what's already done before continuing.",
    "handoff",
  )}\n\n${originalPrompt}`;
}

function recoveredResultContinuationPrompt(
  originalPrompt?: string | null,
): string {
  const p = (originalPrompt || "").trim();
  const clamped = p.length > 2000 ? `${p.slice(0, 2000)}…` : p;
  return (
    "Your reattached turn ended without giving the user a usable final answer. " +
    "Review the work already completed in this session, finish anything still needed, and provide the actual concise answer or handoff now. " +
    "Do not merely repeat the last tool output." +
    (clamped
      ? `\n\nThe prompt that started the interrupted turn was:\n"""\n${clamped}\n"""`
      : "")
  );
}
