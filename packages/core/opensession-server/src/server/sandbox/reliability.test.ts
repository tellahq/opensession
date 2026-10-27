import { describe, expect, test } from "bun:test";
import {
  capacityRetryDelayMs,
  ensureSandboxWaitingForCapacity,
  ensureSandboxWithTransientRetry,
  isSandboxCapacityError,
  isTransientSandboxStartError,
  SandboxCapacityError,
} from "./reliability";
import type { Sandbox, SandboxProvider } from "./provider";

describe("sandbox start reliability", () => {
  test("recognizes bounded transport and service failures", () => {
    expect(
      isTransientSandboxStartError(
        Object.assign(new Error("fetch failed"), {
          cause: { code: "ECONNRESET" },
        }),
      ),
    ).toBe(true);
    expect(
      isTransientSandboxStartError(
        Object.assign(new Error("provider unavailable"), { status: 503 }),
      ),
    ).toBe(true);
    expect(isTransientSandboxStartError(new Error("request timed out"))).toBe(
      true,
    );
  });

  test("does not retry credential, quota, rate-limit, or configuration failures", () => {
    expect(
      isTransientSandboxStartError(
        Object.assign(new Error("credential rejected with 503"), {
          status: 503,
        }),
      ),
    ).toBe(false);
    expect(isTransientSandboxStartError(new Error("quota exceeded"))).toBe(
      false,
    );
    expect(
      isTransientSandboxStartError(
        Object.assign(
          new Error(
            "Rate limit hit: 150 box starts per day. Your plan allows 150/day.",
          ),
          { status: 429, code: "rate_limited" },
        ),
      ),
    ).toBe(false);
    expect(
      isTransientSandboxStartError(new Error("provider is not configured")),
    ).toBe(false);
  });

  test("retries ensure exactly once and never loops", async () => {
    let calls = 0;
    const provider = {
      ensure: async () => {
        calls += 1;
        if (calls === 1)
          throw Object.assign(new Error("network error"), {
            code: "ECONNRESET",
          });
        return { id: "sandbox-1", provider: "modal", workspace: "/workspace" };
      },
    } as any;
    const result = await ensureSandboxWithTransientRetry(
      provider,
      {
        sessionId: "session-1",
        repo: "opensession",
        mode: "code",
        cwd: "/tmp",
      },
      { delayMs: 0 },
    );
    expect(result.id).toBe("sandbox-1");
    expect(calls).toBe(2);

    calls = 0;
    const alwaysDown = {
      ensure: async () => {
        calls += 1;
        throw Object.assign(new Error("network error"), { code: "ECONNRESET" });
      },
    } as any;
    await expect(
      ensureSandboxWithTransientRetry(
        alwaysDown,
        {
          sessionId: "session-2",
          repo: "opensession",
          mode: "code",
          cwd: "/tmp",
        },
        { delayMs: 0 },
      ),
    ).rejects.toThrow("network error");
    expect(calls).toBe(2);
  });
});

describe("waiting for capacity", () => {
  const sandbox = { id: "vm-1" } as unknown as Sandbox;
  function providerFailing(times: number, error: () => Error) {
    let calls = 0;
    const provider = {
      id: "tart",
      async ensure() {
        calls += 1;
        if (calls <= times) throw error();
        return sandbox;
      },
    } as unknown as SandboxProvider;
    return { provider, calls: () => calls };
  }

  test("a full provider is waited out instead of failing the start", async () => {
    const { provider, calls } = providerFailing(
      2,
      () => new SandboxCapacityError("Every Mac host is full"),
    );
    const waits: number[] = [];
    const notes: string[] = [];
    const result = await ensureSandboxWaitingForCapacity(
      provider,
      { sessionId: "s" },
      {
        sleep: async (ms) => void waits.push(ms),
        onWaiting: (error) => notes.push(String(error)),
      },
    );
    expect(result).toBe(sandbox);
    expect(calls()).toBe(3);
    expect(waits).toEqual([15_000, 30_000]);
    expect(notes).toHaveLength(2);
  });

  test("gives up at the deadline, and never waits on other failures", async () => {
    const full = providerFailing(
      99,
      () => new SandboxCapacityError("Every Mac host is full"),
    );
    await expect(
      ensureSandboxWaitingForCapacity(
        full.provider,
        { sessionId: "s" },
        { capacityWaitMs: 0, sleep: async () => {} },
      ),
    ).rejects.toThrow("Every Mac host is full");
    const broken = providerFailing(99, () => new Error("invalid API key"));
    await expect(
      ensureSandboxWaitingForCapacity(
        broken.provider,
        { sessionId: "s" },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("invalid API key");
    expect(broken.calls()).toBe(1);
  });

  test("recognizes capacity errors by class or code and backs off to a minute", () => {
    expect(isSandboxCapacityError(new SandboxCapacityError("full"))).toBe(true);
    expect(
      isSandboxCapacityError(
        Object.assign(new Error("x"), { code: "SANDBOX_CAPACITY" }),
      ),
    ).toBe(true);
    expect(isSandboxCapacityError(new Error("full"))).toBe(false);
    expect(capacityRetryDelayMs(0)).toBe(15_000);
    expect(capacityRetryDelayMs(5)).toBe(60_000);
  });
});
