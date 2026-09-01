import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// state.ts resolves its dir once at import, so point the state root at a scratch
// dir BEFORE importing it and put the env back for everyone else.
const SCRATCH = mkdtempSync(join(tmpdir(), "gh-recovery-plan-"));
const savedRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = SCRATCH;
const { planRecovery } = await import("./state");
type GithubPrState = import("./state").GithubPrState;
if (savedRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
else process.env.OPENSESSION_STATE_DIR = savedRoot;

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const fresh = new Date(NOW - 60_000).toISOString();
const ancient = new Date(NOW - 40 * 60 * 60 * 1000).toISOString();

function state(patch: Partial<GithubPrState>): GithubPrState {
  return {
    prNumber: 4242,
    headRef: "some-feature-branch",
    reviewedShas: [],
    updatedAt: fresh,
    ...patch,
  };
}

describe("planRecovery picks exactly one run per PR", () => {
  test("auto-fix mid gate-review resumes the fix loop only", () => {
    // autofix arms autoFix.active, then its gate review arms activeRun: both are
    // set at once by design. Firing both would run the PR twice on every restart.
    const plan = planRecovery(
      state({
        autoFix: { active: true, iterations: 1, startedAt: fresh },
        activeRun: { kind: "review", requestedBy: "someone", startedAt: fresh },
      }),
      NOW,
    );
    expect(plan.fire).toBe("auto-fix");
    expect(plan.stale).toEqual([]);
  });

  test("every marker at once still fires one, and clears nothing live", () => {
    const plan = planRecovery(
      state({
        autoFix: { active: true, iterations: 0, startedAt: fresh },
        pendingAutoFix: { requestedBy: "soutar", receivedAt: fresh },
        activeRun: { kind: "review", requestedBy: "someone", startedAt: fresh },
        activeMention: {
          author: "someone",
          body: "hi",
          kind: "issue",
          startedAt: fresh,
        },
        pendingMention: {
          kind: "issue",
          commentId: 7,
          body: "hi",
          author: "someone",
          receivedAt: fresh,
        },
      }),
      NOW,
    );
    expect(plan.fire).toBe("auto-fix");
    expect(plan.stale).toEqual([]);
  });

  test("a label receipt that lost dispatch is recovered with its requester", () => {
    const plan = planRecovery(
      state({ pendingAutoFix: { requestedBy: "soutar", receivedAt: fresh } }),
      NOW,
    );
    expect(plan.fire).toBe("pending-auto-fix");
    expect(plan.stale).toEqual([]);
  });

  test("a stale outer marker is cleared and the live inner one fires", () => {
    const plan = planRecovery(
      state({
        autoFix: { active: true, iterations: 3, startedAt: ancient },
        activeRun: { kind: "review", requestedBy: "someone", startedAt: fresh },
      }),
      NOW,
    );
    expect(plan.stale).toEqual(["auto-fix"]);
    expect(plan.fire).toBe("run");
  });

  test("markers older than 24h are all cleared and nothing fires", () => {
    const plan = planRecovery(
      state({
        autoFix: { active: true, iterations: 3, startedAt: ancient },
        activeRun: {
          kind: "simplify",
          requestedBy: "someone",
          startedAt: ancient,
        },
        pendingMention: {
          kind: "issue",
          commentId: 7,
          body: "hi",
          author: "someone",
          receivedAt: ancient,
        },
      }),
      NOW,
    );
    expect(plan.fire).toBeUndefined();
    expect(plan.stale).toEqual(["auto-fix", "run", "pending-mention"]);
  });

  test("an undated marker is stale, not live", () => {
    const plan = planRecovery(
      state({
        activeRun: {
          kind: "adversarial",
          requestedBy: "someone",
          startedAt: "",
        },
      }),
      NOW,
    );
    expect(plan.fire).toBeUndefined();
    expect(plan.stale).toEqual(["run"]);
  });

  test("a finished auto-fix does not claim the PR", () => {
    const plan = planRecovery(
      state({
        autoFix: { active: false, iterations: 2, startedAt: fresh },
        activeRun: { kind: "review", requestedBy: "someone", startedAt: fresh },
      }),
      NOW,
    );
    expect(plan.fire).toBe("run");
  });

  test("a cancelled review is cleared instead of restarted", () => {
    const plan = planRecovery(
      state({
        activeRun: {
          kind: "review",
          requestedBy: "someone",
          startedAt: fresh,
          cancelRequestedAt: fresh,
        },
      }),
      NOW,
    );
    expect(plan.fire).toBeUndefined();
    expect(plan.stale).toEqual(["run"]);
  });

  test("a PR with no markers is left alone", () => {
    expect(planRecovery(state({}), NOW)).toEqual({ stale: [] });
  });
});
