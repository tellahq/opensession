/**
 * Dynamic workflows — shared contracts.
 *
 * A workflow is a model-authored JS script (Claude Code Workflow-tool style:
 * `export const meta = {...}` + async body using agent()/parallel()/pipeline()/
 * phase()/log(), plus direct MCP tool calls) that fans out agent runs
 * deterministically. Tool calls are code mode at the tool layer rather than
 * the agent layer: one costs a round trip, not a model turn. The
 * script executes in a contained Bun Worker (src/server/workflow-worker.ts —
 * env-scrubbed and de-fanged, but exposure gating is the real trust boundary);
 * `agent()` calls bridge to the parent process, which executes them as plain
 * pi runs (kind "workflow") via runAgent and returns the result into the
 * script. A workflow agent remains a focused read/analyze/report worker;
 * heavier code + PR work uses spawnSession(), which delegates to the existing
 * durable SessionControl code-session infrastructure.
 *
 * Consumers:
 *  - workflow-runner.ts  — orchestration (worker lifecycle, semaphore, journal)
 *  - workflow-store.ts   — persistence (~/.opensession-workflows) + live registry
 *                          + workflow_update broadcasts
 *  - workflow-execute.ts — the real WorkflowExecutor on runAgent
 *  - workflow-mcp.ts     — the script's MCP host (transport + policy)
 *  - agents/slack/workflow-tools.ts — the opensession-workflows in-process MCP
 *  - routes/workflows.ts — HTTP reads for the UI
 *  - frontend WorkflowPanel.tsx — renders WorkflowRunSnapshot
 */

// ── Limits (single source of truth) ──────────────────────────────────────────

export const WORKFLOW_LIMITS = {
  /** Concurrent agent runs per workflow. */
  maxConcurrentAgents: 8,
  /** Concurrent WRITE agents (own pool): each one cuts a git worktree — heavy
   *  on disk and on the repo's git lock, so it's kept well below the read pool. */
  maxConcurrentWriteAgents: 4,
  /** Lifetime agent() calls per workflow run. */
  maxAgents: 200,
  /** Lifetime write-agent calls per workflow run (worktrees are expensive). */
  maxWriteAgents: 40,
  /** Per-agent wall clock before the run is failed. An agent may use the
   * workflow's full active-time budget instead of being cut off early. */
  agentTimeoutMs: 4 * 60 * 60_000,
  /** Whole-workflow active wall clock before the worker is terminated. Time
   * spent paused does not consume this allowance. */
  workflowTimeoutMs: 4 * 60 * 60_000,
  /** Advisory threshold surfaced in the UI and telemetry. */
  largeWorkflowAgents: 25,
  /** Advisory combined input/output-token threshold. */
  largeWorkflowTokens: 1_500_000,
  /** Schema-validation attempts per agent() call (1 initial + retries). */
  schemaAttempts: 3,
  /** Cap on stored/returned agent result text. */
  maxResultChars: 100_000,
  /** Cap on prompt/result previews inside snapshots (UI payloads). */
  previewChars: 600,
  /** Cap on the workflow script source. */
  maxScriptChars: 256_000,
  /** Cap on log lines kept in a snapshot. */
  maxLogLines: 200,
  // ── mcp.* (direct tool calls from the script) ──
  /** Concurrent MCP calls per workflow. Higher than the agent pool — these
   *  are HTTP/stdio round trips, not model turns — but still bounded so a
   *  fan-out can't hammer a third-party API. */
  maxConcurrentMcp: 16,
  /** Lifetime mcp.* calls per workflow run. */
  maxMcpCalls: 2_000,
  /** Per-call wall clock. */
  mcpCallTimeoutMs: 60_000,
  /** Handshake budget for the first call to a server (stdio servers boot a
   *  process; HTTP ones may negotiate transports). */
  mcpConnectTimeoutMs: 30_000,
  /** Cap on one tool result (journaled AND structured-cloned to the worker). */
  maxMcpResultChars: 250_000,
  /** MCP calls kept on the snapshot (newest last) for the UI/status tail. */
  maxMcpSnapshotCalls: 50,
  // ── durable child sessions ──
  /** Maximum active code sessions supervised by one workflow. */
  maxConcurrentSessions: 4,
  /** Lifetime child-session creations per workflow. */
  maxSessions: 20,
  /** Maximum parent/child hops from a human-created session. */
  maxSessionDepth: 2,
  /** Aggregate completed token spend across child sessions. Provider account
   * quotas remain an additional hard boundary. */
  maxSessionTokens: 2_000_000,
  /** Aggregate provider-reported child-session cost. */
  maxSessionCostUsd: 100,
  /** Lifetime workflowState get/CAS calls. */
  maxStateCalls: 500,
  /** Maximum keys in one replay-lineage state document. */
  maxStateKeys: 128,
  /** Maximum aggregate encoded state bytes. */
  maxStateBytes: 1_000_000,
} as const;

