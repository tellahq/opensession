import { describe, expect, mock, test } from "bun:test";
import type { ExecOpts, Sandbox } from "./provider";

const sessions = new Map<
  string,
  { sandbox?: { provider: string; sandboxId?: string } }
>();
mock.module("../session-cache", () => ({
  findSessionAsync: async (id: string) => sessions.get(id),
}));

const {
  dispatchWorkspaceExec,
  forgetWorkspaceRun,
  forgetWorkspaceSandbox,
  primeWorkspaceSandbox,
} = await import("./workspace-rpc");

function fakeSandbox(
  id: string,
  seen: Array<{ cmd: string[]; opts?: ExecOpts }>,
) {
  return {
    id,
    provider: "box",
    cwd: "/home/ubuntu/worktrees/acme",
    async exec(cmd: string[], opts?: ExecOpts) {
      seen.push({ cmd, opts });
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  } as unknown as Sandbox;
}

describe("workspace exec", () => {
  test("runs the script in the launched Sandbox, in the requested directory", async () => {
    const seen: Array<{ cmd: string[]; opts?: ExecOpts }> = [];
    primeWorkspaceSandbox("s1", fakeSandbox("bx_1", seen));
    const reply = await dispatchWorkspaceExec({ sessionId: "s1" }, "t1", {
      script: "echo ok",
      cwd: "/home/ubuntu/worktrees/acme/src",
      env: { OS_PATH: "/x", "BAD-NAME": "dropped", NUM: 1 },
      timeoutMs: 5_000,
    });
    expect(reply).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
    expect(seen[0].cmd[0]).toBe("bash");
    expect(seen[0].cmd[2]).toEndWith("\necho ok");
    expect(seen[0].opts?.env).toEqual({
      PATH: expect.stringContaining("/home/ubuntu/.bun/bin"),
      HOME: "/home/ubuntu",
      OS_PATH: "/x",
      OS_CWD: "/home/ubuntu/worktrees/acme/src",
    });
    expect(seen[0].opts?.assumeStarted).toBe(true);
    expect(seen[0].opts?.timeoutMs).toBe(5_000);
    forgetWorkspaceRun("t1");
  });

  test("a session without a Sandbox is refused, never run elsewhere", async () => {
    sessions.set("host-session", {});
    const reply = await dispatchWorkspaceExec(
      { sessionId: "host-session" },
      "t2",
      { script: "echo hi" },
    );
    expect(reply.error).toContain("no Sandbox workspace");
  });

  test("a retired machine is no longer reachable", async () => {
    const seen: Array<{ cmd: string[]; opts?: ExecOpts }> = [];
    primeWorkspaceSandbox("s3", fakeSandbox("bx_3", seen));
    expect(
      (
        await dispatchWorkspaceExec({ sessionId: "s3" }, "t3", {
          script: "true",
        })
      ).exitCode,
    ).toBe(0);
    forgetWorkspaceSandbox("bx_3");
    sessions.set("s3", {});
    const reply = await dispatchWorkspaceExec({ sessionId: "s3" }, "t3", {
      script: "true",
    });
    expect(reply.error).toContain("no Sandbox workspace");
    expect(seen).toHaveLength(1);
  });

  test("an empty script is refused", async () => {
    expect(
      (await dispatchWorkspaceExec({ sessionId: "s1" }, "t4", {})).error,
    ).toContain("needs a script");
  });
});
