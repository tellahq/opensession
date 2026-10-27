import { describe, expect, test } from "bun:test";
import {
  baseModelId,
  engineModelId,
  isAnthropicModel,
  modelEngine,
  modelEngineKey,
  modelVendor,
} from "./model-engine";

describe("Pi model ids", () => {
  test("keeps routed catalog ids stable", () => {
    const id = "pi/anthropic/claude-opus-5";
    expect(modelEngine(id)).toBe("pi");
    expect(baseModelId(id)).toBe(id);
    expect(modelVendor(id)).toBe("anthropic");
    expect(modelEngineKey(id)).toBe("claude-opus-5");
  });

  test("routes bare ids and retired presets", () => {
    expect(engineModelId("pi", "claude-opus-5")).toBe(
      "pi/anthropic/claude-opus-5",
    );
    expect(engineModelId("pi", "dial/opus-fable")).toBe(
      "pi/anthropic/claude-opus-5-5",
    );
    expect(baseModelId("pi/dial/high")).toBe("pi/openai/gpt-6.1-sol");
  });

  test("identifies Anthropic models, including retired presets", () => {
    expect(isAnthropicModel("pi/anthropic/claude-opus-5")).toBe(true);
    expect(isAnthropicModel("pi/dial/opus-fable")).toBe(true);
    expect(isAnthropicModel("pi/openai/gpt-5.6-sol", "codex")).toBe(false);
  });
});
