/**
 * Workflow agent executor — the real WorkflowExecutor behind workflow-runner.
 *
 * Each `agent()` call inside a workflow script becomes one lightweight
 * pi run in a detached workload host (journal kind "workflow", cwd = the
 * session's worktree) driven to completion here. Deliberately minimal
 * RunAgentOpts: no inProcessMcp or deniedTools. Kind "workflow" is
 * interactive-trusted (the
 * opensession-workflows MCP that launches these is interactive-only).
 *
 * Read agents (the default) run in mode "ask", which already withholds write
 * tools. A `write: true` agent instead gets its OWN isolated git worktree
 * (createWorktree(branch, repo, {isolated: true, base: sessionBranch}) —
 * `isolated` is what keeps a shared-checkout repo like opensession out of the
 * LIVE main checkout) and runs in mode "code" there, so N write agents edit
 * code in parallel with zero collisions. Its work is auto-committed on its own
 * branch; an agent that changed nothing has its worktree removed again.
 * mergeWorkflowAgents() lands selected branches back on the session's branch,
 * sequentially, refusing loudly rather than ever clobbering a shared/dirty tree.
 *
 * Schema mode (WorkflowAgentOpts.schema): the agent is told to reply with a
 * fenced ```json block; we extract the LAST fenced block (whole-reply parse
 * fallback), validate against a minimal JSON Schema subset, and on failure
 * retry by resuming the SAME engine session with a correction prompt — up to
 * WORKFLOW_LIMITS.schemaAttempts total attempts.
 */

import { $ } from "bun";
import {
  cancelAgentRun,
  type RunAgentOpts,
  type StreamEvent,
} from "./agent-runner";
import { runAuxiliaryAgentHosted } from "./host-client";
import {
  automaticFallbackModel,
  getDefaultModel,
  modelEfforts,
  resolveModel,
  type SessionEffort,
} from "./models";
import { createWorktree, getRepo, removeWorktree } from "./worktree";
import { gitIdentityEnv, gitIdentityFor } from "./shared/user-mappings";
import {
  WORKFLOW_LIMITS,
  type WorkflowAgentArtifact,
  type WorkflowAgentOutcome,
  type WorkflowAgentRequest,
  type WorkflowExecCtx,
  type WorkflowExecutor,
  type WorkflowMergeResult,
} from "./workflow-types";

// ── Agent seam (production detaches; tests inject a fake) ───────────────────

type RunAgentFn = (
  opts: RunAgentOpts,
  onEngineSession?: (engineSessionId: string) => void,
) => AsyncGenerator<StreamEvent>;

let runAgentImpl: RunAgentFn | null = null;

/** Test seam: workflows use detached hosts unless a test supplies a fake. */
export function _setRunAgentForTests(fn: RunAgentFn | null): void {
  runAgentImpl = fn;
}

// ── worktree seam (tests point it at a throwaway git repo in tmp) ────────────

/** The bits of worktree.ts the write path needs. Tests swap them for a fake
 *  backed by a real (throwaway) git repo — never the live repos. */
export interface WorkflowWorktreeOps {
  create(
    branch: string,
    repoId: string | undefined,
    opts: { base?: string; isolated: true },
  ): Promise<string>;
  remove(branch: string, repoId?: string): Promise<void>;
  /** Is this repo the live shared main checkout (opensession), and is the
   *  session working IN it? Then merging into it is forbidden. */
  isLiveSharedCheckout(repoId: string | undefined, sessionCwd: string): boolean;
}

const realWorktreeOps: WorkflowWorktreeOps = {
  create: (branch, repoId, opts) => createWorktree(branch, repoId, opts),
  remove: (branch, repoId) => removeWorktree(branch, repoId),
  isLiveSharedCheckout: (repoId, sessionCwd) => {
    const repo = getRepo(repoId);
    return !!repo.sharedCheckout && sessionCwd === repo.repo;
  },
};

