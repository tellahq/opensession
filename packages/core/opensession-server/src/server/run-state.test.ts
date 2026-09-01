import { describe, expect, test } from "bun:test";
import {
  RUN_STATE_TRANSITIONS,
  type RunEvent,
  type RunState,
  clearRunState,
  getRunState,
  isRunStateUnsettled,
  nextRunState,
  runStates,
  transitionRunState,
} from "./run-state";

const STATES = Object.keys(RUN_STATE_TRANSITIONS) as RunState[];
const EVENTS = new Set<RunEvent>(
  STATES.flatMap((s) => Object.keys(RUN_STATE_TRANSITIONS[s]) as RunEvent[]),
);

function walk(start: RunState, events: RunEvent[]): RunState {
  let state = start;
  for (const event of events) {
    const next = nextRunState(state, event);
    if (next === undefined) {
      throw new Error(`no edge for ${event} while ${state}`);
    }
    state = next;
  }
  return state;
}

describe("transition table shape", () => {
  test("every state has at least one outgoing edge (no dead ends)", () => {
    for (const state of STATES) {
      expect(Object.keys(RUN_STATE_TRANSITIONS[state]).length).toBeGreaterThan(
        0,
      );
    }
  });

  test("every state is reachable from idle", () => {
    const seen = new Set<RunState>(["idle"]);
    const frontier: RunState[] = ["idle"];
    while (frontier.length > 0) {
      const state = frontier.pop()!;
      for (const to of Object.values(RUN_STATE_TRANSITIONS[state])) {
        if (!seen.has(to)) {
          seen.add(to);
          frontier.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual([...STATES].sort());
  });

  test("every declared event is used by at least one edge", () => {
    // Type-level RunEvent members that never appear in the table would be
    // dead vocabulary; EVENTS is derived from the table, so spot-check the
    // full declared list here.
    const declared: RunEvent[] = [
      "prompt",
      "workspace_prepare",
      "workspace_ready",
      "workspace_failed",
      "run_registered",
      "start_failed",
      "start_aborted",
      "stop_lifted",
      "ask_posed",
      "ask_resolved",
      "steer",
      "turn_end",
      "run_failed",
      "cancel",
      "engine_died",
      "shutdown_orphaned",
      "boot_journal_found",
      "reattach_start",
      "reattach_ok",
      "reattach_fail",
      "resume_reprompt",
    ];
    for (const event of declared) {
      expect(EVENTS.has(event)).toBe(true);
    }
  });
});

describe("lifecycle paths", () => {
  test("happy path: prompt → register → turn end", () => {
    expect(walk("idle", ["prompt", "run_registered", "turn_end"])).toBe("idle");
  });

  test("ask flow parks and resumes the run", () => {
    expect(
      walk("idle", [
        "prompt",
        "run_registered",
        "ask_posed",
        "ask_resolved",
        "turn_end",
      ]),
    ).toBe("idle");
  });

  test("queue-while-busy and mid-run steer are self-edges, not rejections", () => {
    expect(walk("running", ["prompt", "steer"])).toBe("running");
    expect(walk("ask_blocked", ["prompt", "steer"])).toBe("ask_blocked");
  });

  test("user Stop parks the session until intake releases it for a new run", () => {
    expect(walk("running", ["cancel"])).toBe("stopped");
    expect(walk("stopped", ["stop_lifted", "prompt", "run_registered"])).toBe(
      "running",
    );
  });

  test("stopped absorbs the cancelled run's own teardown", () => {
    expect(walk("running", ["cancel", "turn_end"])).toBe("stopped");
    expect(walk("running", ["cancel", "run_failed"])).toBe("stopped");
  });

  test("a repeated Stop while already stopped absorbs", () => {
    expect(walk("running", ["cancel", "cancel"])).toBe("stopped");
  });

  test("un-instrumented recovery paths degrade to run_registered leniency", () => {
    expect(walk("interrupted", ["run_registered", "turn_end"])).toBe("idle");
    expect(walk("reattaching", ["run_registered"])).toBe("running");
  });

  test("a new ask overwriting a pending one stays ask_blocked", () => {
    expect(walk("ask_blocked", ["ask_posed"])).toBe("ask_blocked");
  });

  test("restart recovery: journal adoption → reattach", () => {
    expect(
      walk("idle", [
        "boot_journal_found",
        "reattach_start",
        "reattach_ok",
        "turn_end",
      ]),
    ).toBe("idle");
  });

  test("dead-server fallback: reattach fails → continuation re-prompt", () => {
    expect(
      walk("interrupted", [
        "reattach_start",
        "reattach_fail",
        "resume_reprompt",
        "run_registered",
      ]),
    ).toBe("running");
  });

  test("create flow: workspace prep precedes the first prompt", () => {
    expect(
      walk("idle", ["workspace_prepare", "workspace_ready", "prompt"]),
    ).toBe("starting");
  });

  test("terminal failure needs an explicit new prompt to leave", () => {
    expect(walk("running", ["run_failed"])).toBe("failed");
    expect(walk("failed", ["prompt"])).toBe("starting");
  });

  test("rotation re-registration mid-run is legal", () => {
    expect(walk("running", ["run_registered"])).toBe("running");
  });
});

describe("settlement", () => {
  test("restart recovery remains unsettled until its terminal outcome", () => {
    for (const state of [
      "preparing",
      "starting",
      "running",
      "ask_blocked",
      "interrupted",
      "reattaching",
    ] satisfies RunState[]) {
      expect(isRunStateUnsettled(state)).toBe(true);
    }
    for (const state of ["idle", "stopped", "failed"] satisfies RunState[]) {
      expect(isRunStateUnsettled(state)).toBe(false);
    }
  });
});

describe("illegal combinations are rejected (the zombie class)", () => {
  const rejected: Array<[RunState, RunEvent]> = [
    ["idle", "turn_end"], // double teardown
    ["idle", "ask_resolved"], // answer with nobody waiting
    ["running", "ask_resolved"], // ask already gone
    ["idle", "steer"], // steer with no live run
    ["idle", "reattach_ok"], // reattach completion nobody started
  ];
  for (const [state, event] of rejected) {
    test(`${event} while ${state}`, () => {
      expect(nextRunState(state, event)).toBeUndefined();
    });
  }
});

describe("engine death settles through interrupted", () => {
  // The mid-run death watchers fire engine_died → interrupted, then the
  // run's own terminal outcome (recordRunOutcome) lands moments later. A
  // dead-server turn is lost, not resumable — the follow-up outcome must
  // settle it instead of rejecting.
  test("engine_died then run_failed lands on failed", () => {
    expect(walk("running", ["engine_died", "run_failed"])).toBe("failed");
  });
  test("engine_died then turn_end lands on idle", () => {
    expect(walk("running", ["engine_died", "turn_end"])).toBe("idle");
  });
  test("boot-recovery paths still work from interrupted", () => {
    expect(walk("interrupted", ["reattach_start", "reattach_ok"])).toBe(
      "running",
    );
    expect(walk("interrupted", ["resume_reprompt"])).toBe("starting");
  });
  test("stopping interrupted recovery remains stopped through terminal cleanup", () => {
    expect(walk("interrupted", ["cancel", "turn_end"])).toBe("stopped");
  });
});

describe("transitionRunState (stateful wrapper)", () => {
  const sid = () => `test-${crypto.randomUUID()}`;

  test("legal transition updates the map and emits run_state_transition", async () => {
    const id = sid();
    const events: Record<string, unknown>[] = [];
    try {
      const to = await transitionRunState(id, "prompt", { user: "test" }, (e) =>
        events.push(e),
      );
      expect(to).toBe("starting");
      expect(getRunState(id)).toBe("starting");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        msg: "run_state_transition",
        session_id: id,
        from: "idle",
        to: "starting",
        event: "prompt",
        user: "test",
      });
      expect(runStates.get(id)?.lastEvent).toBe("prompt");
    } finally {
      await clearRunState(id);
    }
  });

  test("rejected transition leaves state untouched and emits run_state_rejected", async () => {
    const id = sid();
    const events: Record<string, unknown>[] = [];
    try {
      const to = await transitionRunState(id, "turn_end", undefined, (e) =>
        events.push(e),
      );
      expect(to).toBe("idle");
      expect(getRunState(id)).toBe("idle");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        msg: "run_state_rejected",
        session_id: id,
        state: "idle",
        event: "turn_end",
      });
    } finally {
      await clearRunState(id);
    }
  });

  test("parked prompts during recovery reject silently; other rejections warn", async () => {
    const id = sid();
    const events: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      await transitionRunState(id, "boot_journal_found", undefined, (e) =>
        events.push(e),
      );
      expect(getRunState(id)).toBe("interrupted");
      // The designed park: rejected, audited, but not warned.
      await transitionRunState(id, "prompt", undefined, (e) => events.push(e));
      expect(getRunState(id)).toBe("interrupted");
      expect(events.at(-1)).toMatchObject({
        msg: "run_state_rejected",
        state: "interrupted",
        event: "prompt",
      });
      expect(warnings).toHaveLength(0);
      // Unexpected rejections still warn.
      await transitionRunState(id, "ask_resolved", undefined, (e) =>
        events.push(e),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("ask_resolved while interrupted");
    } finally {
      console.warn = original;
      await clearRunState(id);
    }
  });

  test("unknown session defaults to idle; clearRunState drops tracking", async () => {
    const id = sid();
    expect(getRunState(id)).toBe("idle");
    await transitionRunState(id, "prompt", undefined, () => {});
    expect(getRunState(id)).toBe("starting");
    await clearRunState(id);
    expect(getRunState(id)).toBe("idle");
  });
});
