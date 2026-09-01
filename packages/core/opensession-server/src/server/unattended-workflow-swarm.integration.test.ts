import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  automationWorkflowSessionPolicy,
  type Automation,
} from "./automations";
import type {
  CreateSessionOpts,
  SessionControl,
  SessionSummary,
} from "./session-control";
import {
  assertAutomationDescendantOpeningIsolation,
  openingCreateTrustPolicy,
} from "./session-create";
import { sandboxRunSecuritySpec } from "./run-session";
import { startWorkflow } from "./workflow-runner";
import { createWorkflowSessionController } from "./workflow-sessions";
import { getWorkflowRun } from "./workflow-store";
import type { UnifiedSession } from "./types";

const savedWorkflowDir = process.env.OPENSESSION_WORKFLOWS_DIR;
const workflowDirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "unattended-swarm-integration-"));
  workflowDirs.push(dir);
  process.env.OPENSESSION_WORKFLOWS_DIR = dir;
});

afterAll(() => {
  if (savedWorkflowDir === undefined)
    delete process.env.OPENSESSION_WORKFLOWS_DIR;
  else process.env.OPENSESSION_WORKFLOWS_DIR = savedWorkflowDir;
  for (const dir of workflowDirs) rmSync(dir, { recursive: true, force: true });
});

async function finished(runId: string) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const snapshot = getWorkflowRun(runId);
    if (snapshot && snapshot.status !== "running") return snapshot;
    if (Date.now() >= deadline) throw new Error("workflow did not finish");
    await Bun.sleep(5);
  }
}

function parentSummary(): SessionSummary {
  return {
    id: "automation-parent",
    local: true,
    source: "opensession",
    title: "Renderer swarm",
    lastActivity: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    createdBy: "Automation",
    startedBy: "Automation",
    transcriptPath: null,
    repo: "renderer",
    branch: "main",
    worktreeDir: "/repo/renderer",
    mode: "code",
    state: "idle",
    queuedCount: 0,
    controllable: true,
    isRunning: false,
    automation: "Renderer swarm",
    automationId: "auto-renderer",
  } as SessionSummary;
}

