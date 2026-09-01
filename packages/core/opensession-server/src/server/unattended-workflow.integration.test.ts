import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { automationWorkflowSessionPolicy } from "./automations";
import { assertAutomationDescendantOpeningIsolation } from "./session-create";
import { publishSessionBranch } from "./session-publication";
import type { SessionControl, SessionSummary } from "./session-control";
import { createWorkflowSessionController } from "./workflow-sessions";
import { startWorkflow } from "./workflow-runner";
import { getWorkflowRun, readWorkflowJournal } from "./workflow-store";
import type {
  WorkflowExecutor,
  WorkflowRunSnapshot,
  WorkflowSessionController,
  WorkflowSessionStatus,
} from "./workflow-types";

const previousWorkflowDir = process.env.OPENSESSION_WORKFLOWS_DIR;
const roots: string[] = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "unattended-workflow-e2e-"));
  roots.push(root);
  process.env.OPENSESSION_WORKFLOWS_DIR = join(root, "workflows");
});

afterAll(() => {
  if (previousWorkflowDir === undefined)
    delete process.env.OPENSESSION_WORKFLOWS_DIR;
  else process.env.OPENSESSION_WORKFLOWS_DIR = previousWorkflowDir;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function finished(runId: string): Promise<WorkflowRunSnapshot> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const snapshot = getWorkflowRun(runId);
    if (snapshot && snapshot.status !== "running") return snapshot;
    await Bun.sleep(10);
  }
  throw new Error("workflow did not finish");
}

function row(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    local: true,
    claudeSessionId: "",
    source: "opensession",
    branch: "main",
    worktreeDir: "/runner/root",
    createdBy: "Automation",
    startedBy: "Automation",
    title: id,
    lastActivity: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    isRunning: true,
    transcriptPath: null,
    repo: "renderer",
    mode: "code",
    state: "running",
    queuedCount: 0,
    controllable: true,
    ...patch,
  };
}

