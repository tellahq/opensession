import { describe, expect, test } from "bun:test";
import {
  memoryNeedsReview,
  memorySourceLabel,
  memoryState,
  memorySummary,
} from "./memory-v2";

describe("memory v2 compatibility helpers", () => {
  test("keeps legacy entries readable", () => {
    const entry = {
      id: "old",
      text: "Legacy fact",
      by: "Alice",
      at: "2026-01-01T00:00:00Z",
    };
    expect(memorySummary(entry)).toBe("Legacy fact");
    expect(memoryState(entry)).toBe("active");
    expect(memorySourceLabel(entry)).toBe("Alice");
  });

  test("derives expiry and review state from lifecycle timestamps", () => {
    const entry = {
      id: "new",
      text: "Temporary fact",
      by: "session",
      at: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z",
      source: { type: "agent-verified" as const },
    };
    expect(memoryState(entry, Date.parse("2026-01-03T00:00:00Z"))).toBe(
      "expired",
    );
    expect(memoryNeedsReview(entry)).toBe(true);
  });
});
