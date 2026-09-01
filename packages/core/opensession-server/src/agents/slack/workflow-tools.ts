/**
 * opensession-workflows — dynamic workflows: run a model-authored JS script
 * that fans out lightweight agent runs deterministically (map-reduce over a
 * codebase, N-way audits, comparative research) and calls MCP tools directly.
 * The script executes in a
 * contained Bun Worker (env-scrubbed, exfil/spawn globals stripped — see
 * workflow-worker.ts; exposure gating is the real boundary); each agent()
 * call becomes a plain pi run in ask mode, while mcp.* calls go through
 * workflow-mcp.ts — a round trip, not a model turn, scoped by the
 * ctx.mcpAllowlist/deniedTools this server was built with (see
 * src/server/workflow-types.ts for the contract, workflow-runner.ts for
 * orchestration). Interactive sessions, plus automations a HUMAN flagged
 * with `workflows: true` (automations.ts registers the instance per run —
 * e.g. the morning support digest, whose cron prompt is our own text).
 * Never set that flag on automations triggered by untrusted event/ticket
 * text (Plain triage, channel watches): model-authored code execution must
 * not be steerable from a ticket. The fail-closed gate in interactive-mcp.ts
 * still withholds the interactive builder from automation-owned sessions;
 * flagged automations only get the instance automations.ts explicitly
 * registers (human-authorized).
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  cancelWorkflow,
  controlWorkflowAgent,
  pauseWorkflow,
  resumeWorkflow,
  startWorkflow,
} from "../../server/workflow-runner";
import {
  getWorkflowRun,
  listWorkflowRunsForSession,
  readWorkflowScript,
} from "../../server/workflow-store";
import { WORKFLOW_LIMITS } from "../../server/workflow-types";
import { selectableModels } from "../../server/models";
import { workflowPhaseStats } from "../../shared/workflow-observability";
import type {
  WorkflowAgentSnapshot,
  WorkflowAutomationSessionPolicy,
  WorkflowRunSnapshot,
} from "../../server/workflow-types";

/**
 * The model workflow agents run on when the script doesn't name one.
 * Deliberately NOT the session's model: a fan-out inherits whatever the
 * orchestrator happens to be on (Fable), which is both expensive and not
 * obviously the right worker. Opus is the strong default — intelligence first,
 * cost only a tie-breaker (CLAUDE.md's priority rule). A script can still route
 * per agent via opts.model when it has a reason to.
 */
export const WORKFLOW_DEFAULT_MODEL = "pi/anthropic/claude-opus-5";