let worktreeOps: WorkflowWorktreeOps = realWorktreeOps;

/** Test seam: swap the worktree ops (null restores the real ones). */
export function _setWorktreeOpsForTests(ops: WorkflowWorktreeOps | null): void {
  worktreeOps = ops ?? realWorktreeOps;
}

// ── runAgentCollect ──────────────────────────────────────────────────────────

export interface RunAgentCollectResult {
  text: string;
  model?: string;
  tokens?: { input: number; output: number };
  toolCalls: number;
  engineSessionId?: string;
  error?: string;
}

/**
 * Drive runAgent to completion, accumulating the streamed text. On abort we
 * stop consuming, best-effort cancel the underlying engine run, and return
 * error "cancelled" (the race means a hung engine run can't wedge a cancel).
 */
export async function runAgentCollect(
  opts: RunAgentOpts,
  signal?: AbortSignal,
  onEngineSession?: (engineSessionId: string) => void,
  runner: RunAgentFn | null = runAgentImpl,
): Promise<RunAgentCollectResult> {
  let text = "";
  let model: string | undefined;
  let tokens: { input: number; output: number } | undefined;
  let engineSessionId: string | undefined;
  let error: string | undefined;
  let toolCalls = 0;
  let skipRunnerNotice = false;
  const noteEngineSession = (id: string) => {
    if (!id || id === engineSessionId) return;
    engineSessionId = id;
    try {
      onEngineSession?.(id);
    } catch {}
  };

  // Already cancelled: never start the engine run at all.
  if (signal?.aborted) return { text, toolCalls, error: "cancelled" };
  if (!runner) throw new Error("Workflow agent runner is not configured");

  const it = runner(opts, noteEngineSession)[Symbol.asyncIterator]();
  const aborted: Promise<"aborted"> | null = signal
    ? new Promise((resolve) => {
        if (signal.aborted) resolve("aborted");
        else
          signal.addEventListener("abort", () => resolve("aborted"), {
            once: true,
          });
      })
    : null;

  try {
    for (;;) {
      const next = aborted
        ? await Promise.race([it.next(), aborted])
        : await it.next();
      if (next === "aborted") {
        if (engineSessionId) {
          try {
            await cancelAgentRun(engineSessionId);
          } catch {}
        }
        void it.return?.(undefined)?.catch?.(() => {});
        return {
          text,
          model,
          tokens,
          toolCalls,
          engineSessionId,
          error: "cancelled",
        };
      }
      if (next.done) break;
      const event = next.value;
      if (event.type === "init") {
        if (event.sessionId) noteEngineSession(event.sessionId);
        model = event.model || model;
      } else if (event.type === "model_switch") {
        // Usage-limit fallback: agent-runner re-runs the FULL prompt on the
        // fallback model. The collected text IS the agent() return value, so
        // drop the pre-switch partial reply. Keep swallowing the legacy
        // synthetic "[runner] …" chunk for older/remote runners.
        text = "";
        skipRunnerNotice = true;
        model = event.toModel || model;
      } else if (event.type === "text_chunk" && event.text) {
        if (skipRunnerNotice) {
          skipRunnerNotice = false;
          if (event.text.trimStart().startsWith("[runner] ")) continue;
        }
        text += event.text;
      } else if (event.type === "tool_use") {
        toolCalls++;
      } else if (event.type === "done") {
        model = event.model || model;
        if (event.usage) {
          tokens = {
            input: event.usage.inputTokens,
            output: event.usage.outputTokens,
          };
        }
      } else if (event.type === "error") {
        error = event.content || "agent run failed";
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { text, model, tokens, toolCalls, engineSessionId, error };
}

// ── Fenced-JSON extraction ───────────────────────────────────────────────────

/**
 * The LAST ```json fenced block in the reply (falling back to the last
 * untagged ``` block); null when there's no fence — callers then try the
 * whole reply as JSON.
 */
export function extractLastFencedJson(text: string): string | null {
  const tagged = [...text.matchAll(/```json[^\S\n]*\n?([\s\S]*?)```/gi)];
  if (tagged.length) return tagged[tagged.length - 1][1].trim();
  const bare = [...text.matchAll(/```[^\S\n]*\n?([\s\S]*?)```/g)];
  if (bare.length) return bare[bare.length - 1][1].trim();
  return null;
}

// ── Minimal JSON Schema subset validator ─────────────────────────────────────
// (anthropic-bridge.ts's general jsonSchemaToZod isn't exported — only the
// tool-shape helper — so this stays a tiny pure function here.)

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/**
 * Validate `value` against a minimal JSON Schema subset: type (object/array/
 * string/number/integer/boolean/null, or an array of those — any match
 * passes), properties, required, items (single schema or tuple form —
 * index-wise, extra items pass), enum, const, anyOf (any branch passes),
 * additionalProperties:false. Property checks use own-property semantics
 * (Object.hasOwn) so keys like "constructor"/"toString" behave like any
 * other. Returns descriptive error paths ("files[2]: expected string, got
 * number"); empty array = valid.
 */
export function validateJsonSchema(value: unknown, schema: unknown): string[] {
  const errors: string[] = [];
  walkSchema(value, schema, "", errors);
  return errors;
}

function walkSchema(
  value: unknown,
  schema: unknown,
  path: string,
  errors: string[],
): void {
  const at = path || "(root)";
  if (Array.isArray(schema)) {
    // A bare array is not a schema node (tuple-form arrays are handled at
    // the `items` site below) — flag it instead of silently passing.
    errors.push(
      `${at}: invalid schema node (array where a schema object was expected)`,
    );
    return;
  }
  if (!schema || typeof schema !== "object") return;
  const s = schema as Record<string, unknown>;

  if ("const" in s) {
    if (JSON.stringify(value) !== JSON.stringify(s.const)) {
      errors.push(`${at}: expected const ${JSON.stringify(s.const)}`);
      return;
    }
  }
  if (Array.isArray(s.enum)) {
    const match = s.enum.some(
      (v) => JSON.stringify(v) === JSON.stringify(value),
    );
    if (!match) {
      errors.push(
        `${at}: expected one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")}`,
      );
      return;
    }
  }
  if (Array.isArray(s.anyOf)) {
    const anyPass = s.anyOf.some((branch) => {
      const branchErrors: string[] = [];
      walkSchema(value, branch, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!anyPass) {
      errors.push(`${at}: matched no anyOf branch`);
      return;
    }
  }

  const types =
    typeof s.type === "string"
      ? [s.type]
      : Array.isArray(s.type)
        ? s.type.filter((t): t is string => typeof t === "string")
        : [];
  if (types.length) {
    const actual = jsonTypeOf(value);
    const ok = types.some((type) =>
      type === "integer"
        ? actual === "number" && Number.isInteger(value)
        : actual === type,
    );
    if (!ok) {
      errors.push(`${at}: expected ${types.join(" | ")}, got ${actual}`);
      return;
    }
  }

  if (jsonTypeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props =
      s.properties && typeof s.properties === "object"
        ? (s.properties as Record<string, unknown>)
        : undefined;
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !Object.hasOwn(obj, key)) {
          errors.push(`${joinPath(path, key)}: missing required property`);
        }
      }
    }
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (Object.hasOwn(obj, key))
          walkSchema(obj[key], sub, joinPath(path, key), errors);
      }
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!props || !Object.hasOwn(props, key)) {
          errors.push(`${joinPath(path, key)}: unexpected property`);
        }
      }
    }
  }

  if (Array.isArray(value) && s.items) {
    if (Array.isArray(s.items)) {
      // Tuple form: validate index-wise; extra items beyond the tuple pass.
      const tuple = s.items;
      value.forEach((item, i) => {
        if (i < tuple.length)
          walkSchema(item, tuple[i], `${path}[${i}]`, errors);
      });
    } else {
      value.forEach((item, i) =>
        walkSchema(item, s.items, `${path}[${i}]`, errors),
      );
    }
  }
}