// ── Script surface ───────────────────────────────────────────────────────────

/** `export const meta = {...}` — must be a pure object literal. */
export interface WorkflowMeta {
  name: string;
  description?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

/** Options bag on an `agent(prompt, opts)` call inside a script. */
export interface WorkflowAgentOpts {
  /** Display label (defaults to a prompt prefix). */
  label?: string;
  /** Progress group; defaults to the phase() active at call time. */
  phase?: string;
  /** JSON Schema; when set the agent must return matching JSON and the
   *  resolved value is the parsed object instead of text. */
  schema?: unknown;
  /** Model id (native or pi form); defaults to the workflow default. */
  model?: string;
  /** Reasoning effort for this agent: low, medium, high, xhigh or max, per the
   *  chosen model's own ladder. Unset = that model's default. Typed as a plain
   *  string rather than the server's SessionEffort union to keep this module
   *  dependency-free (the web UI and the native client read these contracts
   *  too); workflow-execute drops a level the model does not offer, exactly as
   *  the runner would have done silently. */
  effort?: string;
  /** Run this agent in code mode inside its OWN isolated git worktree
   *  (branched off the session's branch) so it may edit files with zero
   *  collisions against sibling agents. Its work is auto-committed on its own
   *  branch; `merge()` lands selected branches back on the session's branch. */
  write?: boolean;
}

/** Options accepted by the script's spawnSession(). Child code sessions use
 * the normal SessionControl create path; isolated worktrees merely opt out of
 * the usual same-workspace sharing rule. */
export interface WorkflowSpawnSessionOpts {
  prompt: string;
  repo: string;
  mode?: "ask" | "code";
  /** Route the child to one already-authorized persistent Runner. */
  runner?: string;
  /** Reserve aggregate budget before creation. Actual usage replaces this
   * reservation as it arrives. */
  admission?: { tokens: number; costUsd?: number };
  workspace?: {
    type: "isolated-worktree";
    /** Start from a committed local/remote Git ref. */
    baseRef?: string;
    /** Start from another child session's pushed branch. */
    baseSessionId?: string;
  };
  branch?: string;
}

export type WorkflowSessionState =
  | "running"
  | "waiting"
  | "branch_pushed"
  | "pr_opened"
  | "pr_checks_passed"
  | "pr_checks_failed"
  | "pr_changes_requested"
  | "pr_approved"
  | "pr_merged"
  | "done"
  | "error"
  | "cancelled";

export interface WorkflowSpawnedSession {
  id: string;
  url: string;
  repo: string;
  branch: string;
  parentSessionId: string;
}

/** sessionStatus()/waitSession() result and the row persisted for the Agents
 * panel. Worktree paths are already visible on ordinary session detail views;
 * carrying one here makes isolated siblings inspectable at a glance. */
export interface WorkflowSessionSnapshot extends WorkflowSpawnedSession {
  seq: number;
  /** Replay-stable spawn ownership key, persisted before result journaling. */
  requestKey?: string;
  label: string;
  status: WorkflowSessionState;
  worktreeDir?: string;
  prUrl?: string;
  prState?: string;
  prReviewDecision?: string;
  prChecks?: { total: number; passed: number; failed: number; pending: number };
  runner?: string;
  reservedTokens?: number;
  reservedCostUsd?: number;
  error?: string;
  cancelPending?: boolean;
  startedAt: string;
  endedAt?: string;
  branchPushed?: boolean;
  tokens?: number;
  costUsd?: number;
}

export interface WorkflowSessionStatus extends WorkflowSpawnedSession {
  status: WorkflowSessionState;
  worktreeDir?: string;
  prUrl?: string;
  prState?: string;
  prReviewDecision?: string;
  prChecks?: { total: number; passed: number; failed: number; pending: number };
  runner?: string;
  error?: string;
  branchPushed: boolean;
  tokens?: number;
  costUsd?: number;
}

export type WorkflowSessionOperation =
  | "spawn"
  | "status"
  | "wait"
  | "send"
  | "autofix"
  | "publish"
  | "cancel"
  | "state_get"
  | "state_cas";

export interface WorkflowStateValue {
  key: string;
  version: number;
  value: unknown;
}

export interface WorkflowStateCasResult extends WorkflowStateValue {
  swapped: boolean;
}

export interface WorkflowSessionController {
  /** Re-adopt a spawn result replayed from a prior journal. */
  adopt(session: WorkflowSpawnedSession): void;
  spawn(
    opts: WorkflowSpawnSessionOpts,
    requestId: string,
  ): Promise<WorkflowSpawnedSession>;
  status(id: string): Promise<WorkflowSessionStatus>;
  wait(
    id: string,
    opts: { until: WorkflowSessionState; timeout?: number },
    signal: AbortSignal,
  ): Promise<WorkflowSessionStatus>;
  send(id: string, message: string, requestId: string): Promise<unknown>;
  autofix?(
    id: string,
    reason: string | undefined,
    requestId: string,
  ): Promise<unknown>;
  publish?(id: string, requestId: string): Promise<unknown>;
  cancel(id: string, requestId: string): Promise<WorkflowSessionStatus>;
  /** Explicit workflow cancellation may propagate to active children. A
   * process crash never calls this, so durable children outlive the worker. */
  cancelActive?(requestIdPrefix: string): Promise<void>;
}

// ── Parent ⇄ executor contract ───────────────────────────────────────────────

export interface WorkflowAgentRequest {
  prompt: string;
  opts: WorkflowAgentOpts;
  /** Invocation ordinal within the run. Orders equal-hash replay records. */
  seq: number;
}

export interface WorkflowExecCtx {
  runId: string;
  sessionId: string;
  user?: string;
  /** Working directory for the agent run (the session's worktree). */
  cwd: string;
  /** The session's repo id (worktree.ts REPOS key) — write agents cut their
   *  isolated worktrees there, merge() lands them back. */
  repo?: string;
  /** The session's branch — the base a write agent's branch is cut from and
   *  the branch merge() merges into. */
  baseBranch?: string;
  /** Default model when the call doesn't override. */
  defaultModel?: string;
  /** Flipped on cancel/timeouts — executors stop consuming and cancel the
   *  underlying engine run. */
  signal: AbortSignal;
  /** Reported as soon as the engine session exists, so the snapshot carries
   *  the drill-in pointer WHILE the agent runs (the journal entry only lands
   *  when it finishes). */
  onEngineSession?: (engineSessionId: string) => void;
}

/** What a write agent LEFT ON DISK: a retained branch and its diffstat. It is
 *  present exactly when a branch survived the run, which is a different axis
 *  from `ok` — a failed agent that committed something itself keeps its branch
 *  (and its worktree), and a successful agent that changed nothing does not. */
export interface WorkflowAgentArtifact {
  /** The agent's own branch, still on disk. */
  branch: string;
  worktreeDir: string;
  /** Always true while an artifact exists (no branch is kept for no change);
   *  carried explicitly because snapshots and scripts read it directly. */
  changed: boolean;
  /** Paths touched vs. the base commit. Absent when the branch was retained
   *  without a run of our own commit machinery (a failed agent's own commit). */
  files?: string[];
  insertions?: number;
  deletions?: number;
  /** The auto-commit's sha. */
  commit?: string;
}

export interface WorkflowAgentOutcome {
  /** Did the TURN succeed? Says nothing about `artifact` — read that for
   *  what the agent left behind. */
  ok: boolean;
  /** Raw final text (capped at maxResultChars). */
  text?: string;
  /** Parsed schema-validated value when the call carried a schema. */
  structured?: unknown;
  error?: string;
  /** Resolved model selected before runtime fallback. */
  requestedModel?: string;
  /** Effective terminal model after any fallback. */
  model?: string;
  tokens?: { input: number; output: number };
  toolCalls?: number;
  /** The pi session this agent ran in — the transcript drill-in pointer. */
  engineSessionId?: string;
  /** Where it ran (the session's worktree, or a write agent's own one). */
  cwd?: string;
  // ── write agents ──
  /** Set exactly when a branch was retained, whether the turn succeeded or
   *  failed. Read this (never `ok`) to decide whether there is anything to
   *  merge() or clean up. */
  artifact?: WorkflowAgentArtifact;
  /** Did the agent actually change anything? (false → worktree removed.)
   *  Mirrors `artifact?.changed` and is false when there is no artifact. */
  changed?: boolean;
  // The remaining fields mirror `artifact` for journal entries written before
  // it existed (normalizeWorkflowOutcome lifts them back out on read) and for
  // consumers that predate it. New code reads `artifact`.
  /** @deprecated read `artifact.branch`. */
  branch?: string;
  /** @deprecated read `artifact.worktreeDir`. */
  worktreeDir?: string;
  /** @deprecated read `artifact.files`. */
  files?: string[];
  /** @deprecated read `artifact.insertions`. */
  insertions?: number;
  /** @deprecated read `artifact.deletions`. */
  deletions?: number;
  /** @deprecated read `artifact.commit`. */
  commit?: string;
}

/** Lift a journal entry's outcome into the current shape. Entries written
 *  before `artifact` existed carry the branch and diffstat at the top level;
 *  without this a resumed run replays them with no branch on the row and hands
 *  the script a null branch it cannot merge(). Returns the outcome unchanged
 *  when there is nothing to lift. */
export function normalizeWorkflowOutcome(
  outcome: WorkflowAgentOutcome,
): WorkflowAgentOutcome {
  if (outcome.artifact || !outcome.branch) return outcome;
  return {
    ...outcome,
    artifact: {
      branch: outcome.branch,
      // Pre-artifact entries always carried worktreeDir alongside branch;
      // an entry missing it still merges (merge() works off the branch).
      worktreeDir: outcome.worktreeDir ?? "",
      changed: outcome.changed !== false,
      ...(outcome.files ? { files: outcome.files } : {}),
      ...(outcome.insertions !== undefined
        ? { insertions: outcome.insertions }
        : {}),
      ...(outcome.deletions !== undefined
        ? { deletions: outcome.deletions }
        : {}),
      ...(outcome.commit ? { commit: outcome.commit } : {}),
    },
  };
}

/** Outcome of a merge() call: every branch lands in exactly one bucket. A
 *  conflicted branch never sinks the batch — the merge is aborted, the
 *  conflicting files are reported, and the next branch is tried. `error` is set
 *  when the batch was refused wholesale (dirty session worktree, live shared
 *  checkout) — nothing was merged in that case. */
export interface WorkflowMergeResult {
  merged: Array<{ branch: string; seq: number }>;
  conflicts: Array<{ branch: string; seq: number; files: string[] }>;
  skipped: Array<{ branch: string; seq: number; reason: string }>;
  error?: string;
}

/** Executes one agent() call. The real implementation drives runAgent; tests
 *  inject fakes. */
export interface WorkflowExecutor {
  execute(
    req: WorkflowAgentRequest,
    ctx: WorkflowExecCtx,
  ): Promise<WorkflowAgentOutcome>;
  /** Land write agents' branches on the session's branch. Optional so test
   *  fakes don't have to implement it (the runner reports a clear error when
   *  a script calls merge() against an executor that can't). */
  merge?(
    ctx: WorkflowExecCtx,
    items: Array<{ seq: number; branch: string }>,
  ): Promise<WorkflowMergeResult>;
}

// ── Persistence / snapshots (UI payloads) ────────────────────────────────────

export type WorkflowAgentStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface WorkflowAgentSnapshot {
  seq: number;
  label: string;
  phase?: string;
  /** Resolved model selected before runtime fallback. */
  requestedModel?: string;
  /** Effective model, updated when the run reports a fallback. */
  model?: string;
  /** Set only when the effective model differs from the resolved request. */
  modelSubstitutedFrom?: string;
  status: WorkflowAgentStatus;
  /** Truncated to previewChars for snapshot payloads. */
  promptPreview: string;
  resultPreview?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  tokens?: { input: number; output: number };
  toolCalls?: number;
  /** Number of times this live call was restarted from the UI. */
  retries?: number;
  /** True when the result came from the journal (resume replay). */
  cached?: boolean;
  /** True when the call carried a schema. */
  structured?: boolean;
  /** The agent's pi session — the UI's transcript drill-in pointer.
   *  Set as soon as the engine session exists (not only when the agent ends). */
  engineSessionId?: string;
  // ── write agents ──
  write?: boolean;
  branch?: string;
  changed?: boolean;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  /** Set by a merge() call that included this agent's branch. */
  merged?: "merged" | "conflict";
}

export type WorkflowRunStatus =
  | "running"
  | "paused"
  | "done"
  | "error"
  | "cancelled"
  /** Marked on boot for runs that were live when the process died. */
  | "interrupted";

export interface WorkflowAutomationSessionPolicy {
  automationId: string;
  automationName: string;
  allowedRepos: string[];
  allowedRunners: string[];
}

export interface WorkflowRecoverySnapshot {
  /** Only active runs carrying this descriptor are replayed after restart. */
  autoResume: boolean;
  args?: unknown;
  defaultModel?: string;
  budgetTotal?: number;
  repo?: string;
  baseBranch?: string;
  mcpAllowlist?: string[];
  deniedTools?: Record<string, string>;
  /** Explicit human-owned automation policy for durable code children. */
  automationSessionPolicy?: WorkflowAutomationSessionPolicy;
  sessionLimits?: {
    maxDepth?: number;
    maxConcurrent?: number;
    maxSessions?: number;
    maxTokens?: number;
    maxCostUsd?: number;
  };
  cancelChildSessions?: boolean;
}

export interface WorkflowPhaseSnapshot {
  title: string;
  agents: number;
  pending: number;
  running: number;
  done: number;
  error: number;
  cancelled: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  durationMs: number;
}

export interface WorkflowWarning {
  kind: "large_workflow";
  message: string;
}

export interface WorkflowPhaseToolTotal {
  calls: number;
  errors: number;
  durationMs: number;
}

export interface WorkflowRunSnapshot {
  runId: string;
  /** First run in a resume chain; stable namespace for idempotent side effects. */
  replayRootRunId?: string;
  sessionId: string;
  name: string;
  description?: string;
  status: WorkflowRunStatus;
  /** Serializable launch policy used for restart recovery. */
  recovery?: WorkflowRecoverySnapshot;
  /** New run that replayed this interrupted run after a process restart. */
  recoveredAsRunId?: string;
  recoveryError?: string;
  pausedAt?: string;
  pauseReason?: string;
  totalPausedMs?: number;
  /** Phase titles in first-seen order (meta.phases pre-seed it). */
  phases: string[];
  currentPhase?: string;
  agents: WorkflowAgentSnapshot[];
  /** Recomputed from agent and direct-tool snapshots on every update. */
  phaseStats?: WorkflowPhaseSnapshot[];
  /** Cumulative direct mcp.* totals by phase; unlike mcpCalls, never tail-capped. */
  phaseToolTotals?: Record<string, WorkflowPhaseToolTotal>;
  warnings?: WorkflowWarning[];
  /** Real durable child sessions spawned by this workflow. */
  sessions?: WorkflowSessionSnapshot[];
  /** Persisted external waits. Recovery replays the script and re-adopts these
   * conditions instead of losing the coordinator's blocking point. */
  sessionWaits?: Array<{
    seq: number;
    requestKey?: string;
    sessionId: string;
    until: WorkflowSessionState;
    startedAt: string;
    deadlineAt?: string;
  }>;
  logs: Array<{ ts: string; message: string }>;
  /** Script return value (JSON-serializable, capped). Set when done. */
  result?: unknown;
  error?: string;
  startedAt: string;
  endedAt?: string;
  totals: {
    agents: number;
    tokensIn: number;
    tokensOut: number;
    /** Tool calls made inside workflow agents. */
    agentToolCalls?: number;
    /** mcp.* calls made by the script (absent on pre-mcp runs). */
    mcpCalls?: number;
    mcpErrors?: number;
  };
  /** Tail of recent mcp.* calls (capped at maxMcpSnapshotCalls). */
  mcpCalls?: WorkflowMcpCallSnapshot[];
  user?: string;
  cwd: string;
}

/** One completed agent() call in journal.jsonl — the resume-replay unit and
 *  the UI's drill-in detail (full prompt/result, not previews). */
export interface WorkflowJournalEntry {
  seq: number;
  /** Hash of (prompt + canonicalized opts); replay matches by hash, then seq order. */
  hash: string;
  /** Absent on entries written before mcp.* existed — those are all agents. */
  kind?: "agent";
  prompt: string;
  opts: WorkflowAgentOpts;
  outcome: WorkflowAgentOutcome;
  startedAt: string;
  endedAt: string;
}

/** One completed mcp.* call. Journaled for the same reason agent calls are:
 *  a resumed run must REPLAY it rather than re-fire it — that's what makes
 *  resuming a script that created a Linear issue safe. */
export interface WorkflowMcpJournalEntry {
  kind: "mcp";
  seq: number;
  /** Hash of (server, tool, canonicalized args). */
  hash: string;
  server: string;
  tool: string;
  args: unknown;
  phase?: string;
  ok: boolean;
  /** The normalized value the script received (capped). */
  value?: unknown;
  error?: string;
  startedAt: string;
  endedAt: string;
}

export interface WorkflowSessionJournalEntry {
  kind: "session";
  seq: number;
  /** Hash of operation + normalized arguments. */
  hash: string;
  operation: WorkflowSessionOperation;
  args: unknown;
  /** Replay-stable identity: operation+args hash occurrence, independent of
   * interleaving with unrelated concurrent calls. */
  requestKey?: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  retryable?: boolean;
  startedAt: string;
  endedAt: string;
}

export type WorkflowJournalRecord =
  | WorkflowJournalEntry
  | WorkflowMcpJournalEntry
  | WorkflowSessionJournalEntry;

export function isMcpJournalEntry(
  entry: WorkflowJournalRecord,
): entry is WorkflowMcpJournalEntry {
  return entry.kind === "mcp";
}

export function isSessionJournalEntry(
  entry: WorkflowJournalRecord,
): entry is WorkflowSessionJournalEntry {
  return entry.kind === "session";
}

/** A recent mcp.* call, surfaced on the snapshot (capped at
 *  maxMcpSnapshotCalls) so the UI and workflow_status can show what the script
 *  is actually touching without journal reads. */
export interface WorkflowMcpCallSnapshot {
  seq: number;
  server: string;
  phase?: string;
  tool: string;
  ok: boolean;
  /** Wall-clock duration in ms. */
  ms: number;
  error?: string;
  /** True when answered from the journal on a resume. */
  cached?: boolean;
}

// ── Worker ⇄ parent message protocol ─────────────────────────────────────────

export type WorkerToParent =
  | {
      type: "agent_call";
      callId: number;
      seq: number;
      prompt: string;
      opts: WorkflowAgentOpts;
    }
  | {
      type: "merge_call";
      callId: number;
      items: Array<{ seq: number; branch: string }>;
    }
  | {
      type: "mcp_call";
      callId: number;
      seq: number;
      server: string;
      tool: string;
      args: unknown;
      phase?: string;
    }
  | {
      type: "session_call";
      callId: number;
      seq: number;
      operation: WorkflowSessionOperation;
      args: unknown;
    }
  /** mcp.servers() / mcp.tools(server) — discovery, never journaled. */
  | { type: "mcp_meta"; callId: number; server?: string }
  | { type: "phase"; title: string }
  | { type: "log"; message: string }
  | { type: "done"; result: unknown }
  | { type: "error"; message: string };

export type ParentToWorker =
  | { type: "start"; body: string; args: unknown }
  | {
      type: "agent_result";
      callId: number;
      ok: boolean;
      /** The resolved value for the script: for a write agent the result
       *  object (branch + diffstat + text), else structured ?? text; null on
       *  error. */
      value: unknown;
      error?: string;
      tokensOut?: number;
    }
  | { type: "merge_result"; callId: number; result: WorkflowMergeResult }
  /** Answers both mcp_call and mcp_meta. Unlike agent_result, `ok:false`
   *  REJECTS the script's promise (a tool call is an exception, not a fuzzy
   *  outcome) — parallel() still degrades a throw to null. */
  | {
      type: "mcp_result";
      callId: number;
      ok: boolean;
      value: unknown;
      error?: string;
    }
  | {
      type: "session_result";
      callId: number;
      ok: boolean;
      value: unknown;
      error?: string;
      retryable?: boolean;
    };
