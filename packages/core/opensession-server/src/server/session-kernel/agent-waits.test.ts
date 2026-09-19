import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentWaitWakePrompt,
  cancelAgentWait,
  getAgentWait,
  handleAgentWait,
  prCheckSettlement,
  registerPrChecksAgentWait,
  registerSessionTurnAgentWait,
  registerTimerAgentWait,
  sessionTurnOutcome,
  stopSessionTurnWatcherForTest,
  type AgentWait,
  type AgentWaitHandlerDeps,
  type PrChecksAgentWait,
  type SessionTurnAgentWait,
  type SessionTurnWaitDeps,
} from "../agent-waits";
import { isContextOnly, parseContextBlocks } from "../prompt-context";
import type { PrDetails } from "../pr-info";
import type { SessionSummary } from "../session-control";
import {
  emitSessionStateChange,
  setPrimarySessionRunning,
} from "../session-state-events";
import type { TranscriptEntry } from "../types";
import { SessionKernelStore, __setSessionKernelStoreForTest } from ".";

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;

beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});

afterEach(() => {
  stopSessionTurnWatcherForTest();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

function handlerDeps(
  overrides: Partial<AgentWaitHandlerDeps> = {},
): AgentWaitHandlerDeps {
  return {
    now: () => 0,
    getPrDetails: async () => null,
    schedule: () => {},
    deliver: async () => {},
    getSession: () => undefined,
    runState: async () => "idle",
    hasQueuedWork: async () => false,
    lastTurnEnd: () => undefined,
    transcriptTail: async () => [],
    watch: () => {},
    ...overrides,
  };
}

function summary(
  state: SessionSummary["state"],
  extra: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: "target-1",
    title: "Investigate flaky test",
    state,
    queuedCount: 0,
    controllable: true,
    ...extra,
  } as unknown as SessionSummary;
}

function assistant(content: string): TranscriptEntry {
  return {
    id: `entry-${content.length}`,
    type: "assistant",
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function turnDeps(
  overrides: Partial<SessionTurnWaitDeps> = {},
): SessionTurnWaitDeps {
  return {
    now: () => 1_000,
    getSession: () => summary("running"),
    runState: async () => "running",
    hasQueuedWork: async () => false,
    lastTurnEnd: () => undefined,
    ...overrides,
  };
}

async function untilObserved(sessionId: string): Promise<SessionTurnAgentWait> {
  for (let i = 0; i < 50; i += 1) {
    const wait = await getAgentWait(sessionId);
    if (wait?.kind === "session_turn" && wait.observedEndAt != null)
      return wait;
    await Bun.sleep(1);
  }
  throw new Error("turn end was not observed");
}

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
    const deps = handlerDeps({
      now: () => now,
      getPrDetails: async () => current,
      schedule: (wait, dueAt) => scheduled.push({ wait, dueAt }),
      deliver: async (_wait, message) => {
        delivered.push(message);
      },
    });
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
    const baseDeps = handlerDeps({
      deliver: async (_wait: AgentWait, message: string) => {
        delivered.push(message);
      },
    });
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

describe("session turn waits", () => {
  const base = {
    sessionId: "caller-1",
    user: "Alex",
    targetSessionId: "target-1",
    waitId: "call-turn",
    now: 1_000,
  };

  test("classifies a watched session's turn", () => {
    expect(sessionTurnOutcome(undefined, "idle")).toBe("missing");
    expect(sessionTurnOutcome(summary("running"), "running")).toBeUndefined();
    expect(sessionTurnOutcome(summary("waiting_question"), "ask_blocked")).toBe(
      "pending_question",
    );
    expect(sessionTurnOutcome(summary("idle"), "idle")).toBe("idle");
    // Work that will run but has not started yet is not a settled turn.
    expect(sessionTurnOutcome(summary("queued"), "idle")).toBeUndefined();
    expect(sessionTurnOutcome(summary("idle"), "idle", true)).toBeUndefined();
    expect(sessionTurnOutcome(summary("idle"), "starting")).toBeUndefined();
    expect(sessionTurnOutcome(summary("idle"), "preparing")).toBeUndefined();
    expect(sessionTurnOutcome(summary("idle"), "stopped")).toBe("cancelled");
    expect(sessionTurnOutcome(summary("idle"), "failed")).toBe("failed");
    expect(
      sessionTurnOutcome(
        summary("idle", { lastRunError: { message: "boom", at: "" } }),
        "idle",
      ),
    ).toBe("failed");
    expect(sessionTurnOutcome(summary("archived"), "idle")).toBe("archived");
  });

  test("rejects targets the caller cannot see and waits on itself", async () => {
    expect(
      await registerSessionTurnAgentWait(
        base,
        turnDeps({ getSession: () => undefined }),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("target-1"),
    });
    expect(
      await registerSessionTurnAgentWait(
        { ...base, targetSessionId: "caller-1" },
        turnDeps(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("own") });
    expect(
      await registerSessionTurnAgentWait(
        { ...base, targetSessionId: "  " },
        turnDeps(),
      ),
    ).toMatchObject({ ok: false });
    expect(await getAgentWait("caller-1")).toBeUndefined();
  });

  test("send-then-wait: queued or admitted work keeps an idle-looking target unsettled", async () => {
    // send_to_session returns once the prompt is durable; the drain that
    // starts the turn runs later. The warm summary still says idle.
    const queued = await registerSessionTurnAgentWait(
      base,
      turnDeps({
        getSession: () => summary("idle"),
        runState: async () => "idle",
        hasQueuedWork: async () => true,
      }),
    );
    if (!queued.ok) throw new Error(queued.error);
    expect(queued.wait.kind).toBe("session_turn");
    expect((queued.wait as SessionTurnAgentWait).observedEndAt).toBeUndefined();
    expect(store.timer("caller-1", "agent-wait")?.dueAt).toBe(31_000);

    const admitted = await registerSessionTurnAgentWait(
      { ...base, waitId: "call-turn-admitted" },
      turnDeps({
        getSession: () => summary("idle"),
        runState: async () => "starting",
      }),
    );
    if (!admitted.ok) throw new Error(admitted.error);
    expect(admitted.replaced).toBe(true);
    expect(
      (admitted.wait as SessionTurnAgentWait).observedEndAt,
    ).toBeUndefined();

    // The poll keeps waiting for the same reasons.
    const scheduled: number[] = [];
    expect(
      await handleAgentWait(
        (await getAgentWait("caller-1")) as SessionTurnAgentWait,
        handlerDeps({
          now: () => 31_000,
          getSession: () => summary("idle"),
          hasQueuedWork: async () => true,
          schedule: (_wait, dueAt) => scheduled.push(dueAt),
        }),
      ),
    ).toBe("rescheduled");
    expect(scheduled).toEqual([61_000]);
  });

  test("catches a turn end that passes while registration is mid-await", async () => {
    // The retained record moves between the snapshot taken before
    // classification and the recheck after the wait is persisted.
    const ends = [
      { at: 500, pendingQuestion: false, seq: 1 },
      { at: 1_200, pendingQuestion: true, seq: 2 },
    ];
    let reads = 0;
    const registered = await registerSessionTurnAgentWait(
      base,
      turnDeps({ lastTurnEnd: () => ends[Math.min(reads++, 1)] }),
    );
    expect(registered).toMatchObject({
      ok: true,
      wait: {
        turnEndBefore: { at: 500, seq: 1 },
        observedEndAt: 1_200,
        observedOutcome: "pending_question",
      },
    });
    expect(store.timer("caller-1", "agent-wait")?.dueAt).toBe(1_200);
  });

  test("a poll detects a boundary from the retained record when the target is busy again", async () => {
    const registered = await registerSessionTurnAgentWait(
      base,
      turnDeps({
        lastTurnEnd: () => ({ at: 500, pendingQuestion: false, seq: 1 }),
      }),
    );
    if (!registered.ok) throw new Error(registered.error);
    expect(registered.wait).toMatchObject({
      turnEndBefore: { at: 500, seq: 1 },
    });
    expect(
      (registered.wait as SessionTurnAgentWait).observedEndAt,
    ).toBeUndefined();

    // Same record: nothing happened, keep polling.
    const scheduled: number[] = [];
    expect(
      await handleAgentWait(
        registered.wait,
        handlerDeps({
          now: () => 31_000,
          getSession: () => summary("running"),
          runState: async () => "running",
          lastTurnEnd: () => ({ at: 500, pendingQuestion: false, seq: 1 }),
          schedule: (_wait, dueAt) => scheduled.push(dueAt),
        }),
      ),
    ).toBe("rescheduled");
    expect(scheduled).toEqual([61_000]);

    // A newer record while the target runs its next turn: the boundary
    // passed (listener missed it, or the process restarted), so deliver.
    const delivered: string[] = [];
    expect(
      await handleAgentWait(
        registered.wait,
        handlerDeps({
          now: () => 61_000,
          getSession: () => summary("running"),
          runState: async () => "running",
          lastTurnEnd: () => ({ at: 40_000, pendingQuestion: false, seq: 7 }),
          transcriptTail: async () => [assistant("Reply to the brief.")],
          deliver: async (_wait, message) => {
            delivered.push(message);
          },
        }),
      ),
    ).toBe("delivered");
    expect(delivered[0]).toContain("is idle (turn finished).");
    expect(delivered[0]).toContain("has since started another turn");
  });

  test("settles immediately when the target is already idle, with the payload", async () => {
    const registered = await registerSessionTurnAgentWait(
      base,
      turnDeps({
        getSession: () => summary("idle"),
        runState: async () => "idle",
      }),
    );
    expect(registered).toMatchObject({
      ok: true,
      replaced: false,
      wait: {
        kind: "session_turn",
        observedEndAt: 1_000,
        observedOutcome: "idle",
      },
    });
    expect(store.timer("caller-1", "agent-wait")?.dueAt).toBe(1_000);

    const delivered: string[] = [];
    const wait = (await getAgentWait("caller-1")) as SessionTurnAgentWait;
    expect(
      await handleAgentWait(
        wait,
        handlerDeps({
          now: () => 1_500,
          getSession: () => summary("idle"),
          transcriptTail: async () => [
            assistant("Earlier draft."),
            { ...assistant("thinking"), isReasoning: true },
            assistant("Done: the flaky test was a timezone assumption."),
          ],
          deliver: async (_wait, message) => {
            delivered.push(message);
          },
        }),
      ),
    ).toBe("delivered");
    expect(delivered).toHaveLength(1);
    const message = delivered[0]!;
    expect(message).toContain(
      'Session `target-1` ("Investigate flaky test") is idle (turn finished).',
    );
    expect(message).toContain(
      "Last assistant message (tail):\nDone: the flaky test was a timezone assumption.",
    );
    expect(message).not.toContain("Earlier draft");
    expect(message).not.toContain("thinking");
    expect(message).toContain("Use get_session with id `target-1`");
  });

  test("re-arms a poll while the target is running, then wakes on the state event", async () => {
    const registered = await registerSessionTurnAgentWait(base, turnDeps());
    expect(registered).toMatchObject({
      ok: true,
      wait: { kind: "session_turn", pollSeconds: 30, deadlineAt: 7_201_000 },
    });
    expect(store.timer("caller-1", "agent-wait")?.dueAt).toBe(31_000);

    const scheduled: number[] = [];
    const watched: string[] = [];
    const wait = (await getAgentWait("caller-1")) as SessionTurnAgentWait;
    expect(
      await handleAgentWait(
        wait,
        handlerDeps({
          now: () => 31_000,
          getSession: () => summary("running"),
          runState: async () => "running",
          schedule: (_wait, dueAt) => scheduled.push(dueAt),
          watch: (w) => watched.push(w.targetSessionId),
        }),
      ),
    ).toBe("rescheduled");
    expect(scheduled).toEqual([61_000]);
    expect(watched).toEqual(["target-1"]);

    // An unrelated session settling does not touch the wait.
    setPrimarySessionRunning("other-1", false, 40_000);
    await Bun.sleep(2);
    expect(
      ((await getAgentWait("caller-1")) as SessionTurnAgentWait).observedEndAt,
    ).toBeUndefined();

    setPrimarySessionRunning("target-1", false, 45_000);
    const observed = await untilObserved("caller-1");
    expect(observed).toMatchObject({
      id: "call-turn",
      observedEndAt: 45_000,
      observedOutcome: "idle",
    });
    expect(store.timer("caller-1", "agent-wait")?.dueAt).toBe(45_000);

    const delivered: string[] = [];
    expect(
      await handleAgentWait(
        observed,
        handlerDeps({
          now: () => 46_000,
          getSession: () => summary("idle"),
          deliver: async (_wait, message) => {
            delivered.push(message);
          },
        }),
      ),
    ).toBe("delivered");
    expect(delivered[0]).toContain("is idle (turn finished).");
    expect(delivered[0]).toContain("has not written an assistant message yet");
  });

  test("wakes when the target stops on a question for a human", async () => {
    await registerSessionTurnAgentWait(base, turnDeps());
    emitSessionStateChange({
      sessionId: "target-1",
      isRunning: true,
      pendingQuestion: true,
      at: 5_000,
    });
    const observed = await untilObserved("caller-1");
    expect(observed.observedOutcome).toBe("pending_question");

    const delivered: string[] = [];
    const waiting = summary("waiting_question", {
      pendingQuestion: {
        questionId: "q-1",
        questions: [{ header: "Auth method", question: "Which?" }],
      },
    });
    expect(
      await handleAgentWait(
        observed,
        handlerDeps({
          now: () => 6_000,
          getSession: () => waiting,
          runState: async () => "ask_blocked",
          transcriptTail: async () => [assistant("Which auth method?")],
          deliver: async (_wait, message) => {
            delivered.push(message);
          },
        }),
      ),
    ).toBe("delivered");
    expect(delivered[0]).toContain("is waiting on a question for a human.");
    expect(delivered[0]).toContain("Pending question `q-1`: Auth method.");
    expect(delivered[0]).toContain("Which auth method?");
  });

  test("wakes on timeout while the target is still running", async () => {
    const registered = await registerSessionTurnAgentWait(
      { ...base, timeoutSeconds: 60 },
      turnDeps(),
    );
    if (!registered.ok) throw new Error(registered.error);
    expect(registered.wait).toMatchObject({ deadlineAt: 61_000 });
    expect(store.timer("caller-1", "agent-wait")?.dueAt).toBe(31_000);

    const delivered: string[] = [];
    const scheduled: number[] = [];
    expect(
      await handleAgentWait(
        registered.wait,
        handlerDeps({
          now: () => 61_000,
          getSession: () => summary("running"),
          runState: async () => "running",
          schedule: (_wait, dueAt) => scheduled.push(dueAt),
          transcriptTail: async () => [assistant("Still digging.")],
          deliver: async (_wait, message) => {
            delivered.push(message);
          },
        }),
      ),
    ).toBe("delivered");
    expect(scheduled).toEqual([]);
    expect(delivered[0]).toContain("still running when the wait timed out");
    expect(delivered[0]).toContain("Still digging.");
  });

  test("reports an observed turn end even when the target is busy again", async () => {
    const wait: SessionTurnAgentWait = {
      version: 1,
      id: "wait-turn",
      sessionId: "caller-1",
      kind: "session_turn",
      user: "Alex",
      prompt: "Continue.",
      targetSessionId: "target-1",
      createdAt: 0,
      deadlineAt: 100_000,
      pollSeconds: 30,
      observedEndAt: 10_000,
      observedOutcome: "idle",
    };
    const delivered: string[] = [];
    expect(
      await handleAgentWait(
        wait,
        handlerDeps({
          now: () => 11_000,
          getSession: () => summary("running"),
          runState: async () => "running",
          transcriptTail: async () => [assistant("Reply to the brief.")],
          deliver: async (_wait, message) => {
            delivered.push(message);
          },
        }),
      ),
    ).toBe("delivered");
    expect(delivered[0]).toContain("is idle (turn finished).");
    expect(delivered[0]).toContain("has since started another turn");
    expect(delivered[0]).toContain("Reply to the brief.");
  });

  test("tail-truncates a long last message and reports failures", async () => {
    const wait: SessionTurnAgentWait = {
      version: 1,
      id: "wait-long",
      sessionId: "caller-1",
      kind: "session_turn",
      user: "Alex",
      prompt: "Continue.",
      targetSessionId: "target-1",
      createdAt: 0,
      deadlineAt: 100_000,
      pollSeconds: 30,
    };
    const long = `${"x".repeat(5_000)}END`;
    const delivered: string[] = [];
    await handleAgentWait(
      wait,
      handlerDeps({
        now: () => 1_000,
        getSession: () =>
          summary("idle", {
            lastRunError: { message: "usage limit reached", at: "" },
          }),
        transcriptTail: async () => [assistant(long)],
        deliver: async (_wait, message) => {
          delivered.push(message);
        },
      }),
    );
    const message = delivered[0]!;
    expect(message).toContain("is failed (the run ended on an error).");
    expect(message).toContain("Error: usage limit reached");
    expect(message).toContain("earlier characters omitted");
    expect(
      message.endsWith(
        "END\n\nUse get_session with id `target-1` for more of the transcript.",
      ),
    ).toBe(true);
    expect(message.length).toBeLessThan(4_600);
  });

  test("replacement drops the old watch and shows up in wait status", async () => {
    await registerSessionTurnAgentWait(base, turnDeps());
    const replaced = await registerTimerAgentWait({
      sessionId: "caller-1",
      user: "Alex",
      seconds: 60,
      waitId: "call-timer",
      now: 2_000,
    });
    expect(replaced).toMatchObject({ ok: true, replaced: true });

    // The stale in-process watch must not resurrect the replaced wait.
    setPrimarySessionRunning("target-1", false, 3_000);
    await Bun.sleep(5);
    expect(await getAgentWait("caller-1")).toMatchObject({
      id: "call-timer",
      kind: "timer",
      dueAt: 62_000,
    });

    const back = await registerSessionTurnAgentWait(
      { ...base, waitId: "call-turn-2", now: 4_000 },
      turnDeps(),
    );
    expect(back).toMatchObject({ ok: true, replaced: true });
    expect(await getAgentWait("caller-1")).toMatchObject({
      id: "call-turn-2",
      kind: "session_turn",
      targetSessionId: "target-1",
    });
  });
});
