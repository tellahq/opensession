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

  test("fires on MERGEABLE → CONFLICTING", async () => {
    expect(await sweep("MERGEABLE")).toEqual([]);
    const events = await sweep("CONFLICTING");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      repoId: "tella-fusion",
      branch: "fix/test",
      number: 42,
    });
  });

  test("a PR first seen as CONFLICTING never fires", async () => {
    // Restart safety: pre-existing conflicts are adopted silently rather than
    // waking every session at once.
    expect(await sweep("CONFLICTING")).toEqual([]);
    expect(await sweep("CONFLICTING")).toEqual([]);
  });

  test("fires once, not on every following sweep", async () => {
    await sweep("MERGEABLE");
    const [event] = await sweep("CONFLICTING");
    expect(event).toBeDefined();
    settleConflictIntent(event!);
    expect(await sweep("CONFLICTING")).toEqual([]);
    expect(await sweep("CONFLICTING")).toEqual([]);
  });

  test("retries a transition until durable delivery admission", async () => {
    await sweep("MERGEABLE");
    const [first] = await sweep("CONFLICTING");
    const [retry] = await sweep("CONFLICTING");
    expect(retry?.conflictId).toBe(first?.conflictId);
  });

  test("a delayed old settlement cannot delete a newer transition", async () => {
    await sweep("MERGEABLE");
    const [first] = await sweep("CONFLICTING");
    expect(isCurrentConflictIntent(first!)).toBe(true);
    await sweep("MERGEABLE");
    expect(isCurrentConflictIntent(first!)).toBe(false);
    const [second] = await sweep("CONFLICTING");
    settleConflictIntent(first!);
    const [retry] = await sweep("CONFLICTING");
    expect(retry?.conflictId).toBe(second?.conflictId);
  });

  test("a flicker through UNKNOWN does not hide the transition", async () => {
    // GitHub reports UNKNOWN whenever its background merge test is still
    // running, which is common on the sweep right after a base push.
    await sweep("MERGEABLE");
    expect(await sweep("UNKNOWN")).toEqual([]);
    expect(await sweep("CONFLICTING")).toHaveLength(1);
  });

  test("UNKNOWN alone never fires", async () => {
    expect(await sweep("UNKNOWN")).toEqual([]);
    expect(await sweep("UNKNOWN")).toEqual([]);
  });

  test("re-fires after a conflict is resolved and returns", async () => {
    await sweep("MERGEABLE");
    const first = await sweep("CONFLICTING");
    expect(first).toHaveLength(1);
    await sweep("MERGEABLE");
    const second = await sweep("CONFLICTING");
    expect(second).toHaveLength(1);
    expect(second[0]?.conflictId).not.toBe(first[0]?.conflictId);
  });

  test("carries the PR body's session ref when it has one", async () => {
    await sweep("MERGEABLE", { sessionRef: "os-abc" });
    expect(
      (await sweep("CONFLICTING", { sessionRef: "os-abc" }))[0]?.sessionRef,
    ).toBe("os-abc");
  });

  test("ignores PRs that are no longer open", async () => {
    await sweep("MERGEABLE");
    expect(await sweep("CONFLICTING", { state: "MERGED" })).toEqual([]);
  });

  test("ignores repos the sweep did not refresh", async () => {
    const data = new Map([
      ["tella-fusion", new Map([["fix/test", pr({ mergeable: "MERGEABLE" })]])],
    ]);
    // A repo whose open-PR query failed is carried forward untouched, so its
    // rows must not be compared against.
    expect(await scanConflictTransitions(data, new Set())).toEqual([]);
    data.get("tella-fusion")!.set("fix/test", pr({ mergeable: "CONFLICTING" }));
    expect(await scanConflictTransitions(data, new Set())).toEqual([]);
    expect(
      await scanConflictTransitions(data, new Set(["tella-fusion"])),
    ).toEqual([]);
  });

  test("forgets a PR that leaves the open set, so a reopen starts clean", async () => {
    await sweep("MERGEABLE");
    // Sweep with the PR gone entirely (merged and aged out of the window).
    expect(
      await scanConflictTransitions(
        new Map([["tella-fusion", new Map()]]),
        new Set(["tella-fusion"]),
      ),
    ).toEqual([]);
    expect(await sweep("CONFLICTING")).toEqual([]);
  });

  test("tracks the same PR number in two repos independently", async () => {
    const data = (fusion: string, backstage: string) =>
      new Map([
        ["tella-fusion", new Map([["fix/test", pr({ mergeable: fusion })]])],
        ["opensession", new Map([["fix/test", pr({ mergeable: backstage })]])],
      ]);
    const fresh = new Set(["tella-fusion", "opensession"]);
    await scanConflictTransitions(data("MERGEABLE", "CONFLICTING"), fresh);
    const events = await scanConflictTransitions(
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

  test("assigns the conflict without repeating the procedure", () => {
    // Delivery reaches exactly one session, so the notice says it owns the
    // conflict. The procedure lives in the branch discipline note.
    expect(msg).toContain("This session is assigned to handle it.");
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
