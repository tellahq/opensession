import { describe, expect, test } from "bun:test";
import {
  decideIdle,
  ingestPoll,
  parseStatusOutput,
  resetIdle,
  type IdleEvidence,
  type PollResult,
} from "./idle";

const MIN = 60_000;
const policy = { minutes: 30, cpuBelow: 0.1, gpuBelow: 0.05 };
const GAP = 3 * MIN;

function on(at: number, cpu = 0.01, gpu = 0): PollResult {
  return { ok: true, at, report: { state: "on", cpu, gpu } };
}

function feed(polls: PollResult[], holds: string[] = []): IdleEvidence {
  return polls.reduce<IdleEvidence>(
    (evidence, poll) =>
      ingestPoll(evidence, { poll, policy, holds, maxGapMs: GAP }),
    {},
  );
}

function every(
  fromMin: number,
  toMin: number,
  make: (at: number) => PollResult = (at) => on(at),
): PollResult[] {
  const polls: PollResult[] = [];
  for (let m = fromMin; m <= toMin; m++) polls.push(make(m * MIN));
  return polls;
}

function decide(evidence: IdleEvidence, nowMin: number, holds: string[] = []) {
  return decideIdle({
    now: nowMin * MIN,
    policy,
    maxGapMs: GAP,
    holds,
    evidence,
  });
}

describe("parseStatusOutput", () => {
  test("reads the last JSON line", () => {
    expect(
      parseStatusOutput(
        'starting up\n{"state":"on","cpu":0.4,"gpu":0,"detail":" ok "}\n',
      ),
    ).toEqual({ state: "on", cpu: 0.4, gpu: 0, detail: "ok" });
  });
  test("rejects empty, non-JSON and unknown states", () => {
    expect(typeof parseStatusOutput("")).toBe("string");
    expect(typeof parseStatusOutput("on")).toBe("string");
    expect(typeof parseStatusOutput("[1]")).toBe("string");
    expect(typeof parseStatusOutput('{"state":"running"}')).toBe("string");
  });
  test("drops metrics that are not non-negative numbers", () => {
    expect(parseStatusOutput('{"state":"on","cpu":"0.1","gpu":-1}')).toEqual({
      state: "on",
    });
  });
});

describe("idle evidence", () => {
  test("stops only after the full period of idle polls", () => {
    expect(decide(feed(every(0, 29)), 29)).toMatchObject({
      kind: "idle",
      stop: false,
    });
    expect(decide(feed(every(0, 30)), 30)).toMatchObject({
      kind: "idle",
      stop: true,
    });
  });

  test("activity restarts the period", () => {
    const busy = on(21 * MIN, 0.9);
    expect(
      decide(feed([...every(0, 20), busy, ...every(22, 45)]), 45),
    ).toMatchObject({ kind: "idle", stop: false });
    expect(
      decide(feed([...every(0, 20), busy, ...every(22, 52)]), 52),
    ).toMatchObject({ stop: true });
  });

  test("a busy GPU alone keeps it on", () => {
    expect(decide(feed(every(0, 60, (at) => on(at, 0, 0.5))), 60).kind).toBe(
      "not-idle",
    );
  });

  test("a failed poll is not idle and restarts the period", () => {
    const failed: PollResult = { ok: false, at: 15 * MIN, error: "boom" };
    expect(
      decide(feed([...every(0, 14), failed, ...every(16, 40)]), 40),
    ).toMatchObject({ stop: false });
    expect(decide(feed([...every(0, 14), failed]), 15)).toEqual({
      kind: "not-idle",
      reason: "Status check failed: boom",
    });
  });

  test("a missing metric is not zero", () => {
    const noGpu: PollResult = {
      ok: true,
      at: 0,
      report: { state: "on", cpu: 0 },
    };
    expect(decide(feed([noGpu]), 0)).toEqual({
      kind: "not-idle",
      reason: "The status check did not report GPU.",
    });
  });

  test("a state other than on is not idle", () => {
    const starting = (at: number): PollResult => ({
      ok: true,
      at,
      report: { state: "starting", cpu: 0, gpu: 0 },
    });
    expect(decide(feed(every(0, 40, starting)), 40).kind).toBe("not-idle");
  });

  test("a gap between polls restarts the period", () => {
    // Idle 0-20, then silence until 40: the idle poll at 40 proves nothing
    // about 20-40, so the period starts again at 40.
    const evidence = feed([...every(0, 20), on(40 * MIN), on(41 * MIN)]);
    expect(decide(evidence, 41)).toMatchObject({
      since: 40 * MIN,
      stop: false,
    });
  });

  test("stale evidence never stops", () => {
    expect(decide(feed(every(0, 40)), 44).kind).toBe("not-idle");
  });

  test("holds win at decision time and break the window while present", () => {
    expect(decide(feed(every(0, 40)), 40, ["exec"])).toEqual({
      kind: "held",
      reasons: ["exec"],
    });
    const held = ingestPoll(feed(every(0, 20)), {
      poll: on(21 * MIN),
      policy,
      holds: ["reserved"],
      maxGapMs: GAP,
    });
    expect(held.since).toBeUndefined();
    expect(decide(feed([...every(0, 20)]), 20).kind).toBe("idle");
  });

  test("resetIdle keeps the poll clock but drops the window", () => {
    const evidence = resetIdle(feed(every(0, 40)), "exec");
    expect(evidence.since).toBeUndefined();
    expect(evidence.lastOkAt).toBe(40 * MIN);
  });

  test("no policy means never stop", () => {
    expect(
      decideIdle({ now: 0, maxGapMs: GAP, holds: [], evidence: {} }),
    ).toEqual({ kind: "disabled" });
  });
});
