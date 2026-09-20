import { describe, expect, it } from "bun:test";
import {
  applyReviewRules,
  capPromptRules,
  diffFilePaths,
  MAX_PROMPT_LENGTH,
  MAX_PROMPT_RULES,
  matchingPromptRules,
  normalizeReviewRuleGroups,
  normalizeReviewRules,
  preflightSkipRule,
  reviewRulesSection,
  ruleKey,
  ruleMatches,
  ruleNeedsModelResult,
  ruleScoreSuffixes,
  type PromptRuleOutcome,
  type ReviewRule,
  type ReviewRuleContext,
} from "./review-rules";

const marketing: ReviewRule = {
  name: "marketing-only",
  when: { allFilesMatch: ["apps/marketing/**", "**/*.mdx"] },
  then: {
    confidence: 5,
    verdict: "approve",
    risk: "low",
    note: "Marketing-only change",
  },
};

const migration: ReviewRule = {
  name: "migration-needs-human",
  when: { anyFileMatches: ["**/migrations/**"] },
  then: { maxConfidence: 3, minRisk: "medium" },
};

function ctx(overrides: Partial<ReviewRuleContext> = {}): ReviewRuleContext {
  return {
    files: ["apps/marketing/pages/pricing.tsx", "content/blog/launch.mdx"],
    additions: 40,
    deletions: 10,
    labels: [],
    baseBranch: "main",
    verdict: "comment",
    confidence: 3,
    risk: "medium",
    ...overrides,
  };
}

describe("normalizeReviewRules", () => {
  it("returns no rules for a missing or non-array value", () => {
    expect(normalizeReviewRules(undefined)).toEqual({
      rules: [],
      rejected: [],
    });
    expect(normalizeReviewRules({ name: "x" })).toEqual({
      rules: [],
      rejected: [],
    });
  });

  it("keeps valid rules and drops malformed ones by name or position", () => {
    const { rules, rejected } = normalizeReviewRules([
      {
        name: "marketing-only",
        when: { allFilesMatch: ["apps/marketing/**"] },
        then: { confidence: 5, verdict: "APPROVE", note: "  Marketing  " },
      },
      { name: "no-when", then: { confidence: 5 } },
      { name: "no-then", when: { labels: ["docs"] } },
      { name: "empty-when", when: {}, then: { confidence: 5 } },
      {
        name: "bad-values-only",
        when: { verdict: "maybe" },
        then: { risk: "x" },
      },
      "garbage",
      {
        name: "marketing-only",
        when: { labels: ["dup"] },
        then: { confidence: 1 },
      },
    ]);
    expect(rules).toEqual([
      {
        name: "marketing-only",
        when: { allFilesMatch: ["apps/marketing/**"] },
        then: { confidence: 5, verdict: "approve", note: "Marketing" },
      },
    ]);
    expect(rejected).toEqual([
      "no-when",
      "no-then",
      "empty-when",
      "bad-values-only",
      "#6",
      "marketing-only",
    ]);
  });

  it("accepts scalars for list conditions and clamps scores", () => {
    const { rules } = normalizeReviewRules([
      {
        name: "release",
        when: { baseBranch: "release/*", labels: "hotfix", verdict: "approve" },
        then: { confidence: 9, minConfidence: 0.4, confidenceDelta: -1.4 },
      },
    ]);
    expect(rules[0].when).toEqual({
      baseBranch: ["release/*"],
      labels: ["hotfix"],
      verdict: ["approve"],
    });
    expect(rules[0].then).toEqual({
      confidence: 5,
      minConfidence: 1,
      confidenceDelta: -1,
    });
  });

  it("drops a zero delta, a false skip, and a blank note", () => {
    const { rules, rejected } = normalizeReviewRules([
      {
        name: "noop",
        when: { maxFiles: 3 },
        then: { confidenceDelta: 0, skipReview: false, note: "   " },
      },
    ]);
    expect(rules).toEqual([]);
    expect(rejected).toEqual(["noop"]);
  });
});

