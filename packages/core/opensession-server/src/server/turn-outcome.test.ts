import { describe, expect, test } from "bun:test";
import {
  beginTurn,
  endTurn,
  getTurn,
  isCheckedKind,
  isReachTool,
  observeToolCall,
  observedToolCall,
  recordDeclaration,
  recordEffect,
  silenceToolFor,
  verdictFor,
} from "./turn-outcome";

describe("isReachTool", () => {
  test("matches the mcp__server__tool spelling", () => {
    expect(isReachTool("mcp__plain__create_note")).toBe(true);
    expect(isReachTool("mcp__slack__conversations_add_message")).toBe(true);
  });

  test("matches the pi <server>_<tool> spelling the engine reports", () => {
    expect(isReachTool("plain_create_note")).toBe(true);
    expect(isReachTool("opensession-report_publish_report")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isReachTool("MCP__Plain__Create_Note")).toBe(true);
  });

  test("does not match reads, unrelated tools, or nothing at all", () => {
    expect(isReachTool("mcp__plain__get_thread")).toBe(false);
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
    recordEffect("bks-effects", "mcp__linear__create_issue");
    expect(getTurn("bks-effects")!.effects).toEqual([
      "mcp__plain__create_note",
      "mcp__linear__create_issue",
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

describe("observedToolCall", () => {
  test("unwraps pi's mcp_call dispatcher to the tool that was really called", () => {
    expect(
      observedToolCall({
        toolName: "mcp_call",
        toolInput: {
          name: "plain_create_note",
          arguments: { threadId: "th_1", text: "triage" },
        },
      })
    ).toEqual({
      name: "plain_create_note",
      args: { threadId: "th_1", text: "triage" },
    });
  });

  test("passes a directly-named tool through unchanged", () => {
    expect(observedToolCall({ toolName: "bash", toolInput: { cmd: "ls" } })).toEqual({
      name: "bash",
      args: { cmd: "ls" },
    });
    expect(
      observedToolCall({ toolName: "opensession-report_publish_report", toolInput: {} })
    ).toEqual({ name: "opensession-report_publish_report", args: {} });
  });

  test("a dispatcher call naming no tool names nothing", () => {
    expect(observedToolCall({ toolName: "mcp_call", toolInput: {} })).toBeUndefined();
    expect(
      observedToolCall({ toolName: "mcp_call", toolInput: { name: 42 } })
    ).toBeUndefined();
    expect(observedToolCall({ toolName: undefined })).toBeUndefined();
  });

  test("survives a missing or non-object input", () => {
    expect(observedToolCall({ toolName: "bash" })).toEqual({ name: "bash", args: {} });
    expect(observedToolCall({ toolName: "bash", toolInput: "nope" })).toEqual({
      name: "bash",
      args: {},
    });
    expect(
      observedToolCall({ toolName: "mcp_call", toolInput: { name: "x", arguments: 7 } })
    ).toEqual({ name: "x", args: {} });
  });
});

describe("silenceToolFor", () => {
  test("knows both opensession-turn tools in both spellings", () => {
    expect(silenceToolFor("opensession-turn_finish_silently")).toBe("finish_silently");
    expect(silenceToolFor("mcp__opensession-turn__finish_silently")).toBe(
      "finish_silently"
    );
    expect(silenceToolFor("opensession-turn_stay_silent")).toBe("stay_silent");
    expect(silenceToolFor("mcp__opensession-turn__stay_silent")).toBe("stay_silent");
  });

  test("is not fooled by a lookalike or by nothing", () => {
    expect(silenceToolFor("finish_silently")).toBeUndefined();
    expect(silenceToolFor("plain_create_note")).toBeUndefined();
    expect(silenceToolFor(undefined)).toBeUndefined();
  });
});

describe("observeToolCall — the cross-process, dispatcher-wrapped run", () => {
  // Both halves of the 2026-08-19 regression, in the exact event shapes a
  // hosted pi automation emits (measured from the transcript store).
  test("an outward effect made through mcp_call still counts as reaching someone", () => {
    beginTurn({ key: "bks-wrapped-reach", kind: "automation" });
    observeToolCall("bks-wrapped-reach", {
      toolName: "mcp_call",
      toolInput: {
        name: "plain_create_note",
        arguments: { threadId: "th_1", text: "triaged" },
      },
    });
    const outcome = endTurn("bks-wrapped-reach")!;
    expect(outcome.verdict).toBe("reached");
    expect(outcome.effects).toEqual(["plain_create_note"]);
  });

  test("finish_silently through mcp_call is recorded even though the tool body ran in another process", () => {
    beginTurn({ key: "bks-wrapped-declare", kind: "automation" });
    observeToolCall("bks-wrapped-declare", {
      toolName: "mcp_call",
      toolInput: {
        name: "opensession-turn_finish_silently",
        arguments: { reason: "health check nominal" },
      },
    });
    const outcome = endTurn("bks-wrapped-declare")!;
    expect(outcome.verdict).toBe("declared");
    expect(outcome.declaration).toEqual({
      tool: "finish_silently",
      reason: "health check nominal",
    });
  });

  test("stay_silent through mcp_call declares too", () => {
    beginTurn({ key: "bks-wrapped-stay", kind: "automation" });
    observeToolCall("bks-wrapped-stay", {
      toolName: "mcp_call",
      toolInput: {
        name: "opensession-turn_stay_silent",
        arguments: { reason: "already answered upthread" },
      },
    });
    expect(endTurn("bks-wrapped-stay")!.declaration).toEqual({
      tool: "stay_silent",
      reason: "already answered upthread",
    });
  });

  test("a declaration with no reason still declares", () => {
    beginTurn({ key: "bks-wrapped-noreason", kind: "automation" });
    observeToolCall("bks-wrapped-noreason", {
      toolName: "mcp_call",
      toolInput: { name: "opensession-turn_finish_silently", arguments: {} },
    });
    const outcome = endTurn("bks-wrapped-noreason")!;
    expect(outcome.verdict).toBe("declared");
    expect(outcome.declaration).toEqual({ tool: "finish_silently" });
  });

  test("a directly-named effect keeps working — the in-process and fallback paths still report one", () => {
    beginTurn({ key: "bks-direct", kind: "automation" });
    observeToolCall("bks-direct", {
      toolName: "opensession-report_publish_report",
      toolInput: {},
    });
    expect(endTurn("bks-direct")!.effects).toEqual([
      "opensession-report_publish_report",
    ]);
  });

  test("the in-process tool recording the same declaration is a harmless duplicate", () => {
    beginTurn({ key: "bks-both", kind: "automation" });
    observeToolCall("bks-both", {
      toolName: "mcp_call",
      toolInput: {
        name: "opensession-turn_finish_silently",
        arguments: { reason: "quiet day" },
      },
    });
    // What createTurnMcpServer does when the ledger IS in this process.
    recordDeclaration("bks-both", { tool: "finish_silently", reason: "quiet day" });
    const outcome = endTurn("bks-both")!;
    expect(outcome.verdict).toBe("declared");
    expect(outcome.declaration).toEqual({
      tool: "finish_silently",
      reason: "quiet day",
    });
  });

  test("an effect outranks a declaration made earlier in the same wrapped turn", () => {
    beginTurn({ key: "bks-wrapped-both", kind: "automation" });
    observeToolCall("bks-wrapped-both", {
      toolName: "mcp_call",
      toolInput: { name: "opensession-turn_finish_silently", arguments: {} },
    });
    observeToolCall("bks-wrapped-both", {
      toolName: "mcp_call",
      toolInput: { name: "plain_create_note", arguments: {} },
    });
    expect(endTurn("bks-wrapped-both")!.verdict).toBe("reached");
  });

  test("reads and searches through the dispatcher are still not effects", () => {
    beginTurn({ key: "bks-wrapped-read", kind: "automation" });
    observeToolCall("bks-wrapped-read", {
      toolName: "mcp_search",
      toolInput: { query: "post a note" },
    });
    observeToolCall("bks-wrapped-read", {
      toolName: "mcp_call",
      toolInput: { name: "plain_get_thread", arguments: { threadId: "th_1" } },
    });
    observeToolCall("bks-wrapped-read", {
      toolName: "mcp_call",
      toolInput: { name: "opensession-papercuts_log_papercut", arguments: {} },
    });
    expect(endTurn("bks-wrapped-read")!.verdict).toBe("silent-drop");
  });

  test("a malformed dispatcher call cannot manufacture an effect", () => {
    beginTurn({ key: "bks-wrapped-bad", kind: "automation" });
    observeToolCall("bks-wrapped-bad", { toolName: "mcp_call", toolInput: {} });
    expect(endTurn("bks-wrapped-bad")!.verdict).toBe("silent-drop");
  });

  test("no key is no ledger — an unchecked kind records nothing", () => {
    expect(() =>
      observeToolCall(undefined, {
        toolName: "mcp_call",
        toolInput: { name: "plain_create_note", arguments: {} },
      })
    ).not.toThrow();
  });
});
