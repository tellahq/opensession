import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import type { PrInfo } from "../../server/pr-cache";
import {
  __setConflictIntentPathForTest,
  conflictMessage,
  isCurrentConflictIntent,
  resetConflictWatch,
  settleConflictIntent,
  scanConflictTransitions,
} from "./pr-conflict";

const scratch = mkdtempSync(join(tmpdir(), "pr-conflicts-"));
__setConflictIntentPathForTest(join(scratch, "pending.json"));
afterAll(() => {
  __setConflictIntentPathForTest(undefined);
  rmSync(scratch, { recursive: true, force: true });
});

function pr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    url: "https://github.com/tellahq/tella-fusion/pull/42",
    state: "OPEN",
    number: 42,
    title: "Test PR",
    isDraft: false,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: "",
    author: "author",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "MERGEABLE",
    reviewRequested: [],
    reviewedBy: [],
    assignees: [],
    ...overrides,
  };
}

/** One sweep of a single repo whose PR sits on `fix/test`. */
function sweep(mergeable: string, overrides: Partial<PrInfo> = {}) {
  return scanConflictTransitions(
    new Map([
      [
        "tella-fusion",
        new Map([["fix/test", pr({ mergeable, ...overrides })]]),
      ],
    ]),
    new Set(["tella-fusion"]),
  );
}

describe("scanConflictTransitions", () => {
  beforeEach(() => resetConflictWatch());

  test("fires on MERGEABLE → CONFLICTING", () => {
    expect(sweep("MERGEABLE")).toEqual([]);
    const events = sweep("CONFLICTING");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      repoId: "tella-fusion",
      branch: "fix/test",
      number: 42,
    });
  });

  test("a PR first seen as CONFLICTING never fires", () => {
    // Restart safety: pre-existing conflicts are adopted silently rather than
    // waking every session at once.
    expect(sweep("CONFLICTING")).toEqual([]);
    expect(sweep("CONFLICTING")).toEqual([]);
  });

  test("fires once, not on every following sweep", () => {
    sweep("MERGEABLE");
    const [event] = sweep("CONFLICTING");
    expect(event).toBeDefined();
    settleConflictIntent(event!);
    expect(sweep("CONFLICTING")).toEqual([]);
    expect(sweep("CONFLICTING")).toEqual([]);
  });

  test("retries a transition until durable delivery admission", () => {
    sweep("MERGEABLE");
    const [first] = sweep("CONFLICTING");
    const [retry] = sweep("CONFLICTING");
    expect(retry?.conflictId).toBe(first?.conflictId);
  });

  test("a delayed old settlement cannot delete a newer transition", () => {
    sweep("MERGEABLE");
    const [first] = sweep("CONFLICTING");
    expect(isCurrentConflictIntent(first!)).toBe(true);
    sweep("MERGEABLE");
    expect(isCurrentConflictIntent(first!)).toBe(false);
    const [second] = sweep("CONFLICTING");
    settleConflictIntent(first!);
    const [retry] = sweep("CONFLICTING");
    expect(retry?.conflictId).toBe(second?.conflictId);
  });

  test("a flicker through UNKNOWN does not hide the transition", () => {
    // GitHub reports UNKNOWN whenever its background merge test is still
    // running, which is common on the sweep right after a base push.
    sweep("MERGEABLE");
    expect(sweep("UNKNOWN")).toEqual([]);
    expect(sweep("CONFLICTING")).toHaveLength(1);
  });

  test("UNKNOWN alone never fires", () => {
    expect(sweep("UNKNOWN")).toEqual([]);
    expect(sweep("UNKNOWN")).toEqual([]);
  });

  test("re-fires after a conflict is resolved and returns", () => {
    sweep("MERGEABLE");
    const first = sweep("CONFLICTING");
    expect(first).toHaveLength(1);
    sweep("MERGEABLE");
    const second = sweep("CONFLICTING");
    expect(second).toHaveLength(1);
    expect(second[0]?.conflictId).not.toBe(first[0]?.conflictId);
  });

  test("carries the PR body's session ref when it has one", () => {
    sweep("MERGEABLE", { sessionRef: "os-abc" });
    expect(sweep("CONFLICTING", { sessionRef: "os-abc" })[0]?.sessionRef).toBe(
      "os-abc",
    );
  });

  test("ignores PRs that are no longer open", () => {
    sweep("MERGEABLE");
    expect(sweep("CONFLICTING", { state: "MERGED" })).toEqual([]);
  });

  test("ignores repos the sweep did not refresh", () => {
    const data = new Map([
      ["tella-fusion", new Map([["fix/test", pr({ mergeable: "MERGEABLE" })]])],
    ]);
    // A repo whose open-PR query failed is carried forward untouched, so its
    // rows must not be compared against.
    expect(scanConflictTransitions(data, new Set())).toEqual([]);
    data.get("tella-fusion")!.set("fix/test", pr({ mergeable: "CONFLICTING" }));
    expect(scanConflictTransitions(data, new Set())).toEqual([]);
    expect(scanConflictTransitions(data, new Set(["tella-fusion"]))).toEqual(
      [],
    );
  });

  test("forgets a PR that leaves the open set, so a reopen starts clean", () => {
    sweep("MERGEABLE");
    // Sweep with the PR gone entirely (merged and aged out of the window).
    expect(
      scanConflictTransitions(
        new Map([["tella-fusion", new Map()]]),
        new Set(["tella-fusion"]),
      ),
    ).toEqual([]);
    expect(sweep("CONFLICTING")).toEqual([]);
  });

  test("tracks the same PR number in two repos independently", () => {
    const data = (fusion: string, backstage: string) =>
      new Map([
        ["tella-fusion", new Map([["fix/test", pr({ mergeable: fusion })]])],
        ["opensession", new Map([["fix/test", pr({ mergeable: backstage })]])],
      ]);
    const fresh = new Set(["tella-fusion", "opensession"]);
    scanConflictTransitions(data("MERGEABLE", "CONFLICTING"), fresh);
    const events = scanConflictTransitions(
      data("CONFLICTING", "CONFLICTING"),
      fresh,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.repoId).toBe("tella-fusion");
  });
});

