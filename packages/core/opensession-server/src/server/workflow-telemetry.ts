import { audit } from "./audit";
import { workflowPhaseStats } from "../shared/workflow-observability";
import type { WorkflowRunSnapshot } from "./workflow-types";

export function workflowTelemetryEvents(
  run: WorkflowRunSnapshot,
): Array<Record<string, unknown>> {
  const ended = Date.parse(run.endedAt || new Date().toISOString());
  const started = Date.parse(run.startedAt);
  const durationMs =
    Number.isFinite(ended) && Number.isFinite(started)
      ? Math.max(0, ended - started - (run.totalPausedMs || 0))
      : 0;
  const base = {
    session_id: run.sessionId,
    workflow_run_id: run.runId,
    workflow_root_run_id: run.replayRootRunId || run.runId,
    workflow_name: run.name,
  };
  const events: Array<Record<string, unknown>> = [
    {
      kind: "workflow_run_metric",
      ...base,
      status: run.status,
      duration_ms: durationMs,
      agent_count: run.agents.length,
      session_count: run.sessions?.length || 0,
      tokens_in: run.totals.tokensIn,
      tokens_out: run.totals.tokensOut,
      agent_tool_calls: run.totals.agentToolCalls || 0,
      direct_tool_calls: run.totals.mcpCalls || 0,
      direct_tool_errors: run.totals.mcpErrors || 0,
      model_substitutions: run.agents.filter((agent) =>
        Boolean(agent.modelSubstitutedFrom),
      ).length,
      large_workflow: Boolean(run.warnings?.length),
    },
  ];
  for (const phase of workflowPhaseStats(run, ended)) {
    events.push({
      kind: "workflow_phase_metric",
      ...base,
      phase: phase.title,
      agents: phase.agents,
      done: phase.done,
      errors: phase.error,
      cancelled: phase.cancelled,
      tokens_in: phase.tokensIn,
      tokens_out: phase.tokensOut,
      tool_calls: phase.toolCalls,
      work_duration_ms: phase.durationMs,
    });
  }
  return events;
}

export function emitWorkflowTelemetry(run: WorkflowRunSnapshot): void {
  for (const event of workflowTelemetryEvents(run)) audit(event);
}
