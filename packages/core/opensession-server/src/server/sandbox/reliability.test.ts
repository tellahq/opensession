import { describe, expect, test } from "bun:test";
import {
  ensureSandboxWithTransientRetry,
  isTransientSandboxStartError,
} from "./reliability";

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
