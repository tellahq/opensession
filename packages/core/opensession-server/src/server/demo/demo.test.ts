/**
 * Demo dataset generator tests — SPAWNER HALF. The real assertions live in
 * demo-isolated.test.ts, which self-skips unless OS_DEMO_TEST_CHILD=1; this
 * test runs them in a CHILD bun process whose HOME/state env point at scratch
 * BEFORE any module evaluates. Why: bun test runs all files in one process,
 * so hook-based seams can't contain module-eval path snapshots or
 * ensureSessionWorkspaces' fire-and-forget persists — demo sessions ended up
 * filed into the operator's LIVE sessions/workspaces stores (2026-08-04). In the
 * child, every resolver and every deferred write sees scratch from first
 * instruction to process exit.
 */

import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

describe("demo dataset generator (isolated child process)", () => {
  it("full suite passes with zero writes outside the scratch HOME", async () => {
    // The operator sets TMPDIR beneath /home/ubuntu for session isolation,
    // while this test asserts generated data has no operator-home literals.
    // Use the OS scratch root so the fixture does not fail on its own HOME.
    const home = join("/tmp", `demo-data-child-${crypto.randomUUID()}`);
    try {
      const proc = Bun.spawn(
        [
          process.execPath,
          "test",
          join(import.meta.dir, "demo-isolated.test.ts"),
        ],
        {
          env: {
            ...process.env,
            OS_DEMO_TEST_CHILD: "1",
            HOME: home,
            // A fresh namespace, not the operator's: no sessions-dir/config/state
            // overrides may leak in from the outer environment.
            OPENSESSION_STATE_DIR: "",
            OPENSESSION_SESSIONS_DIR: "",
            OPENSESSION_CONFIG: join(home, "config.json"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // bun test writes its summary to stderr.
      expect(`${out}\n${err}`).toContain(" 0 fail");
      expect(code).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
