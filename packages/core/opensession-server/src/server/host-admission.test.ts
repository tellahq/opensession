import { describe, expect, test } from "bun:test";
import {
  decideRunHostAdmission,
  readCpuSomeAvg10,
  readMemAvailableMb,
  RunHostAdmissionError,
  waitForRunHostAdmission,
  type HostAdmissionLimits,
  type HostCapacitySnapshot,
} from "./host-admission";

const limits: HostAdmissionLimits = {
  maxActiveHosts: 4,
  minAvailableMb: 1_000,
  reservedPerHostMb: 500,
  maxCpuPressure: 85,
  admissionTimeoutMs: 10_000,
};

const roomy: HostCapacitySnapshot = {
  memAvailableMb: 8_000,
  cpuSomeAvg10: 5,
  activeHosts: 1,
  pendingHosts: 0,
};

describe("decideRunHostAdmission", () => {
  test("admits with headroom", () => {
    expect(decideRunHostAdmission(roomy, limits)).toEqual({ admit: true });
  });

  test("refuses at the active host cap", () => {
    const decision = decideRunHostAdmission(
      { ...roomy, activeHosts: 4 },
      limits,
    );
    expect(decision.admit).toBe(false);
    if (!decision.admit) expect(decision.reason).toContain("4/4");
  });

  test("refuses when reserving the host would break the memory floor", () => {
    // 1400 - 500 reserved = 900 < 1000 floor.
    const decision = decideRunHostAdmission(
      { ...roomy, memAvailableMb: 1_400 },
      limits,
    );
    expect(decision.admit).toBe(false);
    // Exactly at the floor admits.
    expect(
      decideRunHostAdmission({ ...roomy, memAvailableMb: 1_500 }, limits),
    ).toEqual({ admit: true });
  });

  test("reserves memory and host slots for pending launches", () => {
    expect(
      decideRunHostAdmission(
        { ...roomy, activeHosts: 2, pendingHosts: 2 },
        limits,
      ).admit,
    ).toBe(false);
    expect(
      decideRunHostAdmission(
        { ...roomy, memAvailableMb: 2_400, pendingHosts: 2 },
        limits,
      ).admit,
    ).toBe(false);
  });

  test("refuses under CPU pressure", () => {
    const decision = decideRunHostAdmission(
      { ...roomy, cpuSomeAvg10: 92.5 },
      limits,
    );
    expect(decision.admit).toBe(false);
  });

  test("missing signals fail open", () => {
    expect(
      decideRunHostAdmission(
        {
          memAvailableMb: null,
          cpuSomeAvg10: null,
          activeHosts: 0,
          pendingHosts: 0,
        },
        limits,
      ),
    ).toEqual({ admit: true });
  });
});

describe("proc parsing", () => {
  test("parses MemAvailable in MiB", async () => {
    const read = () =>
      "MemTotal:       128000000 kB\nMemAvailable:   116736000 kB\n";
    expect(await readMemAvailableMb(read)).toBe(114_000);
    expect(await readMemAvailableMb(() => "")).toBeNull();
  });

  test("parses CPU PSI some avg10", async () => {
    const read = () =>
      "some avg10=12.34 avg60=5.00 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
    expect(await readCpuSomeAvg10(read)).toBe(12.34);
    expect(await readCpuSomeAvg10(() => "")).toBeNull();
  });
});

describe("waitForRunHostAdmission", () => {
  test("admits immediately without sleeping when capacity exists", async () => {
    let slept = 0;
    const result = await waitForRunHostAdmission({
      sessionId: "s1",
      activeHosts: () => 1,
      limits,
      snapshot: (activeHosts) => ({ ...roomy, activeHosts }),
      sleep: async () => {
        slept += 1;
      },
    });
    expect(result).toBe("admitted");
    expect(slept).toBe(0);
  });

  test("waits with backoff until capacity appears", async () => {
    const sleeps: number[] = [];
    let mem = 1_000;
    const result = await waitForRunHostAdmission({
      sessionId: "s2",
      activeHosts: () => 1,
      limits,
      snapshot: (activeHosts, pendingHosts) => ({
        ...roomy,
        memAvailableMb: mem,
        activeHosts,
        pendingHosts,
      }),
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) mem = 8_000;
      },
      now: () => 0,
    });
    expect(result).toBe("admitted");
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  test("reserves admission before another caller can pass", async () => {
    const oneHostLimit = { ...limits, maxActiveHosts: 1 };
    let pendingHosts = 0;
    const first = await waitForRunHostAdmission({
      sessionId: "first",
      activeHosts: () => 0,
      pendingHosts: () => pendingHosts,
      onAdmit: () => {
        pendingHosts += 1;
      },
      limits: oneHostLimit,
      snapshot: (activeHosts, pending) => ({
        ...roomy,
        activeHosts,
        pendingHosts: pending,
      }),
    });
    expect(first).toBe("admitted");
    expect(pendingHosts).toBe(1);

    let slept = false;
    const second = await waitForRunHostAdmission({
      sessionId: "second",
      activeHosts: () => 0,
      pendingHosts: () => pendingHosts,
      onAdmit: () => {
        pendingHosts += 1;
      },
      limits: oneHostLimit,
      snapshot: (activeHosts, pending) => ({
        ...roomy,
        activeHosts,
        pendingHosts: pending,
      }),
      sleep: async () => {
        slept = true;
        pendingHosts -= 1;
      },
      now: () => 0,
    });
    expect(second).toBe("admitted");
    expect(slept).toBe(true);
    expect(pendingHosts).toBe(1);
  });

  test("cancellation wins over waiting", async () => {
    let cancelled = false;
    const result = await waitForRunHostAdmission({
      sessionId: "s3",
      activeHosts: () => 4,
      shouldCancel: () => cancelled,
      limits,
      snapshot: (activeHosts) => ({ ...roomy, activeHosts }),
      sleep: async () => {
        cancelled = true;
      },
      now: () => 0,
    });
    expect(result).toBe("cancelled");
  });

  test("fails closed with a distinct error after the timeout", async () => {
    let clock = 0;
    await expect(
      waitForRunHostAdmission({
        sessionId: "s4",
        activeHosts: () => 4,
        limits,
        snapshot: (activeHosts) => ({ ...roomy, activeHosts }),
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      }),
    ).rejects.toBeInstanceOf(RunHostAdmissionError);
  });
});
