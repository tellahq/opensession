import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { recoverWorkflow, startWorkflow } from "../workflow-runner";
import { getWorkflowRun, markInterruptedWorkflows } from "../workflow-store";
import type {
  WorkflowSessionController,
  WorkflowSessionStatus,
  WorkflowSpawnedSession,
} from "../workflow-types";

const root = process.env.WORKFLOW_CRASH_ROOT;
const stage = process.env.WORKFLOW_CRASH_STAGE;
if (!root || !stage) throw new Error("missing crash fixture environment");

let child: WorkflowSpawnedSession = {
  id: "durable-child",
  url: "https://opensession.test/session/durable-child",
  repo: "renderer",
  branch: "swarm/crash",
  parentSessionId: "crash-parent",
};

function status(state: WorkflowSessionStatus["status"]): WorkflowSessionStatus {
  return {
    ...child,
    status: state,
    branchPushed: state === "done",
  };
}

const controller: WorkflowSessionController = {
  adopt(session) {
    child = session;
  },
  async spawn(_opts, requestId) {
    writeFileSync(join(root, "spawn-request"), `${stage}:${requestId}`);
    return child;
  },
  async status() {
    return status(stage === "recover" ? "done" : "running");
  },
  async wait(_id, _opts, signal) {
    if (stage === "recover") return status("done");
    return await new Promise<WorkflowSessionStatus>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("fixture aborted")),
        { once: true },
      );
    });
  },
  async send() {
    return {};
  },
  async cancel() {
    return status("cancelled");
  },
};

const executor = {
  async execute(): Promise<never> {
    throw new Error("crash fixture must not call a provider");
  },
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture timed out");
    await Bun.sleep(5);
  }
}

if (stage === "start") {
  const { runId } = startWorkflow({
    sessionId: "crash-parent",
    cwd: root,
    script: [
      'export const meta = { name: "isolated-crash" };',
      'const child = await spawnSession({ prompt: "local only", repo: "renderer", branch: "swarm/crash" });',
      'return await waitSession(child.id, { until: "done", timeout: 60000 });',
    ].join("\n"),
    executor,
    sessionController: controller,
  });
  writeFileSync(join(root, "run-id"), runId);
  await waitFor(() => Boolean(getWorkflowRun(runId)?.sessionWaits?.length));
  process.exit(86);
} else if (stage === "recover") {
  const oldRunId = readFileSync(join(root, "run-id"), "utf8");
  markInterruptedWorkflows();
  const recoveredId = await recoverWorkflow(oldRunId, {
    executor,
    sessionController: controller,
    inProcessMcp: () => ({}),
  });
  if (!recoveredId) throw new Error("workflow was not recoverable");
  await waitFor(() => {
    const snapshot = getWorkflowRun(recoveredId);
    return Boolean(snapshot && snapshot.status !== "running");
  });
  const recovered = getWorkflowRun(recoveredId)!;
  process.stdout.write(
    JSON.stringify({
      oldRunId,
      recoveredId,
      status: recovered.status,
      result: recovered.result,
      sessions: recovered.sessions,
      waits: recovered.sessionWaits,
      spawnRequest: readFileSync(join(root, "spawn-request"), "utf8"),
    }),
  );
} else {
  throw new Error(`unknown fixture stage: ${stage}`);
}
