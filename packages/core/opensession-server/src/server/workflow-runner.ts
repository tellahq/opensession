/**
 * Workflow orchestration — the parent side of dynamic workflows.
 *
 * startWorkflow() validates + persists the run, spawns the sandbox Worker
 * (workflow-worker.ts) and services its message loop: each agent_call is
 * executed through a WorkflowExecutor (the real one drives runAgent — see
 * workflow-execute.ts; tests inject fakes) behind a concurrency semaphore,
 * journaled on completion, and answered back into the script. phase/log
 * messages stream into the run snapshot (workflow-store.ts broadcasts each
 * change as a workflow_update to the session's watchers).
 *
 * mcp.* calls take the same route through workflow-mcp.ts (transport +
 * policy): their own concurrency lane, journaled and replayed like agent
 * calls, and the host is closed when the run finishes (stdio servers are child
 * processes).
 *
 * Resume: startWorkflow({resumeFromRunId}) re-runs the script and answers any
 * agent, durable-session or MCP call whose hash matches the old run's journal
 * instantly — the script replays deterministically up to the first
 * changed/missing call (which is why the worker poisons Date.now &co), and a
 * tool call that already landed is never re-fired.
 *
 * A workflow failure must never take down the server: every handler is
 * wrapped, failures log with a [workflow] prefix and finalize the run.
 */

import { randomUUIDv7 } from "bun";
import { workerEntry } from "../runner-host/exe";
import {
  appendWorkflowJournal,
  cancelLiveWorkflow,
  controlLiveWorkflowAgent,
  createWorkflowRun,
  getWorkflowRun,
  pauseLiveWorkflow,
  readWorkflowJournal,
  readWorkflowScript,
  readWorkflowState,
  compareAndSetWorkflowState,
  recoverableWorkflowRunIds,
  registerLiveWorkflow,
  resumeLiveWorkflow,
  unregisterLiveWorkflow,
  updateWorkflowRun,
} from "./workflow-store";
import { findSession } from "./session-cache";
import { repoForPath } from "./worktree";
import { tryGetSessionControl } from "./session-control";
import {
  WORKFLOW_LIMITS,
  isMcpJournalEntry,
  isSessionJournalEntry,
  normalizeWorkflowOutcome,
  type WorkerToParent,
  type WorkflowAgentOpts,
  type WorkflowAgentOutcome,
  type WorkflowAutomationSessionPolicy,
  type WorkflowAgentSnapshot,
  type WorkflowExecCtx,
  type WorkflowExecutor,
  type WorkflowJournalEntry,
  type WorkflowMcpJournalEntry,
  type WorkflowMergeResult,
  type WorkflowMeta,
  type WorkflowRunSnapshot,
  type WorkflowSessionController,
  type WorkflowSessionJournalEntry,
  type WorkflowSessionOperation,
  type WorkflowSessionSnapshot,
  type WorkflowSessionState,
  type WorkflowSessionStatus,
  type WorkflowSpawnedSession,
  type WorkflowSpawnSessionOpts,
} from "./workflow-types";
import type { WorkflowMcpHost } from "./workflow-mcp";
import { emitWorkflowTelemetry } from "./workflow-telemetry";

/**
 * When a workflow reaches a terminal state, nudge the session that launched it
 * so the model picks the results up on its own — the launching turn already
 * ended (a workflow is fire-and-forget), so without this the session sits idle
 * until a human types "continue". Steered (the deliverToSession default), not
 * queued: this is an agent-to-agent handoff ("continue the task"), so it must
 * reach the model without a human in the loop. A mid-turn session folds it into
 * the running turn (pi steer is a non-disruptive noReply fold-in, not an
 * interrupt — a session polling workflow_status just sees the result land); an
 * idle one starts a turn; a steer that can't land falls through to the queue +
 * drain-watcher. Best-effort — a delivery failure must never affect the run's
 * finalization.
 */
function wakeOwningSession(snap: WorkflowRunSnapshot): void {
  try {
    // Only a natural completion wakes the session. A cancelled run is a human
    // pressing Stop — waking the model to "continue" would fight that intent.
    if (snap.status !== "done" && snap.status !== "error") return;
    const ctrl = tryGetSessionControl();
    if (!ctrl) return;
    // Only wake a session this process is actually tracking (skip CLI/tmux
    // and already-gone sessions — deliverToSession would no-op or error).
    if (!ctrl.getSession(snap.sessionId)) return;
    const counts = { done: 0, error: 0 } as Record<string, number>;
    for (const a of snap.agents) counts[a.status] = (counts[a.status] || 0) + 1;
    const tally = Object.entries(counts)
      .filter(([, n]) => n)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    const head =
      snap.status === "done"
        ? `✅ Workflow "${snap.name}" finished`
        : snap.status === "error"
          ? `⚠️ Workflow "${snap.name}" failed`
          : `⏹️ Workflow "${snap.name}" ${snap.status}`;
    // The sentinel marks this as an agent-to-agent nudge: it is delivered
    // attributed to the human who launched the run, so without it the UI
    // renders it as a message they appear to have typed. Kept in sync with
    // WORKFLOW_SENTINEL_RE in packages/core/protocol/src/notices.ts.
    const msg =
      `<!--os:workflow-notice:${snap.runId}-->\n` +
      `${head} (${snap.runId}) — ${snap.agents.length} agents${tally ? `: ${tally}` : ""}. ` +
      `Read its result with workflow_status ${snap.runId} and continue the task.` +
      (snap.error ? `\nError: ${snap.error}` : "");
    void ctrl
      .deliverToSession(snap.sessionId, msg, snap.user, {
        deliveryId: `workflow:${snap.runId}:${snap.status}`,
      })
      .catch((e) =>
        console.warn(`[workflow] ${snap.runId} wake delivery failed:`, e),
      );
  } catch (e) {
    console.warn(`[workflow] ${snap.runId} wakeOwningSession threw:`, e);
  }
}

// ── Meta parsing ─────────────────────────────────────────────────────────────

/**
 * Zero-execution recursive-descent parser for a pure JS object literal.
 * SECURITY: the meta literal is model-authored (and transitively influenced by
 * whatever the session read), and startWorkflow runs on the server main
 * thread — it must NEVER be evaluated (`new Function` here let an IIFE inside
 * the literal run with the server's full env, review finding 2026-07-10).
 * Grammar: strings ('"), numbers, true/false/null, arrays, nested object
 * literals with identifier or string keys; whitespace, line and block
 * comments, trailing commas. Anything else — parens, templates, computed
 * keys, getters, identifiers-as-values — is a parse error.
 */
function parseObjectLiteral(
  source: string,
  openIndex: number,
): { value: unknown; end: number } {
  let i = openIndex;

  const fail = (msg: string): never => {
    throw new Error(
      `\`export const meta\` must be a pure object literal — ${msg} at offset ${i}`,
    );
  };

  const skipWs = (): void => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source[i] === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      }
      if (source[i] === "/" && source[i + 1] === "*") {
        i += 2;
        while (
          i < source.length &&
          !(source[i] === "*" && source[i + 1] === "/")
        )
          i++;
        i += 2;
        continue;
      }
      return;
    }
  };

  const parseString = (): string => {
    const quote = source[i];
    i++;
    let out = "";
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\n") fail("unterminated string");
      if (source[i] === "\\") {
        const esc = source[i + 1];
        const map: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          "\\": "\\",
          "'": "'",
          '"': '"',
          "`": "`",
          "0": "\0",
        };
        if (esc === "u" || esc === "x")
          fail("unsupported escape (use plain characters)");
        out += map[esc] ?? esc;
        i += 2;
        continue;
      }
      out += source[i];
      i++;
    }
    if (source[i] !== quote) fail("unterminated string");
    i++;
    return out;
  };

  const parseValue = (): unknown => {
    skipWs();
    const ch = source[i];
    if (ch === '"' || ch === "'") return parseString();
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    const rest = source.slice(i);
    const kw = /^(true|false|null)(?![\w$])/.exec(rest);
    if (kw) {
      i += kw[1].length;
      return kw[1] === "true" ? true : kw[1] === "false" ? false : null;
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?(?![\w$.])/.exec(rest);
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    return fail(
      `unsupported value (only strings, numbers, booleans, null, arrays and nested literals are allowed; no expressions, templates or function calls)`,
    );
  };

  const parseArray = (): unknown[] => {
    i++; // [
    const out: unknown[] = [];
    for (;;) {
      skipWs();
      if (source[i] === "]") {
        i++;
        return out;
      }
      if (i >= source.length) fail("unterminated array");
      out.push(parseValue());
      skipWs();
      if (source[i] === ",") i++;
      else if (source[i] !== "]") fail("expected , or ] in array");
    }
  };

  const parseObject = (): Record<string, unknown> => {
    i++; // {
    const out: Record<string, unknown> = {};
    for (;;) {
      skipWs();
      if (source[i] === "}") {
        i++;
        return out;
      }
      if (i >= source.length) fail("unterminated object literal");
      let key: string;
      if (source[i] === '"' || source[i] === "'") key = parseString();
      else {
        const id = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
        if (!id)
          fail(
            "expected a property name (identifier or string; computed keys are not allowed)",
          );
        key = id![0];
        i += key.length;
      }
      skipWs();
      if (source[i] !== ":")
        fail(
          "expected : after property name (shorthand/getters are not allowed)",
        );
      i++;
      // Guard against prototype-key tricks in a model-authored literal.
      if (key !== "__proto__" && key !== "constructor" && key !== "prototype") {
        out[key] = parseValue();
      } else {
        parseValue();
      }
      skipWs();
      if (source[i] === ",") i++;
      else if (source[i] !== "}") fail("expected , or } in object literal");
    }
  };

  skipWs();
  if (source[i] !== "{") fail("expected {");
  const value = parseObject();
  return { value, end: i };
}

/** Locate and statically parse `export const meta = {...}` (never evaluated —
 *  see parseObjectLiteral); body = the script with the export statement
 *  removed (the Worker executes only the body). */
