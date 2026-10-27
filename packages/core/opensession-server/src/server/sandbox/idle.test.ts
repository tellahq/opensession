import { afterEach, describe, expect, test } from "bun:test";
import {
  idleSessionId,
  KEEP_ALIVE_EVERY_MS,
  noteSandboxActivity,
  noteSessionHumanActivity,
  resetSandboxIdleForTests,
  sandboxSleepsAt,
  sweepIdleSandboxes,
  type IdleSweepDeps,
} from "./idle";
import { PORTAL_SANDBOX_SUFFIX } from "../portal-sandbox";

const MIN = 60_000;
const policy = { agentMs: 5 * MIN, humanMs: 20 * MIN };

afterEach(() => resetSandboxIdleForTests());

function deps(overrides: Partial<IdleSweepDeps> = {}) {
  const slept: string[] = [];
  const keptAlive: string[] = [];
  const value: IdleSweepDeps = {
    policy,
    busy: () => false,
    async sleep(_sessionId, sandboxId, stillIdle) {
      if (!stillIdle(sandboxId)) return false;
      slept.push(sandboxId);
      return true;
    },
    async keepAlive(_sessionId, sandboxId) {
      keptAlive.push(sandboxId);
    },
    ...overrides,
  };
  return { value, slept, keptAlive };
}

describe("two idle timers", () => {
  test("a GPU job machine sleeps five minutes after its job, whatever the session does", async () => {
    const t0 = 500_000;
    noteSessionHumanActivity("g1", t0);
    noteSandboxActivity(
      { sandboxId: "md-g1--gpu", sessionId: "g1--gpu" },
      "agent",
      t0,
    );
    noteSandboxActivity(
      { sandboxId: "md-g1--gpu", sessionId: "g1" },
      "human",
      t0,
    );
    noteSessionHumanActivity("g1", t0 + 4 * MIN);
    expect(idleSessionId("g1--gpu")).toBe("g1");
    // The session's own turn keeps running; the GPU machine still sleeps.
    const d = deps({ busy: () => true });
    expect(await sweepIdleSandboxes({ ...d.value, now: t0 + 4 * MIN })).toEqual(
      [],
    );
    expect(await sweepIdleSandboxes({ ...d.value, now: t0 + 5 * MIN })).toEqual(
      ["md-g1--gpu"],
    );
  });

  test("agent work alone: asleep five minutes after the last tool call", async () => {
    const t0 = 1_000_000;
    noteSandboxActivity({ sandboxId: "bx_1", sessionId: "s1" }, "agent", t0);
    const d = deps();
    expect(await sweepIdleSandboxes({ ...d.value, now: t0 + 4 * MIN })).toEqual(
      [],
    );
    expect(await sweepIdleSandboxes({ ...d.value, now: t0 + 5 * MIN })).toEqual(
      ["bx_1"],
    );
    // No longer tracked once asleep.
    expect(sandboxSleepsAt("bx_1")).toBeNull();
  });

  test("a person's prompt keeps the machine for twenty minutes", async () => {
    const t0 = 2_000_000;
    noteSessionHumanActivity("s2", t0);
    // The prompt woke the machine; its tool calls register it afterwards.
    noteSandboxActivity(
      { sandboxId: "bx_2", sessionId: "s2" },
      "agent",
      t0 + MIN,
    );
    const d = deps();
    expect(
      await sweepIdleSandboxes({ ...d.value, now: t0 + 10 * MIN }),
    ).toEqual([]);
    expect(sandboxSleepsAt("bx_2")).toBe(t0 + 20 * MIN);
    expect(
      await sweepIdleSandboxes({ ...d.value, now: t0 + 20 * MIN }),
    ).toEqual(["bx_2"]);
  });

  test("a running turn counts as agent work and pushes the provider timer out", async () => {
    const t0 = 3_000_000;
    noteSandboxActivity({ sandboxId: "bx_3", sessionId: "s3" }, "agent", t0);
    const d = deps({ busy: (sessionId) => sessionId === "s3" });
    expect(
      await sweepIdleSandboxes({ ...d.value, now: t0 + 30 * MIN }),
    ).toEqual([]);
    expect(d.keptAlive).toEqual(["bx_3"]);
    // Not again before the keepalive interval.
    await sweepIdleSandboxes({ ...d.value, now: t0 + 31 * MIN });
    expect(d.keptAlive).toHaveLength(1);
    await sweepIdleSandboxes({
      ...d.value,
      now: t0 + 30 * MIN + KEEP_ALIVE_EVERY_MS,
    });
    expect(d.keptAlive).toHaveLength(2);
  });

  test("Portal requests are interaction on the Portal Sandbox of the session", async () => {
    const t0 = 4_000_000;
    noteSandboxActivity(
      { sandboxId: "bx_p", sessionId: `s4${PORTAL_SANDBOX_SUFFIX}` },
      "agent",
      t0,
    );
    noteSandboxActivity(
      { sandboxId: "bx_p", sessionId: "s4" },
      "human",
      t0 + 2 * MIN,
    );
    const d = deps();
    expect(
      await sweepIdleSandboxes({ ...d.value, now: t0 + 15 * MIN }),
    ).toEqual([]);
    expect(
      await sweepIdleSandboxes({ ...d.value, now: t0 + 22 * MIN }),
    ).toEqual(["bx_p"]);
  });

  test("a failed sleep waits before trying again", async () => {
    const t0 = 5_000_000;
    noteSandboxActivity({ sandboxId: "bx_5", sessionId: "s5" }, "agent", t0);
    let attempts = 0;
    const d = deps({
      async sleep() {
        attempts += 1;
        throw new Error("provider said no");
      },
    });
    await sweepIdleSandboxes({ ...d.value, now: t0 + 6 * MIN });
    await sweepIdleSandboxes({ ...d.value, now: t0 + 7 * MIN });
    expect(attempts).toBe(1);
    await sweepIdleSandboxes({ ...d.value, now: t0 + 17 * MIN });
    expect(attempts).toBe(2);
  });

  test("provider session ids map back to the session", () => {
    expect(idleSessionId(`abc${PORTAL_SANDBOX_SUFFIX}`)).toBe("abc");
    expect(idleSessionId("abc")).toBe("abc");
  });
});
