import { describe, expect, test } from "bun:test";
import {
  beginTurn,
  endTurn,
  getTurn,
  isCheckedKind,
  isReachTool,
  recordDeclaration,
  recordEffect,
  verdictFor,
} from "./turn-outcome";

describe("isReachTool", () => {
  test("matches the mcp__server__tool spelling", () => {
    expect(isReachTool("mcp__plain__create_note")).toBe(true);
    expect(isReachTool("mcp__slack__slack_post_message")).toBe(true);
    expect(isReachTool("mcp__slack__slack_reply_to_thread")).toBe(true);
    expect(isReachTool("mcp__linear__save_comment")).toBe(true);
    expect(isReachTool("mcp__linear__save_issue")).toBe(true);
  });

  test("matches the pi <server>_<tool> spelling the engine reports", () => {
    expect(isReachTool("plain_create_note")).toBe(true);
    expect(isReachTool("slack_slack_post_message")).toBe(true);
    expect(isReachTool("slack_slack_reply_to_thread")).toBe(true);
    expect(isReachTool("linear_save_comment")).toBe(true);
    expect(isReachTool("linear_save_issue")).toBe(true);
    expect(isReachTool("opensession-report_publish_report")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isReachTool("MCP__Plain__Create_Note")).toBe(true);
  });

  test("does not match reads, unrelated tools, or nothing at all", () => {
    expect(isReachTool("mcp__plain__get_thread")).toBe(false);
    expect(isReachTool("slack_slack_get_thread_replies")).toBe(false);
    expect(isReachTool("linear_get_issue")).toBe(false);
    expect(isReachTool("linear_save_customer")).toBe(false);
    expect(isReachTool("bash")).toBe(false);
    expect(isReachTool("mcp__gmail__draft_email")).toBe(false);
    expect(isReachTool(undefined)).toBe(false);
    expect(isReachTool("")).toBe(false);
  });
});

describe("isCheckedKind", () => {
  test("covers the unattended kinds whose point is to reach someone", () => {
    expect(isCheckedKind("automation")).toBe(true);
    expect(isCheckedKind("plain")).toBe(true);
    expect(isCheckedKind("action")).toBe(true);
    expect(isCheckedKind("security-scan")).toBe(true);
  });

  test("strips the resume/rerun/fallback suffixes the journal appends", () => {
    expect(isCheckedKind("automation-resume")).toBe(true);
    expect(isCheckedKind("automation-fallback")).toBe(true);
    expect(isCheckedKind("plain-resume-fallback")).toBe(true);
  });

  test("leaves interactive kinds and normally-quiet kinds alone", () => {
    expect(isCheckedKind("prompt")).toBe(false);
    expect(isCheckedKind("create")).toBe(false);
    expect(isCheckedKind("slack")).toBe(false);
    expect(isCheckedKind("goal")).toBe(false);
    expect(isCheckedKind("workflow")).toBe(false);
    // github-* deliverables are posted by server code after the ledger
    // closes (review.ts postReview), so checking them only manufactures
    // false silent-drop papercuts.
    expect(isCheckedKind("github-review")).toBe(false);
    expect(isCheckedKind("github-review-resume")).toBe(false);
    expect(isCheckedKind(undefined)).toBe(false);
    expect(isCheckedKind("")).toBe(false);
  });
});

describe("verdictFor", () => {
  test("an outward effect is enough on its own", () => {
    expect(verdictFor({ effects: ["mcp__plain__create_note"] })).toBe("reached");
  });

  test("effects outrank a declaration — a run that said it would be quiet and then posted did reach someone", () => {
    expect(
      verdictFor({
        effects: ["mcp__plain__create_note"],
        declaration: { tool: "finish_silently", reason: "nothing found" },
      })
    ).toBe("reached");
  });

  test("a declaration alone is a clean quiet ending", () => {
    expect(verdictFor({ effects: [], declaration: { tool: "finish_silently" } })).toBe(
      "declared"
    );
    expect(
      verdictFor({ effects: [], declaration: { tool: "stay_silent", reason: "asked twice" } })
    ).toBe("declared");
  });

  test("neither is the failure this whole module exists to catch", () => {
    expect(verdictFor({ effects: [] })).toBe("silent-drop");
  });
});

describe("ledger", () => {
  test("records effects once each, in call order", () => {
    beginTurn({ key: "bks-effects", kind: "automation" });
    recordEffect("bks-effects", "mcp__plain__create_note");
    recordEffect("bks-effects", "mcp__plain__create_note");
    recordEffect("bks-effects", "mcp__linear__save_issue");
    expect(getTurn("bks-effects")!.effects).toEqual([
      "mcp__plain__create_note",
      "mcp__linear__save_issue",
    ]);
    expect(endTurn("bks-effects")!.verdict).toBe("reached");
  });

  test("the last declaration wins", () => {
    beginTurn({ key: "bks-declare", kind: "automation" });
    recordDeclaration("bks-declare", { tool: "finish_silently", reason: "first" });
    recordDeclaration("bks-declare", { tool: "stay_silent", reason: "second" });
    const outcome = endTurn("bks-declare")!;
    expect(outcome.verdict).toBe("declared");
    expect(outcome.declaration).toEqual({ tool: "stay_silent", reason: "second" });
  });

  test("an unattended run that reached nobody and said nothing is a silent drop", () => {
    beginTurn({ key: "bks-drop", kind: "plain", sessionId: "bks-drop" });
    const outcome = endTurn("bks-drop")!;
    expect(outcome.verdict).toBe("silent-drop");
    expect(outcome.effects).toEqual([]);
    expect(outcome.declaration).toBeUndefined();
  });

  test("endTurn is idempotent — a second close returns nothing to report twice", () => {
    beginTurn({ key: "bks-twice", kind: "automation" });
    expect(endTurn("bks-twice")).toBeDefined();
    expect(endTurn("bks-twice")).toBeUndefined();
  });

  test("writes to an unknown or closed ledger are dropped, never thrown", () => {
    expect(() => recordEffect("bks-missing", "mcp__plain__create_note")).not.toThrow();
    expect(() => recordDeclaration(undefined, { tool: "finish_silently" })).not.toThrow();
    expect(endTurn("bks-missing")).toBeUndefined();
  });

  test("a fresh run on a reused session id does not inherit the previous verdict", () => {
    beginTurn({ key: "bks-reused", kind: "automation" });
    recordEffect("bks-reused", "mcp__plain__create_note");
    expect(endTurn("bks-reused")!.verdict).toBe("reached");

    beginTurn({ key: "bks-reused", kind: "automation" });
    expect(endTurn("bks-reused")!.verdict).toBe("silent-drop");
  });
});