describe("unattended workflow swarm integration", () => {
  test("policy, Runner opening, durable waits, scoped publication, autofix, and refill converge", async () => {
    const policy = automationWorkflowSessionPolicy({
      id: "renderer-swarm",
      name: "Renderer swarm",
      workflows: true,
      workflowSessions: true,
      workflowSessionRepos: ["renderer"],
      workflowSessionRunners: ["mac-isolated"],
    });
    expect(policy).toEqual({
      automationId: "renderer-swarm",
      automationName: "Renderer swarm",
      allowedRepos: ["renderer"],
      allowedRunners: ["mac-isolated"],
    });

    const sessions = new Map<string, SessionSummary>([
      [
        "parent",
        row("parent", {
          automation: "Renderer swarm",
          automationId: "renderer-swarm",
          isRunning: false,
          state: "idle",
        }),
      ],
    ]);
    const messages: string[] = [];
    const createOrder: string[] = [];
    let next = 0;
    const control: SessionControl = {
      listSessions: () => [...sessions.values()],
      getSession: (id) => sessions.get(id),
      transcriptTail: async () => [],
      answerQuestion: () => false,
      async deliverToSession(id, message) {
        messages.push(`${id}:${message}`);
        return { status: "steered", message: "sent" };
      },
      cancelSession: () => true,
      reparentSession: async () => ({ ok: false, error: "not used" }),
      async createSession(input) {
        const id = `child-${++next}`;
        createOrder.push(id);
        expect(input.runner).toBe("mac-isolated");
        expect(input.mcpServers).toEqual([]);
        assertAutomationDescendantOpeningIsolation({
          automationDescendantPolicy: input.automationDescendantPolicy,
          sandboxProvider: null,
          runnerTarget: {
            id: "mac-isolated",
            name: "Isolation-approved macOS",
            workspacePath: `/runner/root/${id}`,
            repositoryUrl: "https://github.com/tellahq/renderer.git",
          },
        });
        const branch = input.branch!;
        sessions.set(
          id,
          row(id, {
            branch,
            parentSessionId: "parent",
            worktreeDir: `/runner/root/${id}`,
            runner: {
              id: "mac-isolated",
              name: "Isolation-approved macOS",
              workspacePath: `/runner/root/${id}`,
              lifecycle: "awake",
            },
            automation: "Renderer swarm",
            automationId: "renderer-swarm",
            automationDescendantPolicy: input.automationDescendantPolicy,
          }),
        );
        queueMicrotask(() => {
          const current = sessions.get(id)!;
          sessions.set(id, {
            ...current,
            isRunning: false,
            state: "idle",
            claudeSessionId: `engine-${id}`,
            prUrl: `https://github.com/tellahq/renderer/pull/${40 + next}`,
            prState: "OPEN",
            prReviewDecision:
              id === "child-1" ? "CHANGES_REQUESTED" : "APPROVED",
            prChecks: {
              total: 2,
              passed: id === "child-1" ? 1 : 2,
              failed: id === "child-1" ? 1 : 0,
              pending: 0,
            },
          });
        });
        return {
          id,
          createdBy: "Automation",
          createdAt: new Date(0).toISOString(),
        };
      },
    };
    const controller = createWorkflowSessionController({
      parentSessionId: "parent",
      user: "Automation",
      allowSpawning: true,
      automationSessionPolicy: policy,
      mcpAllowlist: [],
      maxDepth: 2,
      deps: {
        control,
        baseUrl: "https://os.invalid",
        branchPushed: async () => false,
        hasUncommittedChanges: async () => false,
        requireCommittedRef: async () => {},
        defaultBranch: () => "main",
        publicationRepo: () => "tellahq/renderer",
        resolveRepo: () => ({
          repo: "renderer",
          dir: "/repo",
          branch: "main",
          primary: true,
        }),
      },
    });
    const executor: WorkflowExecutor = {
      async execute() {
        return { ok: true, text: "unused" };
      },
    };
    const run = startWorkflow({
      sessionId: "parent",
      cwd: "/repo",
      executor,
      sessionController: controller,
      sessionLimits: {
        maxConcurrent: 1,
        maxSessions: 2,
        maxTokens: 40_000,
        maxCostUsd: 4,
      },
      script: [
        'export const meta = { name: "renderer-swarm-e2e" };',
        "const rows = await reconcileSessions([",
        '  { prompt: "layout", repo: "renderer", branch: "compat/layout", runner: "mac-isolated" },',
        '  { prompt: "text", repo: "renderer", branch: "compat/text", runner: "mac-isolated" },',
        "], { concurrency: 1 });",
        "await autofixSession(rows[0].id, 'Address the requested review');",
        "return rows.map((row) => row.prUrl);",
      ].join("\n"),
    });
    const snapshot = await finished(run.runId);
    expect(snapshot.status).toBe("done");
    expect(createOrder).toEqual(["child-1", "child-2"]);
    expect(snapshot.result).toEqual([
      "https://github.com/tellahq/renderer/pull/41",
      "https://github.com/tellahq/renderer/pull/42",
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("do not merge");
    expect(
      readWorkflowJournal(run.runId).filter(
        (entry) => entry.kind === "session" && entry.operation === "wait",
      ).length,
    ).toBe(2);

    const publicationRoot = roots.at(-1)!;
    let exports = 0;
    let requests = 0;
    const published = await publishSessionBranch("child-1", "publish-1", {
      findSession: async () => sessions.get("child-1") as any,
      exportBundle: async () => {
        exports++;
        return Buffer.from("credential-free");
      },
      repositoryToken: async () => "scoped-token",
      baseCommit: async () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      runGit: async (_cwd, args) => ({
        exitCode: 0,
        stdout: args.includes("list-heads")
          ? "0123456789012345678901234567890123456789 refs/heads/compat/layout\n"
          : "",
        stderr: "",
      }),
      request: async () => {
        requests++;
        return requests === 1
          ? new Response("exists", { status: 422 })
          : Response.json([
              {
                html_url: "https://github.com/tellahq/renderer/pull/41",
                head: {
                  ref: "compat/layout",
                  repo: { full_name: "tellahq/renderer" },
                },
                base: { ref: "main" },
              },
            ]);
      },
      receiptPath: (_sessionId, requestId) =>
        join(publicationRoot, `${requestId}.json`),
    });
    expect(published.prUrl).toBe("https://github.com/tellahq/renderer/pull/41");
    expect(exports).toBe(1);
    expect(requests).toBe(2);
  });

  test("bounded deterministic soak preserves admission floors, refill, cancellation, and CAS", async () => {
    const rows = new Map<string, WorkflowSessionStatus>();
    const admissions: Array<{ tokens?: number; costUsd?: number } | undefined> =
      [];
    let spawnCount = 0;
    let waiting = 0;
    let maxWaiting = 0;
    const controller: WorkflowSessionController = {
      async spawn(opts) {
        const id = `soak-${++spawnCount}`;
        admissions.push(opts.admission);
        const row: WorkflowSessionStatus = {
          id,
          url: `https://os.invalid/s/${id}`,
          repo: opts.repo,
          branch: opts.branch || id,
          parentSessionId: "parent",
          status: "running",
          branchPushed: false,
          tokens: 0,
          costUsd: 0,
        };
        rows.set(id, row);
        return row;
      },
      adopt(session) {
        rows.set(session.id, {
          ...session,
          status: "running",
          branchPushed: false,
          tokens: 0,
          costUsd: 0,
        });
      },
      async status(id) {
        const row = rows.get(id);
        if (!row) throw new Error(`unknown ${id}`);
        return row;
      },
      async wait(id) {
        waiting++;
        maxWaiting = Math.max(maxWaiting, waiting);
        await Bun.sleep(Number(id.split("-")[1]) % 3);
        waiting--;
        const done = {
          ...rows.get(id)!,
          status: "done" as const,
          tokens: 100,
          costUsd: 0.01,
        };
        rows.set(id, done);
        return done;
      },
      async send(id) {
        return await this.status(id);
      },
      async cancel(id) {
        const cancelled = { ...rows.get(id)!, status: "cancelled" as const };
        rows.set(id, cancelled);
        return cancelled;
      },
    };
    const desired = Array.from(
      { length: 20 },
      (_, index) =>
        `{ prompt: "item-${index}", repo: "renderer", branch: "soak-${index}" }`,
    ).join(",\n");
    const run = startWorkflow({
      sessionId: "parent",
      cwd: "/repo",
      executor: {
        async execute() {
          return { ok: true, text: "unused" };
        },
      },
      sessionController: controller,
      sessionLimits: {
        maxConcurrent: 3,
        maxSessions: 21,
        maxTokens: 210_000,
        maxCostUsd: 21,
      },
      script: [
        'export const meta = { name: "bounded-soak" };',
        'const initial = await workflowState.get("claim");',
        'const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => workflowState.compareAndSet("claim", initial.version, { winner: i })));',
        'const doomed = await spawnSession({ prompt: "cancel", repo: "renderer", branch: "cancelled" });',
        "await cancelSession(doomed.id);",
        `const done = await reconcileSessions([${desired}], { concurrency: 3 });`,
        "return { winners: claims.filter((row) => row.swapped).length, done: done.length };",
      ].join("\n"),
    });
    const snapshot = await finished(run.runId);
    expect(snapshot.status).toBe("done");
    expect(snapshot.result).toEqual({ winners: 1, done: 20 });
    expect(spawnCount).toBe(21);
    expect(maxWaiting).toBeLessThanOrEqual(3);
    expect(
      admissions.every((row) => row?.tokens === 10_000 && row.costUsd === 1),
    ).toBe(true);
    expect(
      [...rows.values()].filter((row) => row.status === "cancelled"),
    ).toHaveLength(1);
  });
});
