import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendWorkflowJournal,
  compareAndSetWorkflowState,
  cancelLiveWorkflow,
  controlLiveWorkflowAgent,
  createWorkflowRun,
  getWorkflowRun,
  listWorkflowRunsForSession,
  markInterruptedWorkflows,
  pauseLiveWorkflow,
  readWorkflowJournal,
  readWorkflowState,
  recoverableWorkflowRunIds,
  registerLiveWorkflow,
  resumeLiveWorkflow,
  unregisterLiveWorkflow,
  updateWorkflowRun,
} from "./workflow-store";
import { WORKFLOW_LIMITS, type WorkflowJournalEntry } from "./workflow-types";
import { hasSessionRunningHold } from "./session-state-events";

const savedEnv = process.env.OPENSESSION_WORKFLOWS_DIR;
const dirs: string[] = [];
let runCounter = 0;
const createdRunIds: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "wf-store-test-"));
  dirs.push(dir);
  process.env.OPENSESSION_WORKFLOWS_DIR = dir;
});

afterEach(() => {
  for (const runId of createdRunIds.splice(0)) unregisterLiveWorkflow(runId);
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.OPENSESSION_WORKFLOWS_DIR;
  else process.env.OPENSESSION_WORKFLOWS_DIR = savedEnv;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeRun(overrides?: Partial<Parameters<typeof createWorkflowRun>[0]>) {
  const runId = `wf-test-${++runCounter}-${Math.random().toString(36).slice(2)}`;
  createdRunIds.push(runId);
  return createWorkflowRun({
    runId,
    sessionId: "bks-session-1",
    name: "test-workflow",
    phases: ["Phase 1"],
    cwd: "/tmp",
    script: 'export const meta = { name: "test-workflow" };\nreturn 1;',
    ...overrides,
  });
}

function journalEntry(
  seq: number,
  prompt = `prompt ${seq}`,
): WorkflowJournalEntry {
  return {
    seq,
    hash: `hash-${seq}`,
    prompt,
    opts: {},
    outcome: { ok: true, text: `result ${seq}` },
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T00:00:01.000Z",
  };
}

describe("workflow store", () => {
  test("createWorkflowRun persists run.json + script.mjs and is readable back", () => {
    const snapshot = makeRun({ description: "a test", user: "alex" });
    const dir = join(process.env.OPENSESSION_WORKFLOWS_DIR!, snapshot.runId);
    expect(existsSync(join(dir, "run.json"))).toBe(true);
    expect(readFileSync(join(dir, "script.mjs"), "utf-8")).toContain(
      "test-workflow",
    );

    const live = getWorkflowRun(snapshot.runId);
    expect(live?.name).toBe("test-workflow");
    expect(live?.status).toBe("running");
    expect(live?.description).toBe("a test");
    expect(live?.user).toBe("alex");
    expect(live?.phases).toEqual(["Phase 1"]);
    expect(live?.totals).toEqual({ agents: 0, tokensIn: 0, tokensOut: 0 });

    // Still readable from disk once no longer live.
    unregisterLiveWorkflow(snapshot.runId);
    expect(getWorkflowRun(snapshot.runId)?.name).toBe("test-workflow");
  });

  test("overlapping workflows hold their session busy until the last one finishes", () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    const first = makeRun({ sessionId });
    const second = makeRun({ sessionId });
    expect(hasSessionRunningHold(sessionId)).toBe(true);

    unregisterLiveWorkflow(first.runId);
    expect(hasSessionRunningHold(sessionId)).toBe(true);

    unregisterLiveWorkflow(second.runId);
    expect(hasSessionRunningHold(sessionId)).toBe(false);
  });

  test("updateWorkflowRun mutates, persists, and returns the snapshot", () => {
    const snapshot = makeRun();
    const updated = updateWorkflowRun(snapshot.runId, (s) => {
      s.currentPhase = "Phase 1";
      s.logs.push({ ts: "2026-07-10T00:00:00.000Z", message: "hello" });
    });
    expect(updated?.currentPhase).toBe("Phase 1");
    unregisterLiveWorkflow(snapshot.runId);
    const fromDisk = getWorkflowRun(snapshot.runId);
    expect(fromDisk?.logs).toEqual([
      { ts: "2026-07-10T00:00:00.000Z", message: "hello" },
    ]);
    expect(updateWorkflowRun("wf-does-not-exist", () => {})).toBeUndefined();
  });

  test("updateWorkflowRun truncates previews and caps log lines", () => {
    const snapshot = makeRun();
    updateWorkflowRun(snapshot.runId, (s) => {
      s.agents.push({
        seq: 0,
        label: "big",
        status: "done",
        promptPreview: "p".repeat(5000),
        resultPreview: "r".repeat(5000),
      });
      for (let i = 0; i < WORKFLOW_LIMITS.maxLogLines + 50; i++) {
        s.logs.push({ ts: "2026-07-10T00:00:00.000Z", message: `line ${i}` });
      }
    });
    const s = getWorkflowRun(snapshot.runId)!;
    expect(s.agents[0].promptPreview.length).toBeLessThanOrEqual(
      WORKFLOW_LIMITS.previewChars + 1,
    );
    expect(s.agents[0].resultPreview!.length).toBeLessThanOrEqual(
      WORKFLOW_LIMITS.previewChars + 1,
    );
    expect(s.logs.length).toBe(WORKFLOW_LIMITS.maxLogLines);
    expect(s.logs[s.logs.length - 1].message).toBe(
      `line ${WORKFLOW_LIMITS.maxLogLines + 49}`,
    );
  });

  test("journal append/read roundtrip tolerates a corrupt trailing line", () => {
    const snapshot = makeRun();
    appendWorkflowJournal(snapshot.runId, journalEntry(0));
    appendWorkflowJournal(snapshot.runId, journalEntry(1));
    // Simulate a crash mid-append: torn, unparsable trailing line.
    appendFileSync(
      join(
        process.env.OPENSESSION_WORKFLOWS_DIR!,
        snapshot.runId,
        "journal.jsonl",
      ),
      '{"seq":2,"hash":"tru',
    );
    const entries = readWorkflowJournal(
      snapshot.runId,
    ) as WorkflowJournalEntry[];
    expect(entries.length).toBe(2);
    expect(entries[0].prompt).toBe("prompt 0");
    expect(entries[1].outcome.text).toBe("result 1");
    expect(readWorkflowJournal("wf-none")).toEqual([]);
  });

  test("listWorkflowRunsForSession filters by session, newest first", () => {
    const a = makeRun({ sessionId: "bks-list-test" });
    updateWorkflowRun(a.runId, (s) => {
      s.startedAt = "2026-07-01T00:00:00.000Z";
    });
    const b = makeRun({ sessionId: "bks-list-test" });
    updateWorkflowRun(b.runId, (s) => {
      s.startedAt = "2026-07-09T00:00:00.000Z";
    });
    makeRun({ sessionId: "bks-other" });

    const runs = listWorkflowRunsForSession("bks-list-test");
    expect(runs.map((r) => r.runId)).toEqual([b.runId, a.runId]);
    expect(listWorkflowRunsForSession("bks-nobody")).toEqual([]);
  });

  test("registerLiveWorkflow exposes run and agent controls", () => {
    const snapshot = makeRun();
    const calls: string[] = [];
    registerLiveWorkflow(snapshot.runId, {
      cancel: () => calls.push("cancel"),
      pause: () => (calls.push("pause"), true),
      resume: () => (calls.push("resume"), true),
      controlAgent: (seq, action) => (calls.push(`${action}:${seq}`), true),
    });
    expect(pauseLiveWorkflow(snapshot.runId)).toBe(true);
    expect(resumeLiveWorkflow(snapshot.runId)).toBe(true);
    expect(controlLiveWorkflowAgent(snapshot.runId, 7, "retry")).toBe(true);
    expect(cancelLiveWorkflow(snapshot.runId)).toBe(true);
    expect(calls).toEqual(["pause", "resume", "retry:7", "cancel"]);
    unregisterLiveWorkflow(snapshot.runId);
    expect(cancelLiveWorkflow(snapshot.runId)).toBe(false);
  });

  test("markInterruptedWorkflows flips dead running runs, leaves live ones", () => {
    const dead = makeRun({ recovery: { autoResume: true } });
    updateWorkflowRun(dead.runId, (s) => {
      s.agents.push({
        seq: 0,
        label: "in flight",
        status: "running",
        promptPreview: "p",
      });
    });
    unregisterLiveWorkflow(dead.runId); // the process that owned it "died"
    const live = makeRun(); // still registered live → untouched
    const finished = makeRun();
    updateWorkflowRun(finished.runId, (s) => {
      s.status = "done";
    });
    unregisterLiveWorkflow(finished.runId);

    markInterruptedWorkflows();

    const deadNow = getWorkflowRun(dead.runId)!;
    expect(deadNow.status).toBe("interrupted");
    expect(deadNow.endedAt).toBeTruthy();
    expect(deadNow.agents[0].status).toBe("cancelled");
    expect(recoverableWorkflowRunIds()).toContain(dead.runId);
    expect(getWorkflowRun(live.runId)?.status).toBe("running");
    expect(getWorkflowRun(finished.runId)?.status).toBe("done");
  });
});

test("workflow state compare-and-set has one winner and persists", () => {
  const run = makeRun();
  const first = compareAndSetWorkflowState(run.runId, "queue.cursor", 0, {
    next: 1,
  });
  const stale = compareAndSetWorkflowState(run.runId, "queue.cursor", 0, {
    next: 2,
  });
  expect(first).toMatchObject({ swapped: true, version: 1 });
  expect(stale).toMatchObject({
    swapped: false,
    version: 1,
    value: { next: 1 },
  });
  expect(readWorkflowState(run.runId, "queue.cursor")).toEqual({
    key: "queue.cursor",
    version: 1,
    value: { next: 1 },
  });
});

test("workflow state CAS replays the original result by stable operation id", () => {
  const run = makeRun();
  const first = compareAndSetWorkflowState(
    run.runId,
    "queue.cursor",
    0,
    { next: 1 },
    "stable-op",
  );
  const replay = compareAndSetWorkflowState(
    run.runId,
    "queue.cursor",
    0,
    { next: 1 },
    "stable-op",
  );
  expect(first).toEqual(replay);
  expect(replay).toMatchObject({ swapped: true, version: 1 });
});

test("workflow state enforces key and aggregate byte caps", () => {
  const keys = makeRun();
  for (let index = 0; index < WORKFLOW_LIMITS.maxStateKeys; index++) {
    expect(
      compareAndSetWorkflowState(keys.runId, `key-${index}`, 0, null).swapped,
    ).toBe(true);
  }
  expect(() =>
    compareAndSetWorkflowState(keys.runId, "one-too-many", 0, null),
  ).toThrow(/key limit/);

  const bytes = makeRun();
  const chunk = "x".repeat(249_000);
  for (let index = 0; index < 4; index++)
    compareAndSetWorkflowState(bytes.runId, `chunk-${index}`, 0, chunk);
  expect(() =>
    compareAndSetWorkflowState(bytes.runId, "chunk-4", 0, chunk),
  ).toThrow(/byte limit/);
});

test("workflow state reports corruption instead of widening to empty", () => {
  const run = makeRun();
  writeFileSync(
    `${process.env.OPENSESSION_WORKFLOWS_DIR}/${run.runId}/state.json`,
    "{not-json",
  );
  expect(() => readWorkflowState(run.runId, "cursor")).toThrow(/corrupt JSON/);

  writeFileSync(
    `${process.env.OPENSESSION_WORKFLOWS_DIR}/${run.runId}/state.json`,
    JSON.stringify({
      entries: { "bad key!": { version: 1, value: null } },
      operations: {},
    }),
  );
  expect(() => readWorkflowState(run.runId, "cursor")).toThrow(/is corrupt/);

  writeFileSync(
    `${process.env.OPENSESSION_WORKFLOWS_DIR}/${run.runId}/state.json`,
    " ".repeat(WORKFLOW_LIMITS.maxStateBytes + 1),
  );
  expect(() => readWorkflowState(run.runId, "cursor")).toThrow(/byte limit/);
});
