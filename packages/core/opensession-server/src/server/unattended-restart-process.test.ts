import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixture = join(import.meta.dir, "testing/unattended-restart-fixture.ts");

async function phase(root: string, name: "before" | "after") {
  const proc = Bun.spawn([process.execPath, fixture, name], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || "",
      HOME: root,
      UNATTENDED_RESTART_ROOT: root,
    },
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

describe("unattended workflow isolated-process restart", () => {
  test("the boot recovery sweep replays publication and cleans a pending child cancellation after an abrupt exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "unattended-restart-process-"));
    try {
      const crashed = await phase(root, "before");
      expect(crashed.exitCode).toBe(86);
      expect(crashed.stderr).toBe("");

      const after = await phase(root, "after");
      if (after.exitCode !== 0)
        throw new Error(`recovery fixture failed: ${after.stderr}`);
      const line = after.stdout
        .split("\n")
        .find((value) => value.startsWith("RESULT:"));
      if (!line) throw new Error(`recovery fixture produced no result`);
      const result = JSON.parse(line.slice("RESULT:".length)) as any;
      expect(result.recoveredId).not.toBe(result.oldRunId);
      expect(result.old).toMatchObject({
        status: "interrupted",
        recoveredAsRunId: result.recoveredId,
      });
      expect(result.recovered.status).toBe("cancelled");
      expect(result.recovered.error).toBe(
        "Recovered pending child cancellation",
      );
      expect(result.recovered.sessions).toEqual([
        expect.objectContaining({
          id: "child-process-restart",
          cancelPending: false,
          status: "cancelled",
        }),
      ]);
      expect(result.cancelCalls).toBe(1);
      expect(result.state).toMatchObject({
        version: 1,
        value: { owner: "before" },
      });
      expect(result.nextCas).toMatchObject({ swapped: true, version: 2 });
      expect(result.sideEffects).toBe(0);
      expect(result.published.prUrl).toEndWith("/77");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