// ── Write agents: branch naming + git plumbing ───────────────────────────────

/**
 * A write agent's branch: `wf-<short runId>-<seq>`. Derived only from the run
 * and agent invocation ordinal, with no Date.now/random. Replayed outcomes
 * keep pointing at the branch recorded in their journal artifact.
 */
export function workflowBranchName(runId: string, seq: number): string {
  const compact = runId.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const short = compact.slice(-8) || "run";
  return `wf-${short}-${seq}`;
}

/** git commits under the run's user when we can map them, else git's default. */
function gitEnv(user?: string): Record<string, string> {
  return { ...process.env, ...gitIdentityEnv(gitIdentityFor(user)) } as Record<
    string,
    string
  >;
}

async function gitHead(dir: string): Promise<string> {
  const res = await $`git -C ${dir} rev-parse HEAD`.quiet().nothrow();
  return res.exitCode === 0 ? res.stdout.toString().trim() : "";
}

/** `git diff --numstat <from> <to>` → files + insertions + deletions (binary
 *  files report "-" for both counts and contribute 0). */
async function diffStat(
  dir: string,
  from: string,
  to: string,
): Promise<{ files: string[]; insertions: number; deletions: number }> {
  const res = await $`git -C ${dir} diff --numstat ${from} ${to}`
    .quiet()
    .nothrow();
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  if (res.exitCode === 0) {
    for (const line of res.stdout.toString().split("\n")) {
      if (!line.trim()) continue;
      const [add, del, ...rest] = line.split("\t");
      const file = rest.join("\t");
      if (!file) continue;
      files.push(file);
      insertions += Number.parseInt(add, 10) || 0;
      deletions += Number.parseInt(del, 10) || 0;
    }
  }
  return { files, insertions, deletions };
}

