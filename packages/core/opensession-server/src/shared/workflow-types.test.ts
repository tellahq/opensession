import { describe, expect, it } from "bun:test";
import {
  normalizeWorkflowOutcome,
  WORKFLOW_LIMITS,
  type WorkflowAgentOutcome,
  type WorkflowJournalEntry,
} from "./workflow-types";

/** A journal entry exactly as runs wrote it before outcome.artifact existed:
 *  the write agent's branch and diffstat sit at the top level of the outcome. */
const LEGACY_ENTRY: WorkflowJournalEntry = JSON.parse(
  JSON.stringify({
    seq: 3,
    hash: "abc",
    prompt: "edit the thing",
    opts: { write: true },
    outcome: {
      ok: true,
      text: "done",
      branch: "wf-0192-3",
      worktreeDir: "/tmp/wt/wf-0192-3",
      changed: true,
      files: ["a.ts", "b.ts"],
      insertions: 12,
      deletions: 3,
      commit: "deadbeef",
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
  }),
);

describe("workflow limits", () => {
  it("lets one agent use the full workflow active-time budget", () => {
    expect(WORKFLOW_LIMITS.agentTimeoutMs).toBe(
      WORKFLOW_LIMITS.workflowTimeoutMs,
    );
  });
});

describe("normalizeWorkflowOutcome", () => {
  it("lifts a legacy entry's write fields into an artifact", () => {
    const outcome = normalizeWorkflowOutcome(LEGACY_ENTRY.outcome);
    // Still replayable: the resume filter keys on ok, which must survive.
    expect(outcome.ok).toBe(true);
    expect(outcome.artifact).toEqual({
      branch: "wf-0192-3",
      worktreeDir: "/tmp/wt/wf-0192-3",
      changed: true,
      files: ["a.ts", "b.ts"],
      insertions: 12,
      deletions: 3,
      commit: "deadbeef",
    });
  });

  it("leaves an outcome with no retained branch alone", () => {
    const noChange: WorkflowAgentOutcome = {
      ok: true,
      text: "nothing to do",
      changed: false,
    };
    expect(normalizeWorkflowOutcome(noChange)).toBe(noChange);
    const read: WorkflowAgentOutcome = { ok: true, text: "report" };
    expect(normalizeWorkflowOutcome(read).artifact).toBeUndefined();
  });

  it("keeps a current entry's artifact as-is", () => {
    const current: WorkflowAgentOutcome = {
      ok: false,
      error: "agent failed",
      branch: "wf-0192-4",
      changed: true,
      artifact: {
        branch: "wf-0192-4",
        worktreeDir: "/tmp/wt/wf-0192-4",
        changed: true,
      },
    };
    expect(normalizeWorkflowOutcome(current)).toBe(current);
  });
});