describe("unattended workflow swarm integration", () => {
  test("stored policy reaches isolated Runner opening, publication, review autofix, and refill convergence", async () => {
    const stored = {
      id: "auto-renderer",
      name: "Renderer swarm",
      workflows: true,
      workflowSessions: true,
      workflowSessionRepos: ["renderer"],
      workflowSessionRunners: ["isolated-runner"],
    } as Automation;
    const policy = automationWorkflowSessionPolicy(stored);
    expect(policy).toEqual({
      automationId: "auto-renderer",
      automationName: "Renderer swarm",
      allowedRepos: ["renderer"],
      allowedRunners: ["isolated-runner"],
    });

    const sessions = new Map<string, SessionSummary>([
      ["automation-parent", parentSummary()],
    ]);
    const creates: CreateSessionOpts[] = [];
    const reviewHandoffs: Array<{ id: string; deliveryId?: string }> = [];
    let next = 0;
    let activeCreates = 0;
    let maxActiveCreates = 0;

    const control = {
      getSession: (id: string) => sessions.get(id),
      async createSession(input: CreateSessionOpts) {
        creates.push(input);
        activeCreates++;
        maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
        await Bun.sleep(2);
        const id = `child-${++next}`;
        const branch = input.branch || `swarm-${next}`;
        const descendant = input.automationDescendantPolicy;
        expect(descendant).toBeDefined();
        assertAutomationDescendantOpeningIsolation({
          automationDescendantPolicy: descendant,
          sandboxProvider: null,
          runnerTarget: {
            id: input.runner!,
            name: "Isolated Runner",
            workspacePath: `/runner/${id}`,
            repositoryUrl: "https://github.com/tellahq/renderer.git",
          },
        });
        expect(
          openingCreateTrustPolicy({
            automationDescendantPolicy: descendant,
            branch,
            runMcpServers: input.mcpServers,
            user: input.user,
          }),
        ).toMatchObject({
          automation: true,
          mcpServers: [],
          user: undefined,
          aws: false,
          trustProfile: "automation",
        });
        expect(
          sandboxRunSecuritySpec(
            {
              id,
              branch,
              automationDescendantPolicy: descendant,
            } as UnifiedSession,
            {
              isAutomationSession: true,
              user: input.user,
              mcpServers: input.mcpServers,
              deniedTools: { mcp__github__merge_pull_request: "denied" },
            },
          ),
        ).toMatchObject({
          mcpServers: [],
          proxyMcpServers: [],
          aws: false,
          user: undefined,
          trustProfile: "automation",
        });
        sessions.set(id, {
          ...parentSummary(),
          id,
          title: branch,
          branch,
          parentSessionId: input.parentSessionId,
          spawnDepth: input.spawnDepth,
          mcpServers: input.mcpServers,
          automationDescendantPolicy: descendant,
          automationId: descendant?.automationId,
          runner: {
            id: input.runner!,
            name: "Isolated Runner",
            workspacePath: `/runner/${id}`,
          },
          claudeSessionId: `engine-${id}`,
        } as SessionSummary);
        activeCreates--;
        return {
          id,
          createdBy: "Automation",
          createdAt: new Date(0).toISOString(),
        };
      },
      async deliverToSession(
        id: string,
        _message: string,
        _user?: string,
        opts?: { deliveryId?: string; reviewHandoff?: boolean },
      ) {
        if (opts?.reviewHandoff)
          reviewHandoffs.push({ id, deliveryId: opts.deliveryId });
        return { status: "queued", message: "queued" } as const;
      },
      cancelSession: () => true,
    } as unknown as SessionControl;

    const controller = createWorkflowSessionController({
      parentSessionId: "automation-parent",
      user: "Automation",
      allowSpawning: true,
      automationSessionPolicy: policy,
      mcpAllowlist: [],
      maxDepth: 2,
      deps: {
        control,
        baseUrl: "https://opensession.test",
        branchPushed: async () => false,
        hasUncommittedChanges: async () => false,
        requireCommittedRef: async () => {},
        defaultBranch: () => "main",
        publicationRepo: () => "tellahq/renderer",
        resolveRepo: () => ({
          repo: "renderer",
          dir: "/repo/renderer",
          branch: "main",
          primary: true,
        }),
        publishSessionBranch: async (id) => {
          const session = sessions.get(id)!;
          const prUrl = `https://github.com/tellahq/renderer/pull/${id.slice(6)}`;
          sessions.set(id, {
            ...session,
            prUrl,
            prState: "OPEN",
            prReviewDecision: "CHANGES_REQUESTED",
            prChecks: { total: 2, passed: 1, failed: 1, pending: 0 },
          });
          return {
            repo: "tellahq/renderer",
            branch: session.branch!,
            baseBranch: "main",
            prUrl,
          };
        },
      },
    });

    const desired = Array.from({ length: 6 }, (_, index) => ({
      prompt: `Implement shard ${index}`,
      repo: "renderer",
      mode: "code",
      runner: "isolated-runner",
      branch: `swarm/shard-${index}`,
      workspace: { type: "isolated-worktree", baseRef: "main" },
      admission: { tokens: 1_000, costUsd: 0 },
    }));
    const script = [
      'export const meta = { name: "unattended-swarm-e2e" };',
      `const desired = ${JSON.stringify(desired)};`,
      'const completed = await reconcileSessions(desired, { concurrency: 2, until: "done", retry: { attempts: 1 } });',
      "for (const child of completed) {",
      "  await publishSessionBranch(child.id);",
      '  await waitSession(child.id, { until: "pr_checks_failed", timeout: 1000 });',
      '  await autofixSession(child.id, "Fix review and CI");',
      "}",
      "return completed.map((child) => child.id);",
    ].join("\n");
    const { runId } = startWorkflow({
      sessionId: "automation-parent",
      cwd: "/repo/renderer",
      script,
      executor: {
        async execute() {
          throw new Error("integration script must not spend provider tokens");
        },
      },
      sessionController: controller,
      automationSessionPolicy: policy,
      deniedTools: { mcp__github__merge_pull_request: "denied" },
      mcpAllowlist: [],
      sessionLimits: {
        maxConcurrent: 2,
        maxSessions: 6,
        maxTokens: 60_000,
        maxCostUsd: 6,
      },
    });

    const snapshot = await finished(runId);
    if (snapshot.status !== "done")
      throw new Error(`integration workflow failed: ${snapshot.error}`);
    expect(snapshot.result).toEqual([
      "child-1",
      "child-2",
      "child-3",
      "child-4",
      "child-5",
      "child-6",
    ]);
    expect(creates).toHaveLength(6);
    expect(maxActiveCreates).toBe(2);
    expect(creates.every((input) => input.mcpServers?.length === 0)).toBe(true);
    expect(creates.every((input) => input.runner === "isolated-runner")).toBe(
      true,
    );
    expect(snapshot.sessions?.every((row) => row.prChecks?.failed === 1)).toBe(
      true,
    );
    expect(reviewHandoffs).toHaveLength(6);
    expect(new Set(reviewHandoffs.map((row) => row.deliveryId)).size).toBe(6);
  });
});
