import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
  prepareRunnerWorkspace,
  runnerWsClose,
  runnerWsMessage,
  runnerWsOpen,
} from "./runner-ws";

const HOME = mkdtempSync(join(tmpdir(), "os-runner-ws-test-"));
const realHome = process.env.HOME;
process.env.HOME = HOME;

afterEach(() => {
  for (const runner of listRunners()) removeRunner(runner.id);
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(HOME, { recursive: true, force: true });
});

describe("Runner WebSocket policy", () => {
  test("automation create provenance reaches workspace preparation and host launch", async () => {
    const { code } = createRunnerPairing("tester");
    const registered = registerRunner({
      code,
      name: "isolated-runner",
      platform: "linux",
      arch: "x64",
      address: "100.101.102.104",
    });
    if (!registered.ok) throw new Error(registered.error);
    const root = "/runner-root";
    updateRunner(registered.runner.id, {
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
    runnerWsMessage(ws, JSON.stringify({ t: "hello", version: 1 }));
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
    const prepareFrame = JSON.parse(sent.shift()!);
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
    const hostFrame = JSON.parse(sent.shift()!);
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
    await launching;
    runnerWsClose(ws);
  });

  test("blocks exec when maintenance is enabled after connection", async () => {
    const { code } = createRunnerPairing("tester");
    const registered = registerRunner({
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
    updateRunner(registered.runner.id, { maintenance: true });

    await expect(
      execOnRunner(registered.runner.id, "echo stale-policy"),
    ).rejects.toThrow("not permitted");
    expect(sent).toEqual([]);
    runnerWsClose(ws);
  });
});
