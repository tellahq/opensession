import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as commandAws from "./runner-command-aws";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createRunnerPairing,
  listRunners,
  registerRunner,
  removeRunner,
  updateRunner,
} from "./runners";
import {
  execOnRunner,
  launchRunnerHost,
  openRunnerTerminal,
  prepareRunnerWorkspace,
  resizeRunnerTerminal,
  runnerWsClose,
  runnerWsMessage,
  runnerWsOpen,
  runnerWsSettled,
  stopRunnerTerminal,
  writeRunnerTerminal,
} from "./runner-ws";

const HOME = mkdtempSync(join(tmpdir(), "os-runner-ws-test-"));
const realHome = process.env.HOME;
process.env.HOME = HOME;

afterEach(async () => {
  for (const runner of await listRunners()) await removeRunner(runner.id);
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(HOME, { recursive: true, force: true });
});

/** The next frame sent to the Runner; dispatch follows an async registry read. */
async function nextFrame(sent: string[]): Promise<string> {
  for (let i = 0; i < 100 && !sent.length; i++) await Bun.sleep(5);
  return sent.shift()!;
}

describe("Runner WebSocket policy", () => {
  test("heartbeats are acknowledged so the Runner can detect a dead channel", async () => {
    const { code } = createRunnerPairing("tester");
    const registered = await registerRunner({
      code,
      name: "heartbeat-runner",
      platform: "darwin",
      arch: "arm64",
      address: "100.101.102.105",
    });
    if (!registered.ok) throw new Error(registered.error);
    const sent: string[] = [];
    const ws = {
      data: { kind: "runner", runnerId: registered.runner.id },
      send: (frame: string) => sent.push(frame),
      close: () => {},
    };
    runnerWsOpen(ws);
    await runnerWsSettled(ws);
    runnerWsMessage(ws, JSON.stringify({ t: "hello", version: 1 }));
    await runnerWsSettled(ws);
    sent.length = 0;
    runnerWsMessage(ws, JSON.stringify({ t: "heartbeat" }));
    await runnerWsSettled(ws);
    expect(sent.map((frame) => JSON.parse(frame))).toEqual([
      { t: "heartbeat_ack" },
    ]);
    runnerWsClose(ws);
    await runnerWsSettled(ws);
  });

  test("automation create provenance reaches workspace preparation and host launch", async () => {
    const { code } = createRunnerPairing("tester");
    const registered = await registerRunner({
      code,
      name: "isolated-runner",
      platform: "linux",
      arch: "x64",
      address: "100.101.102.104",
    });
    if (!registered.ok) throw new Error(registered.error);
    const root = "/runner-root";
    await updateRunner(registered.runner.id, {
      allowedUsers: ["tester"],
      allowedRepos: ["renderer"],
      workspaceRoots: [root],
      permissions: { automationDescendants: true },
    });
    const sent: string[] = [];
    const ws = {
      data: { kind: "runner", runnerId: registered.runner.id },
      send: (frame: string) => sent.push(frame),
      close: () => {},
    };
    runnerWsOpen(ws);
    await runnerWsSettled(ws);
    runnerWsMessage(ws, JSON.stringify({ t: "hello", version: 1 }));
    await runnerWsSettled(ws);
    const sessionId = "automation-child";
    const workspacePath = `${root}/sessions/${sessionId}`;
    const preparing = prepareRunnerWorkspace(registered.runner.id, {
      sessionId,
      repo: "renderer",
      branch: "compat/layout",
      workspacePath,
      repositoryUrl: "https://github.com/tellahq/renderer.git",
      user: "tester",
      automationDescendant: true,
    });
    const prepareFrame = JSON.parse(await nextFrame(sent));
    expect(prepareFrame.t).toBe("workspace_prepare");
    expect(prepareFrame.automationDescendant).toBe(true);
    runnerWsMessage(
      ws,
      JSON.stringify({
        t: "workspace_ready",
        id: prepareFrame.id,
        operationToken: prepareFrame.operationToken,
        cwd: workspacePath,
      }),
    );
    await runnerWsSettled(ws);
    expect(await preparing).toEqual({ cwd: workspacePath });

    const launching = launchRunnerHost(registered.runner.id, {
      sessionId,
      repo: "renderer",
      user: "tester",
      server: "https://opensession.test",
      spec: {
        hostId: "rh-automation-child",
        osSessionId: sessionId,
        prompt: "opening turn",
        cwd: workspacePath,
        trustProfile: "automation",
      },
    });
    const hostFrame = JSON.parse(await nextFrame(sent));
    expect(hostFrame.t).toBe("run_host");
    expect(hostFrame.automationDescendant).toBe(true);
    expect(hostFrame.spec.trustProfile).toBe("automation");
    runnerWsMessage(
      ws,
      JSON.stringify({
        t: "host_started",
        id: hostFrame.id,
        operationToken: hostFrame.operationToken,
        hostId: "rh-automation-child",
      }),
    );
    await runnerWsSettled(ws);
    await launching;
    runnerWsClose(ws);
    await runnerWsSettled(ws);
  });

  test("a Mac VM terminal rides the commands permission, not workspace roots", async () => {
    const { code } = createRunnerPairing("tester");
    const registered = await registerRunner({
      code,
      name: "mac-mini",
      platform: "darwin",
      arch: "arm64",
      address: "100.101.102.105",
    });
    if (!registered.ok) throw new Error(registered.error);
    await updateRunner(registered.runner.id, {
      workspaceRoots: [],
      permissions: { terminals: false, commands: true },
    });
    const sent: string[] = [];
    const ws = {
      data: { kind: "runner", runnerId: registered.runner.id },
      send: (frame: string) => sent.push(frame),
      close: () => {},
    };
    runnerWsOpen(ws);
    await runnerWsSettled(ws);
    runnerWsMessage(ws, JSON.stringify({ t: "hello", version: 1 }));
    await runnerWsSettled(ws);

    // Without a VM this is a Runner shell, which the permission refuses.
    await expect(
      openRunnerTerminal({
        runnerId: registered.runner.id,
        sessionId: "s1",
        repo: "renderer",
        workspacePath: "/anywhere/sessions/s1",
      }),
    ).rejects.toThrow(/not permitted for terminals/);

    const opening = openRunnerTerminal({
      runnerId: registered.runner.id,
      sessionId: "s1",
      repo: "renderer",
      workspacePath: "/home/ubuntu/worktrees/renderer-s1",
      vm: {
        name: "sbx-s1",
        user: "admin",
        cwd: "/home/ubuntu/worktrees/renderer-s1",
      },
      cols: 120,
      rows: 40,
    });
    const frame = JSON.parse(await nextFrame(sent));
    expect(frame).toMatchObject({
      t: "terminal_start",
      version: 1,
      sessionId: "s1",
      vm: {
        name: "sbx-s1",
        user: "admin",
        cwd: "/home/ubuntu/worktrees/renderer-s1",
      },
      cols: 120,
      rows: 40,
    });
    runnerWsMessage(
      ws,
      JSON.stringify({
        t: "terminal_ready",
        id: frame.id,
        operationToken: frame.operationToken,
        cwd: "/home/ubuntu/worktrees/renderer-s1",
      }),
    );
    await runnerWsSettled(ws);
    expect(await opening).toEqual({
      terminalId: frame.id,
      cwd: "/home/ubuntu/worktrees/renderer-s1",
    });

    // Every later frame carries the protocol version, or the Runner drops it.
    writeRunnerTerminal(registered.runner.id, frame.id, "bHM K");
    resizeRunnerTerminal(registered.runner.id, frame.id, 80, 24);
    stopRunnerTerminal(registered.runner.id, frame.id);
    expect(sent.map((raw) => JSON.parse(raw))).toEqual([
      { t: "terminal_input", id: frame.id, data: "bHM K", version: 1 },
      { t: "terminal_resize", id: frame.id, cols: 80, rows: 24, version: 1 },
      { t: "terminal_stop", id: frame.id, version: 1 },
    ]);
    runnerWsClose(ws);
    await runnerWsSettled(ws);
  });

  test("blocks exec when maintenance is enabled after connection", async () => {
    const { code } = createRunnerPairing("tester");
    const registered = await registerRunner({
      code,
      name: "connected-runner",
      platform: "linux",
      arch: "x64",
      address: "100.101.102.103",
    });
    if (!registered.ok) throw new Error(registered.error);

    const sent: string[] = [];
    const ws = {
      data: { kind: "runner", runnerId: registered.runner.id },
      send: (frame: string) => sent.push(frame),
      close: () => {},
    };
    expect(runnerWsOpen(ws)).toBe(true);
    expect(
      runnerWsMessage(ws, JSON.stringify({ t: "hello", version: 1 })),
    ).toBe(true);
    await runnerWsSettled(ws);
    await updateRunner(registered.runner.id, { maintenance: true });

    await expect(
      execOnRunner(registered.runner.id, "echo stale-policy"),
    ).rejects.toThrow("not permitted");
    expect(sent).toEqual([]);
    runnerWsClose(ws);
    await runnerWsSettled(ws);
  });
});

