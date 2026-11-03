/**
 * The gateway half of repairing a fence over a run nothing owns. The run
 * journal path is pinned at module load, so the scratch sessions dir is set
 * before the imports.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), `orphaned-run-proof-${crypto.randomUUID()}`);
const sessionsDir = join(root, "sessions");
mkdirSync(sessionsDir, { recursive: true });
process.env.OPENSESSION_SESSIONS_DIR = sessionsDir;

type Proof = typeof import("./orphaned-run-proof");
type Kernel = typeof import("./session-kernel");
let proof: Proof;
let kernel: Kernel;
let store: InstanceType<Kernel["SessionKernelStore"]>;

beforeAll(async () => {
  proof = await import("./orphaned-run-proof");
  kernel = await import("./session-kernel");
  store = new kernel.SessionKernelStore(join(root, "session-kernel.sqlite"));
  kernel.__setSessionKernelStoreForTest(store);
});

afterAll(() => {
  kernel.__setSessionKernelStoreForTest(undefined);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function journal(records: Record<string, Record<string, unknown>>): void {
  writeFileSync(join(sessionsDir, "active-runs.json"), JSON.stringify(records));
}

test("proves an unsettled run with no owner from durable state", async () => {
  journal({});
  store.setRunState({
    sessionId: "stranded",
    state: "starting",
    event: "prompt",
    currentRunId: "rh-lost",
  });

  expect(await proof.orphanedRunProof("stranded")).toEqual({
    state: "starting",
    runId: "rh-lost",
  });
});

test("refuses while the run journal still names the session or its run", async () => {
  store.setRunState({
    sessionId: "journaled",
    state: "running",
    event: "prompt",
    currentRunId: "rh-live",
  });
  journal({ "rh-live": { runKey: "rh-live", osSessionId: "someone-else" } });
  expect(await proof.orphanedRunProof("journaled")).toBeUndefined();

  journal({ "rh-other": { runKey: "rh-other", osSessionId: "journaled" } });
  expect(await proof.orphanedRunProof("journaled")).toBeUndefined();

  journal({});
  expect(await proof.orphanedRunProof("journaled")).toEqual({
    state: "running",
    runId: "rh-live",
  });
});

test("offers nothing for a settled or person-blocked run", async () => {
  journal({});
  store.setRunState({ sessionId: "settled", state: "failed", event: "x" });
  store.setRunState({ sessionId: "asking", state: "ask_blocked", event: "x" });

  expect(await proof.orphanedRunProof("settled")).toBeUndefined();
  expect(await proof.orphanedRunProof("asking")).toBeUndefined();
  expect(await proof.orphanedRunProof("never-ran")).toBeUndefined();
});

test("shows Repair for a wedge fence nothing owns", () => {
  journal({});
  const fence = {
    sessionId: "wedged",
    reason: proof.ORPHANED_RUN_QUARANTINE_REASON,
    commandKind: "run_state:running",
    quarantinedAt: 0,
    repairable: false,
  };
  expect(proof.orphanedRunRepairable(fence)).toBe(true);

  journal({ "rh-wedged": { runKey: "rh-wedged", osSessionId: "wedged" } });
  expect(proof.orphanedRunRepairable(fence)).toBe(false);

  journal({});
  expect(
    proof.orphanedRunRepairable({
      ...fence,
      reason: "database is locked",
      commandKind: "delivery:snapshot",
    }),
  ).toBe(false);
});
