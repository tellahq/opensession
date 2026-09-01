import {
  WORKFLOW_LIMITS,
  type WorkflowAgentSnapshot,
  type WorkflowPhaseSnapshot,
  type WorkflowRunSnapshot,
  type WorkflowWarning,
} from "./workflow-types";

function durationMs(agent: WorkflowAgentSnapshot, now: number): number {
  if (!agent.startedAt) return 0;
  const start = Date.parse(agent.startedAt);
  const end = agent.endedAt ? Date.parse(agent.endedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/** Aggregate the progress data both the UI and audit telemetry render. */
export function workflowPhaseStats(
  run: Pick<
    WorkflowRunSnapshot,
    "phases" | "agents" | "mcpCalls" | "phaseToolTotals"
  >,
  now = Date.now(),
): WorkflowPhaseSnapshot[] {
  const titles = [...run.phases];
  for (const agent of run.agents) {
    const title = agent.phase || "Other";
    if (!titles.includes(title)) titles.push(title);
  }
  for (const call of run.mcpCalls || []) {
    const title = call.phase || "Other";
    if (!titles.includes(title)) titles.push(title);
  }
  for (const title of Object.keys(run.phaseToolTotals || {}))
    if (!titles.includes(title)) titles.push(title);

  return titles.map((title) => {
    const agents = run.agents.filter(
      (agent) => (agent.phase || "Other") === title,
    );
    const calls = (run.mcpCalls || []).filter(
      (call) => (call.phase || "Other") === title,
    );
    const directTotals = run.phaseToolTotals?.[title];
    const stats: WorkflowPhaseSnapshot = {
      title,
      agents: agents.length,
      pending: 0,
      running: 0,
      done: 0,
      error: 0,
      cancelled: 0,
      tokensIn: 0,
      tokensOut: 0,
      toolCalls: directTotals?.calls ?? calls.length,
      durationMs:
        directTotals?.durationMs ??
        calls.reduce((sum, call) => sum + call.ms, 0),
    };
    for (const agent of agents) {
      stats[agent.status]++;
      if (!agent.cached) {
        stats.tokensIn += agent.tokens?.input || 0;
        stats.tokensOut += agent.tokens?.output || 0;
        stats.toolCalls += agent.toolCalls || 0;
        stats.durationMs += durationMs(agent, now);
      }
    }
    return stats;
  });
}

export function workflowWarnings(
  run: Pick<WorkflowRunSnapshot, "agents" | "totals" | "sessions">,
): WorkflowWarning[] {
  const tokens =
    run.totals.tokensIn +
    run.totals.tokensOut +
    (run.sessions || []).reduce(
      (sum, session) => sum + (session.tokens || 0),
      0,
    );
  if (
    run.agents.length < WORKFLOW_LIMITS.largeWorkflowAgents &&
    tokens < WORKFLOW_LIMITS.largeWorkflowTokens
  ) {
    return [];
  }
  const reasons: string[] = [];
  if (run.agents.length >= WORKFLOW_LIMITS.largeWorkflowAgents)
    reasons.push(`${run.agents.length} agents`);
  if (tokens >= WORKFLOW_LIMITS.largeWorkflowTokens)
    reasons.push(`${Math.round(tokens / 100_000) / 10}M tokens`);
  return [
    {
      kind: "large_workflow",
      message: `Large workflow: ${reasons.join(" and ")}`,
    },
  ];
}
