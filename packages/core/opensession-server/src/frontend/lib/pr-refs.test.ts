import { describe, expect, test } from "bun:test";
import {
  osReviewText,
  refChipText,
  refLabel,
  refState,
  refTone,
  sessionPrTone,
  summarizePrSeries,
  worstPrRef,
  type SessionPrRef,
} from "./pr-refs";
import { sessionPrPresentation } from "./session-prs";

function ref(over: Partial<SessionPrRef> = {}): SessionPrRef {
  return {
    repo: "tella-fusion",
    branch: "feature",
    source: "discovered",
    number: 72,
    state: "OPEN",
    ...over,
  };
}

describe("osReviewText", () => {
  test("puts the latest score directly in the compact review reading", () => {
    expect(
      osReviewText({
        verdict: "approve",
        confidence: 4,
        findings: 0,
        blocking: 0,
        stale: false,
        at: "2026-08-28T12:00:00Z",
      }),
    ).toBe("4/5 · approved");
  });

  test("keeps blocking and stale review context beside the score", () => {
    expect(
      osReviewText({
        verdict: "request_changes",
        confidence: 2,
        findings: 2,
        blocking: 1,
        stale: true,
        at: "2026-08-28T12:00:00Z",
      }),
    ).toBe("2/5 · changes requested · 1 blocking · stale");
  });
});

describe("refTone", () => {
  test("a terminal PR reads by its ending, not its checks", () => {
    expect(refTone(ref({ state: "MERGED" }))).toBe("purple");
    expect(refTone(ref({ state: "CLOSED" }))).toBe("muted");
    // Checks keep reporting after a merge; the ending still wins.
    expect(
      refTone(
        ref({
          state: "MERGED",
          checks: { total: 1, passed: 0, failed: 1, pending: 0 },
        }),
      ),
    ).toBe("purple");
  });

  test("open PRs surface the thing that needs attention first", () => {
    expect(
      refTone(ref({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } })),
    ).toBe("red");
    expect(refTone(ref({ reviewDecision: "CHANGES_REQUESTED" }))).toBe("red");
    expect(
      refTone(ref({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } })),
    ).toBe("yellow");
    expect(refTone(ref({ isDraft: true }))).toBe("muted");
    expect(refTone(ref())).toBe("green");
  });
});

// The only thing this adapter can get wrong is the renaming, and a wrong name
// reads as `undefined` rather than as an error: every PR would come back green.
// So the cases that must move are the ones that are not green.
describe("sessionPrTone", () => {
  test("reads a session's flat PR fields as the same four facts", () => {
    expect(sessionPrTone({ prState: "MERGED" })).toBe("purple");
    expect(sessionPrTone({ prReviewDecision: "CHANGES_REQUESTED" })).toBe(
      "red",
    );
    expect(
      sessionPrTone({
        prChecks: { total: 2, passed: 1, failed: 0, pending: 1 },
      }),
    ).toBe("yellow");
    expect(sessionPrTone({ prIsDraft: true })).toBe("muted");
    expect(sessionPrTone({ prState: "OPEN" })).toBe("green");
  });
});

describe("refState", () => {
  test("names the same state its tone claims", () => {
    expect(refState(ref({ state: "MERGED" }))).toBe("Merged");
    expect(refState(ref({ state: "CLOSED" }))).toBe("Closed");
    expect(
      refState(ref({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } })),
    ).toBe("Checks failed");
    expect(refState(ref({ reviewDecision: "CHANGES_REQUESTED" }))).toBe(
      "Changes requested",
    );
    expect(refState(ref({ isDraft: true }))).toBe("Draft");
    expect(refState(ref({ reviewDecision: "APPROVED" }))).toBe("Approved");
    expect(refState(ref())).toBe("Open");
  });

  test("counts pending checks instead of collapsing them to Open", () => {
    expect(
      refState(ref({ checks: { total: 3, passed: 2, failed: 0, pending: 1 } })),
    ).toBe("1 check pending");
    expect(
      refState(ref({ checks: { total: 5, passed: 2, failed: 0, pending: 3 } })),
    ).toBe("3 checks pending");
    // A running check outranks the draft flag, matching the primary headline.
    expect(
      refState(
        ref({
          isDraft: true,
          checks: { total: 2, passed: 0, failed: 0, pending: 2 },
        }),
      ),
    ).toBe("2 checks pending");
  });
});

describe("refChipText", () => {
  test("drops the repo hint inside the session's own repo", () => {
    expect(refChipText(ref(), "tella-fusion")).toBe("#72");
    expect(
      refChipText(ref({ repo: "tella-mac", number: 14 }), "tella-fusion"),
    ).toBe("tella-mac #14");
    // A session with no repo of its own (Slack/Linear) keeps every hint.
    expect(refChipText(ref())).toBe("#72");
  });

  test("shows a renamed repo under its display name", () => {
    expect(
      refChipText(ref({ repo: "opensession", number: 9 }), "tella-fusion"),
    ).toBe("opensession #9");
  });
});