describe("Runner command AWS dispatch", () => {
  async function withRunner(
    execAws: boolean,
    run: (id: string, sent: any[], ws: any) => Promise<void>,
  ) {
    const { code } = createRunnerPairing("tester");
    const registered = await registerRunner({
      code,
      name: "aws-runner",
      platform: "win32",
      arch: "x64",
      address: "100.101.102.103",
    });
    if (!registered.ok) throw new Error(registered.error);
    const id = registered.runner.id;
    await updateRunner(id, {
      aws: { roleArn: "arn:aws:iam::123456789012:role/os-runner" },
    });
    const sent: any[] = [];
    const ws = {
      data: { kind: "runner", runnerId: id },
      close() {},
      send(frame: string) {
        const message = JSON.parse(frame);
        sent.push(message);
        if (message.t === "exec")
          queueMicrotask(() =>
            runnerWsMessage(
              ws,
              JSON.stringify({
                t: "exit",
                id: message.id,
                operationToken: message.operationToken,
                code: 0,
              }),
            ),
          );
      },
    };
    runnerWsOpen(ws);
    await runnerWsSettled(ws);
    runnerWsMessage(ws, JSON.stringify({ t: "hello", version: 1, execAws }));
    await runnerWsSettled(ws);
    try {
      await run(id, sent, ws);
    } finally {
      runnerWsClose(ws);
      await runnerWsSettled(ws);
    }
  }
  test("interactive grant forwards credentials separately from command text", async () => {
    const mint = spyOn(commandAws, "runnerCommandAwsEnv").mockResolvedValue({
      AWS_ACCESS_KEY_ID: "role-key",
    });
    try {
      await withRunner(true, async (id, sent) => {
        await execOnRunner(id, "aws sts get-caller-identity", { aws: true });
        expect(mint).toHaveBeenCalledTimes(1);
        expect(sent[0].awsEnv).toEqual({ AWS_ACCESS_KEY_ID: "role-key" });
        expect(sent[0].command).toBe("aws sts get-caller-identity");
      });
    } finally {
      mint.mockRestore();
    }
  });
  test("internal calls without the grant do not mint, even with a configured role", async () => {
    const mint = spyOn(commandAws, "runnerCommandAwsEnv").mockRejectedValue(
      new Error("must not mint"),
    );
    try {
      await withRunner(false, async (id, sent) => {
        await execOnRunner(id, "echo probe");
        expect(mint).not.toHaveBeenCalled();
        expect(sent[0].awsEnv).toBeUndefined();
      });
    } finally {
      mint.mockRestore();
    }
  });
  test("old clients are rejected before minting or dispatch", async () => {
    const mint = spyOn(commandAws, "runnerCommandAwsEnv").mockRejectedValue(
      new Error("must not mint"),
    );
    try {
      await withRunner(false, async (id, sent) => {
        await expect(
          execOnRunner(id, "aws sts get-caller-identity", { aws: true }),
        ).rejects.toThrow("Update Runner");
        expect(mint).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
      });
    } finally {
      mint.mockRestore();
    }
  });
  test("mint failure prevents dispatch", async () => {
    const mint = spyOn(commandAws, "runnerCommandAwsEnv").mockRejectedValue(
      new Error("STS refused"),
    );
    try {
      await withRunner(true, async (id, sent) => {
        await expect(
          execOnRunner(id, "aws sts get-caller-identity", { aws: true }),
        ).rejects.toThrow("STS refused");
        expect(sent).toEqual([]);
      });
    } finally {
      mint.mockRestore();
    }
  });
  test("permission revocation during mint prevents dispatch", async () => {
    const mint = spyOn(commandAws, "runnerCommandAwsEnv").mockImplementation(
      async (runner) => {
        await updateRunner(runner.id, { maintenance: true });
        return { AWS_ACCESS_KEY_ID: "role-key" };
      },
    );
    try {
      await withRunner(true, async (id, sent) => {
        await expect(
          execOnRunner(id, "aws sts get-caller-identity", { aws: true }),
        ).rejects.toThrow("permissions changed");
        expect(sent).toEqual([]);
      });
    } finally {
      mint.mockRestore();
    }
  });
});
