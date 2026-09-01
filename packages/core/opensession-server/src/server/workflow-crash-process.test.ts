import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixture = join(import.meta.dir, "testing/workflow-crash-process.ts");

async function runStage(root: string, stage: "start" | "recover") {
  const proc = Bun.spawn([process.execPath, fixture], {
    env: {
      ...process.env,
      OPENSESSION_WORKFLOWS_DIR: join(root, "workflows"),
      OPENSESSION_STATE_DIR: join(root, "state"),
      WORKFLOW_CRASH_ROOT: root,
      WORKFLOW_CRASH_STAGE: stage,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("workflow isolated-process crash recovery", () => {
  test("replays a durable spawn and re-adopts its persisted wait after an abrupt process exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-crash-process-"));
    try {
      const crashed = await runStage(root, "start");
      expect(crashed.exitCode).toBe(86);
      expect(crashed.stderr).toBe("");

      const recovery = await runStage(root, "recover");
      expect(recovery.exitCode).toBe(0);
      expect(recovery.stderr).toBe("");
      const result = JSON.parse(recovery.stdout) as {
        oldRunId: string;
        recoveredId: string;
        status: string;
        result: { id: string; status: string };
        sessions: Array<{ id: string; status: string }>;
        waits?: unknown[];
        spawnRequest: string;
      };
      expect(result.recoveredId).not.toBe(result.oldRunId);
      expect(result.status).toBe("done");
      expect(result.result).toMatchObject({
        id: "durable-child",
        status: "done",
      });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        id: "durable-child",
        status: "done",
      });
      expect(result.waits).toEqual([]);
      expect(result.spawnRequest).toMatch(/^start:workflow-session-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
