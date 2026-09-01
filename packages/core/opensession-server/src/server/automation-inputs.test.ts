import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import {
  automationInputStateExists,
  deleteAutomationInputState,
  prepareAutomationInputs,
  sanitizeAutomationInputs,
  type AutomationInput,
} from "./automation-inputs";
import { publishReport, REPORTS_ROOT } from "./reports";

const automationId = `test-automation-inputs-${process.pid}`;

afterEach(() => {
  deleteAutomationInputState(automationId);
  rmSync(join(REPORTS_ROOT, automationId), { recursive: true, force: true });
});

describe("sanitizeAutomationInputs", () => {
  test("normalizes Slack and report-history inputs", () => {
    expect(
      sanitizeAutomationInputs([
        {
          id: " Chat ",
          label: "Team chat",
          source: { type: "slack_channel", channel: "c01ed50a2kg" },
        },
        {
          id: "history",
          source: { type: "reports", automationId: "self", limit: 2 },
        },
      ]),
    ).toEqual([
      {
        id: "chat",
        label: "Team chat",
        source: {
          type: "slack_channel",
          channel: "C01ED50A2KG",
          includeThreads: true,
          includeBots: false,
          limit: 200,
        },
      },
      {
        id: "history",
        source: { type: "reports", automationId: "self", limit: 2 },
      },
    ]);
  });

  test("rejects duplicate ids and channel names", () => {
    expect(
      sanitizeAutomationInputs([
        { id: "same", source: { type: "reports", automationId: "self" } },
        { id: "same", source: { type: "reports", automationId: "self" } },
      ]),
    ).toEqual({ error: 'duplicate automation input id "same"' });
    expect(
      sanitizeAutomationInputs([
        { id: "chat", source: { type: "slack_channel", channel: "#chat" } },
      ]),
    ).toEqual({
      error: "inputs[0].source.channel must be a Slack C…/G… channel id",
    });
  });
});

describe("prepareAutomationInputs", () => {
  test("reduces Slack as inert data and advances its cursor only on commit", async () => {
    const oldestCalls: number[] = [];
    const input = sanitizeAutomationInputs([
      {
        id: "chat",
        label: "#chat",
        window: {
          mode: "since_last_success",
          minutes: 120,
          overlapMinutes: 10,
        },
        source: {
          type: "slack_channel",
          channel: "C01ED50A2KG",
          includeThreads: false,
        },
      },
    ]) as AutomationInput[];
    const deps = {
      slackApiGet: async (_method: string, args: Record<string, any>) => {
        oldestCalls.push(Number(args.oldest));
        return {
          ok: true,
          messages: [
            {
              type: "message",
              ts: "1786361400.000001",
              user: "U123456",
              text: "A concrete claim",
            },
          ],
          response_metadata: {},
        };
      },
      resolveSlackUser: async () => ({ name: "Alice" }),
      oneShot: async () =>
        "- Alice made a concrete claim — slack://C01ED50A2KG/1786361400.000001?message=1786361400.000001",
    };
    const firstAt = new Date("2026-08-10T12:00:00.000Z");
    const prepared = await prepareAutomationInputs(
      { automationId, inputs: input, startedAt: firstAt },
      deps as any,
    );
    expect(prepared.note).toContain("untrusted data");
    expect(prepared.note).toContain("concrete claim");
    expect(automationInputStateExists(automationId)).toBe(false);
    prepared.commit();
    expect(automationInputStateExists(automationId)).toBe(true);

    await prepareAutomationInputs(
      {
        automationId,
        inputs: input,
        startedAt: new Date("2026-08-10T13:00:00.000Z"),
      },
      deps as any,
    );
    expect(oldestCalls[1]).toBe(firstAt.getTime() / 1000 - 10 * 60);
  });

  test("injects structured report history without raw HTML", async () => {
    publishReport({
      automationId,
      automationName: "Cassandra",
      title: "Previous assessment",
      html: "<p>RAW SECRET HTML</p>",
      summary: "A bounded prior summary",
      urgency: "medium",
      confidence: "high",
    });
    const inputs = sanitizeAutomationInputs([
      {
        id: "history",
        source: { type: "reports", automationId: "self", limit: 3 },
      },
    ]) as AutomationInput[];
    const prepared = await prepareAutomationInputs(
      { automationId, inputs, startedAt: new Date() },
      {
        slackApiGet: async () => ({ ok: true, messages: [] }),
        resolveSlackUser: async (id: string) => ({ name: id }),
        oneShot: async () => null,
      } as any,
    );
    expect(prepared.note).toContain("A bounded prior summary");
    expect(prepared.note).toContain('"urgency":"medium"');
    expect(prepared.note).not.toContain("RAW SECRET HTML");
  });
});
