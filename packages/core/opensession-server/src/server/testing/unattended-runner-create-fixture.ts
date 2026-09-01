import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = process.env.UNATTENDED_RUNNER_CREATE_ROOT;
if (!root) throw new Error("UNATTENDED_RUNNER_CREATE_ROOT is required");
const state = join(root, "state");
const repo = join(root, "repo");
const worktrees = join(root, "worktrees");
mkdirSync(state, { recursive: true });
mkdirSync(repo, { recursive: true });
mkdirSync(worktrees, { recursive: true });
process.env.HOME = root;
process.env.OPENSESSION_STATE_DIR = state;
process.env.OPENSESSION_CONFIG = join(root, "config.json");
process.env.OPENSESSION_WORKTREES_DIR = worktrees;
process.env.OPENSESSION_SESSION_KERNEL_DB_PATH = join(root, "kernel.sqlite");

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stderr));
}
git("init", "-b", "main");
git("config", "user.email", "test@opensession.invalid");
git("config", "user.name", "Open Session test");
writeFileSync(join(repo, "README.md"), "fixture\n");
git("add", "README.md");
git("commit", "-m", "fixture");
writeFileSync(
  process.env.OPENSESSION_CONFIG,
  JSON.stringify({
    paths: { worktreesDir: worktrees },
    repos: {
      renderer: {
        repo,
        ghRepo: "tellahq/renderer",
        default: true,
        defaultBranch: "main",
        sharedCheckout: false,
      },
    },
  }),
);

const { startSessionKernelService } =
  await import("../session-kernel/actor-service");
const kernelToken = crypto.randomUUID();
const kernel = await startSessionKernelService({
  port: 0,
  token: kernelToken,
  databasePath: join(root, "kernel.sqlite"),
  workerCount: 1,
});
process.env.OPENSESSION_SESSION_KERNEL_URL = kernel.url;
process.env.OPENSESSION_SESSION_KERNEL_TOKEN = kernelToken;
const actorRuntime = await import("../session-kernel/actor-runtime");
await actorRuntime.startSessionKernelActor();

const runWs = await import("../run-ws");
const runWsServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server) {
    return (
      runWs.handleSandboxWsUpgrade(req, server, new URL(req.url).pathname) ??
      undefined
    );
  },
  websocket: {
    open(ws) {
      runWs.sandboxWsOpen(ws);
    },
    message(ws, message) {
      runWs.sandboxWsMessage(ws, message as any);
    },
    close(ws) {
      runWs.sandboxWsClose(ws);
    },
  },
});
process.env.OPENSESSION_SERVER_URL = `http://127.0.0.1:${runWsServer.port}`;

const runners = await import("../runners");
const runnerWs = await import("../runner-ws");
const { WsFrameBuffer } = await import("../../runner-host/ws-buffer");
const { code } = runners.createRunnerPairing("Renderer swarm (automation)");
const registered = runners.registerRunner({
  code,
  name: "isolation-approved-macos",
  platform: "darwin",
  arch: "arm64",
  address: "127.0.0.1",
});
if (!registered.ok) throw new Error(registered.error);
const runnerRoot = join(root, "runner-root");
mkdirSync(runnerRoot, { recursive: true });
runners.updateRunner(registered.runner.id, {
  allowedUsers: ["Renderer swarm (automation)"],
  allowedRepos: ["renderer"],
  workspaceRoots: [runnerRoot],
  permissions: { automationDescendants: true },
});

const controlFrames: any[] = [];
let openingSpec: any;
let runnerSocket: WebSocket | undefined;
const controlWs = {
  data: { kind: "runner", runnerId: registered.runner.id },
  send(frame: string) {
    const message = JSON.parse(frame);
    controlFrames.push(message);
    queueMicrotask(() => {
      if (message.t === "workspace_prepare") {
        runnerWs.runnerWsMessage(
          controlWs,
          JSON.stringify({
            t: "workspace_ready",
            id: message.id,
            operationToken: message.operationToken,
            cwd: message.workspacePath,
          }),
        );
      } else if (message.t === "run_host") {
        openingSpec = message.spec;
        runnerWs.runnerWsMessage(
          controlWs,
          JSON.stringify({
            t: "host_started",
            id: message.id,
            operationToken: message.operationToken,
            hostId: message.spec.hostId,
          }),
        );
        const buffer = new WsFrameBuffer();
        runnerSocket = new WebSocket(
          `ws://127.0.0.1:${runWsServer.port}/run-ws/${message.spec.hostId}`,
          {
            headers: { authorization: `Bearer ${message.spec.wsToken}` },
          } as unknown as string[],
        );
        runnerSocket.onopen = () => {
          runnerSocket!.send(
            JSON.stringify({
              t: "hello",
              hostId: message.spec.hostId,
              state: "running",
              pendingAsks: [],
            }),
          );
          runnerSocket!.send(
            buffer.stamp({
              t: "event",
              event: {
                type: "init",
                sessionId: "ses_runner_opening",
                provider: "pi",
                model: "pi/anthropic/claude-sonnet-5",
              },
            }),
          );
          runnerSocket!.send(
            buffer.stamp({
              t: "event",
              event: {
                type: "done",
                sessionId: "ses_runner_opening",
                provider: "pi",
                model: "pi/anthropic/claude-sonnet-5",
                result: "Opening completed locally",
              },
            }),
          );
          runnerSocket!.send(buffer.stamp({ t: "end" }));
        };
      }
    });
    return 1;
  },
  close() {},
};
runnerWs.runnerWsOpen(controlWs);
runnerWs.runnerWsMessage(controlWs, JSON.stringify({ t: "hello", version: 1 }));

