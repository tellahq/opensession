import { describe, expect, test } from "bun:test";
import {
  distillDue,
  validateDistilledRules,
  type LearnedRulesFile,
} from "./learned-rules-gates";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-07-28T12:00:00Z");

function file(overrides: Partial<LearnedRulesFile> = {}): LearnedRulesFile {
  return {
    updatedAt: new Date(NOW - 24 * HOUR).toISOString(),
    signalCount: 20,
    rules: [],
    ...overrides,
  };
}

describe("validateDistilledRules", () => {
  test("accepts {rules:[...]} and bare arrays, normalizes kind and whitespace", () => {
    const rules = validateDistilledRules({
      rules: [
        {
          text: "Don't flag  missing null checks the type system already rules out.",
          kind: "bogus",
        },
        {
          text: "Check new endpoints for missing org scoping — you have missed IDOR twice.",
          kind: "focus",
          evidence: "2 missed bugs",
        },
      ],
    });
    expect(rules).toHaveLength(2);
    expect(rules![0].kind).toBe("calibration");
    expect(rules![0].text).not.toContain("  ");
    expect(rules![1]).toMatchObject({
      kind: "focus",
      evidence: "2 missed bugs",
    });
  });

  test("drops junk entries and caps length and count", () => {
    const rules = validateDistilledRules([
      { text: "too short" },
      { text: "x".repeat(400) },
      "not an object",
      ...Array.from({ length: 20 }, (_, i) => ({
        text: `A perfectly reasonable calibration rule number ${i}.`,
      })),
    ]);
    expect(rules).toHaveLength(10);
    expect(
      rules!.every((r) => r.text.length >= 20 && r.text.length <= 300),
    ).toBe(true);
  });

  test("null on unusable output (caller keeps previous rules)", () => {
    expect(validateDistilledRules("prose, not json")).toBeNull();
    expect(validateDistilledRules({ notRules: [] })).toBeNull();
  });
});

describe("distillDue", () => {
  test("first distill waits for a real corpus", () => {
    expect(distillDue(null, 14, NOW)).toBe(false);
    expect(distillDue(null, 15, NOW)).toBe(true);
  });

  test("re-distill needs both new signals and elapsed time", () => {
    expect(distillDue(file(), 24, NOW)).toBe(false); // only 4 new signals
    expect(distillDue(file(), 25, NOW)).toBe(true); // 5 new, 24h old
    expect(
      distillDue(
        file({ updatedAt: new Date(NOW - HOUR).toISOString() }),
        40,
        NOW,
      ),
    ).toBe(false); // too recent
  });

  test("a corrupt timestamp never blocks distilling forever", () => {
    expect(distillDue(file({ updatedAt: "garbage" }), 25, NOW)).toBe(true);
  });
});