describe("independent rule results", () => {
  const policy: ReviewRule = {
    name: "Marketing policy",
    when: { allFilesMatch: ["apps/marketing/**", "content/**"] },
    then: {
      result: { verdict: "approve" },
      note: "Marketing-only change",
    },
  };

  it("normalizes standalone verdicts and scores without adding overrides", () => {
    const { rules, rejected } = normalizeReviewRules([
      policy,
      {
        name: "Score",
        when: { maxFiles: 5 },
        then: { result: { score: 9, verdict: "COMMENT" } },
      },
    ]);
    expect(rejected).toEqual([]);
    expect(rules).toEqual([
      policy,
      {
        name: "Score",
        when: { maxFiles: 5 },
        then: { result: { score: 5, verdict: "comment" } },
      },
    ]);
  });

  it("rejects malformed result-only rules", () => {
    for (const result of [
      null,
      "approve",
      {},
      { verdict: "yes" },
      { score: "5" },
      { score: NaN },
    ]) {
      expect(
        normalizeReviewRules([
          { name: "Invalid", when: { maxFiles: 5 }, then: { result } },
        ]),
      ).toEqual({ rules: [], rejected: ["Invalid"] });
    }
  });

  it("preserves a request-changes model result even when the policy approves", () => {
    const context = ctx({
      verdict: "request_changes",
      confidence: 1,
      risk: "high",
    });
    const before = structuredClone(context);
    const evaluation = applyReviewRules([policy], context);
    expect(evaluation.original).toEqual({
      verdict: "request_changes",
      confidence: 1,
      risk: "high",
    });
    expect(evaluation.final).toEqual(evaluation.original);
    expect(evaluation.changed).toBe(false);
    expect(context).toEqual(before);
    expect(evaluation.applied).toEqual([
      {
        name: "Marketing policy",
        changes: [],
        result: { verdict: "approve" },
        note: "Marketing-only change",
      },
    ]);
    expect(ruleScoreSuffixes(evaluation)).toEqual({
      verdict: "",
      confidence: "",
      risk: "",
    });
    expect(preflightSkipRule([policy], context)).toBeNull();
    expect(reviewRulesSection(evaluation)).toBe(
      "\n\n📏 **Custom rule results**\nIndependent policy results; not the AI verdict or merge approval.\n- **Marketing policy**: approved · Marketing-only change",
    );
  });

  it("keeps multiple matching results separate and renders score-only results", () => {
    const scoreOnly: ReviewRule = {
      name: "Small change",
      when: { maxFiles: 5 },
      then: { result: { score: 4 } },
    };
    const dissent: ReviewRule = {
      name: "Needs attention",
      when: { minFiles: 1 },
      then: { result: { verdict: "request_changes", score: 2 } },
    };
    const evaluation = applyReviewRules([policy, scoreOnly, dissent], ctx());
    expect(evaluation.final).toEqual(evaluation.original);
    expect(evaluation.changed).toBe(false);
    expect(evaluation.applied.map((r) => [r.name, r.result])).toEqual([
      ["Marketing policy", { verdict: "approve" }],
      ["Small change", { score: 4 }],
      ["Needs attention", { verdict: "request_changes", score: 2 }],
    ]);
    expect(reviewRulesSection(evaluation)).toContain("- **Small change**: 4/5");
    expect(reviewRulesSection(evaluation)).toContain(
      "- **Needs attention**: changes requested · 2/5",
    );
  });

  it("does not report approval for mixed or empty diffs", () => {
    for (const files of [[], ["apps/marketing/page.tsx", "src/server.ts"]]) {
      const evaluation = applyReviewRules([policy], ctx({ files }));
      expect(evaluation.applied).toEqual([]);
      expect(reviewRulesSection(evaluation)).toBe("");
    }
  });

  it("keeps explicit score overrides backward compatible alongside independent results", () => {
    const evaluation = applyReviewRules([policy, marketing], ctx());
    expect(evaluation.final).toEqual({
      verdict: "approve",
      confidence: 5,
      risk: "low",
    });
    expect(evaluation.applied[0].result).toEqual({ verdict: "approve" });
    expect(reviewRulesSection(evaluation)).toContain("**Custom rule results**");
    expect(reviewRulesSection(evaluation)).toContain("**Rules applied**");
    expect(ruleScoreSuffixes(evaluation).confidence).toBe(" (model 3/5)");
  });
});