/**
 * Commit everything a write agent produced, on its own branch. Returns the
 * commit + diffstat vs. the commit the worktree started at; `changed: false`
 * when the agent touched nothing at all (the caller then removes the worktree,
 * so a no-op agent leaves no branch behind).
 */
async function commitWriteAgent(
  dir: string,
  baseCommit: string,
  message: string,
  user?: string,
): Promise<{
  changed: boolean;
  commit?: string;
  files: string[];
  insertions: number;
  deletions: number;
}> {
  const env = gitEnv(user);
  await $`git -C ${dir} add -A`.quiet().nothrow().env(env);
  const staged = await $`git -C ${dir} diff --cached --quiet`.quiet().nothrow();
  // exit 1 = something is staged; 0 = nothing to commit.
  if (staged.exitCode !== 0) {
    const commit = await $`git -C ${dir} commit --no-verify -m ${message}`
      .quiet()
      .nothrow()
      .env(env);
    if (commit.exitCode !== 0) {
      throw new Error(
        `workflow write agent commit failed: ${commit.stderr.toString().trim().slice(0, 300)}`,
      );
    }
  }
  const head = await gitHead(dir);
  if (!head || head === baseCommit) {
    return { changed: false, files: [], insertions: 0, deletions: 0 };
  }
  const stat = await diffStat(dir, baseCommit, head);
  return { changed: true, commit: head, ...stat };
}

// ── The executor ─────────────────────────────────────────────────────────────

/** Terse preamble so the worker's final message is machine-consumable. */
const WORKER_PREAMBLE =
  "You are a focused worker agent inside a scripted workflow. Your final " +
  "message IS the return value a script consumes — output exactly the " +
  "requested data, with no greeting, preamble, or sign-off. Be " +
  "self-contained: don't reference other agents or ask questions.";

/** Write agents get their own worktree; they must not reach outside it, and
 *  they never commit/push (we auto-commit their work on their branch). */
