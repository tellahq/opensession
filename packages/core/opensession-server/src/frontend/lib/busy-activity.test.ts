import { describe, expect, test } from "bun:test";
import { busyActivityStatus } from "./busy-activity";

describe("busyActivityStatus", () => {
  test("starts with a quiet working label", () => {
    expect(busyActivityStatus(9_999)).toEqual({
      label: "Working",
      elapsed: null,
    });
  });

  test("acknowledges a visible pause after ten seconds", () => {
    expect(busyActivityStatus(12_000)).toEqual({
      label: "Still working",
      elapsed: "12s",
    });
  });

  test("keeps long-running work neutral", () => {
    expect(busyActivityStatus(45_000)).toEqual({
      label: "Still working",
      elapsed: "45s",
    });
    expect(busyActivityStatus(90_000)).toEqual({
      label: "Still working",
      elapsed: "1m",
    });
  });

  test("clamps clock skew", () => {
    expect(busyActivityStatus(-1)).toEqual({
      label: "Working",
      elapsed: null,
    });
  });

  test("names the phase the engine reported", () => {
    expect(busyActivityStatus(2_000, { kind: "waiting" }).label).toBe(
      "Waiting for the model",
    );
    expect(busyActivityStatus(2_000, { kind: "compacting" }).label).toBe(
      "Compacting the conversation",
    );
    expect(
      busyActivityStatus(2_000, { kind: "preparing", toolName: "edit" }).label,
    ).toBe("Writing an edit");
  });

  test("describes a running tool by family, and several by count", () => {
    expect(
      busyActivityStatus(0, { kind: "tool", toolName: "bash", count: 1 }).label,
    ).toBe("Running a command");
    expect(
      busyActivityStatus(0, { kind: "tool", toolName: "mcp_call", count: 1 })
        .label,
    ).toBe("Calling a tool");
    expect(
      busyActivityStatus(0, { kind: "tool", toolName: "bash", count: 3 }).label,
    ).toBe("Running 3 tools");
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
      elapsed: null,
    });
    expect(busyActivityStatus(0, retrying, 10_500).label).toBe("Retrying");
  });

  test("keeps the elapsed time beside a named phase", () => {
    expect(busyActivityStatus(45_000, { kind: "thinking" })).toEqual({
      label: "Thinking",
      elapsed: "45s",
    });
  });

  test("falls back to neutral wording for a phase it does not know", () => {
    // SAFETY: a newer server may report a phase this client's RunActivity
    // union does not list; the cast stands in for that wire value.
    const unknown = { kind: "future" } as never;
    expect(busyActivityStatus(1_000, unknown).label).toBe("Working");
  });
});