describe("ruleMatches", () => {
  it("allFilesMatch needs every file to match and at least one file", () => {
    expect(ruleMatches(marketing, ctx())).toBe(true);
    expect(
      ruleMatches(
        marketing,
        ctx({ files: ["apps/marketing/x.tsx", "packages/api/server.ts"] }),
      ),
    ).toBe(false);
    expect(ruleMatches(marketing, ctx({ files: [] }))).toBe(false);
  });

  it("anyFileMatches and noFileMatches", () => {
    expect(
      ruleMatches(
        migration,
        ctx({ files: ["src/app.ts", "db/migrations/0042_add_index.sql"] }),
      ),
    ).toBe(true);
    expect(ruleMatches(migration, ctx({ files: ["src/app.ts"] }))).toBe(false);
    const noTests: ReviewRule = {
      name: "no-tests",
      when: { noFileMatches: ["**/*.test.ts"] },
      then: { maxConfidence: 4 },
    };
    expect(ruleMatches(noTests, ctx({ files: ["src/a.ts"] }))).toBe(true);
    expect(
      ruleMatches(noTests, ctx({ files: ["src/a.ts", "src/a.test.ts"] })),
    ).toBe(false);
  });

  it("size bounds count changed lines and files", () => {
    const small: ReviewRule = {
      name: "small",
      when: { maxChangedLines: 50, maxFiles: 2, minFiles: 1 },
      then: { minConfidence: 4 },
    };
    expect(ruleMatches(small, ctx())).toBe(true);
    expect(ruleMatches(small, ctx({ additions: 41 }))).toBe(false);
    expect(ruleMatches(small, ctx({ files: ["a.ts", "b.ts", "c.ts"] }))).toBe(
      false,
    );
    const big: ReviewRule = {
      name: "big",
      when: { minChangedLines: 500 },
      then: { maxConfidence: 3 },
    };
    expect(ruleMatches(big, ctx())).toBe(false);
    expect(ruleMatches(big, ctx({ additions: 500, deletions: 0 }))).toBe(true);
  });

  it("labels match any of, case-insensitively", () => {
    const docs: ReviewRule = {
      name: "docs",
      when: { labels: ["Docs", "chore"] },
      then: { confidence: 5 },
    };
    expect(ruleMatches(docs, ctx({ labels: ["bug", "docs"] }))).toBe(true);
    expect(ruleMatches(docs, ctx({ labels: ["bug"] }))).toBe(false);
    expect(ruleMatches(docs, ctx({ labels: [] }))).toBe(false);
  });

  it("base branch is a glob", () => {
    const release: ReviewRule = {
      name: "release",
      when: { baseBranch: ["release/*"] },
      then: { minRisk: "high" },
    };
    expect(ruleMatches(release, ctx({ baseBranch: "release/2026.09" }))).toBe(
      true,
    );
    expect(ruleMatches(release, ctx({ baseBranch: "main" }))).toBe(false);
  });

  it("model verdict, confidence and risk conditions", () => {
    const rule: ReviewRule = {
      name: "model",
      when: {
        verdict: ["approve", "comment"],
        minConfidence: 3,
        maxConfidence: 4,
        risk: ["low", "medium"],
      },
      then: { note: "ok" },
    };
    expect(ruleMatches(rule, ctx())).toBe(true);
    expect(ruleMatches(rule, ctx({ verdict: "request_changes" }))).toBe(false);
    expect(ruleMatches(rule, ctx({ confidence: 5 }))).toBe(false);
    expect(ruleMatches(rule, ctx({ confidence: undefined }))).toBe(false);
    expect(ruleMatches(rule, ctx({ risk: "high" }))).toBe(false);
    expect(ruleMatches(rule, ctx({ risk: undefined }))).toBe(false);
  });

  it("every condition in a rule must hold", () => {
    const rule: ReviewRule = {
      name: "both",
      when: { allFilesMatch: ["**/*.mdx"], labels: ["docs"] },
      then: { confidence: 5 },
    };
    expect(ruleMatches(rule, ctx({ files: ["a.mdx"], labels: ["docs"] }))).toBe(
      true,
    );
    expect(ruleMatches(rule, ctx({ files: ["a.mdx"], labels: [] }))).toBe(
      false,
    );
  });
});