export function parseWorkflowMeta(script: string): {
  meta: WorkflowMeta;
  body: string;
} {
  const match = /export\s+const\s+meta\s*=\s*/.exec(script);
  if (!match) {
    throw new Error(
      'workflow script must declare `export const meta = { name: "..." }`',
    );
  }
  const braceStart = match.index + match[0].length;
  if (script[braceStart] !== "{") {
    throw new Error(
      "`export const meta` must be a plain object literal (no function calls or identifiers)",
    );
  }
  const { value: meta, end: afterLiteral } = parseObjectLiteral(
    script,
    braceStart,
  );
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("`export const meta` must evaluate to an object");
  }
  const name = (meta as WorkflowMeta).name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("meta.name must be a non-empty string");
  }
  if (name.length > 120)
    throw new Error("meta.name is too long (max 120 chars)");
  let end = afterLiteral;
  while (script[end] === " " || script[end] === "\t") end++;
  if (script[end] === ";") end++;
  const body = script.slice(0, match.index) + script.slice(end);
  return { meta: meta as WorkflowMeta, body };
}

/**
 * Compile-check the script body without running it (the worker executes it as
 * an AsyncFunction; we build the same AsyncFunction here in a try/catch). On a
 * SyntaxError, return an actionable message; null when it parses. The dominant
 * real-world cause is a truncated `run_workflow` argument (big scripts, often
 * with inlined JSON schemas), so a truncation-shaped error says so explicitly
 * so the model splits the script up rather than blindly resubmitting the same
 * broken text. Never runs the body — no side effects.
 */
export function checkScriptSyntax(body: string): string | null {
  try {
    // Same construction shape as the worker (agent/parallel/… + shadowed
    // globals), so a valid body here is valid there. Parsing only.
    const AsyncFunction = async function () {}.constructor as new (
      ...args: string[]
    ) => unknown;
    new AsyncFunction(
      "agent",
      "parallel",
      "pipeline",
      "merge",
      "mcp",
      "phase",
      "log",
      "args",
      "budget",
      body,
    );
    return null;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const looksTruncated =
      /Unexpected (EOF|end of|token)|missing|must have an initializer|Unterminated/i.test(
        raw,
      );
    const hint = looksTruncated
      ? " — the script looks truncated (unbalanced braces/parens or a cut-off statement). " +
        "This usually means the run_workflow argument was too large: shorten it (define a JSON " +
        "schema once in a variable and reuse it, drop inline comments, keep prompts terse) and resubmit."
      : "";
    return `workflow script has a syntax error: ${raw}${hint}`;
  }
}

// ── Journal hashing (stable across key order) ────────────────────────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

function hashAgentCall(prompt: string, opts: WorkflowAgentOpts): string {
  return new Bun.CryptoHasher("sha256")
    .update(prompt + " " + stableStringify(opts))
    .digest("hex");
}

/** Namespaced so an mcp hash can never collide with an agent hash (they live
 *  in separate replay maps, but the journal is one file). */
function hashMcpCall(server: string, tool: string, args: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(`mcp\u0000${server}\u0000${tool}\u0000${stableStringify(args)}`)
    .digest("hex");
}

function hashSessionCall(
  operation: WorkflowSessionOperation,
  args: unknown,
): string {
  return new Bun.CryptoHasher("sha256")
    .update(`session\u0000${operation}\u0000${stableStringify(args)}`)
    .digest("hex");
}

function configuredSessionLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ── Start / cancel ───────────────────────────────────────────────────────────

export interface StartWorkflowOpts {
  script: string;
  args?: unknown;
  sessionId: string;
  user?: string;
  cwd: string;
  defaultModel?: string;
  /** Output-token budget exposed to the script as `budget` (null = unbounded). */
  budgetTotal?: number;
  /** The session's repo id + branch. Resolved from the session file when
   *  omitted; write agents cut their isolated worktrees off this branch and
   *  merge() lands them back onto it. */
  repo?: string;
  baseBranch?: string;
  /** Injected by tests; defaults to the real runAgent-backed executor. */
  executor?: WorkflowExecutor;
  /** Replay this run's journal: matching agent calls resolve instantly. */
  resumeFromRunId?: string;
  // ── the script's mcp.* surface (see workflow-mcp.ts) ──
  /** MCP allowlist for the script. Omitted = every server the run's user may
   *  see; an automation passes its own least-privilege list. */
  mcpAllowlist?: string[];
  /** Per-call tool denials (automation runs). */
  deniedTools?: Record<string, string>;
  /** Human-owned automation policy for durable code children. */
  automationSessionPolicy?: WorkflowAutomationSessionPolicy;
  /** Builds the in-process opensession-* servers the authoring run carries.
   *  Interactive sessions only; workflow-mcp.ts intersects it with its own
   *  allowlist. Must return FRESH instances (one transport per McpServer). */
  inProcessMcp?: () => Record<string, unknown>;
  /** Injected by tests; defaults to the SessionControl-backed supervisor. */
  sessionController?: WorkflowSessionController;
  /** Per-run overrides for nested-session depth/concurrency/lifetime limits. */
  sessionLimits?: {
    maxDepth?: number;
    maxConcurrent?: number;
    maxSessions?: number;
    maxTokens?: number;
    maxCostUsd?: number;
  };
  /** Explicit cancellation propagates to active children by default. A server
   * crash never does, so children remain durable across workflow restarts. */
  cancelChildSessions?: boolean;
  /** Active runs replay their completed journal after a gateway restart. */
  autoRecover?: boolean;
  /** Injected by tests; defaults to the real MCP host. */
  mcpHost?: WorkflowMcpHost;
}

/** Validate, persist, spawn the Worker and wire its message loop. Returns
 *  immediately; progress streams via workflow_update broadcasts. Throws on
 *  invalid input (script too big, missing/invalid meta). */
