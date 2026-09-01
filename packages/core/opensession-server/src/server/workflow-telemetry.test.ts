import { expect, test } from "bun:test";
import { workflowTelemetryEvents } from "./workflow-telemetry";
import type { WorkflowRunSnapshot } from "./workflow-types";

test("workflow telemetry emits one run event and one event per phase", () => {
  const run: WorkflowRunSnapshot = {
    runId: "wf-child",
    replayRootRunId: "wf-root",
    sessionId: "session-1",
    name: "audit",
    status: "done",
    phases: ["Review"],
    agents: [
      {
        seq: 0,
        label: "review",
        phase: "Review",
        status: "done",
        promptPreview: "review",
        requestedModel: "pi/anthropic/claude-opus-5",
        model: "pi/anthropic/claude-sonnet-5",
        modelSubstitutedFrom: "pi/anthropic/claude-opus-5",
        tokens: { input: 100, output: 20 },
        toolCalls: 2,
        startedAt: "2026-08-30T10:00:00.000Z",
        endedAt: "2026-08-30T10:00:02.000Z",
      },
    ],
    logs: [],
    startedAt: "2026-08-30T10:00:00.000Z",
    endedAt: "2026-08-30T10:00:03.000Z",
    totals: {
      agents: 1,
      tokensIn: 100,
      tokensOut: 20,
      agentToolCalls: 2,
      mcpCalls: 1,
    },
    mcpCalls: [
      {
        seq: 0,
        server: "github",
        tool: "get_pull_request",
        phase: "Review",
        ok: true,
        ms: 50,
      },
    ],
    cwd: "/tmp",
  };
  const events = workflowTelemetryEvents(run);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    kind: "workflow_run_metric",
    workflow_root_run_id: "wf-root",
    model_substitutions: 1,
    agent_tool_calls: 2,
    direct_tool_calls: 1,
  });
  expect(events[1]).toMatchObject({
    kind: "workflow_phase_metric",
    phase: "Review",
    tokens_in: 100,
    tokens_out: 20,
    tool_calls: 3,
    work_duration_ms: 2050,
  });
});
