import { describe, expect, test } from "bun:test";
import {
  isLegacyReasoningHeading,
  liveReasoningHeading,
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

  test("extracts a partial streamed heading for the shimmer", () => {
    expect(liveReasoningHeading("**Checking deploy")).toBe("Checking deploy");
    expect(liveReasoningHeading("**Checking deploy**")).toBe("Checking deploy");
    expect(liveReasoningHeading("**Title**\n\nBody")).toBeNull();
  });
});
