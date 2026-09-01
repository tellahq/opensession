import { describe, expect, it } from "bun:test";
import {
  similarity,
  suppressDecision,
  isNegativeSignal,
  isPositiveSignal,
  type FeedbackRecord,
} from "./feedback-gates";

function rec(overrides: Partial<FeedbackRecord>): FeedbackRecord {
  return {
    pr: 1,
    path: "a.ts",
    severity: "P3",
    title: "Consider extracting this into a helper function",
    text: "This block repeats logic; consider extracting a shared helper function for readability.",
    postedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

describe("feedback signals", () => {
  it("downvotes and silent ignores are negative", () => {
    expect(isNegativeSignal(rec({ minus: 1 }))).toBe(true);
    expect(isNegativeSignal(rec({ outcome: "ignored" }))).toBe(true);
    expect(isNegativeSignal(rec({ outcome: "ignored", plus: 1 }))).toBe(false);
  });

  it("upvotes and addressed outcomes are positive", () => {
    expect(isPositiveSignal(rec({ plus: 1 }))).toBe(true);
    expect(isPositiveSignal(rec({ outcome: "addressed" }))).toBe(true);
    expect(isPositiveSignal(rec({ outcome: "addressed", minus: 2 }))).toBe(
      false,
    );
  });
});

describe("similarity", () => {
  it("scores near-identical nits high and unrelated text low", () => {
    const a = "Consider extracting this into a helper function for readability";
    const b = "Consider extracting the repeated logic into a helper function";
    expect(similarity(a, b)).toBeGreaterThan(0.5);
    expect(
      similarity(
        a,
        "Race condition: the lock is released before the write lands",
      ),
    ).toBeLessThan(0.2);
  });
});

describe("suppressDecision", () => {
  const nitCluster = [
    rec({ outcome: "ignored" }),
    rec({
      pr: 2,
      minus: 1,
      text: "Consider extracting this repeated block into a helper function.",
    }),
    rec({
      pr: 3,
      outcome: "ignored",
      text: "Consider extracting the duplicated logic into a shared helper function.",
    }),
  ];

  it("suppresses a candidate matching 3+ negative records", () => {
    expect(
      suppressDecision(
        "Consider extracting this duplicated logic into a helper function",
        nitCluster,
      ),
    ).toBe("suppress");
  });

  it("keeps candidates without enough similar negatives", () => {
    expect(
      suppressDecision(
        "Off-by-one in the pagination cursor bounds check",
        nitCluster,
      ),
    ).toBe("keep");
  });

  it("positive history force-keeps even with negatives present", () => {
    const mixed = [
      ...nitCluster,
      rec({ pr: 4, plus: 2 }),
      rec({ pr: 5, outcome: "addressed" }),
      rec({ pr: 6, plus: 1 }),
    ];
    expect(
      suppressDecision(
        "Consider extracting this duplicated logic into a helper function",
        mixed,
      ),
    ).toBe("keep");
  });
});
