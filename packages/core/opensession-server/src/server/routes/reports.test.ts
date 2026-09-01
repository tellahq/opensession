import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { publishReport, REPORTS_ROOT } from "../reports";
import {
  type CreateSessionOpts,
  type SessionControl,
  registerSessionControl,
  tryGetSessionControl,
} from "../session-control";
import { fanOutPrompt, handleReportsRoutes } from "./reports";

const automationId = `test-report-assets-route-${process.pid}`;

afterEach(() => {
  rmSync(join(REPORTS_ROOT, automationId), { recursive: true, force: true });
});

describe("report asset routes", () => {
  test("serves a published asset with its content type", async () => {
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const report = publishReport({
      automationId,
      automationName: "Test",
      title: "Asset report",
      html: '<img src="assets/evidence/frame.jpg">',
      assets: [{ path: "evidence/frame.jpg", data }],
    });
    const path = `/api/reports/${automationId}/${report.id}/assets/evidence/frame.jpg`;
    const url = new URL(`http://localhost${path}`);

    const response = await handleReportsRoutes({
      req: new Request(url),
      url,
      path,
      publicPrefix: "/backstage",
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/jpeg");
    expect(response?.headers.get("content-security-policy")).toBe("sandbox");
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(data);
  });
});

describe("fanOutPrompt", () => {
  const report = {
    title: "21 native parity gaps",
    automationName: "iOS parity check",
  };

  test("points a single task at its own worktree and says where it came from", () => {
    const prompt = fanOutPrompt(
      { title: "Decode the frame", prompt: "Add the case." },
      report,
      1,
    );
    expect(prompt.startsWith("Add the case.")).toBe(true);
    expect(prompt).toContain("21 native parity gaps");
    // A report names the checkout its own run used; followed literally that
    // puts the session back in the shared checkout.
    expect(prompt).toContain("ignore it and use your own worktree");
    expect(prompt).not.toContain("one of");
  });

  test("tells a batched session that the rest of the report is not its job", () => {
    const prompt = fanOutPrompt(
      { title: "Decode the frame", prompt: "Add the case." },
      report,
      6,
    );
    expect(prompt.startsWith("Add the case.")).toBe(true);
    expect(prompt).toContain("one of 6 started together");
    expect(prompt).toContain("do this item only");
  });
});

describe("starting a session per task", () => {
  const previousControl = tryGetSessionControl();
  // The control is a process-wide singleton and `bun test` runs every file in
  // one process, so it is restored rather than left pointing at the fake.
  afterEach(() => registerSessionControl(previousControl as SessionControl));

  function fakeControl(opts: CreateSessionOpts[], failOn?: string) {
    registerSessionControl({
      createSession: async (input: CreateSessionOpts) => {
        opts.push(input);
        if (failOn && input.branch?.includes(failOn))
          throw new Error("branch already exists");
        return { id: `os-${opts.length}` };
      },
    } as unknown as SessionControl);
  }

  async function post(reportId: string, body: unknown) {
    const path = `/api/reports/${automationId}/${reportId}/sessions`;
    const url = new URL(`http://localhost${path}`);
    return await handleReportsRoutes({
      req: new Request(url, { method: "POST", body: JSON.stringify(body) }),
      url,
      path,
      publicPrefix: "/backstage",
    });
  }

  function publishTasks(count: number) {
    return publishReport({
      automationId,
      automationName: "iOS parity check",
      title: "Parity gaps",
      html: "<p>gaps</p>",
      tasks: Array.from({ length: count }, (_, i) => ({
        title: `Fix thing ${i + 1}`,
        prompt: `Do thing ${i + 1}.`,
      })),
    });
  }

  test("starts one isolated code session per selected task", async () => {
    const created: CreateSessionOpts[] = [];
    fakeControl(created);
    const report = publishTasks(3);

    const response = await post(report.id, { tasks: [2, 0, 0] });

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      sessions: [
        { task: 0, title: "Fix thing 1", id: "os-1" },
        { task: 2, title: "Fix thing 3", id: "os-2" },
      ],
    });
    expect(created).toHaveLength(2);
    for (const opts of created) {
      expect(opts.mode).toBe("code");
      // Without this every session on a shared-checkout repo would edit
      // the one live checkout, which is the mingled diff the fan-out exists
      // to avoid.
      expect(opts.isolatedWorktree).toBe(true);
      // Clicking Fix starts the opening turn without a composer. Preserve that
      // origin so clients can mark it without classifying it as an automation run.
      expect(opts.agentStarted).toBe(true);
      expect(opts.branch).toMatch(/^report-fix-thing-[13]/);
    }
    expect(created[0].prompt.startsWith("Do thing 1.")).toBe(true);
    expect(created[0].prompt).toContain("one of 2 started together");
  });

  test("defaults to every task when none are named", async () => {
    const created: CreateSessionOpts[] = [];
    fakeControl(created);
    const report = publishTasks(2);

    await post(report.id, {});

    expect(created.map((opts) => opts.prompt.split(".")[0])).toEqual([
      "Do thing 1",
      "Do thing 2",
    ]);
  });

  test("reports a failed create per task instead of losing the batch", async () => {
    const created: CreateSessionOpts[] = [];
    fakeControl(created, "thing-1");
    const report = publishTasks(2);

    const body = (await (await post(report.id, {}))!.json()) as {
      sessions: Array<{ id?: string; error?: string }>;
    };

    expect(body.sessions[0].error).toBe("branch already exists");
    expect(body.sessions[1].id).toBeTruthy();
  });

  test("refuses a report that proposes no work, and an out-of-range pick", async () => {
    const report = publishReport({
      automationId,
      automationName: "iOS parity check",
      title: "Nothing to do",
      html: "<p>none</p>",
    });
    expect((await post(report.id, {}))?.status).toBe(400);

    const withTasks = publishTasks(1);
    expect((await post(withTasks.id, { tasks: [7] }))?.status).toBe(400);
    expect((await post("2026-01-01-000000-none", {}))?.status).toBe(404);
  });
});
