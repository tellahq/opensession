import { describe, expect, test } from "bun:test";
import { buildRunJournalRecord } from "./run-journal";
import { registerSandboxSessionPredicate, runAgent } from "./agent-runner";

const workspace = {
  provider: "box",
  sandboxId: "bx_1",
  cwd: "/home/ubuntu/worktrees/acme-feature",
  scratchDir: "/home/ubuntu/.opensession/session-scratch/s1",
};

describe("remote workspace recovery", () => {
  test("an engine's own journal record keeps the Sandbox, not its token", () => {
    const record = buildRunJournalRecord(
      { remoteWorkspace: { ...workspace, rpcToken: "secret-token" } },
      { runKey: "rk-1", osSessionId: "s1", cwd: workspace.cwd },
    );
    expect(record.remoteWorkspace).toEqual(workspace);
    expect(JSON.stringify(record)).not.toContain("secret-token");
  });

  test("a Sandbox session's run without its workspace is refused", async () => {
    registerSandboxSessionPredicate((id) => id === "sandbox-session");
    try {
      const events = [];
      for await (const event of runAgent({
        prompt: "hello",
        cwd: workspace.cwd,
        mcpServers: [],
        journal: { osSessionId: "sandbox-session", kind: "prompt" },
      }))
        events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      expect(String(events[0].content)).toContain("was not connected");
    } finally {
      registerSandboxSessionPredicate(() => false);
    }
  });
});
