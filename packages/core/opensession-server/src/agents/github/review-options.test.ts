import { describe, expect, it } from "bun:test";
import {
  normalizeReviewOptions,
  severityRank,
  titleHasSkipKeyword,
  pathIgnored,
  REVIEW_OPTION_DEFAULTS,
} from "./review-options";
import { oldSideRanges, prNumberFromSubject } from "./missed-bugs";

describe("review options", () => {
  it("falls back to defaults on garbage", () => {
    expect(normalizeReviewOptions(null)).toEqual(REVIEW_OPTION_DEFAULTS);
    expect(
      normalizeReviewOptions({
        minInlineSeverity: "P9",
        summaryOnlyOverFiles: -1,
      }),
    ).toEqual(REVIEW_OPTION_DEFAULTS);
  });

  it("accepts valid overrides (case-insensitive severity)", () => {
    const o = normalizeReviewOptions({
      ignoreGlobs: ["**/*.lock", 3, ""],
      minInlineSeverity: "p1",
      summaryOnlyOverFiles: 40,
      skipKeywords: ["[no-review]"],
      secretScan: false,
    });
    expect(o.ignoreGlobs).toEqual(["**/*.lock"]);
    expect(o.minInlineSeverity).toBe("P1");
    expect(o.summaryOnlyOverFiles).toBe(40);
    expect(o.skipKeywords).toEqual(["[no-review]"]);
    expect(o.secretScan).toBe(false);
  });

  it("defaults secretScan on", () => {
    expect(REVIEW_OPTION_DEFAULTS.secretScan).toBe(true);
    expect(normalizeReviewOptions({}).secretScan).toBe(true);
  });

  it("ranks severities with unknowns as least severe", () => {
    expect(severityRank("P0")).toBe(0);
    expect(severityRank("high")).toBe(0);
    expect(severityRank("P2")).toBe(2);
    expect(severityRank(undefined)).toBe(3);
  });

  it("matches skip keywords case-insensitively", () => {
    expect(
      titleHasSkipKeyword(
        "WIP [Skip-Review] big refactor",
        REVIEW_OPTION_DEFAULTS,
      ),
    ).toBe(true);
    expect(titleHasSkipKeyword("normal title", REVIEW_OPTION_DEFAULTS)).toBe(
      false,
    );
  });

  it("matches ignore globs", () => {
    const o = normalizeReviewOptions({
      ignoreGlobs: ["**/*.lock", "generated/**"],
    });
    expect(pathIgnored("bun.lock", o)).toBe(true);
    expect(pathIgnored("packages/app/yarn.lock", o)).toBe(true);
    expect(pathIgnored("generated/api/client.ts", o)).toBe(true);
    expect(pathIgnored("src/app.ts", o)).toBe(false);
  });
});

describe("missed-bug helpers", () => {
  it("extracts old-side ranges from a patch, skipping pure additions", () => {
    const patch = [
      "@@ -10,3 +10,4 @@ ctx",
      " a",
      "-b",
      "+b2",
      "+b3",
      " c",
      "@@ -50,0 +52,2 @@ ctx",
      "+added only",
      "+added only 2",
    ].join("\n");
    expect(oldSideRanges(patch)).toEqual([{ start: 10, end: 12 }]);
  });

  it("extracts PR numbers from squash-merge subjects", () => {
    expect(prNumberFromSubject("fix: handle empty upload queue (#4913)")).toBe(
      4913,
    );
    expect(prNumberFromSubject("fix without suffix")).toBeNull();
  });
});
