import { describe, expect, test } from "bun:test";
import {
  chooseConfiguredDefaultModel,
  modelUpstreamProvider,
  pickerModelId,
} from "./model-catalog";

const openaiOnly = new Set(["openai"]);
const both = new Set(["anthropic", "openai"]);

describe("model catalog provider availability", () => {
  test("resolves native and Pi model ids to their upstream provider", () => {
    expect(modelUpstreamProvider("gpt-6.1-sol")).toBe("openai");
    expect(modelUpstreamProvider("pi/anthropic/claude-fable-5-1")).toBe(
      "anthropic",
    );
  });

  test("routes retired preset ids to the model they led", () => {
    expect(pickerModelId("dial/high")).toBe("pi/openai/gpt-6.1-sol");
    expect(pickerModelId("pi/orchestrator/fable-sol")).toBe(
      "pi/anthropic/claude-fable-5-1",
    );
  });

  test("replaces an unavailable default with the first configured model", () => {
    const fallbacks = [
      "pi/anthropic/claude-fable-5-1",
      "pi/openai/gpt-6.1-sol",
      "pi/openai/gpt-5.6-terra",
    ];
    expect(
      chooseConfiguredDefaultModel("claude-fable-5-1", openaiOnly, fallbacks),
    ).toBe("pi/openai/gpt-6.1-sol");
    expect(
      chooseConfiguredDefaultModel("dial/ultra", openaiOnly, fallbacks),
    ).toBe("pi/openai/gpt-6.1-sol");
  });

  test("preserves defaults whose provider is configured", () => {
    expect(chooseConfiguredDefaultModel("gpt-6.1-sol", openaiOnly, [])).toBe(
      "pi/openai/gpt-6.1-sol",
    );
    expect(chooseConfiguredDefaultModel("claude-opus-5-5", both, [])).toBe(
      "pi/anthropic/claude-opus-5-5",
    );
  });
});
