import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Store roots resolve at import, so point them at scratch dirs first.
const root = mkdtempSync(join(tmpdir(), "derived-catalog-repair-"));
const saved = {
  state: process.env.OPENSESSION_STATE_DIR,
  workflows: process.env.OPENSESSION_WORKFLOWS_DIR,
};
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_WORKFLOWS_DIR = join(root, "workflows");
const { importApplicationCatalog, repairFreshDerivedImports } =
  await import("./catalog-documents");
const { listWorkflowRunsForSession } = await import("./workflow-store");
const { getPrReviewStatus } = await import("./pr-cache");
const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");

const store = new SessionKernelStore(":memory:");
const previousStore = __setSessionKernelStoreForTest(store);

afterAll(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
  if (saved.state === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = saved.state;
  if (saved.workflows === undefined)
    delete process.env.OPENSESSION_WORKFLOWS_DIR;
  else process.env.OPENSESSION_WORKFLOWS_DIR = saved.workflows;
  rmSync(root, { recursive: true, force: true });
});

test("writes a previous gateway made during the import are repaired", async () => {
  await importApplicationCatalog();

  // The previous gateway, running code that predates the projections, keeps
  // writing source files while this one imports.
  const runId = "wf-01a0f700-0000-7000-8000-000000000001";
  mkdirSync(join(root, "workflows", runId), { recursive: true });
  writeFileSync(
    join(root, "workflows", runId, "run.json"),
    JSON.stringify({
      runId,
      sessionId: "os-previous",
      name: "late",
      status: "running",
      phases: [],
      agents: [],
      sessions: [],
      logs: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      totals: { agents: 0, tokensIn: 0, tokensOut: 0 },
      cwd: root,
    }),
  );
  mkdirSync(join(root, ".opensession-github"), { recursive: true });
  writeFileSync(
    join(root, ".opensession-github", "777.json"),
    JSON.stringify({
      prNumber: 777,
      headRef: "late-review",
      reviewedShas: [],
      lastReview: {
        verdict: "approve",
        findings: 0,
        blocking: 0,
        sha: "abc",
        at: "2026-01-01T00:00:00.000Z",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  expect(await listWorkflowRunsForSession("os-previous")).toEqual([]);

  await repairFreshDerivedImports();

  expect(
    (await listWorkflowRunsForSession("os-previous")).map((r) => r.runId),
  ).toEqual([runId]);
  expect(
    (await getPrReviewStatus(777, undefined, "abc")).osReview?.verdict,
  ).toBe("approve");
});
