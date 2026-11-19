import { describe, expect, test } from "bun:test";
import { busyActivityStatus } from "./busy-activity";

describe("busyActivityStatus", () => {
  test("counts from the first second, with no words of its own", () => {
    expect(busyActivityStatus(0)).toEqual({
      label: null,
      spoken: "Working",
      elapsed: "0s",
    });
    expect(busyActivityStatus(999).elapsed).toBe("0s");
    expect(busyActivityStatus(4_400).elapsed).toBe("4s");
  });

  test("keeps the seconds past a minute, then drops them past an hour", () => {
    expect(busyActivityStatus(59_999).elapsed).toBe("59s");
    expect(busyActivityStatus(65_000).elapsed).toBe("1m 05s");
    expect(busyActivityStatus(15 * 60_000).elapsed).toBe("15m 00s");
    expect(busyActivityStatus(62 * 60_000 + 30_000).elapsed).toBe("1h 02m");
  });

  test("clamps clock skew", () => {
    expect(busyActivityStatus(-1).elapsed).toBe("0s");
  });

  test("names a tool, a thought or a wait only for screen readers", () => {
    for (const activity of [
      { kind: "waiting" as const },
      { kind: "thinking" as const },
      { kind: "tool" as const, toolName: "bash", count: 1 },
    ]) {
      expect(busyActivityStatus(2_000, activity).label).toBeNull();
    }
    expect(busyActivityStatus(2_000, { kind: "waiting" }).spoken).toBe(
      "Waiting for the model",
    );
  });

  test("puts words beside the dot for a compaction", () => {
    expect(busyActivityStatus(2_000, { kind: "compacting" })).toEqual({
      label: "Compacting the conversation",
      spoken: "Compacting the conversation",
      elapsed: "2s",
    });
  });

  test("names the phase the engine reported", () => {
    expect(
      busyActivityStatus(2_000, { kind: "preparing", toolName: "edit" }).spoken,
    ).toBe("Writing an edit");
  });

  test("describes a running tool by family, and several by count", () => {
    const spoken = (toolName: string, count: number) =>
      busyActivityStatus(0, { kind: "tool", toolName, count }).spoken;
    expect(spoken("bash", 1)).toBe("Running a command");
    expect(spoken("mcp_call", 1)).toBe("Calling a tool");
    expect(spoken("bash", 3)).toBe("Running 3 tools");
  });

  test("counts a retry down, then stops promising a time", () => {
    const retrying = {
      kind: "retrying" as const,
      attempt: 2,
      maxAttempts: 3,
      retryAt: 10_000,
    };
    expect(busyActivityStatus(0, retrying, 6_200)).toEqual({
      label: "Retrying in 4s",
      detail: "attempt 2 of 3",
      spoken: "Retrying in 4s",
      elapsed: "0s",
    });
    expect(busyActivityStatus(0, retrying, 10_500).label).toBe("Retrying");
  });

  test("falls back to neutral wording for a phase it does not know", () => {
    // SAFETY: a newer server may report a phase this client's RunActivity
    // union does not list; the cast stands in for that wire value.
    const unknown = { kind: "future" } as never;
    expect(busyActivityStatus(1_000, unknown)).toEqual({
      label: null,
      spoken: "Working",
      elapsed: "1s",
    });
  });
});
