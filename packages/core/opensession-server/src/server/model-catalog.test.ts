import { describe, expect, test } from "bun:test";
import {
  CLAUDE_API_CAPACITY,
  chooseConfiguredDefaultModel,
  modelFitsConfiguredProviders,
  modelUpstreamProvider,
  pickerModelId,
} from "./model-catalog";

const openaiOnly = new Set(["openai"]);
const both = new Set(["anthropic", "openai"]);

describe("model catalog provider availability", () => {
  test("resolves native and Pi model ids to their upstream provider", () => {
    expect(modelUpstreamProvider("gpt-6.2-sol")).toBe("openai");
    expect(modelUpstreamProvider("pi/anthropic/claude-fable-5-2")).toBe(
      "anthropic",
    );
  });

  test("routes retired preset ids to the model they led", () => {
    expect(pickerModelId("dial/high")).toBe("pi/openai/gpt-6.2-sol");
    expect(pickerModelId("pi/orchestrator/fable-sol")).toBe(
      "pi/anthropic/claude-fable-5-2",
    );
  });

  test("replaces an unavailable default with the first configured model", () => {
    const fallbacks = [
      "pi/anthropic/claude-fable-5-2",
      "pi/openai/gpt-6.2-sol",
      "pi/openai/gpt-5.6-terra",
    ];
    expect(
      chooseConfiguredDefaultModel("claude-fable-5-2", openaiOnly, fallbacks),
    ).toBe("pi/openai/gpt-6.2-sol");
    expect(
      chooseConfiguredDefaultModel("dial/ultra", openaiOnly, fallbacks),
    ).toBe("pi/openai/gpt-6.2-sol");
  });

  test("preserves defaults whose provider is configured", () => {
    expect(chooseConfiguredDefaultModel("gpt-6.2-sol", openaiOnly, [])).toBe(
      "pi/openai/gpt-6.2-sol",
    );
    expect(chooseConfiguredDefaultModel("claude-opus-5-5", both, [])).toBe(
      "pi/anthropic/claude-opus-5-5",
    );
  });

  test("Claude API accounts make only Mythos runnable", () => {
    const apiOnly = new Set([CLAUDE_API_CAPACITY]);
    const fallbacks = [
      "pi/anthropic/claude-fable-5-2",
      "pi/anthropic/claude-mythos-5-2",
      "pi/anthropic/claude-mythos-5-1",
    ];
    expect(
      chooseConfiguredDefaultModel("claude-fable-5-2", apiOnly, fallbacks),
    ).toBe("pi/anthropic/claude-mythos-5-2");
    expect(
      modelFitsConfiguredProviders("pi/anthropic/claude-opus-5-5", apiOnly),
    ).toBe(false);
    // A subscription cannot serve Mythos.
    expect(
      modelFitsConfiguredProviders("pi/anthropic/claude-mythos-5-2", both),
    ).toBe(false);
    expect(
      modelFitsConfiguredProviders(
        "pi/anthropic/claude-mythos-5-2",
        new Set(["anthropic", CLAUDE_API_CAPACITY]),
      ),
    ).toBe(true);
  });
});
