import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _setRunAgentForTests,
  _setWorktreeOpsForTests,
  mergeWorkflowAgents,
  workflowBranchName,
  workflowExecutor,
  type WorkflowWorktreeOps,
} from "./workflow-execute";
import type { WorkflowExecCtx, WorkflowAgentRequest } from "./workflow-types";
import type { StreamEvent } from "./run-events";

// ── A real throwaway git repo for the merge/commit paths ─────────────────────

const repos: string[] = [];

async function gitInit(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "wf-git-"));
  repos.push(dir);
  await $`git -C ${dir} init -q -b main`.quiet();
  await $`git -C ${dir} config user.email t@t.dev`.quiet();
  await $`git -C ${dir} config user.name Test`.quiet();
  writeFileSync(join(dir, "a.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(dir, "b.txt"), "b1\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m base`.quiet();
  return dir;
}

/** Create a branch off HEAD that rewrites a file, committed. */
async function branchEditing(
  dir: string,
  branch: string,
  file: string,
  content: string,
): Promise<void> {
  await $`git -C ${dir} checkout -q -b ${branch}`.quiet();
  writeFileSync(join(dir, file), content);
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} commit -q -m ${`edit ${file}`}`.quiet();
  await $`git -C ${dir} checkout -q main`.quiet();
}

afterAll(() => {
  for (const d of repos.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctx(
  dir: string,
  over: Partial<WorkflowExecCtx> = {},
): WorkflowExecCtx {
  return {
    runId: "wf-test-0001",
    sessionId: "bks-test",
    cwd: dir,
    signal: new AbortController().signal,
    ...over,
  };
}

// ── mergeWorkflowAgents (real git) ───────────────────────────────────────────

describe("mergeWorkflowAgents", () => {
  beforeEach(() => {
    // Default: never treat the tmp repo as a live shared checkout.
    _setWorktreeOpsForTests({
      create: async () => "",
      remove: async () => {},
      isLiveSharedCheckout: () => false,
    });
  });
  afterEach(() => _setWorktreeOpsForTests(null));

  it("merges branches touching different files", async () => {
    const dir = await gitInit();
    await branchEditing(dir, "wf-a", "a.txt", "line1\nCHANGED\nline3\n");
    await branchEditing(dir, "wf-b", "b.txt", "b1\nADDED\n");
    const res = await mergeWorkflowAgents(ctx(dir), [
      { seq: 0, branch: "wf-a" },
      { seq: 1, branch: "wf-b" },
    ]);
    expect(res.error).toBeUndefined();
    expect(res.merged.map((m) => m.branch).sort()).toEqual(["wf-a", "wf-b"]);
    expect(res.conflicts).toEqual([]);
    const a = await $`git -C ${dir} show HEAD:a.txt`.quiet().text();
    const b = await $`git -C ${dir} show HEAD:b.txt`.quiet().text();
    expect(a).toContain("CHANGED");
    expect(b).toContain("ADDED");
  });

  it("reports a conflict, aborts it clean, and continues the batch", async () => {
    const dir = await gitInit();
    // wf-x and wf-y both rewrite the SAME line of a.txt → conflict on the 2nd.
    await branchEditing(dir, "wf-x", "a.txt", "line1\nFROM-X\nline3\n");
    await branchEditing(dir, "wf-y", "a.txt", "line1\nFROM-Y\nline3\n");
    // wf-z touches a different file — must still merge after the conflict.
    await branchEditing(dir, "wf-z", "b.txt", "b1\nZ\n");
    const res = await mergeWorkflowAgents(ctx(dir), [
      { seq: 0, branch: "wf-x" },
      { seq: 1, branch: "wf-y" },
      { seq: 2, branch: "wf-z" },
    ]);
    expect(res.merged.map((m) => m.branch)).toEqual(["wf-x", "wf-z"]);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].branch).toBe("wf-y");
    expect(res.conflicts[0].files).toContain("a.txt");
    // The aborted conflict left the tree clean (no merge markers, no staged state).
    const status = await $`git -C ${dir} status --porcelain`.quiet().text();
    expect(status.trim()).toBe("");
    const a = await $`git -C ${dir} show HEAD:a.txt`.quiet().text();
    expect(a).toContain("FROM-X");
    expect(a).not.toContain("FROM-Y");
  });

  it("skips a branch that no longer exists", async () => {
    const dir = await gitInit();
    const res = await mergeWorkflowAgents(ctx(dir), [
      { seq: 0, branch: "wf-gone" },
    ]);
    expect(res.merged).toEqual([]);
    expect(res.skipped[0]).toMatchObject({ branch: "wf-gone" });
  });

  it("refuses a dirty session worktree (nothing merged)", async () => {
    const dir = await gitInit();
    await branchEditing(dir, "wf-a", "a.txt", "line1\nX\nline3\n");
    writeFileSync(join(dir, "a.txt"), "dirty uncommitted\n"); // dirty the tree
    const res = await mergeWorkflowAgents(ctx(dir), [
      { seq: 0, branch: "wf-a" },
    ]);
    expect(res.error).toMatch(/dirty worktree/);
    expect(res.merged).toEqual([]);
  });

  it("refuses the live shared checkout (nothing merged)", async () => {
    const dir = await gitInit();
    _setWorktreeOpsForTests({
      create: async () => "",
      remove: async () => {},
      isLiveSharedCheckout: () => true,
    });
    const res = await mergeWorkflowAgents(ctx(dir, { repo: "opensession" }), [
      { seq: 0, branch: "wf-a" },
    ]);
    expect(res.error).toMatch(/live shared checkout/);
    expect(res.merged).toEqual([]);
  });
});

// ── branch naming determinism ────────────────────────────────────────────────

describe("workflowBranchName", () => {
  it("is deterministic in (runId, seq) — no Date.now/random", () => {
    const a = workflowBranchName("wf-019f-abcd", 3);
    const b = workflowBranchName("wf-019f-abcd", 3);
    expect(a).toBe(b);
    expect(workflowBranchName("wf-019f-abcd", 4)).not.toBe(a);
    // filesystem/git-ref safe
    expect(a).toMatch(/^[\w./-]+$/);
  });
});

// ── write-agent execution (mocked runAgent + worktree ops) ───────────────────

function fakeRun(events: StreamEvent[]) {
  _setRunAgentForTests(async function* () {
    for (const e of events) yield e;
  });
}

function doneEvents(text: string): StreamEvent[] {
  return [
    { type: "init", sessionId: "eng-123" },
    { type: "text_chunk", text },
    {
      type: "done",
      usage: {
        inputTokens: 5,
        outputTokens: 9,
        costUsd: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextTokens: 0,
      },
    },
  ];
}

describe("write-agent execution", () => {
  let dir: string;
  let created: string[] = [];
  let removed: string[] = [];

  beforeEach(async () => {
    dir = await gitInit();
    created = [];
    removed = [];
    const ops: WorkflowWorktreeOps = {
      create: async (branch) => {
        created.push(branch);
        // Each write agent gets its own throwaway worktree off the same repo.
        const wt = mkdtempSync(join(tmpdir(), "wf-wt-"));
        repos.push(wt);
        await $`git -C ${dir} worktree add -q -b ${branch} ${wt}`.quiet();
        return wt;
      },
      remove: async (branch) => {
        removed.push(branch);
      },
      isLiveSharedCheckout: () => false,
    };
    _setWorktreeOpsForTests(ops);
  });
  afterEach(() => {
    _setRunAgentForTests(null);
    _setWorktreeOpsForTests(null);
  });

  function writeReq(): WorkflowAgentRequest {
    return {
      seq: 0,
      prompt: "edit a.txt",
      opts: { write: true, label: "edit-a" },
    };
  }

  it("returns a result object with engineSessionId even in ask mode", async () => {
    fakeRun(doneEvents("hello"));
    const out = await workflowExecutor.execute(
      { seq: 0, prompt: "read", opts: {} },
      ctx(dir),
    );
    expect(out.ok).toBe(true);
    expect(out.engineSessionId).toBe("eng-123");
    expect(out.cwd).toBe(dir);
  });

  it("a write agent that changes a file commits it and reports the diffstat", async () => {
    // The mocked run doesn't actually edit; simulate the edit by having the
    // worktree create hook leave a change, then run.
    const ops = {
      create: async (branch: string) => {
        created.push(branch);
        const wt = mkdtempSync(join(tmpdir(), "wf-wt-"));
        repos.push(wt);
        await $`git -C ${dir} worktree add -q -b ${branch} ${wt}`.quiet();
        writeFileSync(join(wt, "a.txt"), "line1\nEDITED\nline3\nline4\n");
        return wt;
      },
      remove: async (branch: string) => {
        removed.push(branch);
      },
      isLiveSharedCheckout: () => false,
    };
    _setWorktreeOpsForTests(ops);
    fakeRun(doneEvents("done editing"));
    const out = await workflowExecutor.execute(
      writeReq(),
      ctx(dir, { repo: "x", baseBranch: "main" }),
    );
    expect(out.ok).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.branch).toBeTruthy();
    expect(out.files).toContain("a.txt");
    expect(out.insertions ?? 0).toBeGreaterThan(0);
    expect(out.commit).toBeTruthy();
    // It changed something → the worktree is kept (not removed).
    expect(removed).not.toContain(out.branch);
  });

  it("a write agent that changes nothing removes its worktree and reports changed:false", async () => {
    // create hook leaves the tree untouched.
    fakeRun(doneEvents("nothing to do"));
    const out = await workflowExecutor.execute(
      writeReq(),
      ctx(dir, { repo: "x", baseBranch: "main" }),
    );
    expect(out.ok).toBe(true);
    expect(out.changed).toBe(false);
    expect(out.branch).toBeUndefined();
    expect(removed.length).toBe(1); // cleaned up
  });
});