export function startWorkflow(opts: StartWorkflowOpts): { runId: string } {
  const script = opts.script || "";
  if (!script.trim()) throw new Error("workflow script is empty");
  if (script.length > WORKFLOW_LIMITS.maxScriptChars) {
    throw new Error(
      `workflow script is too large (${script.length} chars; max ${WORKFLOW_LIMITS.maxScriptChars})`,
    );
  }
  const { meta, body } = parseWorkflowMeta(script);
  // Syntax-check the body BEFORE spawning the worker, so a broken script fails
  // synchronously with an actionable message the model can act on — instead of
  // dying inside the worker with a bare "Unexpected EOF" it can't place. The
  // common cause is a script argument that got truncated (large scripts with
  // inlined JSON schemas), so we detect the truncation shape and say so.
  const syntaxError = checkScriptSyntax(body);
  if (syntaxError) throw new Error(syntaxError);
  const runId = `wf-${randomUUIDv7()}`;

  // Replay matches by hash only: seq (worker invocation order) can differ
  // across runs when a dependent chain advances after a wall-clock result.
  // Within one hash bucket, however, seq owns ordering. Journal lines append
  // on completion, so using file order would swap results when two identical
  // concurrent calls finish out of order.
  // Failed outcomes are journaled (audit trail) but never replayed — resume
  // means "retry what didn't finish", so a transient failure gets a fresh
  // execution instead of a cached error.
  //
  // mcp.* calls replay the same way, in their own map: a resumed script must
  // NOT re-fire a tool call that already landed (that's what makes resuming a
  // script that created a Linear issue safe).
  const replay = new Map<string, WorkflowJournalEntry[]>();
  const mcpReplay = new Map<string, WorkflowMcpJournalEntry[]>();
  const sessionReplay = new Map<string, WorkflowSessionJournalEntry[]>();
  if (opts.resumeFromRunId) {
    for (const entry of readWorkflowJournal(opts.resumeFromRunId)) {
      if (isSessionJournalEntry(entry)) {
        const queue = sessionReplay.get(entry.hash);
        if (queue) queue.push(entry);
        else sessionReplay.set(entry.hash, [entry]);
        continue;
      }
      if (isMcpJournalEntry(entry)) {
        if (!entry.ok) continue;
        const queue = mcpReplay.get(entry.hash);
        if (queue) queue.push(entry);
        else mcpReplay.set(entry.hash, [entry]);
        continue;
      }
      if (!entry.outcome.ok) continue;
      // Entries written before outcome.artifact existed carry the branch and
      // diffstat at the top level; lift them so a replayed write agent still
      // reports its branch instead of a null the script can't merge().
      const normalized: WorkflowJournalEntry = {
        ...entry,
        outcome: normalizeWorkflowOutcome(entry.outcome),
      };
      const queue = replay.get(entry.hash);
      if (queue) queue.push(normalized);
      else replay.set(entry.hash, [normalized]);
    }
    for (const queue of replay.values()) {
      queue.sort((a, b) => a.seq - b.seq);
    }
    for (const queue of mcpReplay.values()) {
      queue.sort((a, b) => a.seq - b.seq);
    }
    for (const queue of sessionReplay.values()) {
      queue.sort((a, b) => a.seq - b.seq);
    }
  }

  const resumed = opts.resumeFromRunId
    ? getWorkflowRun(opts.resumeFromRunId)
    : undefined;
  const replayRootRunId =
    resumed?.replayRootRunId || opts.resumeFromRunId || runId;
  createWorkflowRun({
    runId,
    replayRootRunId,
    sessionId: opts.sessionId,
    name: meta.name,
    description: meta.description,
    phases: (meta.phases || []).map((p) => p.title),
    user: opts.user,
    cwd: opts.cwd,
    script,
    recovery: {
      autoResume: opts.autoRecover !== false,
      ...(opts.args !== undefined ? { args: opts.args } : {}),
      ...(opts.defaultModel ? { defaultModel: opts.defaultModel } : {}),
      ...(opts.budgetTotal !== undefined
        ? { budgetTotal: opts.budgetTotal }
        : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
      ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
      ...(opts.mcpAllowlist ? { mcpAllowlist: opts.mcpAllowlist } : {}),
      ...(opts.deniedTools ? { deniedTools: opts.deniedTools } : {}),
      ...(opts.automationSessionPolicy
        ? { automationSessionPolicy: opts.automationSessionPolicy }
        : {}),
      ...(opts.sessionLimits ? { sessionLimits: opts.sessionLimits } : {}),
      ...(opts.cancelChildSessions !== undefined
        ? { cancelChildSessions: opts.cancelChildSessions }
        : {}),
    },
  });
  if (resumed?.sessions?.length) {
    updateWorkflowRun(runId, (snapshot) => {
      snapshot.sessions = resumed.sessions?.map((session) => ({ ...session }));
    });
  }
  runWorkflow(
    runId,
    replayRootRunId,
    opts,
    body,
    replay,
    mcpReplay,
    sessionReplay,
    [...(resumed?.sessionWaits || [])],
  );
  return { runId };
}

/** Cancel a live workflow. False when the run isn't live in this process. */
export function cancelWorkflow(runId: string): boolean {
  return cancelLiveWorkflow(runId);
}

export function pauseWorkflow(runId: string, reason?: string): boolean {
  return pauseLiveWorkflow(runId, reason);
}

export function resumeWorkflow(runId: string): boolean {
  return resumeLiveWorkflow(runId);
}

export function controlWorkflowAgent(
  runId: string,
  seq: number,
  action: "skip" | "retry",
): boolean {
  return controlLiveWorkflowAgent(runId, seq, action);
}

/** Replay an interrupted coordinator from its durable journal. Completed calls
 * return immediately; unfinished calls start again. A new run id keeps the old
 * attempt immutable and gives every recovery an explicit lineage. */
export async function recoverWorkflow(
  runId: string,
  overrides: Partial<StartWorkflowOpts> = {},
): Promise<string | undefined> {
  const old = getWorkflowRun(runId);
  if (
    !old ||
    old.status !== "interrupted" ||
    old.recoveredAsRunId ||
    !old.recovery
  )
    return undefined;
  const script = readWorkflowScript(runId);
  if (!script) {
    updateWorkflowRun(runId, (snapshot) => {
      snapshot.recoveryError = "original workflow script is missing";
    });
    return undefined;
  }

  const recovery = old.recovery;
  let inProcessMcp = overrides.inProcessMcp;
  const parent = findSession(old.sessionId);
  if (recovery.automationSessionPolicy) {
    const { getAutomation, automationWorkflowSessionPolicy } =
      await import("./automations");
    const current = getAutomation(
      recovery.automationSessionPolicy.automationId,
    );
    const currentPolicy = current
      ? automationWorkflowSessionPolicy(current)
      : undefined;
    if (
      !currentPolicy ||
      parent?.automationId !== currentPolicy.automationId ||
      stableStringify(currentPolicy) !==
        stableStringify(recovery.automationSessionPolicy)
    ) {
      updateWorkflowRun(runId, (snapshot) => {
        snapshot.recoveryError =
          "Automation durable-session authority changed; recovery denied";
      });
      return undefined;
    }
  }
  if (!inProcessMcp && !parent?.automation && !recovery.deniedTools) {
    const { interactiveMcpServers } = await import("./interactive-mcp");
    inProcessMcp = () => interactiveMcpServers(old.user, old.sessionId);
  }
  try {
    const recovered = startWorkflow({
      script,
      args: recovery.args,
      sessionId: old.sessionId,
      user: old.user,
      cwd: old.cwd,
      defaultModel: recovery.defaultModel,
      budgetTotal: recovery.budgetTotal,
      repo: recovery.repo,
      baseBranch: recovery.baseBranch,
      resumeFromRunId: runId,
      mcpAllowlist: recovery.mcpAllowlist,
      deniedTools: recovery.deniedTools,
      automationSessionPolicy: recovery.automationSessionPolicy,
      inProcessMcp,
      sessionLimits: recovery.sessionLimits,
      cancelChildSessions: recovery.cancelChildSessions,
      autoRecover: true,
      ...overrides,
    });
    updateWorkflowRun(runId, (snapshot) => {
      snapshot.recoveredAsRunId = recovered.runId;
      snapshot.recoveryError = undefined;
    });
    return recovered.runId;
  } catch (error) {
    updateWorkflowRun(runId, (snapshot) => {
      snapshot.recoveryError =
        error instanceof Error ? error.message : String(error);
    });
    return undefined;
  }
}

export async function recoverInterruptedWorkflows(
  overrides: Partial<StartWorkflowOpts> = {},
): Promise<string[]> {
  const recovered: string[] = [];
  for (const runId of recoverableWorkflowRunIds()) {
    const next = await recoverWorkflow(runId, overrides);
    if (next) recovered.push(next);
  }
  return recovered;
}

// ── Message loop ─────────────────────────────────────────────────────────────

function runWorkflow(
  runId: string,
  replayRootRunId: string,
  opts: StartWorkflowOpts,
  body: string,
  replay: Map<string, WorkflowJournalEntry[]>,
  mcpReplay: Map<string, WorkflowMcpJournalEntry[]>,
  sessionReplay: Map<string, WorkflowSessionJournalEntry[]>,
  replayedWaits: NonNullable<WorkflowRunSnapshot["sessionWaits"]>,
): void {
  const controller = new AbortController();
  // Lazy-import the real executor so test paths (which always inject) never
  // pull runner internals in.
  const executorPromise: Promise<WorkflowExecutor> = opts.executor
    ? Promise.resolve(opts.executor)
    : import("./workflow-execute").then((m) => m.workflowExecutor);

  // The script's mcp.* host, built on first use (a run that never calls a
  // tool never connects to one) and torn down in finish(). Same lazy-import
  // reasoning as the executor.
  let mcpHostPromise: Promise<WorkflowMcpHost> | undefined;
  function mcpHost(): Promise<WorkflowMcpHost> {
    if (!mcpHostPromise) {
      mcpHostPromise = opts.mcpHost
        ? Promise.resolve(opts.mcpHost)
        : import("./workflow-mcp").then((m) =>
            m.createWorkflowMcpHost({
              allowlist: opts.mcpAllowlist,
              user: opts.user,
              deniedTools: opts.deniedTools,
              inProcessMcp: opts.inProcessMcp,
            }),
          );
    }
    return mcpHostPromise;
  }

  let sessionControllerPromise: Promise<WorkflowSessionController> | undefined;
  function sessionController(): Promise<WorkflowSessionController> {
    if (!sessionControllerPromise) {
      sessionControllerPromise = opts.sessionController
        ? Promise.resolve(opts.sessionController)
        : import("./workflow-sessions").then((m) => {
            const parent = findSession(opts.sessionId);
            return m.createWorkflowSessionController({
              parentSessionId: opts.sessionId,
              user: opts.user,
              // Automation workflows fail closed unless their human-owned
              // definition separately opts into durable sessions. Opted-in
              // children receive an explicit empty MCP scope below.
              allowSpawning:
                (!parent?.automation && !opts.deniedTools) ||
                !!opts.automationSessionPolicy,
              automationSessionPolicy: opts.automationSessionPolicy,
              // Automation children inherit no interactive MCP surface. Their
              // coding/PR path remains available through the normal shell.
              mcpAllowlist: parent?.automation ? [] : opts.mcpAllowlist,
              maxDepth:
                opts.sessionLimits?.maxDepth ??
                configuredSessionLimit(
                  "OPENSESSION_WORKFLOW_MAX_SESSION_DEPTH",
                  WORKFLOW_LIMITS.maxSessionDepth,
                ),
            });
          });
    }
    return sessionControllerPromise;
  }

  let worker: Worker | undefined;
  let finished = false;
  let totalCalls = 0;
  let totalWriteCalls = 0;
  let totalMcpCalls = 0;
  let totalSessionSpawns = 0;
  let totalStateCalls = 0;
  let sessionSpawnsInFlight = 0;
  let sessionReservedTokensInFlight = 0;
  let sessionReservedCostInFlight = 0;
  const sessionCallOccurrences = new Map<string, number>();
  let sessionBudgetCancelled = false;
  // Calls the worker is still awaiting an agent_result for.
  const openCalls = new Set<number>();
  // …and the mcp_result equivalents (settled on cancel so the script's
  // awaited tool calls reject rather than hanging until termination).
  const openMcpCalls = new Set<number>();
  const openSessionCalls = new Set<number>();
  let paused = false;
  let pauseEpoch = 0;
  let pauseStartedAt = 0;
  let resumeWaiters: Array<() => void> = [];
  const activeAgentControllers = new Map<number, AbortController>();
  const agentActions = new Map<number, "skip" | "retry">();

  async function waitWhilePaused(): Promise<void> {
    if (!paused || finished) return;
    await new Promise<void>((resolve) => resumeWaiters.push(resolve));
  }

  function releasePauseWaiters(): void {
    const waiters = resumeWaiters;
    resumeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // The session's repo + branch, resolved once per run (write agents branch
  // off it; merge() merges back into it). Explicit opts win — tests pass them.
  let repoInfo: { repo?: string; baseBranch?: string } | undefined;
  function sessionRepoInfo(): { repo?: string; baseBranch?: string } {
    if (repoInfo) return repoInfo;
    if (opts.repo !== undefined || opts.baseBranch !== undefined) {
      repoInfo = { repo: opts.repo, baseBranch: opts.baseBranch };
      return repoInfo;
    }
    try {
      const session = findSession(opts.sessionId);
      repoInfo = {
        repo:
          session?.repo ||
          (session?.worktreeDir
            ? repoForPath(session.worktreeDir).id
            : undefined),
        baseBranch: session?.branch || undefined,
      };
    } catch (e) {
      console.warn(
        `[workflow] ${runId} could not resolve the session's repo:`,
        e,
      );
      repoInfo = {};
    }
    return repoInfo;
  }

  function execCtx(extra?: Partial<WorkflowExecCtx>): WorkflowExecCtx {
    const { repo, baseBranch } = sessionRepoInfo();
    return {
      runId,
      sessionId: opts.sessionId,
      user: opts.user,
      cwd: opts.cwd,
      repo,
      baseBranch,
      defaultModel: opts.defaultModel,
      signal: controller.signal,
      ...extra,
    };
  }

  // Two semaphores: read agents share the big pool, write agents a small one
  // of their own (each cuts a git worktree — disk + the repo's git lock).
  // The rest queue FIFO in their own lane.
  // mcp calls get their own (bigger) lane: they're round trips, not model
  // turns, and must not queue behind a slow agent fan-out.
  const pools = {
    read: {
      inFlight: 0,
      max: WORKFLOW_LIMITS.maxConcurrentAgents,
      waiting: [] as Array<() => void>,
    },
    write: {
      inFlight: 0,
      max: WORKFLOW_LIMITS.maxConcurrentWriteAgents,
      waiting: [] as Array<() => void>,
    },
    mcp: {
      inFlight: 0,
      max: WORKFLOW_LIMITS.maxConcurrentMcp,
      waiting: [] as Array<() => void>,
    },
  };
  type PoolKind = keyof typeof pools;
  const acquire = (kind: PoolKind): Promise<void> =>
    new Promise((resolve) => {
      const pool = pools[kind];
      if (pool.inFlight < pool.max) {
        pool.inFlight++;
        resolve();
      } else {
        pool.waiting.push(() => {
          pool.inFlight++;
          resolve();
        });
      }
    });
  const release = (kind: PoolKind): void => {
    const pool = pools[kind];
    pool.inFlight--;
    const next = pool.waiting.shift();
    if (next) next();
  };

  function postResult(
    callId: number,
    result: { ok: boolean; value: unknown; error?: string; tokensOut?: number },
  ): void {
    if (!openCalls.has(callId)) return;
    openCalls.delete(callId);
    try {
      worker?.postMessage({ type: "agent_result", callId, ...result });
    } catch {}
  }

  let sessionRefresh: ReturnType<typeof setInterval> | undefined;
  let workflowTimeRemaining = WORKFLOW_LIMITS.workflowTimeoutMs;
  let deadlineStartedAt = Date.now();
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function clearDeadline(consume: boolean): void {
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
    if (consume) {
      workflowTimeRemaining = Math.max(
        0,
        workflowTimeRemaining - (Date.now() - deadlineStartedAt),
      );
    }
  }

  function armDeadline(): void {
    deadlineStartedAt = Date.now();
    deadline = setTimeout(
      () => cancel("workflow timed out"),
      workflowTimeRemaining,
    );
    (deadline as { unref?: () => void }).unref?.();
  }

  function finish(mutate: (s: WorkflowRunSnapshot) => void): void {
    if (finished) return;
    finished = true;
    clearDeadline(false);
    if (sessionRefresh) clearInterval(sessionRefresh);
    controller.abort();
    releasePauseWaiters();
    let snap: WorkflowRunSnapshot | undefined;
    try {
      snap = updateWorkflowRun(runId, mutate);
    } catch (e) {
      console.warn(`[workflow] ${runId} failed to finalize snapshot:`, e);
    }
    unregisterLiveWorkflow(runId);
    try {
      worker?.terminate();
    } catch {}
    // Close MCP clients — a stdio server is a child process, so skipping
    // this leaks one per server per run. Fire-and-forget: teardown must
    // never delay or fail finalization.
    if (mcpHostPromise) {
      void mcpHostPromise
        .then((host) => host.close())
        .catch((e) =>
          console.warn(`[workflow] ${runId} MCP host teardown failed:`, e),
        );
    }
    // Wake the owning session so it continues on its own instead of waiting
    // for a human "continue" — the workflow was fire-and-forget from the
    // turn that launched it, so nothing else re-drives the model when it's
    // done. Steered agent-to-agent (see wakeOwningSession): folds into an
    // in-flight turn, starts one on an idle session — never parked waiting
    // on a human.
    if (snap) {
      emitWorkflowTelemetry(snap);
      wakeOwningSession(snap);
    }
  }

  function markUnfinishedAgents(s: WorkflowRunSnapshot, endedAt: string): void {
    for (const agent of s.agents) {
      if (agent.status === "pending" || agent.status === "running") {
        agent.status = "cancelled";
        agent.endedAt = endedAt;
      }
    }
  }

  function pause(reason?: string): boolean {
    if (finished || paused) return false;
    paused = true;
    pauseEpoch++;
    pauseStartedAt = Date.now();
    clearDeadline(true);
    updateWorkflowRun(runId, (snapshot) => {
      snapshot.status = "paused";
      snapshot.pausedAt = new Date(pauseStartedAt).toISOString();
      snapshot.pauseReason = reason;
      if (reason)
        snapshot.logs.push({
          ts: snapshot.pausedAt,
          message: `Paused: ${reason}`,
        });
    });
    for (const active of activeAgentControllers.values()) {
      active.abort(new Error("workflow paused"));
    }
    return true;
  }

  function resume(): boolean {
    if (finished || !paused) return false;
    const pausedFor = Math.max(0, Date.now() - pauseStartedAt);
    paused = false;
    updateWorkflowRun(runId, (snapshot) => {
      snapshot.status = "running";
      snapshot.totalPausedMs = (snapshot.totalPausedMs || 0) + pausedFor;
      snapshot.pausedAt = undefined;
      snapshot.pauseReason = undefined;
    });
    armDeadline();
    releasePauseWaiters();
    return true;
  }

  function controlAgent(seq: number, action: "skip" | "retry"): boolean {
    if (finished) return false;
    const agent = getWorkflowRun(runId)?.agents.find((row) => row.seq === seq);
    if (
      !agent ||
      (agent.status !== "pending" && agent.status !== "running") ||
      (action === "retry" && agent.status !== "running")
    )
      return false;
    agentActions.set(seq, action);
    activeAgentControllers.get(seq)?.abort(new Error(`agent ${action}`));
    return true;
  }

  function cancel(reason?: string): void {
    if (finished) return;
    // Resolve everything the script is still awaiting (best-effort — the
    // worker is about to be terminated anyway).
    for (const callId of [...openCalls]) {
      postResult(callId, {
        ok: false,
        value: null,
        error: "workflow cancelled",
      });
    }
    for (const callId of [...openMcpCalls]) {
      postMcpResult(callId, {
        ok: false,
        value: null,
        error: "workflow cancelled",
      });
    }
    for (const callId of [...openSessionCalls]) {
      postSessionResult(callId, {
        ok: false,
        value: null,
        error: "workflow cancelled",
      });
    }
    if (opts.cancelChildSessions !== false && sessionControllerPromise) {
      void sessionControllerPromise
        .then((controller) =>
          controller.cancelActive?.(`workflow:${runId}:cancel`),
        )
        .catch((e) =>
          console.warn(`[workflow] ${runId} child cancellation failed:`, e),
        );
    }
    finish((s) => {
      s.status = "cancelled";
      s.endedAt = new Date().toISOString();
      if (reason) s.error = reason;
      markUnfinishedAgents(s, s.endedAt);
      if (opts.cancelChildSessions !== false)
        for (const session of s.sessions || []) {
          if (["running", "waiting"].includes(session.status)) {
            session.status = "cancelled";
            session.endedAt = s.endedAt;
          }
        }
    });
  }

  armDeadline();

  function agentLabel(prompt: string, agentOpts: WorkflowAgentOpts): string {
    if (agentOpts.label) return agentOpts.label;
    return prompt.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function outcomePreview(outcome: WorkflowAgentOutcome): string | undefined {
    if (outcome.structured !== undefined) {
      try {
        return JSON.stringify(outcome.structured);
      } catch {}
    }
    return outcome.text;
  }

  /** What the script's `await agent(...)` resolves to. A write agent resolves
   *  to an OBJECT (its branch + diffstat + text) so the script can hand it
   *  straight to merge(); a read agent keeps resolving to text/structured. */
  function agentValue(
    outcome: WorkflowAgentOutcome,
    seq: number,
    write: boolean,
  ): unknown {
    if (!outcome.ok) return null;
    const value = outcome.structured ?? outcome.text ?? null;
    if (!write) return value;
    // The artifact — not `ok`, not the outcome's legacy top-level copies —
    // says whether there is a branch to hand to merge().
    const artifact = outcome.artifact;
    return {
      text: outcome.text ?? "",
      ...(outcome.structured !== undefined
        ? { structured: outcome.structured }
        : {}),
      branch: artifact?.branch ?? null,
      worktreeDir: artifact?.worktreeDir ?? null,
      changed: artifact?.changed === true,
      files: artifact?.files ?? [],
      insertions: artifact?.insertions ?? 0,
      deletions: artifact?.deletions ?? 0,
      seq,
    };
  }

  /** Copy the outcome's drill-in pointer + write artifact onto the row. The
   *  artifact is keyed on itself, not on the row's `write` flag or on `ok`:
   *  a failed agent that committed something keeps its branch, and the row
   *  has to show it or the branch is only reachable by reading the journal. */
  function applyOutcome(
    agent: WorkflowAgentSnapshot,
    outcome: WorkflowAgentOutcome,
  ): void {
    if (outcome.engineSessionId)
      agent.engineSessionId = outcome.engineSessionId;
    const artifact = outcome.artifact;
    if (!artifact) {
      // Nothing on disk. A write agent still reports "no changes".
      if (agent.write) agent.changed = false;
      return;
    }
    agent.changed = artifact.changed;
    agent.branch = artifact.branch;
    if (artifact.files) agent.filesChanged = artifact.files.length;
    if (artifact.insertions !== undefined)
      agent.insertions = artifact.insertions;
    if (artifact.deletions !== undefined) agent.deletions = artifact.deletions;
  }

  async function handleAgentCall(
    msg: Extract<WorkerToParent, { type: "agent_call" }>,
  ): Promise<void> {
    openCalls.add(msg.callId);
    await waitWhilePaused();
    totalCalls++;
    if (totalCalls > WORKFLOW_LIMITS.maxAgents) {
      postResult(msg.callId, {
        ok: false,
        value: null,
        error: "agent cap reached",
      });
      return;
    }
    const write = msg.opts.write === true;
    if (write && ++totalWriteCalls > WORKFLOW_LIMITS.maxWriteAgents) {
      postResult(msg.callId, {
        ok: false,
        value: null,
        error: "write-agent cap reached",
      });
      return;
    }
    const hash = hashAgentCall(msg.prompt, msg.opts);
    const label = agentLabel(msg.prompt, msg.opts);
    const structured = msg.opts.schema !== undefined ? true : undefined;

    // Invocation order per hash; only ok outcomes were admitted to the map
    // (see startWorkflow), so a previously failed call re-executes on resume.
    const queue = replay.get(hash);
    const journaled = queue?.length ? queue.shift() : undefined;
    if (journaled) {
      const outcome = journaled.outcome;
      const now = new Date().toISOString();
      updateWorkflowRun(runId, (s) => {
        // A replayed write agent is NOT re-run: its branch already exists
        // (and if a human deleted it, merge() reports it skipped).
        const agent: WorkflowAgentSnapshot = {
          seq: msg.seq,
          label,
          phase: msg.opts.phase,
          requestedModel: outcome.requestedModel,
          model: outcome.model,
          ...(outcome.requestedModel &&
          outcome.model &&
          outcome.requestedModel !== outcome.model
            ? { modelSubstitutedFrom: outcome.requestedModel }
            : {}),
          status: "done",
          promptPreview: msg.prompt,
          resultPreview: outcomePreview(outcome),
          // Shown on the row (marked cached) but excluded from run totals —
          // totals are THIS run's real spend.
          tokens: outcome.tokens,
          toolCalls: outcome.toolCalls,
          startedAt: now,
          endedAt: now,
          cached: true,
          structured,
          ...(write ? { write: true } : {}),
        };
        applyOutcome(agent, outcome);
        s.agents.push(agent);
        s.totals.agents = s.agents.length;
      });
      // Carry the entry into this run's journal so resuming the resumed
      // run replays too (with this run's seq — seq is display-only).
      try {
        appendWorkflowJournal(runId, { ...journaled, seq: msg.seq });
      } catch (e) {
        console.warn(`[workflow] ${runId} journal append failed:`, e);
      }
      postResult(msg.callId, {
        ok: true,
        value: agentValue(outcome, msg.seq, write),
        // Report the ORIGINAL spend so the worker-side budget replays
        // deterministically (a script branching on budget.remaining() must
        // see the same numbers as the original run).
        tokensOut: outcome.tokens?.output,
      });
      return;
    }

    updateWorkflowRun(runId, (s) => {
      s.agents.push({
        seq: msg.seq,
        label,
        phase: msg.opts.phase,
        requestedModel: msg.opts.model || opts.defaultModel,
        model: msg.opts.model || opts.defaultModel,
        status: "pending",
        promptPreview: msg.prompt,
        structured,
        ...(write ? { write: true } : {}),
      });
      s.totals.agents = s.agents.length;
    });

    await acquire(write ? "write" : "read");
    // Everything after acquire() runs under one finally — retries and pauses
    // retain this slot, so queued siblings cannot jump ahead of an agent that
    // is being resumed in place.
    const startedAt = new Date().toISOString();
    let outcome: WorkflowAgentOutcome = {
      ok: false,
      error: "workflow cancelled",
    };
    try {
      for (;;) {
        await waitWhilePaused();
        if (finished || controller.signal.aborted) {
          postResult(msg.callId, {
            ok: false,
            value: null,
            error: "workflow cancelled",
          });
          return;
        }
        if (agentActions.get(msg.seq) === "skip") {
          agentActions.delete(msg.seq);
          outcome = { ok: false, error: "skipped by user" };
          break;
        }
        updateWorkflowRun(runId, (s) => {
          const agent = s.agents.find((a) => a.seq === msg.seq);
          if (agent) {
            agent.status = "running";
            agent.startedAt ||= startedAt;
            agent.error = undefined;
          }
        });

        const attemptPauseEpoch = pauseEpoch;
        const attemptController = new AbortController();
        const abortAttempt = () =>
          attemptController.abort(controller.signal.reason);
        if (controller.signal.aborted) abortAttempt();
        else
          controller.signal.addEventListener("abort", abortAttempt, {
            once: true,
          });
        activeAgentControllers.set(msg.seq, attemptController);
        try {
          const executor = await executorPromise;
          outcome = await executor.execute(
            { prompt: msg.prompt, opts: msg.opts, seq: msg.seq },
            execCtx({
              signal: attemptController.signal,
              // The engine session id lands on the row as soon as it exists,
              // so the UI can drill into a RUNNING agent's conversation.
              onEngineSession: (engineSessionId) => {
                updateWorkflowRun(runId, (s) => {
                  const agent = s.agents.find((a) => a.seq === msg.seq);
                  if (agent) agent.engineSessionId = engineSessionId;
                });
              },
            }),
          );
        } catch (e) {
          outcome = {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        } finally {
          controller.signal.removeEventListener("abort", abortAttempt);
          if (activeAgentControllers.get(msg.seq) === attemptController)
            activeAgentControllers.delete(msg.seq);
        }

        const action = agentActions.get(msg.seq);
        agentActions.delete(msg.seq);
        if (action === "skip") {
          outcome = { ok: false, error: "skipped by user" };
          break;
        }
        if (action === "retry" || paused || attemptPauseEpoch !== pauseEpoch) {
          updateWorkflowRun(runId, (s) => {
            const agent = s.agents.find((a) => a.seq === msg.seq);
            if (!agent) return;
            agent.status = "pending";
            if (action === "retry") agent.retries = (agent.retries || 0) + 1;
          });
          continue;
        }
        break;
      }
    } finally {
      release(write ? "write" : "read");
    }
    const endedAt = new Date().toISOString();
    // A cancel/finish that raced us already resolved the call and marked
    // the agent cancelled — don't overwrite the final snapshot.
    if (finished) return;

    updateWorkflowRun(runId, (s) => {
      const agent = s.agents.find((a) => a.seq === msg.seq);
      if (agent) {
        agent.status = outcome.ok
          ? "done"
          : outcome.error === "skipped by user"
            ? "cancelled"
            : "error";
        agent.endedAt = endedAt;
        if (outcome.requestedModel)
          agent.requestedModel = outcome.requestedModel;
        if (outcome.model) agent.model = outcome.model;
        if (
          outcome.requestedModel &&
          outcome.model &&
          outcome.requestedModel !== outcome.model
        )
          agent.modelSubstitutedFrom = outcome.requestedModel;
        if (outcome.tokens) agent.tokens = outcome.tokens;
        if (outcome.toolCalls !== undefined)
          agent.toolCalls = outcome.toolCalls;
        agent.resultPreview = outcomePreview(outcome);
        if (!outcome.ok) agent.error = outcome.error || "agent failed";
        applyOutcome(agent, outcome);
      }
      if (outcome.tokens) {
        s.totals.tokensIn += outcome.tokens.input || 0;
        s.totals.tokensOut += outcome.tokens.output || 0;
      }
      if (outcome.toolCalls)
        s.totals.agentToolCalls =
          (s.totals.agentToolCalls || 0) + outcome.toolCalls;
    });
    try {
      appendWorkflowJournal(runId, {
        seq: msg.seq,
        hash,
        prompt: msg.prompt,
        opts: msg.opts,
        outcome,
        startedAt,
        endedAt,
      });
    } catch (e) {
      console.warn(`[workflow] ${runId} journal append failed:`, e);
    }
    postResult(msg.callId, {
      ok: outcome.ok,
      value: agentValue(outcome, msg.seq, write),
      error: outcome.error,
      tokensOut: outcome.tokens?.output,
    });
  }

  // ── merge() bridge ─────────────────────────────────────────────────────────

  function postMergeResult(callId: number, result: WorkflowMergeResult): void {
    try {
      worker?.postMessage({ type: "merge_result", callId, result });
    } catch {}
  }

  /** The script's merge(items): land write agents' branches on the session's
   *  branch (workflow-execute's mergeWorkflowAgents does the safety work) and
   *  mark the outcome on each agent's row. */
  async function handleMergeCall(
    msg: Extract<WorkerToParent, { type: "merge_call" }>,
  ): Promise<void> {
    await waitWhilePaused();
    const items = (msg.items || []).filter(
      (i) => i && typeof i.branch === "string" && i.branch,
    );
    if (!items.length) {
      postMergeResult(msg.callId, { merged: [], conflicts: [], skipped: [] });
      return;
    }
    let result: WorkflowMergeResult;
    try {
      const executor = await executorPromise;
      if (!executor.merge) {
        throw new Error("this workflow executor cannot merge write agents");
      }
      result = await executor.merge(execCtx(), items);
    } catch (e) {
      result = {
        merged: [],
        conflicts: [],
        skipped: items.map((i) => ({ ...i, reason: "merge failed" })),
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (!finished) {
      updateWorkflowRun(runId, (s) => {
        for (const m of result.merged) {
          const agent = s.agents.find((a) => a.seq === m.seq);
          if (agent) agent.merged = "merged";
        }
        for (const c of result.conflicts) {
          const agent = s.agents.find((a) => a.seq === c.seq);
          if (agent) agent.merged = "conflict";
        }
      });
    }
    postMergeResult(msg.callId, result);
  }

  // ── durable child-session bridge ──────────────────────────────────────────

  function postSessionResult(
    callId: number,
    result: {
      ok: boolean;
      value: unknown;
      error?: string;
      retryable?: boolean;
    },
  ): void {
    if (!openSessionCalls.has(callId)) return;
    openSessionCalls.delete(callId);
    try {
      worker?.postMessage({ type: "session_result", callId, ...result });
    } catch {}
  }

  function sessionRequestId(requestKey: string): string {
    const digest = new Bun.CryptoHasher("sha256")
      .update(`${replayRootRunId}\u0000${requestKey}`)
      .digest("hex");
    return `workflow-session-${digest}`;
  }

  function sessionLabel(args: unknown): string {
    const prompt = (args as { prompt?: unknown } | null)?.prompt;
    return typeof prompt === "string"
      ? prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Code session"
      : "Code session";
  }

  function applySessionStatus(
    seq: number,
    status: WorkflowSessionStatus,
  ): void {
    if (finished) return;
    updateWorkflowRun(runId, (s) => {
      const row = s.sessions?.find((item) => item.id === status.id);
      if (!row) return;
      row.status = status.status;
      row.branch = status.branch;
      row.repo = status.repo;
      row.branchPushed = status.branchPushed;
      if (status.worktreeDir) row.worktreeDir = status.worktreeDir;
      if (status.prUrl) row.prUrl = status.prUrl;
      if (status.prState) row.prState = status.prState;
      if (status.prReviewDecision)
        row.prReviewDecision = status.prReviewDecision;
      if (status.prChecks) row.prChecks = status.prChecks;
      if (status.runner) row.runner = status.runner;
      if (status.error) row.error = status.error;
      if (status.tokens !== undefined) row.tokens = status.tokens;
      if (status.costUsd !== undefined) row.costUsd = status.costUsd;
      if (["done", "error", "cancelled"].includes(status.status))
        row.endedAt ||= new Date().toISOString();
      // A replay can carry a different display seq while retaining the same id.
      row.seq = seq;
    });
  }

  async function refreshSessionRows(): Promise<void> {
    const rows = (getWorkflowRun(runId)?.sessions || []).filter((row) =>
      ["running", "waiting"].includes(row.status),
    );
    if (!rows.length || finished) return;
    const controller = await sessionController();
    await Promise.all(
      rows.map(async (row) => {
        try {
          applySessionStatus(row.seq, await controller.status(row.id));
        } catch (e) {
          if (!finished)
            updateWorkflowRun(runId, (s) => {
              const current = s.sessions?.find((item) => item.id === row.id);
              if (current)
                current.error = e instanceof Error ? e.message : String(e);
            });
        }
      }),
    );
    const budgetError = sessionBudgetError();
    if (budgetError && !sessionBudgetCancelled) {
      sessionBudgetCancelled = true;
      await controller.cancelActive?.(`workflow:${runId}:budget`);
      updateWorkflowRun(runId, (s) => {
        s.logs.push({ ts: new Date().toISOString(), message: budgetError });
      });
    }
  }

  function sessionBudgetTotals(): { tokens: number; cost: number } {
    const rows = getWorkflowRun(runId)?.sessions || [];
    let tokens = sessionReservedTokensInFlight;
    let cost = sessionReservedCostInFlight;
    for (const row of rows) {
      const terminal = ["done", "error", "cancelled"].includes(row.status);
      // A terminal row releases unused reservation only after usage is known.
      // Missing usage retains the reservation, which is the fail-closed choice.
      tokens += terminal
        ? (row.tokens ?? row.reservedTokens ?? 0)
        : Math.max(row.tokens || 0, row.reservedTokens || 0);
      cost += terminal
        ? (row.costUsd ?? row.reservedCostUsd ?? 0)
        : Math.max(row.costUsd || 0, row.reservedCostUsd || 0);
    }
    return { tokens, cost };
  }

  function sessionBudgetError(): string | undefined {
    const { tokens, cost } = sessionBudgetTotals();
    const maxTokens =
      opts.sessionLimits?.maxTokens ??
      configuredSessionLimit(
        "OPENSESSION_WORKFLOW_MAX_SESSION_TOKENS",
        WORKFLOW_LIMITS.maxSessionTokens,
      );
    const maxCost =
      opts.sessionLimits?.maxCostUsd ??
      configuredSessionLimit(
        "OPENSESSION_WORKFLOW_MAX_SESSION_COST_USD",
        WORKFLOW_LIMITS.maxSessionCostUsd,
      );
    if (tokens > maxTokens)
      return `Nested session token budget exceeded (${tokens} > ${maxTokens})`;
    if (cost > maxCost)
      return `Nested session cost budget exceeded ($${cost.toFixed(2)} > $${maxCost.toFixed(2)})`;
    return undefined;
  }

  function assertSessionBudget(): void {
    const error = sessionBudgetError();
    if (error) throw new Error(error);
  }

  function ensureSessionRefresh(): void {
    if (sessionRefresh) return;
    sessionRefresh = setInterval(() => {
      void refreshSessionRows().catch((e) =>
        console.warn(`[workflow] ${runId} child refresh failed:`, e),
      );
    }, 3_000);
    (sessionRefresh as { unref?: () => void }).unref?.();
  }

  function addSessionRow(
    seq: number,
    spawned: WorkflowSpawnedSession,
    args: unknown,
    status?: WorkflowSessionStatus,
    requestKey?: string,
  ): void {
    updateWorkflowRun(runId, (s) => {
      const sessions = (s.sessions ||= []);
      if (sessions.some((item) => item.id === spawned.id)) return;
      const row: WorkflowSessionSnapshot = {
        ...spawned,
        seq,
        ...(requestKey ? { requestKey } : {}),
        label: sessionLabel(args),
        status: status?.status || "running",
        startedAt: new Date().toISOString(),
        ...(status?.worktreeDir ? { worktreeDir: status.worktreeDir } : {}),
        ...(status?.prUrl ? { prUrl: status.prUrl } : {}),
        ...(status?.error ? { error: status.error } : {}),
        ...(status ? { branchPushed: status.branchPushed } : {}),
        ...(status?.tokens !== undefined ? { tokens: status.tokens } : {}),
        ...(status?.costUsd !== undefined ? { costUsd: status.costUsd } : {}),
        ...((args as WorkflowSpawnSessionOpts | null)?.admission
          ? {
              reservedTokens:
                (args as WorkflowSpawnSessionOpts).admission?.tokens || 0,
              reservedCostUsd:
                (args as WorkflowSpawnSessionOpts).admission?.costUsd || 0,
            }
          : {}),
      };
      sessions.push(row);
    });
    ensureSessionRefresh();
  }

  async function executeSessionOperation(
    operation: WorkflowSessionOperation,
    args: unknown,
    seq: number,
    hash: string,
    requestKey: string,
  ): Promise<unknown> {
    const requestId = sessionRequestId(requestKey);
    if (operation === "state_get") {
      const key = (args as { key?: unknown })?.key;
      if (typeof key !== "string")
        throw new Error("workflowState.get() needs a key");
      return readWorkflowState(replayRootRunId, key);
    }
    if (operation === "state_cas") {
      const input = args as {
        key?: unknown;
        expectedVersion?: unknown;
        value?: unknown;
      };
      if (typeof input?.key !== "string")
        throw new Error("workflowState.compareAndSet() needs a key");
      if (typeof input.expectedVersion !== "number")
        throw new Error(
          "workflowState.compareAndSet() needs an expected version",
        );
      return compareAndSetWorkflowState(
        replayRootRunId,
        input.key,
        input.expectedVersion,
        input.value,
        requestId,
      );
    }
    const supervisor = await sessionController();
    if (operation === "spawn") {
      const existing = getWorkflowRun(runId)?.sessions?.find(
        (row) => row.requestKey === requestKey,
      );
      if (existing) {
        const spawned: WorkflowSpawnedSession = {
          id: existing.id,
          url: existing.url,
          repo: existing.repo,
          branch: existing.branch,
          parentSessionId: existing.parentSessionId,
        };
        supervisor.adopt(spawned);
        if (existing.cancelPending) {
          const cancelled = await supervisor.cancel(
            spawned.id,
            `${requestId}:cancel-retry`,
          );
          applySessionStatus(seq, cancelled);
          updateWorkflowRun(runId, (snapshot) => {
            const row = snapshot.sessions?.find(
              (candidate) => candidate.requestKey === requestKey,
            );
            if (row) row.cancelPending = false;
          });
          throw new Error("Workflow cancelled after child creation");
        }
        return spawned;
      }
      const maxSessions =
        opts.sessionLimits?.maxSessions ??
        configuredSessionLimit(
          "OPENSESSION_WORKFLOW_MAX_SESSIONS",
          WORKFLOW_LIMITS.maxSessions,
        );
      if (++totalSessionSpawns > maxSessions)
        throw new Error(
          `Nested session cap reached (${maxSessions} per workflow)`,
        );
      await refreshSessionRows();
      assertSessionBudget();
      const spawnInput = args as WorkflowSpawnSessionOpts;
      const admitted = sessionBudgetTotals();
      const maxTokens =
        opts.sessionLimits?.maxTokens ??
        configuredSessionLimit(
          "OPENSESSION_WORKFLOW_MAX_SESSION_TOKENS",
          WORKFLOW_LIMITS.maxSessionTokens,
        );
      const maxCost =
        opts.sessionLimits?.maxCostUsd ??
        configuredSessionLimit(
          "OPENSESSION_WORKFLOW_MAX_SESSION_COST_USD",
          WORKFLOW_LIMITS.maxSessionCostUsd,
        );
      // Admission is server-owned. A script may ask for a larger reservation,
      // but omission, zero, and understated values cannot bypass the floor.
      const reservedTokens = Math.max(
        Math.min(10_000, Math.floor(maxTokens / 2)),
        spawnInput.admission?.tokens || 0,
      );
      const reservedCost = Math.max(
        Math.min(1, maxCost / 10),
        spawnInput.admission?.costUsd || 0,
      );
      const admittedInput: WorkflowSpawnSessionOpts = {
        ...spawnInput,
        admission: { tokens: reservedTokens, costUsd: reservedCost },
      };
      if (admitted.tokens + reservedTokens > maxTokens)
        throw new Error(
          "Nested session token admission exceeds the workflow budget",
        );
      if (admitted.cost + reservedCost > maxCost)
        throw new Error(
          "Nested session cost admission exceeds the workflow budget",
        );
      const maxConcurrent =
        opts.sessionLimits?.maxConcurrent ??
        configuredSessionLimit(
          "OPENSESSION_WORKFLOW_MAX_ACTIVE_SESSIONS",
          WORKFLOW_LIMITS.maxConcurrentSessions,
        );
      const active = (getWorkflowRun(runId)?.sessions || []).filter((row) =>
        ["running", "waiting"].includes(row.status),
      ).length;
      if (active + sessionSpawnsInFlight >= maxConcurrent)
        throw new Error(
          `Active nested session cap reached (${maxConcurrent} per workflow)`,
        );
      // Admission + reservation is one synchronous critical section. No await
      // occurs between the checks above and these counters.
      sessionSpawnsInFlight++;
      sessionReservedTokensInFlight += reservedTokens;
      sessionReservedCostInFlight += reservedCost;
      try {
        const spawned = await supervisor.spawn(admittedInput, requestId);
        const current = await supervisor
          .status(spawned.id)
          .catch(() => undefined);
        addSessionRow(seq, spawned, admittedInput, current, requestKey);
        if (finished || controller.signal.aborted) {
          updateWorkflowRun(runId, (snapshot) => {
            const row = snapshot.sessions?.find(
              (candidate) => candidate.requestKey === requestKey,
            );
            if (row) row.cancelPending = true;
          });
          try {
            const cancelled = await supervisor.cancel(
              spawned.id,
              `${requestId}:late-cancel`,
            );
            applySessionStatus(seq, cancelled);
            updateWorkflowRun(runId, (snapshot) => {
              const row = snapshot.sessions?.find(
                (candidate) => candidate.requestKey === requestKey,
              );
              if (row) row.cancelPending = false;
            });
          } catch (error) {
            console.warn(
              `[workflow] ${runId} late child cancellation deferred:`,
              error,
            );
          }
          throw new Error("Workflow cancelled");
        }
        return spawned;
      } finally {
        sessionSpawnsInFlight--;
        sessionReservedTokensInFlight -= reservedTokens;
        sessionReservedCostInFlight -= reservedCost;
      }
    }
    const input = args as {
      id?: unknown;
      message?: unknown;
      until?: unknown;
      timeout?: unknown;
    };
    if (typeof input?.id !== "string" || !input.id)
      throw new Error(`${operation}Session() needs a child session id`);
    if (operation === "status") {
      const current = await supervisor.status(input.id);
      applySessionStatus(seq, current);
      return current;
    }
    if (operation === "wait") {
      const allowed: WorkflowSessionState[] = [
        "running",
        "waiting",
        "branch_pushed",
        "pr_opened",
        "pr_checks_passed",
        "pr_checks_failed",
        "pr_changes_requested",
        "pr_approved",
        "pr_merged",
        "done",
        "error",
        "cancelled",
      ];
      if (!allowed.includes(input.until as WorkflowSessionState))
        throw new Error(
          `waitSession() until must be one of: ${allowed.join(", ")}`,
        );
      const requestedTimeout =
        typeof input.timeout === "number" ? input.timeout : 60 * 60_000;
      const recoveredWaitIndex = replayedWaits.findIndex(
        (wait) =>
          wait.requestKey === requestKey ||
          (!wait.requestKey &&
            wait.sessionId === input.id &&
            wait.until === (input.until as WorkflowSessionState)),
      );
      const recoveredWait =
        recoveredWaitIndex >= 0
          ? replayedWaits.splice(recoveredWaitIndex, 1)[0]
          : undefined;
      const recoveredDeadline = recoveredWait?.deadlineAt
        ? Date.parse(recoveredWait.deadlineAt)
        : Number.NaN;
      const timeout = Number.isFinite(recoveredDeadline)
        ? Math.max(
            0,
            Math.min(requestedTimeout, recoveredDeadline - Date.now()),
          )
        : requestedTimeout;
      const deadlineAt = Number.isFinite(recoveredDeadline)
        ? new Date(recoveredDeadline).toISOString()
        : new Date(Date.now() + timeout).toISOString();
      updateWorkflowRun(runId, (snapshot) => {
        const waits = (snapshot.sessionWaits ||= []);
        if (!waits.some((wait) => wait.seq === seq))
          waits.push({
            seq,
            requestKey,
            sessionId: input.id as string,
            until: input.until as WorkflowSessionState,
            startedAt: recoveredWait?.startedAt || new Date().toISOString(),
            deadlineAt,
          });
      });
      const current = await supervisor.wait(
        input.id,
        { until: input.until as WorkflowSessionState, timeout },
        controller.signal,
      );
      applySessionStatus(seq, current);
      return current;
    }
    if (operation === "send") {
      assertSessionBudget();
      if (typeof input.message !== "string" || !input.message.trim())
        throw new Error("sendToSession() needs a message");
      return await supervisor.send(input.id, input.message, requestId);
    }
    if (operation === "publish") {
      if (!supervisor.publish)
        throw new Error("publishSessionBranch() is unavailable");
      return await supervisor.publish(input.id, requestId);
    }
    if (operation === "autofix") {
      assertSessionBudget();
      if (!supervisor.autofix)
        throw new Error("autofixSession() is unavailable");
      return await supervisor.autofix(
        input.id,
        typeof input.message === "string" ? input.message : undefined,
        requestId,
      );
    }
    const current = await supervisor.cancel(input.id, requestId);
    applySessionStatus(seq, current);
    return current;
  }

  async function handleSessionCall(
    msg: Extract<WorkerToParent, { type: "session_call" }>,
  ): Promise<void> {
    openSessionCalls.add(msg.callId);
    const hash = hashSessionCall(msg.operation, msg.args);
    const occurrence = sessionCallOccurrences.get(hash) || 0;
    sessionCallOccurrences.set(hash, occurrence + 1);
    const requestKey = `${hash}:${occurrence}`;
    if (
      (msg.operation === "state_get" || msg.operation === "state_cas") &&
      ++totalStateCalls > WORKFLOW_LIMITS.maxStateCalls
    ) {
      postSessionResult(msg.callId, {
        ok: false,
        value: null,
        error: `Workflow state call limit reached (${WORKFLOW_LIMITS.maxStateCalls})`,
      });
      return;
    }
    await waitWhilePaused();
    const queue = sessionReplay.get(hash);
    const keyedIndex = queue?.findIndex(
      (entry) => entry.requestKey === requestKey,
    );
    const journaled =
      keyedIndex !== undefined && keyedIndex >= 0
        ? queue!.splice(keyedIndex, 1)[0]
        : queue?.length
          ? queue.shift()
          : undefined;
    if (journaled) {
      try {
        if (msg.operation === "spawn" && journaled.ok && journaled.value) {
          const spawned = journaled.value as WorkflowSpawnedSession;
          const controller = await sessionController();
          controller.adopt(spawned);
          const current = await controller
            .status(spawned.id)
            .catch(() => undefined);
          addSessionRow(
            msg.seq,
            spawned,
            msg.args,
            current,
            journaled.requestKey,
          );
          totalSessionSpawns++;
        } else if (
          journaled.ok &&
          ["status", "wait", "cancel"].includes(msg.operation)
        ) {
          const id = (msg.args as { id?: unknown } | null)?.id;
          if (typeof id === "string") {
            const current = await (
              await sessionController()
            )
              .status(id)
              .catch(() => undefined);
            if (current) applySessionStatus(msg.seq, current);
          }
        }
        appendWorkflowJournal(runId, { ...journaled, seq: msg.seq });
      } catch (e) {
        console.warn(`[workflow] ${runId} session replay failed:`, e);
      }
      if (msg.operation === "wait") {
        updateWorkflowRun(runId, (snapshot) => {
          snapshot.sessionWaits = snapshot.sessionWaits?.filter(
            (wait) =>
              wait.requestKey !== requestKey &&
              wait.requestKey !== journaled.requestKey &&
              wait.seq !== msg.seq,
          );
        });
      }
      postSessionResult(msg.callId, {
        ok: journaled.ok,
        value: journaled.value ?? null,
        error: journaled.error,
        ...(journaled.retryable ? { retryable: true } : {}),
      });
      return;
    }

    const startedAt = new Date().toISOString();
    let ok = false;
    let value: unknown = null;
    let error: string | undefined;
    let retryable = false;
    try {
      value = await executeSessionOperation(
        msg.operation,
        msg.args,
        msg.seq,
        hash,
        requestKey,
      );
      ok = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      retryable = (e as { retryable?: unknown })?.retryable === true;
    }
    if (finished) return;
    const endedAt = new Date().toISOString();
    try {
      appendWorkflowJournal(runId, {
        kind: "session",
        seq: msg.seq,
        hash,
        operation: msg.operation,
        args: msg.args,
        requestKey,
        ok,
        ...(ok ? { value } : {}),
        ...(error ? { error } : {}),
        ...(retryable ? { retryable: true } : {}),
        startedAt,
        endedAt,
      });
      if (msg.operation === "wait") {
        updateWorkflowRun(runId, (snapshot) => {
          snapshot.sessionWaits = snapshot.sessionWaits?.filter(
            (wait) => wait.requestKey !== requestKey && wait.seq !== msg.seq,
          );
        });
      }
    } catch (e) {
      console.warn(`[workflow] ${runId} session journal append failed:`, e);
    }
    postSessionResult(msg.callId, {
      ok,
      value: ok ? value : null,
      error,
      ...(retryable ? { retryable: true } : {}),
    });
  }

  // ── mcp.* bridge ───────────────────────────────────────────────────────────

  function postMcpResult(
    callId: number,
    result: { ok: boolean; value: unknown; error?: string },
  ): void {
    if (!openMcpCalls.has(callId)) return;
    openMcpCalls.delete(callId);
    try {
      worker?.postMessage({ type: "mcp_result", callId, ...result });
    } catch {}
  }

  /** Record one finished mcp call on the snapshot: running totals plus a
   *  capped tail of recent calls (a script may make thousands — the journal,
   *  not the snapshot, is the full record). */
  function recordMcpCall(entry: {
    seq: number;
    server: string;
    tool: string;
    phase?: string;
    ok: boolean;
    ms: number;
    error?: string;
    cached?: boolean;
  }): void {
    if (finished) return;
    updateWorkflowRun(runId, (s) => {
      s.totals.mcpCalls = (s.totals.mcpCalls || 0) + 1;
      if (!entry.ok) s.totals.mcpErrors = (s.totals.mcpErrors || 0) + 1;
      const phase = entry.phase || "Other";
      const phaseTotals = (s.phaseToolTotals ||= {});
      const phaseTotal = (phaseTotals[phase] ||= {
        calls: 0,
        errors: 0,
        durationMs: 0,
      });
      phaseTotal.calls++;
      if (!entry.ok) phaseTotal.errors++;
      phaseTotal.durationMs += entry.ms;
      const calls = (s.mcpCalls ||= []);
      calls.push({
        seq: entry.seq,
        server: entry.server,
        tool: entry.tool,
        ...(entry.phase ? { phase: entry.phase } : {}),
        ok: entry.ok,
        ms: entry.ms,
        ...(entry.error ? { error: entry.error.slice(0, 500) } : {}),
        ...(entry.cached ? { cached: true } : {}),
      });
      if (calls.length > WORKFLOW_LIMITS.maxMcpSnapshotCalls) {
        s.mcpCalls = calls.slice(-WORKFLOW_LIMITS.maxMcpSnapshotCalls);
      }
    });
  }

  /** The script's mcp.<server>.<tool>(args): policy-checked, journaled, and
   *  replayed from the journal on resume so a resumed run never re-fires a
   *  call that already landed. */
  async function handleMcpCall(
    msg: Extract<WorkerToParent, { type: "mcp_call" }>,
  ): Promise<void> {
    openMcpCalls.add(msg.callId);
    await waitWhilePaused();
    if (++totalMcpCalls > WORKFLOW_LIMITS.maxMcpCalls) {
      postMcpResult(msg.callId, {
        ok: false,
        value: null,
        error: `mcp call cap reached (${WORKFLOW_LIMITS.maxMcpCalls} per run)`,
      });
      return;
    }
    const hash = hashMcpCall(msg.server, msg.tool, msg.args);

    // Invocation order per hash; only ok outcomes were admitted, so a failed
    // call re-runs.
    const queue = mcpReplay.get(hash);
    const journaled = queue?.length ? queue.shift() : undefined;
    if (journaled) {
      recordMcpCall({
        seq: msg.seq,
        server: msg.server,
        tool: msg.tool,
        phase: msg.phase || journaled.phase,
        ok: true,
        ms: 0,
        cached: true,
      });
      try {
        appendWorkflowJournal(runId, {
          ...journaled,
          seq: msg.seq,
          ...(msg.phase ? { phase: msg.phase } : {}),
        });
      } catch (e) {
        console.warn(`[workflow] ${runId} journal append failed:`, e);
      }
      postMcpResult(msg.callId, { ok: true, value: journaled.value ?? null });
      return;
    }

    await acquire("mcp");
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let ok = false;
    let value: unknown = null;
    let error: string | undefined;
    try {
      if (finished || controller.signal.aborted) {
        postMcpResult(msg.callId, {
          ok: false,
          value: null,
          error: "workflow cancelled",
        });
        return;
      }
      const host = await mcpHost();
      value = await host.call(msg.server, msg.tool, msg.args);
      ok = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      release("mcp");
    }
    const endedAt = new Date().toISOString();
    if (finished) return;
    recordMcpCall({
      seq: msg.seq,
      server: msg.server,
      tool: msg.tool,
      phase: msg.phase,
      ok,
      ms: Date.now() - startedMs,
      error,
    });
    try {
      appendWorkflowJournal(runId, {
        kind: "mcp",
        seq: msg.seq,
        hash,
        server: msg.server,
        tool: msg.tool,
        args: msg.args,
        ...(msg.phase ? { phase: msg.phase } : {}),
        ok,
        ...(ok ? { value } : {}),
        ...(error ? { error } : {}),
        startedAt,
        endedAt,
      });
    } catch (e) {
      console.warn(`[workflow] ${runId} journal append failed:`, e);
    }
    postMcpResult(msg.callId, { ok, value: ok ? value : null, error });
  }

  /** mcp.servers() / mcp.tools(server) — discovery only, never journaled
   *  (it makes no change and its answer is config, not an observation). */
  async function handleMcpMeta(
    msg: Extract<WorkerToParent, { type: "mcp_meta" }>,
  ): Promise<void> {
    openMcpCalls.add(msg.callId);
    await waitWhilePaused();
    try {
      const host = await mcpHost();
      const value = msg.server ? await host.tools(msg.server) : host.servers();
      postMcpResult(msg.callId, { ok: true, value });
    } catch (e) {
      postMcpResult(msg.callId, {
        ok: false,
        value: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Bound the stored top-level result (it's persisted + broadcast). */
  function capResult(result: unknown): unknown {
    try {
      const json = JSON.stringify(result);
      if (json && json.length > WORKFLOW_LIMITS.maxResultChars) {
        return json.slice(0, WORKFLOW_LIMITS.maxResultChars) + "…(truncated)";
      }
    } catch {}
    return result;
  }

  function handleWorkerMessage(msg: WorkerToParent): void {
    if (finished) return;
    switch (msg.type) {
      case "agent_call":
        handleAgentCall(msg).catch((e) => {
          console.warn(`[workflow] ${runId} agent call failed:`, e);
          postResult(msg.callId, {
            ok: false,
            value: null,
            error: e instanceof Error ? e.message : String(e),
          });
        });
        return;
      case "merge_call":
        handleMergeCall(msg).catch((e) => {
          console.warn(`[workflow] ${runId} merge call failed:`, e);
          postMergeResult(msg.callId, {
            merged: [],
            conflicts: [],
            skipped: [],
            error: e instanceof Error ? e.message : String(e),
          });
        });
        return;
      case "session_call":
        handleSessionCall(msg).catch((e) => {
          console.warn(`[workflow] ${runId} session call failed:`, e);
          postSessionResult(msg.callId, {
            ok: false,
            value: null,
            error: e instanceof Error ? e.message : String(e),
          });
        });
        return;
      case "mcp_call":
        handleMcpCall(msg).catch((e) => {
          console.warn(`[workflow] ${runId} mcp call failed:`, e);
          postMcpResult(msg.callId, {
            ok: false,
            value: null,
            error: e instanceof Error ? e.message : String(e),
          });
        });
        return;
      case "mcp_meta":
        handleMcpMeta(msg).catch((e) => {
          console.warn(`[workflow] ${runId} mcp discovery failed:`, e);
          postMcpResult(msg.callId, {
            ok: false,
            value: null,
            error: e instanceof Error ? e.message : String(e),
          });
        });
        return;
      case "phase":
        updateWorkflowRun(runId, (s) => {
          if (!s.phases.includes(msg.title)) s.phases.push(msg.title);
          s.currentPhase = msg.title;
        });
        return;
      case "log":
        updateWorkflowRun(runId, (s) => {
          s.logs.push({ ts: new Date().toISOString(), message: msg.message });
        });
        return;
      case "done":
        void waitWhilePaused().then(() => {
          if (finished) return;
          finish((s) => {
            s.status = "done";
            s.result = capResult(msg.result);
            s.endedAt = new Date().toISOString();
            markUnfinishedAgents(s, s.endedAt);
          });
        });
        return;
      case "error":
        finish((s) => {
          s.status = "error";
          s.error = msg.message;
          s.endedAt = new Date().toISOString();
          markUnfinishedAgents(s, s.endedAt);
        });
        return;
    }
  }

  registerLiveWorkflow(runId, { cancel, pause, resume, controlAgent });
  try {
    // Minimal env (belt) on top of the worker-side scrub (braces) — a Bun
    // Worker is a same-process thread and would otherwise inherit the
    // server's full secret-bearing process.env.
    worker = new Worker(
      workerEntry(
        "workflow-worker.js",
        new URL("./workflow-worker.ts", import.meta.url).href,
      ),
      {
        env: { WORKFLOW_WORKER: "1" },
      } as WorkerOptions,
    );
    worker.addEventListener("message", (event) => {
      try {
        handleWorkerMessage((event as MessageEvent).data as WorkerToParent);
      } catch (e) {
        console.warn(`[workflow] ${runId} message handling failed:`, e);
      }
    });
    worker.addEventListener("error", (event) => {
      const message =
        (event as ErrorEvent)?.message || "workflow worker crashed";
      console.warn(`[workflow] ${runId} worker error:`, message);
      finish((s) => {
        s.status = "error";
        s.error = String(message);
        s.endedAt = new Date().toISOString();
        markUnfinishedAgents(s, s.endedAt);
      });
    });
    // A worker that exits without posting done/error (script called
    // close(), thread crash) must not leave the run "running" until the
    // 60-minute deadline — finish() is idempotent, so a normal terminate()
    // arriving here is a no-op.
    worker.addEventListener("close", () => {
      finish((s) => {
        s.status = "error";
        s.error = "workflow worker exited before completing";
        s.endedAt = new Date().toISOString();
        markUnfinishedAgents(s, s.endedAt);
      });
    });
    // Finish durable cancellation cleanup before replaying script code. A
    // process can die after marking a late child cancelPending but before the
    // spawn call is revisited; journal replay would otherwise bypass the
    // operation branch that used to perform this cleanup.
    void (async () => {
      const pending = (getWorkflowRun(runId)?.sessions || []).filter(
        (row) => row.cancelPending,
      );
      if (pending.length) {
        const supervisor = await sessionController();
        for (const row of pending) {
          supervisor.adopt({
            id: row.id,
            url: row.url,
            repo: row.repo,
            branch: row.branch,
            parentSessionId: row.parentSessionId,
          });
          const status = await supervisor.cancel(
            row.id,
            `workflow-session-recovery-cancel:${row.requestKey || row.seq}`,
          );
          updateWorkflowRun(runId, (snapshot) => {
            const current = snapshot.sessions?.find(
              (candidate) => candidate.id === row.id,
            );
            if (!current) return;
            current.cancelPending = false;
            current.status = status.status;
            current.branchPushed = status.branchPushed;
            current.endedAt = new Date().toISOString();
          });
        }
        finish((snapshot) => {
          snapshot.status = "cancelled";
          snapshot.error = "Recovered pending child cancellation";
          snapshot.endedAt = new Date().toISOString();
          markUnfinishedAgents(snapshot, snapshot.endedAt);
        });
        return;
      }
      // budgetTotal rides the start message (worker-side `budget` global);
      // it's an extra field on top of the ParentToWorker start shape.
      worker?.postMessage({
        type: "start",
        body,
        args: opts.args ?? null,
        budgetTotal: opts.budgetTotal ?? null,
      });
    })().catch((error) => {
      finish((snapshot) => {
        snapshot.status = "error";
        snapshot.error = `Pending child cancellation recovery failed: ${error instanceof Error ? error.message : String(error)}`;
        snapshot.endedAt = new Date().toISOString();
        markUnfinishedAgents(snapshot, snapshot.endedAt);
      });
    });
  } catch (e) {
    console.warn(`[workflow] ${runId} failed to start worker:`, e);
    finish((s) => {
      s.status = "error";
      s.error = e instanceof Error ? e.message : String(e);
      s.endedAt = new Date().toISOString();
    });
  }
}
