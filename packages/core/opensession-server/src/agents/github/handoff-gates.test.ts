import { describe, expect, test } from "bun:test";
import {
  handoffActive,
  handoffDecision,
  openFindingsNoticeNeeded,
  pickHandoffOwner,
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

describe("open findings notice gate", () => {
  test("a passing review with open findings notifies the owner", () => {
    expect(
      openFindingsNoticeNeeded(
        { findings: 1, blocking: 0, confidence: 5 },
        undefined,
      ),
    ).toBe(true);
  });

  test("a clean or unsatisfied review sends no notice", () => {
    expect(
      openFindingsNoticeNeeded(
        { findings: 0, blocking: 0, confidence: 5 },
        undefined,
      ),
    ).toBe(false);
    expect(
      openFindingsNoticeNeeded(
        { findings: 1, blocking: 1, confidence: 5 },
        undefined,
      ),
    ).toBe(false);
  });

  test("after fix rounds the settled message closes the loop instead", () => {
    expect(
      openFindingsNoticeNeeded(
        { findings: 1, blocking: 0, confidence: 5 },
        { rounds: 2 },
      ),
    ).toBe(false);
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

describe("handoff owner", () => {
  const live = (s: { id: string; archived?: boolean }) => !s.archived;

  test("the PR footer's session wins over branch owners", () => {
    expect(
      pickHandoffOwner({ id: "footer" }, live, [{ id: "branch" }])?.id,
    ).toBe("footer");
  });

  test("the footer's session is enough when no session has the branch", () => {
    expect(pickHandoffOwner({ id: "footer" }, live, [])?.id).toBe("footer");
  });

  test("an archived footer session falls back to the branch owner", () => {
    expect(
      pickHandoffOwner({ id: "footer", archived: true }, live, [
        { id: "branch" },
      ])?.id,
    ).toBe("branch");
  });

  test("no footer and no branch owner means no owner", () => {
    expect(pickHandoffOwner(undefined, live, [])).toBeUndefined();
  });
});