const WRITE_PREAMBLE =
  "You are a focused worker agent inside a scripted workflow, running in your " +
  "OWN isolated git worktree — edit files freely here, and NEVER touch paths " +
  "outside this working directory. Do NOT run git commit/push/checkout: your " +
  "changes are committed for you when you finish, and other agents are editing " +
  "sibling worktrees in parallel. Your final message is a short report of what " +
  "you changed — no greeting, preamble or sign-off.";

function capResult(text: string): string {
  return text.length > WORKFLOW_LIMITS.maxResultChars
    ? text.slice(0, WORKFLOW_LIMITS.maxResultChars)
    : text;
}

function addTokens(
  total: { input: number; output: number } | undefined,
  add: { input: number; output: number } | undefined,
): { input: number; output: number } | undefined {
  if (!add) return total;
  if (!total) return { ...add };
  return { input: total.input + add.input, output: total.output + add.output };
}

/** Attach a retained branch to an outcome. The artifact is the truth; the
 *  top-level copies exist for journals and consumers written before it. */
function withArtifact(
  outcome: WorkflowAgentOutcome,
  artifact: WorkflowAgentArtifact,
): WorkflowAgentOutcome {
  return { ...outcome, artifact, ...artifact };
}

/**
 * The reasoning effort an agent() call asked for, kept only when the model it
 * runs on actually offers that level.
 *
 * Dropping instead of coercing is deliberate: normalizeModelEffort() rewrites
 * an unsupported level to the model's default anyway, so passing nothing lands
 * on exactly the same variant while leaving `effort` absent from RunAgentOpts
 * (and out of the journal's replay hash) for every call that never asked. A
 * script that names a level its model lacks is a script bug, not a run error:
 * failing the agent over it would abort a 200-agent fan-out for a typo.
 */
function agentEffort(model: string, requested?: string): string | undefined {
  const want = requested?.trim().toLowerCase();
  if (!want) return undefined;
  return modelEfforts(model).includes(want as SessionEffort) ? want : undefined;
}

function detachedWorkflowRunner(
  ctx: WorkflowExecCtx,
  signal: AbortSignal,
): RunAgentFn {
  return (opts, onEngineSession) =>
    runAuxiliaryAgentHosted({
      osSessionId: ctx.sessionId,
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mode: opts.mode,
      mcpGrantUser: opts.mcpGrantUser,
      model: opts.model,
      images: opts.images,
      forkSession: opts.forkSession,
      resumeSessionAt: opts.resumeSessionAt,
      mcpServers: opts.mcpServers,
      reposNote: opts.reposNote,
      deniedTools: opts.deniedTools,
      confirmTools: opts.confirmTools,
      aws: opts.aws,
      claudeCliEnv: opts.claudeCliEnv,
      codexCliEnv: opts.codexCliEnv,
      author: opts.author,
      user: opts.user,
      fallbackModel: opts.fallbackModel,
      accountAffinityKey: opts.accountAffinityKey,
      effort: opts.effort,
      fastMode: opts.fastMode,
      accountId: opts.accountId,
      accountStrict: opts.accountStrict,
      usageCredits: opts.usageCredits,
      prReviewer: opts.prReviewer,
      journalKind: opts.journal?.kind || "workflow",
      // Workflow snapshots already own the worker's visible output. Direct
      // in-process workers had no transcript owner mapping, so preserve that
      // behavior instead of projecting subagent chatter into the parent session.
      transcriptTarget: "none",
      signal,
      onEngineSession,
    });
}

