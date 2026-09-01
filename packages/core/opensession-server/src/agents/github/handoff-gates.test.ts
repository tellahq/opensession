import { describe, expect, test } from "bun:test";
import {
  handoffActive,
  handoffDecision,
  reviewSatisfied,
} from "./handoff-gates";

describe("review satisfaction gate", () => {
  test("clean review is satisfied", () => {
    expect(reviewSatisfied({ findings: 0, blocking: 0 })).toBe(true);
  });

  test("open findings need confidence >= 4", () => {
    expect(reviewSatisfied({ findings: 2, blocking: 0, confidence: 4 })).toBe(
      true,
    );
    expect(reviewSatisfied({ findings: 2, blocking: 0, confidence: 3 })).toBe(
      false,
    );
    expect(reviewSatisfied({ findings: 2, blocking: 0 })).toBe(false);
  });

  test("blocking findings are never satisfied, whatever the confidence", () => {
    expect(reviewSatisfied({ findings: 1, blocking: 1, confidence: 5 })).toBe(
      false,
    );
  });
});

describe("handoff round decision", () => {
  test("first unsatisfied review delivers", () => {
    expect(handoffDecision(undefined, "abc", 3)).toBe("deliver");
  });

  test("same SHA never delivers twice", () => {
    expect(handoffDecision({ rounds: 1, lastSha: "abc" }, "abc", 3)).toBe(
      "duplicate",
    );
    expect(handoffDecision({ rounds: 1, lastSha: "abc" }, "def", 3)).toBe(
      "deliver",
    );
  });

  test("round cap stops delivery, and dedup wins over the cap", () => {
    expect(handoffDecision({ rounds: 3, lastSha: "abc" }, "def", 3)).toBe(
      "capped",
    );
    expect(handoffDecision({ rounds: 3, lastSha: "abc" }, "abc", 3)).toBe(
      "duplicate",
    );
  });
});

describe("handoff active window", () => {
  const h = { rounds: 1, deliveredAt: new Date(1_000_000).toISOString() };

  test("active within the TTL, inactive after", () => {
    expect(handoffActive(h, 1_000_000 + 60_000, 3_600_000)).toBe(true);
    expect(handoffActive(h, 1_000_000 + 3_600_000, 3_600_000)).toBe(false);
  });

  test("no state, zero rounds, or missing/garbage timestamp is inactive", () => {
    expect(handoffActive(undefined, 0, 3_600_000)).toBe(false);
    expect(
      handoffActive(
        { rounds: 0, deliveredAt: h.deliveredAt },
        1_000_000,
        3_600_000,
      ),
    ).toBe(false);
    expect(handoffActive({ rounds: 1 }, 1_000_000, 3_600_000)).toBe(false);
    expect(
      handoffActive(
        { rounds: 1, deliveredAt: "not-a-date" },
        1_000_000,
        3_600_000,
      ),
    ).toBe(false);
  });
});