describe("conflictMessage", () => {
  const msg = conflictMessage({
    repoId: "tella-fusion",
    branch: "fix/test",
    number: 42,
    title: "Test PR",
    url: "https://github.com/tellahq/tella-fusion/pull/42",
    conflictId: "sha:transition-1",
  });

  test("names the PR and links it", () => {
    expect(msg).toContain("PR #42");
    expect(msg).toContain("Test PR");
    expect(msg).toContain("https://github.com/tellahq/tella-fusion/pull/42");
  });

  test("notifies without prescribing what to do about it", () => {
    // It is an event, not a briefing: no procedure, no priority call, no
    // repetition of git rules the agent already has.
    expect(msg.length).toBeLessThan(160);
    for (const instruction of [
      "git ",
      "gh pr",
      "resolve",
      "finish",
      "Never",
      "push",
    ])
      expect(msg).not.toContain(instruction);
  });

  test("reads as a system notice, never as something the human sent", () => {
    // deliverToSession(id, msg, "GitHub") delivers it attributed
    // (session-control-wiring.ts), and classifyEntry turns a GitHub-attributed
    // user turn into a system notice: no sender, so no client can render it as
    // the session owner's own message or as a teammate's steer.
    const delivered = {
      type: "user",
      content: `[GitHub] ${msg}`,
    } as TranscriptEntry;
    const classified = classifyEntry(delivered);
    expect(classified.sender).toBeUndefined();
    expect(classified.senderVia).toBeUndefined();
    expect(classified.notice?.kind).toBe("system");
    expect(classified.notice?.tone).toBe("info");
    // The whole line is the notice title, which is why it has to stay short.
    expect(classified.notice?.title).toBe(msg);
    expect(classified.content).toBe(msg);
  });
});
