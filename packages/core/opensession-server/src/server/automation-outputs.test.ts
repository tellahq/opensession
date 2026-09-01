import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import {
  automationSlackBlocks,
  deleteAutomationOutputState,
  deliverAutomationOutputs,
  sanitizeAutomationOutputs,
} from "./automation-outputs";
import {
  __resetReportIndexForTest,
  publishReport,
  REPORTS_ROOT,
} from "./reports";

const automationId = `test-automation-outputs-${process.pid}`;

afterEach(() => {
  deleteAutomationOutputState(automationId);
  rmSync(join(REPORTS_ROOT, automationId), { recursive: true, force: true });
  __resetReportIndexForTest();
});

describe("sanitizeAutomationOutputs", () => {
  test("normalizes report and disabled Slack sinks", () => {
    expect(
      sanitizeAutomationOutputs([
        { id: "report", type: "report", publish: "on_findings" },
        {
          id: "slack",
          type: "slack",
          enabled: false,
          channel: "c01ed50a2kg",
        },
      ]),
    ).toEqual([
      { id: "report", type: "report", enabled: true, publish: "on_findings" },
      {
        id: "slack",
        type: "slack",
        enabled: false,
        channel: "C01ED50A2KG",
        source: "report",
        minUrgency: "high",
        minConfidence: "high",
      },
    ]);
  });

  test("accepts direct-message conversations", () => {
    expect(
      sanitizeAutomationOutputs([
        { id: "slack", type: "slack", channel: "d0a7zb82npl" },
      ]),
    ).toEqual([
      {
        id: "slack",
        type: "slack",
        enabled: true,
        channel: "D0A7ZB82NPL",
        source: "report",
        minUrgency: "high",
        minConfidence: "high",
      },
    ]);
  });

  test("rejects conversation names and duplicate ids", () => {
    expect(
      sanitizeAutomationOutputs([
        { id: "slack", type: "slack", channel: "#chat" },
      ]),
    ).toEqual({
      error: "outputs[0].channel must be a Slack C…/D…/G… conversation id",
    });
    expect(
      sanitizeAutomationOutputs([
        { id: "same", type: "report" },
        { id: "same", type: "report" },
      ]),
    ).toEqual({ error: 'duplicate automation output id "same"' });
  });
});

describe("automationSlackBlocks", () => {
  const report = {
    id: "report-1",
    title: "4 native parity gaps",
    automationId,
    automationName: "iOS parity check",
    createdAt: new Date().toISOString(),
    urgency: "high" as const,
    confidence: "high" as const,
    tasks: [
      { title: "Fix protocol", prompt: "Fix it." },
      { title: "Fix status", prompt: "Fix that too." },
    ],
  };

  test("puts the one-tap fix action before the report link", () => {
    const blocks = automationSlackBlocks(report, "https://os.test/reports/a/r");
    const actions = blocks.find((block) => block.type === "actions").elements;

    expect(actions.map((action: any) => action.text.text)).toEqual([
      "Fix these",
      "Open report",
    ]);
    expect(actions[0]).toMatchObject({
      style: "primary",
      action_id: "report-fix-all",
    });
    expect(JSON.parse(actions[0].value)).toEqual({
      automationId,
      reportId: "report-1",
    });
  });

  test("does not offer to fix a report with no proposed work", () => {
    const blocks = automationSlackBlocks(
      { ...report, tasks: undefined },
      "https://os.test/reports/a/r",
    );
    const actions = blocks.find((block) => block.type === "actions").elements;
    expect(actions.map((action: any) => action.text.text)).toEqual([
      "Open report",
    ]);
  });
});

describe("deliverAutomationOutputs", () => {
  test("does not require or deliver a disabled Slack sink", async () => {
    await expect(
      deliverAutomationOutputs({
        automationId,
        outputs: [
          {
            id: "slack",
            type: "slack",
            enabled: false,
            channel: "C01ED50A2KG",
          },
        ],
        sessionId: "os-no-report",
        startedAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });

  test("fails a required report output when the run did not publish", async () => {
    await expect(
      deliverAutomationOutputs({
        automationId,
        outputs: [{ id: "report", type: "report", publish: "always" }],
        sessionId: "os-no-report",
        startedAt: new Date(),
      }),
    ).rejects.toThrow("Required report output was not published");
  });

  test("accepts a current report as the required durable output", async () => {
    const startedAt = new Date(Date.now() - 1000);
    publishReport({
      automationId,
      automationName: "Test",
      sessionId: "os-with-report",
      title: "Current report",
      html: "<p>ok</p>",
    });
    await expect(
      deliverAutomationOutputs({
        automationId,
        outputs: [{ id: "report", type: "report", publish: "always" }],
        sessionId: "os-with-report",
        startedAt,
      }),
    ).resolves.toBeUndefined();
  });
});
