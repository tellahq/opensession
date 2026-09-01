import { describe, expect, test } from "bun:test";
import { elapsedSince, formatDuration } from "./time";

describe("formatDuration", () => {
  test("nothing under a second", () => {
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(400)).toBeNull();
    expect(formatDuration(NaN)).toBeNull();
  });

  test("seconds up to the first minute", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(59_400)).toBe("59s");
  });

  test("past a minute the seconds go", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(72_000)).toBe("1m");
    expect(formatDuration(119_000)).toBe("1m");
    expect(formatDuration(12 * 60_000 + 44_000)).toBe("12m");
    expect(formatDuration(59 * 60_000 + 59_000)).toBe("59m");
  });

  test("hours keep their minutes, and drop them when there are none", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_600_000 + 4 * 60_000 + 22_000)).toBe("1h 4m");
    expect(formatDuration(2 * 3_600_000 + 59 * 60_000)).toBe("2h 59m");
  });
});

describe("elapsedSince", () => {
  test("reads 0s at the start rather than nothing", () => {
    expect(elapsedSince(1_000, 1_000)).toBe("0s");
    expect(elapsedSince(2_000, 1_000)).toBe("0s"); // clock skew, never negative
  });

  test("counts up in formatDuration's units", () => {
    expect(elapsedSince(0, 7_000)).toBe("7s");
    expect(elapsedSince(0, 90_000)).toBe("1m");
  });
});