describe("applyReviewRules", () => {
  it("overrides the model's scores and keeps the originals", () => {
    const result = applyReviewRules([marketing, migration], ctx());
    expect(result.original).toEqual({
      verdict: "comment",
      confidence: 3,
      risk: "medium",
    });
    expect(result.final).toEqual({
      verdict: "approve",
      confidence: 5,
      risk: "low",
    });
    expect(result.changed).toBe(true);
    expect(result.applied).toEqual([
      {
        name: "marketing-only",
        changes: [
          "quality 3 → 5",
          "verdict comment → approve",
          "risk medium → low",
        ],
        note: "Marketing-only change",
      },
    ]);
  });

  it("leaves everything alone when nothing matches", () => {
    const result = applyReviewRules(
      [marketing, migration],
      ctx({ files: ["src/app.ts"] }),
    );
    expect(result.changed).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.final).toEqual(result.original);
  });

  it("adjusts confidence with deltas, floors and caps, clamped to 1-5", () => {
    const rules: ReviewRule[] = [
      {
        name: "nudge-up",
        when: { labels: ["trusted"] },
        then: { confidenceDelta: 3 },
      },
      {
        name: "floor",
        when: { labels: ["floor"] },
        then: { minConfidence: 4 },
      },
      { name: "cap", when: { labels: ["cap"] }, then: { maxConfidence: 2 } },
    ];
    expect(
      applyReviewRules(rules, ctx({ labels: ["trusted"], confidence: 3 })).final
        .confidence,
    ).toBe(5);
    expect(
      applyReviewRules(rules, ctx({ labels: ["floor"], confidence: 2 })).final
        .confidence,
    ).toBe(4);
    expect(
      applyReviewRules(rules, ctx({ labels: ["floor"], confidence: 5 })).final
        .confidence,
    ).toBe(5);
    expect(
      applyReviewRules(rules, ctx({ labels: ["cap"], confidence: 4 })).final
        .confidence,
    ).toBe(2);
    // A delta with no model score has nothing to adjust; a floor still applies.
    expect(
      applyReviewRules(
        rules,
        ctx({ labels: ["trusted"], confidence: undefined }),
      ).final.confidence,
    ).toBeUndefined();
    expect(
      applyReviewRules(rules, ctx({ labels: ["floor"], confidence: undefined }))
        .final.confidence,
    ).toBe(4);
  });

  it("raises and lowers risk with minRisk and maxRisk", () => {
    expect(
      applyReviewRules(
        [migration],
        ctx({ files: ["db/migrations/1.sql"], risk: "low", confidence: 5 }),
      ).final,
    ).toEqual({ verdict: "comment", confidence: 3, risk: "medium" });
    expect(
      applyReviewRules(
        [migration],
        ctx({ files: ["db/migrations/1.sql"], risk: "high", confidence: 2 }),
      ).final,
    ).toEqual({ verdict: "comment", confidence: 2, risk: "high" });
    const cap: ReviewRule = {
      name: "ui-only",
      when: { allFilesMatch: ["**/*.css"] },
      then: { maxRisk: "low" },
    };
    expect(
      applyReviewRules([cap], ctx({ files: ["a.css"], risk: "high" })).final
        .risk,
    ).toBe("low");
    expect(
      applyReviewRules([cap], ctx({ files: ["a.css"], risk: undefined })).final
        .risk,
    ).toBeUndefined();
    expect(
      applyReviewRules(
        [{ ...migration, then: { minRisk: "medium" } }],
        ctx({ files: ["db/migrations/1.sql"], risk: undefined }),
      ).final.risk,
    ).toBe("medium");
  });

  it("matches against the model's result but applies outcomes in order", () => {
    const rules: ReviewRule[] = [
      { name: "first", when: { minConfidence: 3 }, then: { confidence: 1 } },
      // Still matches: `when` reads the original 3, not the running 1.
      {
        name: "second",
        when: { minConfidence: 3 },
        then: { confidenceDelta: 1 },
      },
    ];
    const result = applyReviewRules(rules, ctx({ confidence: 3 }));
    expect(result.final.confidence).toBe(2);
    expect(result.applied.map((r) => [r.name, r.changes])).toEqual([
      ["first", ["quality 3 → 1"]],
      ["second", ["quality 1 → 2"]],
    ]);
  });

  it("records note-only rules without marking the result changed", () => {
    const result = applyReviewRules(
      [{ name: "fyi", when: { labels: ["fyi"] }, then: { note: "Heads up" } }],
      ctx({ labels: ["fyi"] }),
    );
    expect(result.changed).toBe(false);
    expect(result.applied).toEqual([
      { name: "fyi", changes: [], note: "Heads up" },
    ]);
  });

  it("ignores skipReview when scoring", () => {
    const skip: ReviewRule = {
      name: "skip",
      when: { labels: ["skip"] },
      then: { skipReview: true },
    };
    const result = applyReviewRules([skip], ctx({ labels: ["skip"] }));
    expect(result.applied).toEqual([]);
    expect(result.changed).toBe(false);
  });
});

