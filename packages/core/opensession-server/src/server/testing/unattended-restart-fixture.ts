import { mkdirSync } from "fs";
import { join } from "path";

const root = process.env.UNATTENDED_RESTART_ROOT;
const phase = process.argv[2];
if (!root || !phase) throw new Error("root and phase are required");
process.env.HOME = root;
process.env.OPENSESSION_STATE_DIR = join(root, "state");
process.env.OPENSESSION_WORKFLOWS_DIR = join(root, "workflows");
mkdirSync(root, { recursive: true });

const store = await import("../workflow-store");
const workflows = await import("../workflow-runner");
const { publishSessionBranch } = await import("../session-publication");
import type {
  WorkflowSessionController,
  WorkflowSessionStatus,
  WorkflowSpawnedSession,
} from "../workflow-types";

const requestId = "publish-process-restart";
const receiptPath = () => join(root, "publication-receipt.json");
let child: WorkflowSpawnedSession = {
  id: "child-process-restart",
  url: "https://os.invalid/s/child-process-restart",
  repo: "renderer",
  branch: "compat/restart",
  parentSessionId: "parent",
};
const descendant = {
  id: child.id,
  title: "Child",
  branch: child.branch,
  worktreeDir: "/runner/child-process-restart",
  runner: {
    id: "fake-runner",
    name: "Fake Runner",
    workspacePath: "/runner/child-process-restart",
    lifecycle: "awake",
  },
  automationDescendantPolicy: {
    automationId: "renderer",
    automationName: "Renderer",
    mcpServers: [],
    repo: "renderer",
    publicationRepo: "tellahq/renderer",
    baseBranch: "main",
    allowedRunners: ["fake-runner"],
    publication: "branch-pr-only",
  },
};

function status(state: WorkflowSessionStatus["status"]): WorkflowSessionStatus {
  return { ...child, status: state, branchPushed: state === "done" };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("restart fixture timed out");
    await Bun.sleep(5);
  }
}

const executor = {
  async execute(): Promise<never> {
    throw new Error("restart fixture must not call a provider");
  },
};

if (phase === "before") {
  const controller: WorkflowSessionController = {
    adopt(session) {
      child = session;
    },
    async spawn() {
      return child;
    },
    async status() {
      return status("running");
    },
    async wait(_id, _opts, signal) {
      return await new Promise<WorkflowSessionStatus>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    },
    async send() {
      return {};
    },
    async cancel() {
      throw new Error("the crashing process must not clean up the child");
    },
  };
  const { runId } = workflows.startWorkflow({
    sessionId: "parent",
    cwd: root,
    script: [
      'export const meta = { name: "boot-recovery" };',
      'const child = await spawnSession({ prompt: "local", repo: "renderer", branch: "compat/restart" });',
      'return await waitSession(child.id, { until: "done", timeout: 60000 });',
    ].join("\n"),
    executor,
    sessionController: controller,
  });
  const snapshot = await waitFor(() => {
    const current = store.getWorkflowRun(runId);
    return current?.sessions?.length && current.sessionWaits?.length
      ? current
      : undefined;
  });
  store.updateWorkflowRun(runId, (current) => {
    const row = current.sessions?.[0];
    if (!row) throw new Error("spawn row missing");
    row.cancelPending = true;
  });
  store.compareAndSetWorkflowState(
    runId,
    "claim",
    0,
    { owner: "before" },
    "cas-before",
  );
  let exports = 0;
  await publishSessionBranch(descendant.id, requestId, {
    findSession: async () => descendant as any,
    exportBundle: async () => {
      exports++;
      return Buffer.from("credential-free");
    },
    repositoryToken: async () => "scoped-token",
    baseCommit: async () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    runGit: async (_cwd, args) => ({
      exitCode: 0,
      stdout: args.includes("list-heads")
        ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/compat/restart\n"
        : "",
      stderr: "",
    }),
    request: async () =>
      Response.json({
        html_url: "https://github.com/tellahq/renderer/pull/77",
      }),
    receiptPath,
  });
  if (exports !== 1 || snapshot.status !== "running")
    throw new Error("crash fixture setup failed");
  process.exit(86);
} else if (phase === "after") {
  let cancelCalls = 0;
  const controller: WorkflowSessionController = {
    adopt(session) {
      child = session;
    },
    async spawn() {
      throw new Error("boot recovery must replay the durable spawn");
    },
    async status() {
      return status("running");
    },
    async wait() {
      return status("done");
    },
    async send() {
      return {};
    },
    async cancel() {
      cancelCalls++;
      return status("cancelled");
    },
  };
  store.markInterruptedWorkflows();
  const [recoveredId] = await workflows.recoverInterruptedWorkflows({
    executor,
    sessionController: controller,
    inProcessMcp: () => ({}),
  });
  if (!recoveredId) throw new Error("boot recovery found no workflow");
  const recovered = await waitFor(() => {
    const current = store.getWorkflowRun(recoveredId);
    return current && current.status !== "running" ? current : undefined;
  });
  const oldRunId = recovered.replayRootRunId!;
  const state = store.readWorkflowState(oldRunId, "claim");
  const nextCas = store.compareAndSetWorkflowState(
    oldRunId,
    "claim",
    state.version,
    { owner: "after" },
    "cas-after",
  );
  let sideEffects = 0;
  const published = await publishSessionBranch(descendant.id, requestId, {
    findSession: async () => {
      sideEffects++;
      throw new Error("receipt replay should not look up the session");
    },
    exportBundle: async () => {
      sideEffects++;
      throw new Error("receipt replay should not export");
    },
    repositoryToken: async () => {
      sideEffects++;
      throw new Error("receipt replay should not mint credentials");
    },
    receiptPath,
  });
  process.stdout.write(
    `RESULT:${JSON.stringify({
      oldRunId,
      recoveredId,
      old: store.getWorkflowRun(oldRunId),
      recovered,
      state,
      nextCas,
      cancelCalls,
      sideEffects,
      published,
    })}\n`,
  );
} else {
  throw new Error(`unknown phase ${phase}`);
}
