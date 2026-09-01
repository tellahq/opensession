import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentWaitWakePrompt,
  cancelAgentWait,
  getAgentWait,
  handleAgentWait,
  prCheckSettlement,
  registerPrChecksAgentWait,
  registerTimerAgentWait,
  type AgentWait,
  type AgentWaitHandlerDeps,
  type PrChecksAgentWait,
} from "../agent-waits";
import { isContextOnly, parseContextBlocks } from "../prompt-context";
import type { PrDetails } from "../pr-info";
import { SessionKernelStore, __setSessionKernelStoreForTest } from ".";

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;

beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});

afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

function details(
  checks: PrDetails["checks"],
  state: PrDetails["state"] = "OPEN",
): PrDetails {
  return {
    number: 42,
    title: "Wait for checks",
    url: "https://github.com/tellahq/example/pull/42",
    state,
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "abc",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "",
    author: "jfrolich",
    body: "",
    checks,
    comments: [],
    commits: [],
    files: [],
    reviewers: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    staging: null,
  };
}

const passing = {
  name: "test",
  workflowName: "CI",
  status: "COMPLETED",
  conclusion: "SUCCESS",
};
const failing = {
  name: "lint",
  workflowName: "CI",
  status: "COMPLETED",
  conclusion: "FAILURE",
};
const running = {
  name: "build",
  workflowName: "CI",
  status: "IN_PROGRESS",
  conclusion: "",
};