describe("preflightSkipRule", () => {
  const lockfile: ReviewRule = {
    name: "lockfile-only",
    when: { allFilesMatch: ["**/bun.lock", "**/package.json"] },
    then: { skipReview: true },
  };
  const preflight = ctx({
    files: ["bun.lock", "packages/app/package.json"],
    verdict: undefined,
    confidence: undefined,
    risk: undefined,
  });

  it("returns the first matching skip rule before any model runs", () => {
    expect(preflightSkipRule([marketing, lockfile], preflight)).toBe(lockfile);
    expect(
      preflightSkipRule(
        [lockfile],
        ctx({ files: ["bun.lock", "src/app.ts"], verdict: undefined }),
      ),
    ).toBeNull();
  });

  it("never skips on a rule that reads the model's result", () => {
    const needsModel: ReviewRule = {
      name: "approved-anyway",
      when: { verdict: ["approve"], allFilesMatch: ["**"] },
      then: { skipReview: true },
    };
    expect(ruleNeedsModelResult(needsModel)).toBe(true);
    expect(ruleNeedsModelResult(lockfile)).toBe(false);
    expect(preflightSkipRule([needsModel], preflight)).toBeNull();
  });

  it("ignores rules that only score", () => {
    expect(
      preflightSkipRule([marketing], ctx({ verdict: undefined })),
    ).toBeNull();
  });
});

describe("diffFilePaths", () => {
  it("lists added, modified, renamed and deleted files once each", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
      'diff --git "a/with space.md" "b/with space.md"',
      '--- "a/with space.md"',
      '+++ "b/with space.md"',
    ].join("\n");
    expect(diffFilePaths(patch)).toEqual([
      "src/app.ts",
      "new.ts",
      "gone.ts",
      "with space.md",
    ]);
  });

  it("falls back to +++ paths for a patch without diff headers", () => {
    expect(diffFilePaths("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n")).toEqual([
      "x.ts",
    ]);
    expect(diffFilePaths("")).toEqual([]);
  });
});

