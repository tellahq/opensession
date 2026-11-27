import { describe, expect, test } from "bun:test";
import { formatModelGuidanceTitle, modelGuidanceFor } from "./model-guidance";

describe("modelGuidanceFor", () => {
  test("resolves candid strongAt and watchFor guidance for routed and bare model ids", () => {
    const opus = modelGuidanceFor("pi/anthropic/claude-opus-5-5");
    expect(opus?.summary).toContain("Feature");
    expect(opus?.strongAt.length).toBeGreaterThan(0);
    expect(opus?.watchFor.length).toBeGreaterThan(0);

    const astra = modelGuidanceFor("pi/openai/gpt-6.2-astra");
    expect(astra?.strongAt.join(" ")).toContain("apply_patch");

    const sol = modelGuidanceFor("gpt-6.2-sol");
    expect(sol?.summary).toContain("Everyday");

    const gemini = modelGuidanceFor("pi/google-vertex/gemini-4-carbon");
    expect(gemini?.summary).toContain("Large-context");

    expect(modelGuidanceFor("pi/custom/unknown-model-x")).toBeNull();
  });

  test("formats guidance into a concise multi-line tooltip string", () => {
    const opus = modelGuidanceFor("claude-opus-5-5")!;
    const text = formatModelGuidanceTitle(opus);
    expect(text).toContain("Strong at:");
    expect(text).toContain("Watch for:");
  });
});
