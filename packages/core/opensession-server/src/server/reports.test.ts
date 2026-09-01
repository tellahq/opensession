import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  __resetReportIndexForTest,
  getReport,
  listReports,
  MAX_REPORT_TASK_PROMPT,
  MAX_REPORT_TASKS,
  listReportsForSession,
  publishReport,
  readReportAsset,
  REPORTS_ROOT,
  type ReportMeta,
} from "./reports";

const automationId = `test-session-reports-${process.pid}`;
const secondAutomationId = `${automationId}-second`;
const dirs = [
  join(REPORTS_ROOT, automationId),
  join(REPORTS_ROOT, secondAutomationId),
];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  __resetReportIndexForTest();
});

describe("listReportsForSession", () => {
  test("returns only reports produced by the requested session, newest first", () => {
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    const reports: ReportMeta[] = [
      {
        id: "older",
        title: "Older",
        automationId,
        automationName: "Test",
        sessionId: "bks-target",
        createdAt: "2026-07-19T10:00:00.000Z",
      },
      {
        id: "newer",
        title: "Newer",
        automationId,
        automationName: "Test",
        sessionId: "bks-target",
        createdAt: "2026-07-20T10:00:00.000Z",
      },
      {
        id: "other",
        title: "Other",
        automationId,
        automationName: "Test",
        sessionId: "bks-other",
        createdAt: "2026-07-21T10:00:00.000Z",
      },
      {
        id: "newer",
        title: "Same id, another automation",
        automationId: secondAutomationId,
        automationName: "Second test",
        sessionId: "bks-target",
        createdAt: "2026-07-22T10:00:00.000Z",
      },
    ];
    for (const report of reports) {
      const dir = join(REPORTS_ROOT, report.automationId);
      writeFileSync(join(dir, `${report.id}.json`), JSON.stringify(report));
    }

    expect(
      listReportsForSession("bks-target").map(
        (report) => `${report.automationId}/${report.id}`,
      ),
    ).toEqual([
      `${secondAutomationId}/newer`,
      `${automationId}/newer`,
      `${automationId}/older`,
    ]);
  });
});

describe("report assets", () => {
  test("publishes nested assets beside the report", () => {
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const report = publishReport({
      automationId,
      automationName: "Test",
      title: "Asset report",
      html: '<img src="assets/evidence/frame.jpg">',
      assets: [{ path: "evidence/frame.jpg", data }],
    });

    const asset = readReportAsset(
      automationId,
      report.id,
      "evidence/frame.jpg",
    );
    expect(asset?.rel).toBe("evidence/frame.jpg");
    expect(readFileSync(asset!.path)).toEqual(data);

    unlinkSync(join(REPORTS_ROOT, automationId, `${report.id}.json`));
    expect(
      readReportAsset(automationId, report.id, "evidence/frame.jpg"),
    ).toBeNull();

    publishReport({
      automationId,
      automationName: "Test",
      title: "Next report",
      html: "<p>next</p>",
    });
    expect(
      existsSync(join(REPORTS_ROOT, automationId, `${report.id}.assets`)),
    ).toBe(false);
  });

  test("rejects asset traversal and duplicate paths", () => {
    const input = {
      automationId,
      automationName: "Test",
      title: "Unsafe asset report",
      html: "<p>unsafe</p>",
    };

    expect(() =>
      publishReport({
        ...input,
        assets: [{ path: "../secret", data: Buffer.from("no") }],
      }),
    ).toThrow("asset path must be relative");
    expect(() =>
      publishReport({
        ...input,
        assets: [
          { path: "same.jpg", data: Buffer.from("one") },
          { path: "same.jpg", data: Buffer.from("two") },
        ],
      }),
    ).toThrow("Duplicate report asset");
  });
});

describe("report signals", () => {
  test("persists urgency, confidence, and bounded structured highlights", () => {
    const report = publishReport({
      automationId,
      automationName: "Test",
      title: "Signal report",
      html: "<p>signal</p>",
      urgency: "high",
      confidence: "medium",
      highlights: [
        {
          title: " Assumption changed ",
          summary: " Evidence no longer supports it. ",
          urgency: "high",
          confidence: "medium",
          sourceRefs: [" slack://C123456/1 "],
        },
      ],
    });

    expect(report.urgency).toBe("high");
    expect(report.confidence).toBe("medium");
    expect(report.highlights?.[0]).toEqual({
      title: "Assumption changed",
      summary: "Evidence no longer supports it.",
      urgency: "high",
      confidence: "medium",
      sourceRefs: ["slack://C123456/1"],
    });
    expect(listReports(automationId)[0]?.highlights).toEqual(report.highlights);
  });

  test("rejects invalid and oversized signal metadata", () => {
    const base = {
      automationId,
      automationName: "Test",
      title: "Invalid signal report",
      html: "<p>signal</p>",
    };
    expect(() => publishReport({ ...base, urgency: "soon" as any })).toThrow(
      "Invalid report urgency",
    );
    expect(() =>
      publishReport({
        ...base,
        highlights: Array.from({ length: 21 }, () => ({
          title: "Finding",
          summary: "Summary",
          urgency: "low" as const,
          confidence: "low" as const,
        })),
      }),
    ).toThrow("Too many report highlights");
  });
});

describe("report tasks", () => {
  test("persists the work a report proposes, separately from its findings", () => {
    const report = publishReport({
      automationId,
      automationName: "Test",
      title: "21 native parity gaps",
      html: "<p>gaps</p>",
      highlights: [
        {
          title: "Quick replies are dropped",
          summary: "The decoder ignores the frame.",
          urgency: "high",
          confidence: "high",
        },
      ],
      tasks: [
        { title: " Decode reply_suggestions ", prompt: " Add the case. " },
        { title: "Show the mentions badge", prompt: "Read /api/mentions." },
      ],
    });

    // A report may rank three findings and still propose twenty tasks, so
    // neither list is derived from the other.
    expect(report.highlights).toHaveLength(1);
    expect(report.tasks).toEqual([
      { title: "Decode reply_suggestions", prompt: "Add the case." },
      { title: "Show the mentions badge", prompt: "Read /api/mentions." },
    ]);
    expect(getReport(automationId, report.id)?.tasks).toEqual(report.tasks);
  });

  test("rejects a task that could not be handed to a session on its own", () => {
    const base = {
      automationId,
      automationName: "Test",
      title: "Invalid task report",
      html: "<p>tasks</p>",
    };
    expect(() =>
      publishReport({ ...base, tasks: [{ title: "No prompt", prompt: "  " }] }),
    ).toThrow("Report task 1 needs a title and a prompt");
    expect(() =>
      publishReport({
        ...base,
        tasks: Array.from({ length: MAX_REPORT_TASKS + 1 }, () => ({
          title: "Task",
          prompt: "Do it.",
        })),
      }),
    ).toThrow("Too many report tasks");
    // Truncating would hand an agent an instruction that stops mid-sentence.
    expect(() =>
      publishReport({
        ...base,
        tasks: [
          { title: "Long", prompt: "x".repeat(MAX_REPORT_TASK_PROMPT + 1) },
        ],
      }),
    ).toThrow("prompt is too long");
  });
});