describe("rendering", () => {
  it("renders nothing when no rule applied", () => {
    expect(reviewRulesSection(null)).toBe("");
    expect(
      reviewRulesSection(
        applyReviewRules([marketing], ctx({ files: ["a.ts"] })),
      ),
    ).toBe("");
    expect(ruleScoreSuffixes(null)).toEqual({
      verdict: "",
      confidence: "",
      risk: "",
    });
  });

  it("lists applied rules with their changes and notes", () => {
    const section = reviewRulesSection(
      applyReviewRules([marketing, migration], ctx()),
    );
    expect(section).toBe(
      "\n\n📏 **Rules applied**\n- **marketing-only**: quality 3 → 5, verdict comment → approve, risk medium → low. Marketing-only change",
    );
  });

  it("shows the model's original score next to an overridden one", () => {
    expect(ruleScoreSuffixes(applyReviewRules([marketing], ctx()))).toEqual({
      verdict: " (model: comment)",
      confidence: " (model 3/5)",
      risk: " (model medium)",
    });
    expect(
      ruleScoreSuffixes(
        applyReviewRules(
          [marketing],
          ctx({ confidence: undefined, risk: undefined, verdict: "approve" }),
        ),
      ),
    ).toEqual({ verdict: "", confidence: " (rule)", risk: " (rule)" });
  });
});

describe("rule groups", () => {
  it("flattens groups into rules that carry the group name", () => {
    const { rules, rejected } = normalizeReviewRuleGroups([
      {
        name: "Design",
        rules: [
          {
            name: "CSS only",
            when: { allFilesMatch: ["**/*.css"] },
            then: { result: { verdict: "approve" } },
          },
          { name: "Tone", prompt: "Does new copy sound like us?" },
        ],
      },
    ]);
    expect(rejected).toEqual([]);
    expect(rules).toEqual([
      {
        name: "CSS only",
        group: "Design",
        when: { allFilesMatch: ["**/*.css"] },
        then: { result: { verdict: "approve" } },
      },
      {
        name: "Tone",
        group: "Design",
        when: {},
        prompt: "Does new copy sound like us?",
      },
    ]);
    expect(rules.map(ruleKey)).toEqual(["Design / CSS only", "Design / Tone"]);
  });

  it("rejects unnamed, duplicate, and empty groups but keeps the rest", () => {
    const { rules, rejected } = normalizeReviewRuleGroups([
      { rules: [{ name: "x", when: { minFiles: 1 }, then: { note: "n" } }] },
      { name: "Empty", rules: [{ name: "broken", when: {}, then: {} }] },
      {
        name: "Ok",
        rules: [{ name: "a", when: { minFiles: 1 }, then: { note: "n" } }],
      },
      {
        name: "Ok",
        rules: [{ name: "b", when: { minFiles: 1 }, then: { note: "n" } }],
      },
      "nope",
    ]);
    expect(rules.map(ruleKey)).toEqual(["Ok / a"]);
    expect(rejected).toEqual(["#1", "Empty / broken", "Empty", "Ok", "#5"]);
  });

  it("allows the same rule name in different groups", () => {
    const { rules, rejected } = normalizeReviewRuleGroups([
      { name: "A", rules: [{ name: "same", prompt: "p" }] },
      { name: "B", rules: [{ name: "same", prompt: "p" }] },
    ]);
    expect(rejected).toEqual([]);
    expect(rules.map(ruleKey)).toEqual(["A / same", "B / same"]);
  });
});

