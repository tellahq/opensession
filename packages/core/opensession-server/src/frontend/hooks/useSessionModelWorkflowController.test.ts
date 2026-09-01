import { describe, expect, test } from "bun:test";

const viewerSource = await Bun.file(
  new URL("../components/SessionViewer.tsx", import.meta.url),
).text();
const hookSource = await Bun.file(
  new URL("useSessionModelWorkflowController.ts", import.meta.url),
).text();

function expectInOrder(source: string, needles: string[]) {
  let offset = 0;
  for (const needle of needles) {
    const index = source.indexOf(needle, offset);
    expect(index).toBeGreaterThanOrEqual(offset);
    offset = index + needle.length;
  }
}

describe("session model and workflow ownership", () => {
  test("SessionViewer delegates the send settings once", () => {
    expect(
      viewerSource.match(/useSessionModelWorkflowController\(\{/g),
    ).toHaveLength(1);
    expect(viewerSource).not.toContain("const [models, setModels]");
    expect(viewerSource).not.toContain("const [defaultModel, setDefaultModel]");
    expect(viewerSource).not.toContain("const [accounts, setAccounts]");
    expect(viewerSource).not.toContain("const [effort, setEffort]");
    expect(viewerSource).not.toContain("const [fastMode, setFastMode]");
    expect(viewerSource).not.toContain("const [goalOverride, setGoalOverride]");
    expect(viewerSource).not.toContain("const [workflowRuns, setWorkflowRuns]");
    expect(viewerSource).not.toContain("function workflowAction(");
    expect(viewerSource).not.toContain("fetchModels(");
    expect(viewerSource).not.toContain("fetchProviderAccounts(");
  });

  test("the controller owns the seed fetches and the workflow endpoint", () => {
    expect(hookSource).toContain("fetchModels(session.workspaceId");
    expect(hookSource).toContain("fetchProviderAccounts()");
    expect(hookSource).toContain("/workflows`");
    expect(hookSource).toContain("api/workflows/${encodeURIComponent(runId)}");
  });

  test("keeps the sync effects and the workflow seed in source order", () => {
    expectInOrder(hookSource, [
      "useEffect(() => setGoalOverride(undefined), [session.id, session.goal]);",
      "fetchModels(session.workspaceId",
      'type: "sync_model"',
      "setAccountId(session.accountId",
      "setEffort(session.effort",
      "setFastMode(session.fastMode",
      'type: "sync_usage"',
      "setWorkflowsLoaded(false);",
      "function workflowAction(",
    ]);
  });

  test("returns grouped slices rather than a flat bag", () => {
    expect(hookSource).toContain("    model: {");
    expect(hookSource).toContain(
      "    workflows: { workflowRuns, setWorkflowRuns, workflowAction },",
    );
    expect(viewerSource).toContain(
      "    workflows: { workflowRuns, setWorkflowRuns, workflowAction },",
    );
  });

  test("the sub-agent list and the busy flag stay in the viewer", () => {
    expect(hookSource).not.toContain("fetchSessionSubagents");
    expect(hookSource).not.toContain("const isBusy");
    expect(viewerSource).toContain("fetchSessionSubagents(session.id)");
    expect(viewerSource).toContain(
      "const isBusy = !safety && (isRunningLive || isStreaming);",
    );
  });
});