const automations = await import("../automations");
const requestScope = "renderer-swarm";
const requestId = "runner-opening-e2e";
const { sessionIdForRequest } = await import("../session-request-id");
const expectedSessionId = sessionIdForRequest(requestScope, requestId);
const sessionsDir = join(state, ".opensession-sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(
  join(sessionsDir, "generated-titles.json"),
  JSON.stringify({ [expectedSessionId]: "Runner opening fixture" }),
);

const automation = {
  id: "renderer-swarm",
  name: "Renderer swarm",
  prompt: "Coordinate renderer work",
  schedule: "",
  mode: "code" as const,
  repo: "renderer",
  enabled: true,
  createdBy: "Operator",
  createdAt: new Date(0).toISOString(),
  webhookSecret: "fixture",
  workflows: true,
  workflowSessions: true,
  workflowSessionRepos: ["renderer"],
  workflowSessionRunners: [registered.runner.id],
};
automations.saveAutomation(automation);
const stored = automations.getAutomation(automation.id);
if (!stored) throw new Error("stored automation missing");
const workflowPolicy = automations.automationWorkflowSessionPolicy(stored);
if (!workflowPolicy) throw new Error("stored policy missing");

await import("../session-control-wiring");
const kernelRuntime = await import("../session-kernel/runtime");
kernelRuntime.startSessionKernelRuntime();
const { getSessionControl } = await import("../session-control");
const control = getSessionControl();
let created: { id: string; createdBy: string; createdAt: string } | undefined;
try {
  created = await control.createSession({
    requestId,
    requestScope,
    prompt: "Implement the renderer shard without publishing anything.",
    repo: "renderer",
    mode: "code",
    branch: "swarm/runner-opening",
    baseRef: "main",
    isolatedWorktree: true,
    parentSessionId: "automation-parent",
    spawnDepth: 1,
    agentStarted: true,
    reportBack: true,
    user: "Renderer swarm (automation)",
    model: "pi/anthropic/claude-sonnet-5",
    mcpServers: [],
    runner: registered.runner.id,
    automationDescendantPolicy: {
      automationId: workflowPolicy.automationId,
      automationName: workflowPolicy.automationName,
      mcpServers: [],
      repo: "renderer",
      publicationRepo: "tellahq/renderer",
      baseBranch: "main",
      allowedRunners: [...workflowPolicy.allowedRunners],
      publication: "branch-pr-only",
    },
  });
  const { sessionKernel, sessionRunStateSnapshot } =
    await import("../session-kernel");
  const deadline = Date.now() + 20_000;
  let runState = await sessionRunStateSnapshot(created.id);
  let creationState = await sessionKernel(created.id).creationState();
  while (
    (!openingSpec ||
      runState.state !== "idle" ||
      creationState?.state !== "ready") &&
    Date.now() < deadline
  ) {
    await Bun.sleep(20);
    runState = await sessionRunStateSnapshot(created.id);
    creationState = await sessionKernel(created.id).creationState();
  }
  if (
    !openingSpec ||
    runState.state !== "idle" ||
    creationState?.state !== "ready"
  )
    throw new Error(
      `opening did not settle: spec=${!!openingSpec} run=${runState.state} creation=${creationState?.state}`,
    );
  const session = JSON.parse(
    readFileSync(join(sessionsDir, `${created.id}.json`), "utf8"),
  );
  process.stdout.write(
    `RESULT:${JSON.stringify({
      created,
      session: {
        id: session?.id,
        branch: session?.branch,
        parentSessionId: session?.parentSessionId,
        automationId: session?.automationId,
        automationDescendantPolicy: session?.automationDescendantPolicy,
        runner: session?.runner,
        piSessionId: session?.piSessionId,
        lastRunError: session?.lastRunError,
      },
      runState,
      creationState,
      runnerPermissions: runners.getRunner(registered.runner.id)?.permissions,
      controlFrames: controlFrames.map((frame) => ({
        t: frame.t,
        automationDescendant: frame.automationDescendant,
        trustProfile: frame.spec?.trustProfile,
        mcpServers: frame.spec?.mcpServers,
        proxyMcpServers: frame.spec?.proxyMcpServers,
        aws: frame.spec?.aws,
        user: frame.spec?.user,
        publicationPolicy: frame.spec?.publicationPolicy,
      })),
      openingSpec: {
        trustProfile: openingSpec?.trustProfile,
        mcpServers: openingSpec?.mcpServers,
        proxyMcpServers: openingSpec?.proxyMcpServers,
        aws: openingSpec?.aws,
        user: openingSpec?.user,
        publicationPolicy: openingSpec?.publicationPolicy,
      },
    })}\n`,
  );
} finally {
  runnerSocket?.close();
  runnerWs.runnerWsClose(controlWs);
  runWsServer.stop(true);
  kernelRuntime.stopSessionKernelRuntime();
  actorRuntime.stopSessionKernelActor();
  kernel.stop();
}
