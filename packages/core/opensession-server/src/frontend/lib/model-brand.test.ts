import { describe, expect, test } from "bun:test";
import { modelBrandKey, modelBrandKeys } from "./model-brand";

describe("modelBrandKey", () => {
  test("maps routed model vendors to their product marks", () => {
    expect(modelBrandKey("pi/anthropic/claude-opus-5", "pi")).toBe("claude");
    expect(modelBrandKey("pi/openai/gpt-5.6-sol", "pi")).toBe("codex");
    expect(modelBrandKey("pi/moonshotai/kimi-k3", "pi")).toBe("moonshotai");
    expect(modelBrandKey("pi/xai/grok-4", "pi")).toBe("xai");
  });

  test("maps legacy direct-SDK models from their provider", () => {
    expect(modelBrandKey("claude-opus-5", "claude")).toBe("claude");
    expect(modelBrandKey("gpt-5.6-sol", "codex")).toBe("codex");
  });

  test("maps every distinct vendor in combo compositions", () => {
    expect(
      modelBrandKeys("pi/dial/ultra", "pi", [
        "pi/anthropic/claude-fable-5-1",
        "pi/openai/gpt-5.6-sol",
      ]),
    ).toEqual(["claude", "codex"]);
    expect(
      modelBrandKeys("pi/dial/medium", "pi", [
        "pi/openai/gpt-5.6-sol",
        "pi/openai/gpt-5.6-sol",
      ]),
    ).toEqual(["codex"]);
  });

  test("leaves presets without composition and unknown vendors unbranded", () => {
    expect(modelBrandKeys("pi/dial/ultra", "pi")).toEqual([]);
    expect(modelBrandKey("pi/google/gemini-3", "pi")).toBeNull();
  });
});
