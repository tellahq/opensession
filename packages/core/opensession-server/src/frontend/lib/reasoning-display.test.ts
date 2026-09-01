import { describe, expect, test } from "bun:test";
import {
  isLegacyReasoningHeading,
  liveReasoningHeading,
  normalizeFragmentedReasoning,
  reasoningDisplay,
} from "./reasoning-display";

describe("reasoning display", () => {
  test("moves a generated bold heading out of markdown", () => {
    expect(
      reasoningDisplay(
        "**Checking deployment status**\n\nThe release is still moving.",
      ),
    ).toEqual({
      title: "Checking deployment status",
      body: "The release is still moving.",
    });
  });

  test("recognizes old heading-only reasoning rows", () => {
    expect(isLegacyReasoningHeading("**Checking deployment status**")).toBe(
      true,
    );
    expect(
      isLegacyReasoningHeading(
        "**Checking deployment status**\n\n**Verifying the release**",
      ),
    ).toBe(true);
    expect(isLegacyReasoningHeading("**Done**\n\nFinal answer")).toBe(false);
  });

  test("removes bold markdown from batched reasoning headings", () => {
    expect(
      reasoningDisplay(
        "**Confirming app details**\n\n**Analyzing shimmer behavior**\n\n**Clarifying usage**",
      ),
    ).toEqual({
      title:
        "Confirming app details\nAnalyzing shimmer behavior\nClarifying usage",
      body: "",
    });
  });

  test("repairs token-fragmented provider reasoning", () => {
    const fragmented = [
      "The",
      "rule",
      "genuinely",
      "has",
      "only",
      "8",
      "inline",
      "bridges",
      "(",
      "first",
      "and",
      "last",
      ")",
      "+",
      "2",
      "multiline",
      "ones",
      "don",
      "'t",
      "match",
      "the",
      "literal",
      "pattern",
      ".",
    ].join("\n\n");

    expect(normalizeFragmentedReasoning(fragmented)).toBe(
      "The rule genuinely has only 8 inline bridges (first and last) + 2 multiline ones don't match the literal pattern.",
    );
  });

  test("preserves authored markdown structure", () => {
    const list = Array.from(
      { length: 12 },
      (_, index) => `- Check item ${index + 1}`,
    ).join("\n");
    const prose =
      "This is a deliberately wrapped line with enough words to read naturally.\n" +
      "It continues at a normal prose measure instead of splitting every token.\n\n" +
      "A second paragraph remains separate.";

    const fenced =
      "Inspect this output:\n\n```text\nalpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n```";

    expect(normalizeFragmentedReasoning(list)).toBe(list);
    expect(normalizeFragmentedReasoning(prose)).toBe(prose);
    expect(normalizeFragmentedReasoning(fenced)).toBe(fenced);
  });

  test("extracts a partial streamed heading for the shimmer", () => {
    expect(liveReasoningHeading("**Checking deploy")).toBe("Checking deploy");
    expect(liveReasoningHeading("**Checking deploy**")).toBe("Checking deploy");
    expect(liveReasoningHeading("**Title**\n\nBody")).toBeNull();
  });
});