describe("agent wait registration", () => {
  test("stores one durable timer and replaces it idempotently", async () => {
    const first = await registerTimerAgentWait({
      sessionId: "s1",
      user: "Jaap",
      seconds: 60,
      waitId: "call-1",
      now: 1_000,
    });
    expect(first).toMatchObject({ ok: true, replaced: false });
    expect(await getAgentWait("s1")).toMatchObject({
      id: "call-1",
      kind: "timer",
      dueAt: 61_000,
    });

    const duplicate = await registerTimerAgentWait({
      sessionId: "s1",
      user: "Jaap",
      seconds: 120,
      waitId: "call-1",
      now: 2_000,
    });
    expect(duplicate).toMatchObject({ ok: true, replaced: false });
    expect(await getAgentWait("s1")).toMatchObject({ dueAt: 61_000 });

    const replacement = await registerPrChecksAgentWait({
      sessionId: "s1",
      user: "Jaap",
      repo: "example",
      branch: "feature",
      waitId: "call-2",
      now: 3_000,
    });
    expect(replacement).toMatchObject({ ok: true, replaced: true });
    expect(await getAgentWait("s1")).toMatchObject({
      id: "call-2",
      kind: "pr_checks",
      repo: "example",
      branch: "feature",
    });
    expect(await cancelAgentWait("s1")).toBe(true);
    expect(await getAgentWait("s1")).toBeUndefined();
  });

  test("wakes with hidden system context rather than a user message", async () => {
    const registered = await registerTimerAgentWait({
      sessionId: "s1",
      user: "Jaap",
      seconds: 60,
      waitId: "call-hidden",
      now: 1_000,
      prompt: "Inspect the result and continue.",
    });
    if (!registered.ok) throw new Error(registered.error);
    const prompt = agentWaitWakePrompt(registered.wait, "The timer finished.");
    expect(isContextOnly(prompt)).toBe(true);
    expect(parseContextBlocks(prompt)).toEqual([
      {
        source: "background-wait",
        body: expect.stringContaining(
          "Continue with: Inspect the result and continue.",
        ),
      },
    ]);
    expect(prompt).not.toContain("[Jaap]");
  });

  test("rejects timer waits outside the safe bounds", async () => {
    expect(
      await registerTimerAgentWait({
        sessionId: "s1",
        user: "Jaap",
        seconds: 5,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await registerTimerAgentWait({
        sessionId: "s1",
        user: "Jaap",
        seconds: 24 * 60 * 60 + 1,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("PR check settlement", () => {
  test("classifies checks and fences settlement to the current head", async () => {
    expect(
      prCheckSettlement(details([passing, failing, running])),
    ).toMatchObject({
      settled: false,
      total: 3,
      pending: 1,
      failed: 1,
      passed: 1,
    });
    const settled = prCheckSettlement(details([passing, failing]));
    expect(settled).toMatchObject({
      settled: true,
      total: 2,
      pending: 0,
      failed: 1,
      passed: 1,
    });
    expect(
      prCheckSettlement({
        ...details([passing, failing]),
        headRefOid: "new-head",
      }).signature,
    ).not.toBe(settled.signature);
  });

  test("requires a stable settlement window before delivery", async () => {
    let now = 10_000;
    let current = details([running]);
    const scheduled: Array<{ wait: AgentWait; dueAt: number }> = [];
    const delivered: string[] = [];
    const deps: AgentWaitHandlerDeps = {
      now: () => now,
      getPrDetails: async () => current,
      schedule: (wait, dueAt) => scheduled.push({ wait, dueAt }),
      deliver: async (_wait, message) => {
        delivered.push(message);
      },
    };
    const wait: PrChecksAgentWait = {
      version: 1,
      id: "wait-1",
      sessionId: "s1",
      kind: "pr_checks",
      user: "Jaap",
      prompt: "Continue.",
      repo: "example",
      branch: "feature",
      createdAt: 0,
      deadlineAt: 300_000,
      pollSeconds: 30,
      settleSeconds: 45,
    };

    expect(await handleAgentWait(wait, deps)).toBe("rescheduled");
    expect(
      (scheduled.at(-1)?.wait as PrChecksAgentWait).candidateSince,
    ).toBeUndefined();

    current = details([passing, failing]);
    now = 40_000;
    const afterRunning = scheduled.at(-1)!.wait as PrChecksAgentWait;
    expect(await handleAgentWait(afterRunning, deps)).toBe("rescheduled");
    const candidate = scheduled.at(-1)!.wait as PrChecksAgentWait;
    expect(candidate.candidateSince).toBe(40_000);

    now = 70_000;
    expect(await handleAgentWait(candidate, deps)).toBe("rescheduled");
    now = 90_000;
    const stable = scheduled.at(-1)!.wait as PrChecksAgentWait;
    expect(await handleAgentWait(stable, deps)).toBe("delivered");
    expect(delivered).toEqual([
      "PR example#42 checks settled. 2 checks settled: 1 passed, 1 failed.",
    ]);
  });

  test("wakes on PR closure and on timeout after transient failures", async () => {
    const delivered: string[] = [];
    const wait: PrChecksAgentWait = {
      version: 1,
      id: "wait-2",
      sessionId: "s1",
      kind: "pr_checks",
      user: "Jaap",
      prompt: "Continue.",
      repo: "example",
      branch: "feature",
      createdAt: 0,
      deadlineAt: 100_000,
      pollSeconds: 30,
      settleSeconds: 45,
    };
    const baseDeps = {
      schedule: () => {},
      deliver: async (_wait: AgentWait, message: string) => {
        delivered.push(message);
      },
    };
    expect(
      await handleAgentWait(wait, {
        ...baseDeps,
        now: () => 50_000,
        getPrDetails: async () => details([], "MERGED"),
      }),
    ).toBe("delivered");
    expect(delivered.at(-1)).toBe("PR example#42 is merged.");

    expect(
      await handleAgentWait(
        { ...wait, lastError: "GitHub unavailable" },
        {
          ...baseDeps,
          now: () => 100_000,
          getPrDetails: async () => {
            throw new Error("should not fetch after deadline");
          },
        },
      ),
    ).toBe("delivered");
    expect(delivered.at(-1)).toContain("timed out");
    expect(delivered.at(-1)).toContain("GitHub unavailable");
  });
});
