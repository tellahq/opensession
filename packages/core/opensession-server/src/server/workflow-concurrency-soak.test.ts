import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startWorkflow } from "./workflow-runner";
import { getWorkflowRun } from "./workflow-store";
import type {
  WorkflowSessionController,
  WorkflowSessionStatus,
  WorkflowSpawnedSession,
} from "./workflow-types";

const savedWorkflowDir = process.env.OPENSESSION_WORKFLOWS_DIR;
const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-soak-"));
  dirs.push(dir);
  process.env.OPENSESSION_WORKFLOWS_DIR = dir;
});

afterAll(() => {
  if (savedWorkflowDir === undefined)
    delete process.env.OPENSESSION_WORKFLOWS_DIR;
  else process.env.OPENSESSION_WORKFLOWS_DIR = savedWorkflowDir;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function waitForDone(runId: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = getWorkflowRun(runId);
    if (snapshot && snapshot.status !== "running") return snapshot;
    if (Date.now() >= deadline) throw new Error("soak workflow timed out");
    await Bun.sleep(2);
  }
}

function controller(metrics: {
  active: number;
  maxActive: number;
  spawns: number;
  waits: number;
  requestIds: Set<string>;
}): WorkflowSessionController {
  const rows = new Map<string, WorkflowSessionStatus>();
  return {
    adopt(session) {
      rows.set(session.id, {
        ...session,
        status: "running",
        branchPushed: false,
      });
    },
    async spawn(opts, requestId) {
      metrics.spawns++;
      metrics.active++;
      metrics.maxActive = Math.max(metrics.maxActive, metrics.active);
      expect(metrics.requestIds.has(requestId)).toBe(false);
      metrics.requestIds.add(requestId);
      const row: WorkflowSpawnedSession = {
        id: `child-${metrics.spawns}`,
        url: `https://opensession.test/session/child-${metrics.spawns}`,
        repo: opts.repo,
        branch: opts.branch || `branch-${metrics.spawns}`,
        parentSessionId: "soak-parent",
      };
      rows.set(row.id, { ...row, status: "running", branchPushed: false });
      return row;
    },
    async status(id) {
      return rows.get(id)!;
    },
    async wait(id) {
      metrics.waits++;
      const sequence = Number(id.slice("child-".length));
      await Bun.sleep(sequence % 3);
      const done = { ...rows.get(id)!, status: "done" as const };
      rows.set(id, done);
      metrics.active--;
      return done;
    },
    async send() {
      return {};
    },
    async cancel(id) {
      const cancelled = { ...rows.get(id)!, status: "cancelled" as const };
      rows.set(id, cancelled);
      return cancelled;
    },
  };
}

describe("workflow concurrency soak without provider spend", () => {
  test("ten refill waves converge with stable unique side-effect identities and a hard four-child cap", async () => {
    const metrics = {
      active: 0,
      maxActive: 0,
      spawns: 0,
      waits: 0,
      requestIds: new Set<string>(),
    };
    const desired = Array.from({ length: 20 }, (_, index) => ({
      prompt: `Local deterministic shard ${index}`,
      repo: "renderer",
      branch: `soak/shard-${index}`,
      admission: { tokens: 0, costUsd: 0 },
    }));
    const script = [
      'export const meta = { name: "concurrency-soak" };',
      `return await reconcileSessions(${JSON.stringify(desired)}, { concurrency: 4, until: "done", retry: { attempts: 1 } });`,
    ].join("\n");

    for (let wave = 0; wave < 10; wave++) {
      const { runId } = startWorkflow({
        sessionId: "soak-parent",
        cwd: "/tmp/local-only",
        script,
        executor: {
          async execute() {
            throw new Error("soak test must not spend provider tokens");
          },
        },
        sessionController: controller(metrics),
        sessionLimits: {
          maxConcurrent: 4,
          maxSessions: 20,
          maxTokens: 0,
          maxCostUsd: 0,
        },
      });
      const snapshot = await waitForDone(runId);
      expect(snapshot.status).toBe("done");
      expect(snapshot.sessions).toHaveLength(20);
      expect(snapshot.totals.tokensIn).toBe(0);
      expect(snapshot.totals.tokensOut).toBe(0);
    }

    expect(metrics.spawns).toBe(200);
    expect(metrics.waits).toBe(200);
    expect(metrics.active).toBe(0);
    expect(metrics.maxActive).toBe(4);
    expect(metrics.requestIds.size).toBe(200);
  }, 30_000);
});