export const workflowExecutor: WorkflowExecutor = {
  async execute(
    req: WorkflowAgentRequest,
    ctx: WorkflowExecCtx,
  ): Promise<WorkflowAgentOutcome> {
    const requestedModel =
      req.opts.model || ctx.defaultModel || getDefaultModel();
    const model = resolveModel(requestedModel)?.id || requestedModel;
    const effort = agentEffort(model, req.opts.effort);
    const write = req.opts.write === true;

    // Per-agent timeout + the workflow's cancel signal fold into one signal.
    const inner = new AbortController();
    let timedOut = false;
    const onCancel = () => inner.abort();
    if (ctx.signal.aborted) inner.abort();
    else ctx.signal.addEventListener("abort", onCancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      inner.abort();
    }, WORKFLOW_LIMITS.agentTimeoutMs);

    // Set once a write agent's worktree exists — the finally block cleans it
    // up when the agent produced no commit of its own.
    let worktree:
      | { branch: string; dir: string; baseCommit: string }
      | undefined;
    let keepWorktree = false;

    try {
      if (write) {
        const branch = workflowBranchName(ctx.runId, req.seq);
        // `isolated: true` is load-bearing: without it a shared-checkout repo
        // (opensession) would hand back the LIVE main checkout and every write
        // agent would edit the running server's tree.
        const dir = await worktreeOps.create(branch, ctx.repo, {
          isolated: true,
          base: ctx.baseBranch,
        });
        worktree = { branch, dir, baseCommit: await gitHead(dir) };
      }

      const cwd = worktree?.dir || ctx.cwd;
      const baseOpts: RunAgentOpts = {
        prompt: "",
        cwd,
        mode: write ? "code" : "ask",
        model,
        ...(effort ? { effort } : {}),
        fallbackModel: automaticFallbackModel(model),
        accountAffinityKey: `workflow:${ctx.runId}:${req.seq}`,
        user: ctx.user,
        ...(write ? { author: gitIdentityFor(ctx.user) } : {}),
        journal: { kind: "workflow" },
        // Workflow workers keep the full connector set they had before
        // McpScope; scope it per workflow if that becomes a cost.
        mcpServers: "all",
      };
      let prompt = `${write ? WRITE_PREAMBLE : WORKER_PREAMBLE}\n\n${req.prompt}`;

      const cancelError = () =>
        timedOut
          ? `agent timed out after ${Math.round(WORKFLOW_LIMITS.agentTimeoutMs / 60_000)}m`
          : "workflow cancelled";

      let engineSessionId: string | undefined;
      const onEngineSession = (id: string) => {
        engineSessionId = id;
        ctx.onEngineSession?.(id);
      };
      const runner = runAgentImpl ?? detachedWorkflowRunner(ctx, inner.signal);

      /** Everything a write agent adds on top of a finished run: commit its
       *  work, diffstat it, and drop the worktree when it changed nothing. */
      const withWriteResult = async (
        outcome: WorkflowAgentOutcome,
      ): Promise<WorkflowAgentOutcome> => {
        const base = { ...outcome, engineSessionId, cwd };
        if (!worktree) return base;
        const label =
          req.opts.label || req.prompt.replace(/\s+/g, " ").trim().slice(0, 60);
        if (!outcome.ok) {
          // Failed/cancelled: only keep the worktree if the agent committed
          // something itself (rare); otherwise leave nothing behind. A kept
          // branch is an artifact like any other — the turn failing doesn't
          // make it invisible to the snapshot or to merge().
          const head = await gitHead(worktree.dir);
          keepWorktree = !!head && head !== worktree.baseCommit;
          if (!keepWorktree) return { ...base, changed: false };
          return withArtifact(base, {
            branch: worktree.branch,
            worktreeDir: worktree.dir,
            changed: true,
          });
        }
        // Hold the worktree across the commit: if committing throws, the
        // agent's work stays on disk for a human instead of evaporating.
        keepWorktree = true;
        const committed = await commitWriteAgent(
          worktree.dir,
          worktree.baseCommit,
          `workflow: ${label}`,
          ctx.user,
        );
        keepWorktree = committed.changed;
        if (!committed.changed) return { ...base, changed: false };
        return withArtifact(base, {
          branch: worktree.branch,
          worktreeDir: worktree.dir,
          changed: true,
          commit: committed.commit,
          files: committed.files,
          insertions: committed.insertions,
          deletions: committed.deletions,
        });
      };

      if (req.opts.schema === undefined) {
        const res = await runAgentCollect(
          { ...baseOpts, prompt },
          inner.signal,
          onEngineSession,
          runner,
        );
        if (res.error) {
          return await withWriteResult({
            ok: false,
            error: res.error === "cancelled" ? cancelError() : res.error,
            requestedModel: model,
            model: res.model || model,
            tokens: res.tokens,
            toolCalls: res.toolCalls,
          });
        }
        return await withWriteResult({
          ok: true,
          text: capResult(res.text),
          requestedModel: model,
          model: res.model || model,
          tokens: res.tokens,
          toolCalls: res.toolCalls,
        });
      }

      // Schema mode: demand a fenced json block, validate, retry by
      // resuming the same engine session with the validation errors.
      prompt +=
        "\n\nReply with ONLY a fenced ```json block matching this JSON Schema:\n" +
        JSON.stringify(req.opts.schema);
      let tokens: { input: number; output: number } | undefined;
      let toolCalls = 0;
      let lastModel: string | undefined;
      let lastError = "";
      for (
        let attempt = 0;
        attempt < WORKFLOW_LIMITS.schemaAttempts;
        attempt++
      ) {
        // The retry resumes the same engine session, but the resume target can
        // be silently lost (no engineSessionId on pre-init termination; the
        // runner falls back to a fresh session when the id misses) — so every
        // retry prompt is self-contained: it restates the full original task
        // prompt (which ends with the schema) alongside the validation errors.
        const attemptPrompt =
          attempt === 0
            ? prompt
            : `Your reply failed JSON Schema validation:\n${lastError}\n\n` +
              "Reply again with ONLY a fenced ```json block matching the schema — no other " +
              "text. In case earlier context was lost, the original task follows.\n\n" +
              prompt;
        const res = await runAgentCollect(
          { ...baseOpts, prompt: attemptPrompt, sessionId: engineSessionId },
          inner.signal,
          onEngineSession,
          runner,
        );
        engineSessionId = res.engineSessionId || engineSessionId;
        tokens = addTokens(tokens, res.tokens);
        toolCalls += res.toolCalls;
        lastModel = res.model || lastModel;
        if (res.error) {
          return await withWriteResult({
            ok: false,
            error: res.error === "cancelled" ? cancelError() : res.error,
            requestedModel: model,
            model: lastModel || model,
            tokens,
            toolCalls,
          });
        }
        const raw = extractLastFencedJson(res.text) ?? res.text.trim();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          lastError = `not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
          continue;
        }
        const schemaErrors = validateJsonSchema(parsed, req.opts.schema);
        if (!schemaErrors.length) {
          return await withWriteResult({
            ok: true,
            text: capResult(res.text),
            structured: parsed,
            requestedModel: model,
            model: lastModel || model,
            tokens,
            toolCalls,
          });
        }
        lastError = schemaErrors.join("; ");
      }
      return await withWriteResult({
        ok: false,
        error: `schema validation failed after ${WORKFLOW_LIMITS.schemaAttempts} attempts: ${lastError}`,
        requestedModel: model,
        model: lastModel || model,
        tokens,
        toolCalls,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onCancel);
      // A write agent with nothing to show for itself (no changes, an error,
      // a cancel, or a throw on the way) leaves no worktree or branch behind.
      if (worktree && !keepWorktree) {
        try {
          await worktreeOps.remove(worktree.branch, ctx.repo);
        } catch (e) {
          console.warn(
            `[workflow] failed to remove worktree ${worktree.branch}:`,
            e,
          );
        }
      }
    }
  },

  merge(ctx, items) {
    return mergeWorkflowAgents(ctx, items);
  },
};

// ── merge() ──────────────────────────────────────────────────────────────────

/**
 * Land write agents' branches on the session's branch, in the session's own
 * worktree, sequentially.
 *
 * SAFETY (this touches a checkout a human and the live server may be using):
 *  - REFUSES when the session works in a shared-checkout repo's LIVE main
 *    checkout (opensession on master) — merging into the tree the server runs
 *    from, while every other session is editing it, is exactly the "never reset
 *    or switch the shared tree" trap in AGENTS.md. The script gets the branch
 *    names back and can report them for manual handling.
 *  - REFUSES when the session worktree is dirty — a merge would entangle
 *    somebody's uncommitted work.
 *  - A conflicting branch is `merge --abort`ed (tree left exactly as it was),
 *    its conflicting files are reported, and the batch CONTINUES: one bad agent
 *    must not sink the others.
 */
export async function mergeWorkflowAgents(
  ctx: WorkflowExecCtx,
  items: Array<{ seq: number; branch: string }>,
): Promise<WorkflowMergeResult> {
  const result: WorkflowMergeResult = {
    merged: [],
    conflicts: [],
    skipped: [],
  };
  if (!items.length) return result;

  const dir = ctx.cwd;
  if (worktreeOps.isLiveSharedCheckout(ctx.repo, dir)) {
    return {
      ...result,
      error:
        `refusing to merge into the live shared checkout (${dir}): this session works directly ` +
        `in ${ctx.repo || "the repo"}'s main checkout, which the running server and other sessions share. ` +
        `The agents' branches are intact — merge or cherry-pick them by hand: ${items
          .map((i) => i.branch)
          .join(", ")}.`,
    };
  }

  const isRepo = await $`git -C ${dir} rev-parse --git-dir`.quiet().nothrow();
  if (isRepo.exitCode !== 0) {
    return { ...result, error: `not a git worktree: ${dir}` };
  }
  const status = await $`git -C ${dir} status --porcelain`.quiet().nothrow();
  const dirty =
    status.exitCode === 0 && status.stdout.toString().trim().length > 0;
  if (dirty) {
    return {
      ...result,
      error:
        `refusing to merge into a dirty worktree (${dir}): commit or stash the uncommitted changes first. ` +
        `The agents' branches are intact: ${items.map((i) => i.branch).join(", ")}.`,
    };
  }

  const env = gitEnv(ctx.user);
  for (const item of items) {
    const exists =
      await $`git -C ${dir} rev-parse --verify --quiet refs/heads/${item.branch}`
        .quiet()
        .nothrow();
    if (exists.exitCode !== 0) {
      result.skipped.push({ ...item, reason: "branch no longer exists" });
      continue;
    }
    const merge =
      await $`git -C ${dir} merge --no-ff --no-edit -m ${`workflow: merge ${item.branch}`} ${item.branch}`
        .quiet()
        .nothrow()
        .env(env);
    if (merge.exitCode === 0) {
      result.merged.push({ seq: item.seq, branch: item.branch });
      // The work lives on the session's branch now — the worktree is dead
      // weight (the branch itself is cheap, so it stays as a paper trail).
      try {
        await worktreeOps.remove(item.branch, ctx.repo);
      } catch (e) {
        console.warn(
          `[workflow] failed to remove merged worktree ${item.branch}:`,
          e,
        );
      }
      continue;
    }
    const conflicted = await $`git -C ${dir} diff --name-only --diff-filter=U`
      .quiet()
      .nothrow();
    const files =
      conflicted.exitCode === 0
        ? conflicted.stdout
            .toString()
            .split("\n")
            .map((f) => f.trim())
            .filter(Boolean)
        : [];
    // Leave the tree exactly as we found it, then keep going.
    await $`git -C ${dir} merge --abort`.quiet().nothrow();
    if (!files.length) {
      // Not a content conflict (e.g. the merge refused outright) — say so
      // rather than reporting a conflict with no files.
      result.skipped.push({
        ...item,
        reason: merge.stderr.toString().trim().slice(0, 200) || "merge failed",
      });
      continue;
    }
    result.conflicts.push({ seq: item.seq, branch: item.branch, files });
  }
  return result;
}
