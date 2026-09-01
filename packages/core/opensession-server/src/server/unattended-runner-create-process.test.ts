import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixture = join(
  import.meta.dir,
  "testing/unattended-runner-create-fixture.ts",
);

describe("automation descendant Runner create orchestration", () => {
  test("registered SessionControl creation crosses actor planning, Runner preparation, run-ws events, and opening settlement", async () => {
    const root = mkdtempSync(join(tmpdir(), "unattended-runner-create-"));
    try {
      const proc = Bun.spawn([process.execPath, fixture], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH || "",
          UNATTENDED_RUNNER_CREATE_ROOT: root,
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
      if (exitCode !== 0)
        throw new Error(
          `Runner create fixture failed (${exitCode}): ${stderr}`,
        );
      const resultLine = stdout
        .split("\n")
        .find((line) => line.startsWith("RESULT:"));
      if (!resultLine)
        throw new Error(`Runner create fixture produced no result: ${stdout}`);
      const result = JSON.parse(resultLine.slice("RESULT:".length)) as any;
      expect(result.session).toMatchObject({
        id: result.created.id,
        branch: "swarm/runner-opening",
        parentSessionId: "automation-parent",
        automationId: "renderer-swarm",
        piSessionId: "ses_runner_opening",
        runner: {
          workspacePath: expect.stringContaining("/runner-root/sessions/"),
        },
        automationDescendantPolicy: {
          automationId: "renderer-swarm",
          mcpServers: [],
          repo: "renderer",
          publicationRepo: "tellahq/renderer",
          baseBranch: "main",
          publication: "branch-pr-only",
        },
      });
      expect(result.session.lastRunError).toBeUndefined();
      expect(result.runState).toMatchObject({ state: "idle" });
      expect(result.creationState).toMatchObject({ state: "ready" });
      expect(result.runnerPermissions).toMatchObject({
        fullSessions: false,
        automationDescendants: true,
      });
      expect(result.controlFrames.map((frame: any) => frame.t)).toEqual([
        "workspace_prepare",
        "run_host",
      ]);
      expect(result.controlFrames[0].automationDescendant).toBe(true);
      expect(result.controlFrames[1].automationDescendant).toBe(true);
      expect(result.openingSpec).toEqual({
        trustProfile: "automation",
        mcpServers: [],
        proxyMcpServers: [],
        aws: false,
        user: undefined,
        publicationPolicy: {
          repo: "tellahq/renderer",
          branch: "main",
          headBranch: "swarm/runner-opening",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
