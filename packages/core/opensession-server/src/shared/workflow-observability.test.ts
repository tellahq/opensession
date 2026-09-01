import { describe, expect, test } from "bun:test";
import { workflowPhaseStats, workflowWarnings } from "./workflow-observability";
import { WORKFLOW_LIMITS, type WorkflowRunSnapshot } from "./workflow-types";

function run(): WorkflowRunSnapshot {
  return {
    runId: "wf-test",
    sessionId: "session-test",
    name: "test",
    status: "running",
    phases: ["Gather", "Verify"],
    currentPhase: "Verify",
    agents: [
      {
        seq: 0,
        label: "gather",
        phase: "Gather",
        status: "done",
        promptPreview: "gather",
        startedAt: "2026-08-30T10:00:00.000Z",
        endedAt: "2026-08-30T10:00:02.000Z",
        tokens: { input: 100, output: 20 },
        toolCalls: 3,
      },
      {
        seq: 1,
        label: "verify",
        phase: "Verify",
        status: "running",
        promptPreview: "verify",
        startedAt: "2026-08-30T10:00:01.000Z",
        tokens: { input: 50, output: 10 },
        toolCalls: 1,
      },
    ],
    mcpCalls: [
      {
        seq: 0,
        server: "linear",
        tool: "get",
        phase: "Gather",
        ok: true,
        ms: 40,
      },
    ],
    logs: [],
    startedAt: "2026-08-30T10:00:00.000Z",
    totals: { agents: 2, tokensIn: 150, tokensOut: 30, mcpCalls: 1 },
    cwd: "/tmp",
  };
}

describe("workflow observability", () => {
  test("aggregates agent and direct-tool progress by phase", () => {
    const stats = workflowPhaseStats(
      run(),
      Date.parse("2026-08-30T10:00:04.000Z"),
    );
    expect(stats).toEqual([
      {
        title: "Gather",
        agents: 1,
        pending: 0,
        running: 0,
        done: 1,
        error: 0,
        cancelled: 0,
        tokensIn: 100,
        tokensOut: 20,
        toolCalls: 4,
        durationMs: 2040,
      },
      {
        title: "Verify",
        agents: 1,
        pending: 0,
        running: 1,
        done: 0,
        error: 0,
        cancelled: 0,
        tokensIn: 50,
        tokensOut: 10,
        toolCalls: 1,
        durationMs: 3000,
      },
    ]);
  });

  test("warns at either large-run threshold", () => {
    const value = run();
    expect(workflowWarnings(value)).toEqual([]);
    value.agents = Array.from(
      { length: WORKFLOW_LIMITS.largeWorkflowAgents },
      (_, seq) => ({
        seq,
        label: String(seq),
        status: "pending" as const,
        promptPreview: "",
      }),
    );
    value.totals.agents = value.agents.length;
    expect(workflowWarnings(value)[0]?.message).toContain(
      `${WORKFLOW_LIMITS.largeWorkflowAgents} agents`,
    );

    value.agents = [];
    value.totals.tokensIn = WORKFLOW_LIMITS.largeWorkflowTokens;
    expect(workflowWarnings(value)[0]?.message).toContain("tokens");
  });
});