describe("refLabel", () => {
  test("carries the detail the compact row drops", () => {
    expect(
      refLabel(
        ref({
          title: "Fix the uploader",
          checks: { total: 4, passed: 3, failed: 0, pending: 1 },
        }),
      ),
    ).toBe(
      "tella-fusion #72 (1 check pending) · Fix the uploader · 3/4 checks passed",
    );
  });

  test("omits checks a PR does not have", () => {
    expect(refLabel(ref({ title: "Fix the uploader" }))).toBe(
      "tella-fusion #72 (open) · Fix the uploader",
    );
  });
});

describe("worstPrRef", () => {
  test("nothing to pick from", () => {
    expect(worstPrRef([])).toBeUndefined();
  });

  test("the failing PR wins the single slot a phone bar has", () => {
    const green = ref({ repo: "tella-fusion", branch: "a" });
    const failing = ref({
      repo: "tella-mac",
      branch: "b",
      checks: { total: 2, passed: 1, failed: 1, pending: 0 },
    });
    const merged = ref({ repo: "tella-windows", branch: "c", state: "MERGED" });

    expect(worstPrRef([green, failing, merged])).toBe(failing);
    expect(worstPrRef([merged, green])).toBe(green);
  });
});

describe("summarizePrSeries", () => {
  test("no refs means no aggregate headline", () => {
    expect(summarizePrSeries([])).toBeNull();
  });

  test("a single open PR reads as one, in its own tone", () => {
    expect(
      summarizePrSeries([
        ref({ checks: { total: 2, passed: 1, failed: 0, pending: 1 } }),
      ]),
    ).toEqual({ tone: "yellow", label: "1 PR" });
  });

  test("several open PRs read as the series, in its worst tone", () => {
    expect(
      summarizePrSeries([
        ref({ repo: "tella-fusion", branch: "a" }),
        ref({
          repo: "tella-mac",
          branch: "b",
          checks: { total: 2, passed: 1, failed: 1, pending: 0 },
        }),
        ref({ repo: "tella-windows", branch: "c", isDraft: true }),
      ]),
    ).toEqual({ tone: "red", label: "3 PRs" });
  });

  test("a part-landed series says how much is still open", () => {
    expect(
      summarizePrSeries([
        ref({ repo: "tella-fusion", branch: "a", state: "MERGED" }),
        ref({ repo: "tella-mac", branch: "b" }),
        ref({ repo: "tella-windows", branch: "c" }),
      ]),
    ).toEqual({ tone: "green", label: "3 PRs · 2 open" });
  });

  test("a landed series says so", () => {
    const merged = (repo: string, branch: string) =>
      ref({ repo, branch, state: "MERGED" });
    expect(
      summarizePrSeries([
        merged("tella-fusion", "a"),
        merged("tella-mac", "b"),
      ]),
    ).toEqual({ tone: "purple", label: "All 2 merged" });
  });

  test("terminal-but-not-all-merged does not claim the series landed", () => {
    expect(
      summarizePrSeries([
        ref({ repo: "tella-fusion", branch: "a", state: "MERGED" }),
        ref({ repo: "tella-mac", branch: "b", state: "CLOSED" }),
      ]),
    ).toEqual({ tone: "purple", label: "1 of 2 merged" });
    expect(
      summarizePrSeries([
        ref({ repo: "tella-fusion", branch: "a", state: "CLOSED" }),
        ref({ repo: "tella-mac", branch: "b", state: "CLOSED" }),
      ]),
    ).toEqual({ tone: "muted", label: "All 2 closed" });
  });
});

/**
 * The strip feeds `sessionPrPresentation().additional` to `summarizePrSeries`,
 * so which PRs count as a series is decided upstream. The two are unit-tested
 * apart; this pins the seam between them — a sole linked PR is promoted to the
 * normal single-PR surface, and must not come back as a one-item "1 PR" series
 * headline, which is the surface it was promoted out of.
 */
describe("series headline over sessionPrPresentation", () => {
  test("a promoted sole PR leaves no series behind", () => {
    const linked = ref({ source: "linked", branch: "linked-branch" });
    const { primary, additional } = sessionPrPresentation([linked]);

    expect(primary).toBe(linked);
    expect(summarizePrSeries(additional)).toBeNull();
  });

  test("PRs beside a primary one are the series, the primary one is not", () => {
    const primaryRef = ref({ source: "primary", branch: "main-work" });
    const sibling = ref({
      source: "discovered",
      repo: "tella-mac",
      branch: "mac-work",
      checks: { total: 2, passed: 1, failed: 1, pending: 0 },
    });
    const { primary, additional } = sessionPrPresentation([
      primaryRef,
      sibling,
    ]);

    expect(primary).toBe(primaryRef);
    // The primary PR's own red checks are the strip's headline, not the
    // series' — only the sibling is summarized.
    expect(summarizePrSeries(additional)).toEqual({
      tone: "red",
      label: "1 PR",
    });
  });

  test("no primary at all keeps the whole set as the series", () => {
    const a = ref({ source: "linked", repo: "tella-mac", branch: "a" });
    const b = ref({ source: "discovered", repo: "tella-windows", branch: "b" });
    const { primary, additional } = sessionPrPresentation([a, b]);

    expect(primary).toBeUndefined();
    expect(summarizePrSeries(additional)).toEqual({
      tone: "green",
      label: "2 PRs",
    });
  });
});