describe("prompt rules", () => {
  const tone: ReviewRule = {
    name: "Tone",
    group: "Michiel",
    when: { anyFileMatches: ["apps/marketing/**"] },
    prompt: "Does new copy sound like us?",
  };
  const always: ReviewRule = {
    name: "Focused",
    when: {},
    prompt: "One thing?",
  };

  it("normalizes a prompt rule with optional conditions and no then", () => {
    const { rules, rejected } = normalizeReviewRules([
      { name: "Tone", prompt: "  Does new copy sound like us?  " },
      { name: "Scoped", when: { minFiles: 2 }, prompt: "p" },
      { name: "Both", when: { minFiles: 1 }, prompt: "p", then: { note: "n" } },
      { name: "Blank", prompt: "   " },
      { name: "Long", prompt: "x".repeat(MAX_PROMPT_LENGTH + 5) },
    ]);
    expect(rejected).toEqual(["Both", "Blank"]);
    expect(rules).toEqual([
      { name: "Tone", when: {}, prompt: "Does new copy sound like us?" },
      { name: "Scoped", when: { minFiles: 2 }, prompt: "p" },
      { name: "Long", when: {}, prompt: "x".repeat(MAX_PROMPT_LENGTH) },
    ]);
  });

  it("caps prompt rules per config and reports the dropped ones", () => {
    const many = Array.from({ length: MAX_PROMPT_RULES + 2 }, (_, i) => ({
      name: `p${i}`,
      when: {},
      prompt: "q",
    })) as ReviewRule[];
    const { rules, rejected } = capPromptRules([marketing, ...many]);
    expect(rules).toHaveLength(MAX_PROMPT_RULES + 1);
    expect(rejected).toEqual([
      `p${MAX_PROMPT_RULES}`,
      `p${MAX_PROMPT_RULES + 1}`,
    ]);
  });

  it("matches a prompt rule without conditions on every non-empty diff", () => {
    expect(ruleMatches(always, ctx())).toBe(true);
    expect(ruleMatches(always, ctx({ files: [] }))).toBe(true);
    expect(ruleMatches(tone, ctx({ files: ["src/app.ts"] }))).toBe(false);
  });

  it("splits matching prompt rules by whether they read the model's result", () => {
    const late: ReviewRule = {
      name: "Late",
      when: { verdict: ["approve"] },
      prompt: "p",
    };
    const c = ctx({ verdict: "approve" });
    expect(
      matchingPromptRules([tone, always, late, marketing], c, "before-model"),
    ).toEqual([tone, always]);
    expect(
      matchingPromptRules([tone, always, late, marketing], c, "after-model"),
    ).toEqual([late]);
  });

  it("never skips a review and never changes scores", () => {
    expect(preflightSkipRule([always], ctx())).toBeNull();
    const out = applyReviewRules([tone, always], ctx());
    expect(out.applied).toEqual([]);
    expect(out.changed).toBe(false);
  });

  it("records scoring outcomes in file order under the rule's group", () => {
    const outcomes = new Map<string, PromptRuleOutcome>([
      [
        "Focused",
        { result: { verdict: "comment", score: 3 }, note: "Two changes." },
      ],
      ["Michiel / Tone", { unavailable: "model unavailable" }],
    ]);
    const out = applyReviewRules([always, tone], ctx(), outcomes);
    expect(out.changed).toBe(false);
    expect(out.final).toEqual(out.original);
    expect(out.applied).toEqual([
      {
        name: "Focused",
        changes: [],
        result: { verdict: "comment", score: 3 },
        note: "Two changes.",
      },
      {
        name: "Tone",
        group: "Michiel",
        changes: [],
        unavailable: "model unavailable",
      },
    ]);
    expect(reviewRulesSection(out)).toBe(
      "\n\n📏 **Custom rule results**\nIndependent policy results; not the AI verdict or merge approval.\n- **Focused**: comment · 3/5 · Two changes." +
        "\n\n📏 **Michiel**\nIndependent policy results; not the AI verdict or merge approval.\n- **Tone**: not evaluated (model unavailable)",
    );
  });

  it("renders a group's static and prompt results together, in order", () => {
    const css: ReviewRule = {
      name: "CSS only",
      group: "Michiel",
      when: { allFilesMatch: ["**/*.css"] },
      then: { result: { verdict: "approve" }, note: "CSS-only change" },
    };
    const outcomes = new Map<string, PromptRuleOutcome>([
      [
        "Focused",
        { result: { verdict: "approve", score: 5 }, note: "One tweak." },
      ],
    ]);
    const out = applyReviewRules(
      [css, always, migration],
      ctx({ files: ["styles/site.css"], verdict: "approve", confidence: 5 }),
      outcomes,
    );
    expect(reviewRulesSection(out)).toBe(
      "\n\n📏 **Michiel**\nIndependent policy results; not the AI verdict or merge approval.\n- **CSS only**: approved · CSS-only change" +
        "\n\n📏 **Custom rule results**\nIndependent policy results; not the AI verdict or merge approval.\n- **Focused**: approved · 5/5 · One tweak.",
    );
  });
});