export interface WorkflowsToolContext {
  sessionId: string;
  user?: string;
  /** Resolved lazily per call — repos can attach or switch mid-run. */
  workspace: (
    repo?: string,
    hint?: string,
  ) => { cwd: string; repo?: string; baseBranch?: string } | undefined;
  /** Overrides WORKFLOW_DEFAULT_MODEL for agent() calls that name no model.
   *  Left unset in production — agents default to Opus, not the session's model. */
  defaultModel?: () => string | undefined;
  /** MCP allowlist for the script's mcp.* calls. Omitted (interactive
   *  sessions) = every server this user's own runs may see; an automation
   *  passes its own least-privilege list so a script can't widen it. */
  mcpAllowlist?: string[];
  /** Per-call tool denials for mcp.* (automation runs: Plain customer-facing
   *  writes, WorkOS identity mutation). */
  deniedTools?: Record<string, string>;
  /** Human-owned automation policy for durable code child sessions. */
  automationSessionPolicy?: WorkflowAutomationSessionPolicy;
  /** The in-process opensession-* servers this run carries, built FRESH per
   *  call (an McpServer holds one transport — see workflow-mcp.ts). Supplied
   *  by interactive sessions only; an automation's script stays external-only.
   *  workflow-mcp.ts intersects the result with its own allowlist, so passing
   *  the full interactive set here cannot widen the script's surface. */
  inProcessMcp?: () => Record<string, unknown>;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function elapsed(run: WorkflowRunSnapshot): string {
  const start = Date.parse(run.startedAt);
  const now = Date.now();
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  const currentPause = run.pausedAt
    ? Math.max(0, now - Date.parse(run.pausedAt))
    : 0;
  const s = Math.max(
    0,
    Math.round((end - start - (run.totalPausedMs || 0) - currentPause) / 1000),
  );
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

function countByStatus(agents: WorkflowAgentSnapshot[]): string {
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(a.status, (counts.get(a.status) || 0) + 1);
  return ["done", "running", "pending", "error", "cancelled"]
    .filter((st) => counts.get(st))
    .map((st) => `${counts.get(st)} ${st}`)
    .join(", ");
}

/** Compact enough to stay in every eligible model context. The full API and
 * examples live in the lazily loaded workflow-authoring skill. */
export const RUN_WORKFLOW_DESCRIPTION = `Run a model-authored plain-JavaScript workflow for deterministic agent fan-out, direct MCP calls, and durable child sessions. Use it for broad, repetitive work that benefits from parallelism. Progress streams to the Agents panel and workflow_status.

The script must export meta with a short name, then may use top-level await and return. Minimal shape:

export const meta = { name: "audit", phases: [{ title: "Inspect" }] };
phase("Inspect");
return await parallel([() => agent("Inspect path A", { label: "A" })]);

Before authoring or revising a non-trivial workflow, load the workflow-authoring skill (or invoke /workflow-authoring) for the complete API, determinism rules, durable-session patterns, and examples. Call workflow_capabilities for the current model ids, defaults, and runtime limits. Agents start with no conversation context and are read-only unless explicitly given write access. Completed agent, MCP, and session calls are journaled for resume/recovery.`;

export function workflowCapabilitiesText(
  defaultModel = WORKFLOW_DEFAULT_MODEL,
): string {
  const models = selectableModels();
  const modelLines = models.length
    ? models.map((model) => `- ${model.id} — ${model.label}`)
    : ["- No selectable models are currently registered."];
  return [
    "# Workflow capabilities",
    "",
    `Default agent model: ${defaultModel}`,
    "Selectable agent models (pass as opts.model):",
    ...modelLines,
    "",
    "Runtime limits:",
    `- Agents: ${WORKFLOW_LIMITS.maxConcurrentAgents} concurrent, ${WORKFLOW_LIMITS.maxAgents} per run, ${Math.round(WORKFLOW_LIMITS.agentTimeoutMs / 60_000)} minutes each`,
    `- Write agents: ${WORKFLOW_LIMITS.maxConcurrentWriteAgents} concurrent, ${WORKFLOW_LIMITS.maxWriteAgents} per run`,
    `- Direct MCP: ${WORKFLOW_LIMITS.maxConcurrentMcp} concurrent, ${WORKFLOW_LIMITS.maxMcpCalls} per run, ${Math.round(WORKFLOW_LIMITS.mcpCallTimeoutMs / 1000)} seconds each`,
    `- Durable sessions: ${WORKFLOW_LIMITS.maxConcurrentSessions} concurrent, ${WORKFLOW_LIMITS.maxSessions} total, ${WORKFLOW_LIMITS.maxSessionDepth} levels deep`,
    `- Child-session budget: ${WORKFLOW_LIMITS.maxSessionTokens} completed tokens and $${WORKFLOW_LIMITS.maxSessionCostUsd} provider-reported cost`,
    `- Workflow active time: ${Math.round(WORKFLOW_LIMITS.workflowTimeoutMs / 60_000)} minutes`,
    "",
    "Load the workflow-authoring skill (or invoke /workflow-authoring) for the complete API and examples.",
  ].join("\n");
}

export function createWorkflowsMcpServer(ctx: WorkflowsToolContext) {
  const tools = [
    tool(
      "workflow_capabilities",
      "List the current workflow agent models, defaults, and runtime limits. Call this only when choosing models or sizing a workflow; load the workflow-authoring skill for the full API and examples.",
      {},
      async () =>
        text(
          workflowCapabilitiesText(
            ctx.defaultModel?.() || WORKFLOW_DEFAULT_MODEL,
          ),
        ),
    ),
    tool(
      "run_workflow",
      RUN_WORKFLOW_DESCRIPTION,
      {
        script: z
          .string()
          .describe(
            "The workflow script: `export const meta = {...}` + plain-JS async body using the injected globals.",
          ),
        args_json: z
          .string()
          .optional()
          .describe(
            "JSON string exposed to the script as `args` (parameters, file lists, timestamps — anything the script needs).",
          ),
        budget_tokens: z
          .number()
          .optional()
          .describe(
            "Optional output-token budget the script can consult via `budget` (advisory: spent()/remaining()).",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Repo context for every workflow agent. Pass this when auditing an attached repo so agents start in that exact worktree and can see current/uncommitted changes.",
          ),
      },
      async (args: {
        script: string;
        args_json?: string;
        budget_tokens?: number;
        repo?: string;
      }) => {
        let parsedArgs: unknown;
        if (args.args_json !== undefined) {
          try {
            parsedArgs = JSON.parse(args.args_json);
          } catch (e: any) {
            return text(
              `args_json is not valid JSON (${e?.message || String(e)}) — pass a JSON string, e.g. '{"files": ["a.ts"]}'.`,
            );
          }
        }
        const workspace = ctx.workspace(args.repo, args.script);
        if (!workspace) {
          return text(
            args.repo
              ? `Repo "${args.repo}" is not attached to this session — attach it first (opensession-repos attach_repo), or choose one of the session's repos.`
              : "This session has no worktree — workflow agents need a working directory. Attach a repo first (opensession-repos attach_repo).",
          );
        }
        try {
          const { runId } = startWorkflow({
            script: args.script,
            args: parsedArgs,
            sessionId: ctx.sessionId,
            user: ctx.user,
            cwd: workspace.cwd,
            repo: workspace.repo,
            baseBranch: workspace.baseBranch,
            defaultModel: ctx.defaultModel?.() || WORKFLOW_DEFAULT_MODEL,
            budgetTotal: args.budget_tokens,
            mcpAllowlist: ctx.mcpAllowlist,
            deniedTools: ctx.deniedTools,
            automationSessionPolicy: ctx.automationSessionPolicy,
            inProcessMcp: ctx.inProcessMcp,
          });
          return text(
            `Workflow started: ${runId}. Poll workflow_status for progress; it also streams live to this session's Agents panel.`,
          );
        } catch (e: any) {
          return text(`Couldn't start workflow: ${e?.message || String(e)}`);
        }
      },
    ),
    tool(
      "workflow_status",
      "Progress of a workflow run: status, elapsed, per-phase agent counts, currently-running agents, recent logs — and the script's return value once done. Poll this after run_workflow (the UI panel updates live, but this is how YOU read the result).",
      {
        run_id: z.string().describe("The wf-… run id from run_workflow."),
        include_result: z
          .boolean()
          .optional()
          .describe(
            "Include the script's return value when the run is done (default true).",
          ),
      },
      async (args: { run_id: string; include_result?: boolean }) => {
        const run = getWorkflowRun(args.run_id);
        if (!run) return text(`No workflow run ${args.run_id}.`);
        const lines: string[] = [];
        const livePhaseStats = workflowPhaseStats(run);
        const totals = countByStatus(run.agents);
        lines.push(
          `${run.name} (${run.runId}): ${run.status} · ${elapsed(run)} · ${run.agents.length} agents${totals ? ` (${totals})` : ""}`,
        );
        for (const stats of livePhaseStats) {
          const agents = run.agents.filter(
            (agent) => (agent.phase || "Other") === stats.title,
          );
          if (!agents.length && !stats.toolCalls) continue;
          const running = agents
            .filter((agent) => agent.status === "running")
            .map((agent) => agent.label)
            .slice(0, 5);
          const counts = countByStatus(agents) || "0 agents";
          const details = ` · ${stats.tokensIn + stats.tokensOut} tokens · ${stats.toolCalls} tool calls · ${Math.round(stats.durationMs / 1000)}s work time`;
          lines.push(
            `  ${stats.title}: ${counts}${details}${running.length ? ` — running: ${running.join(", ")}` : ""}`,
          );
        }
        if (run.sessions?.length) {
          lines.push("  sessions:");
          for (const session of run.sessions) {
            lines.push(
              `    - ${session.id} — ${session.status} · ${session.repo}:${session.branch}${session.prUrl ? ` · PR ${session.prUrl}` : ""}${session.error ? ` · ${session.error}` : ""}`,
            );
          }
        }
        if (run.totals.mcpCalls) {
          const errs = run.totals.mcpErrors || 0;
          // Which servers the script actually hit — cheap signal that it's
          // reaching the right data (and where it's erroring).
          const byServer = new Map<string, number>();
          for (const c of run.mcpCalls || [])
            byServer.set(c.server, (byServer.get(c.server) || 0) + 1);
          const servers = [...byServer.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([s, n]) => `${s}×${n}`)
            .join(", ");
          lines.push(
            `  tool calls: ${run.totals.mcpCalls}${errs ? `, ${errs} failed` : ""}${servers ? ` — recent: ${servers}` : ""}`,
          );
          const failures = (run.mcpCalls || []).filter((c) => !c.ok).slice(-3);
          for (const f of failures)
            lines.push(`    ✗ ${f.server}.${f.tool}: ${f.error || "failed"}`);
        }
        for (const warning of run.warnings || [])
          lines.push(`Warning: ${warning.message}`);
        if (run.error) lines.push(`Error: ${run.error}`);
        if (run.logs.length) {
          lines.push("Recent logs:");
          for (const l of run.logs.slice(-5))
            lines.push(`  [${l.ts.slice(11, 19)}] ${l.message}`);
        }
        if (run.status === "done" && args.include_result !== false) {
          let result: string;
          try {
            result =
              typeof run.result === "string"
                ? run.result
                : JSON.stringify(run.result, null, 2);
          } catch {
            result = String(run.result);
          }
          lines.push("Result:");
          if (result.length > 20_000) {
            // Spill the full value to a scratch file so it isn't lost to
            // the tool-output cap. /tmp/pi/** is readable by the
            // Read tool in BOTH shell and ask-mode runs (see
            // ASK_EXTERNAL_DIR_PERMISSIONS in pi-runner.ts), so the
            // agent can read the untruncated result instead of replaying
            // the whole workflow with a compacted return shape (the
            // "resume_workflow just to reshape the return" papercut).
            let spillPath = "";
            try {
              const dir = "/tmp/pi/workflow-results";
              mkdirSync(dir, { recursive: true });
              spillPath = `${dir}/${run.runId}.txt`;
              writeFileSync(spillPath, result);
            } catch {
              spillPath = "";
            }
            lines.push(
              result.slice(0, 20_000) + "\n… (truncated at 20,000 chars)",
            );
            if (spillPath)
              lines.push(
                `Full result (${result.length} chars) written to ${spillPath} — Read that file for the complete value instead of re-running the workflow.`,
              );
          } else {
            lines.push(result);
          }
        }
        return text(lines.join("\n"));
      },
    ),
    tool(
      "list_workflows",
      "List this session's workflow runs, newest first — one line each with run id, name, status and agent count.",
      {},
      async () => {
        const runs = listWorkflowRunsForSession(ctx.sessionId);
        if (!runs.length) return text("No workflow runs in this session yet.");
        const lines = runs.map(
          (r: WorkflowRunSnapshot) =>
            `- ${r.runId} ${r.name} — ${r.status}, ${r.agents.length} agents, ${r.sessions?.length || 0} sessions, ${elapsed(r)}, started ${r.startedAt.slice(0, 16).replace("T", " ")}`,
        );
        return text(lines.join("\n"));
      },
    ),
    tool(
      "cancel_workflow",
      "Cancel a running workflow: aborts in-flight agents, terminates the script, marks the run cancelled, and applies its configured active-child cancellation policy.",
      {
        run_id: z.string().describe("The wf-… run id to cancel."),
      },
      async (args: { run_id: string }) => {
        const ok = cancelWorkflow(args.run_id);
        return text(
          ok
            ? `Cancelled ${args.run_id}.`
            : `No live workflow ${args.run_id} — it may have already finished (check workflow_status).`,
        );
      },
    ),
    tool(
      "pause_workflow",
      "Pause a running workflow. Active agents stop cleanly and restart in place when the workflow resumes; completed journal entries are preserved.",
      {
        run_id: z.string().describe("The live wf-… run id to pause."),
      },
      async (args: { run_id: string }) =>
        text(
          pauseWorkflow(args.run_id, "paused by agent")
            ? `Paused ${args.run_id}.`
            : `Could not pause ${args.run_id}; it may not be running.`,
        ),
    ),
    tool(
      "control_workflow_agent",
      "Skip or retry one pending/running workflow agent without cancelling its siblings. Retry is available only while the agent is running.",
      {
        run_id: z.string().describe("The live wf-… run id."),
        seq: z.number().int().nonnegative().describe("Agent sequence number."),
        action: z.enum(["skip", "retry"]),
      },
      async (args: { run_id: string; seq: number; action: "skip" | "retry" }) =>
        text(
          controlWorkflowAgent(args.run_id, args.seq, args.action)
            ? `${args.action === "retry" ? "Retrying" : "Skipping"} agent ${args.seq} in ${args.run_id}.`
            : `Could not ${args.action} agent ${args.seq}; it may already be finished.`,
        ),
    ),
    tool(
      "resume_workflow",
      "Resume a paused workflow in place, or re-launch a done/error/interrupted/cancelled workflow as a NEW run that replays completed agent(), mcp.* and session API calls from the old run's journal. Existing child sessions are re-adopted, never duplicated. Optionally pass a fixed script.",
      {
        run_id: z.string().describe("The finished wf-… run id to resume from."),
        script: z
          .string()
          .optional()
          .describe(
            "Replacement script (e.g. with a bug fixed). Omit to re-run the original script.",
          ),
        args_json: z
          .string()
          .optional()
          .describe(
            "JSON string for the script's `args`. Omit to run with no args — note agent() calls whose prompts derive from args only replay when the prompts come out identical.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Repo context for the resumed workflow. Omit to reuse the original run's cwd.",
          ),
      },
      async (args: {
        run_id: string;
        script?: string;
        args_json?: string;
        repo?: string;
      }) => {
        const old = getWorkflowRun(args.run_id);
        if (!old) return text(`No workflow run ${args.run_id}.`);
        if (old.status === "running")
          return text(
            `${args.run_id} is still running — cancel_workflow it first, or wait for it to finish.`,
          );
        if (
          old.status === "paused" &&
          args.script === undefined &&
          args.args_json === undefined &&
          args.repo === undefined &&
          resumeWorkflow(args.run_id)
        )
          return text(`Resumed ${args.run_id} in place.`);
        if (old.status === "paused")
          return text(
            `${args.run_id} is paused — resume it unchanged, or cancel it before relaunching with edits.`,
          );
        const script = args.script ?? readWorkflowScript(args.run_id);
        if (!script)
          return text(
            `Couldn't read the original script for ${args.run_id} — pass one explicitly via the script param.`,
          );
        let parsedArgs: unknown = old.recovery?.args;
        if (args.args_json !== undefined) {
          try {
            parsedArgs = JSON.parse(args.args_json);
          } catch (e: any) {
            return text(
              `args_json is not valid JSON (${e?.message || String(e)}).`,
            );
          }
        }
        // New runs persist cwd but older snapshots do not carry repo id.
        // Re-resolve the old cwd as a hint so an attached-repo workflow
        // resumes with the correct repo/base branch for write agents too.
        const workspace = args.repo
          ? ctx.workspace(args.repo, script)
          : ctx.workspace(undefined, old.cwd);
        if (args.repo && !workspace)
          return text(`Repo "${args.repo}" is not attached to this session.`);
        try {
          const { runId } = startWorkflow({
            script,
            args: parsedArgs,
            sessionId: ctx.sessionId,
            user: ctx.user,
            cwd: workspace?.cwd || old.cwd,
            repo: workspace?.repo,
            baseBranch: workspace?.baseBranch,
            defaultModel: ctx.defaultModel?.() || WORKFLOW_DEFAULT_MODEL,
            resumeFromRunId: args.run_id,
            mcpAllowlist: ctx.mcpAllowlist,
            deniedTools: ctx.deniedTools,
            automationSessionPolicy: ctx.automationSessionPolicy,
            inProcessMcp: ctx.inProcessMcp,
          });
          return text(
            `Resumed as ${runId} (journal replay from ${args.run_id}). Poll workflow_status; progress streams to the Agents panel.`,
          );
        } catch (e: any) {
          return text(`Couldn't resume workflow: ${e?.message || String(e)}`);
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-workflows",
    version: "1.0.0",
    tools,
  });
}
