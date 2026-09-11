import { describe, expect, test } from "bun:test";
import {
  haikuOneShotFallbackModel,
  haikuOneShotShouldFallOver,
  oneShot,
  oneShotFallbackModels,
  oneShotModel,
} from "./one-shot";

describe("oneShot", () => {
  test("routes native and legacy Pi model ids onto Pi", () => {
    expect(oneShotModel("claude-haiku-4-5")).toBe(
      "pi/anthropic/claude-haiku-4-5",
    );
    expect(oneShotModel("pi/openai/gpt-5.6-luna")).toBe(
      "pi/openai/gpt-5.6-luna",
    );
    expect(oneShotModel("pi/anthropic/claude-opus-5")).toBe(
      "pi/anthropic/claude-opus-5",
    );
  });

  test("never spends a model turn under tests", async () => {
    expect(await oneShot("Reply with ok")).toBeNull();
  });

  test("falls back from Haiku to OpenAI for provider exhaustion", () => {
    expect(
      haikuOneShotFallbackModel(
        "pi/anthropic/claude-haiku-4-5",
        "no usable Claude account in the pool",
      ),
    ).toBe("pi/openai/gpt-5.6-luna");
    expect(
      haikuOneShotFallbackModel(
        "pi/anthropic/claude-haiku-4-5",
        "timed out after 120000ms",
      ),
    ).toBe("pi/openai/gpt-5.6-luna");
  });

  test("does not fall over for caller or non-Haiku failures", () => {
    expect(haikuOneShotShouldFallOver("invalid model id")).toBe(false);
    expect(
      haikuOneShotFallbackModel(
        "pi/anthropic/claude-haiku-4-5",
        "invalid model id",
      ),
    ).toBeUndefined();
    expect(
      haikuOneShotFallbackModel(
        "pi/openai/gpt-5.6-luna",
        "usage limit reached",
      ),
    ).toBeUndefined();
  });

  test("falls over from any Claude model to caller-named OpenAI models", () => {
    expect(
      oneShotFallbackModels(
        "pi/anthropic/claude-fable-5-1",
        "no usable Claude account in the pool (all exhausted or sidelined)",
        ["gpt-6-astra", "gpt-5.6-sol"],
      ),
    ).toEqual(["pi/openai/gpt-6-astra", "pi/openai/gpt-5.6-sol"]);
  });

  test("skips fallbacks on the primary's own provider and the primary itself", () => {
    expect(
      oneShotFallbackModels("pi/openai/gpt-6-astra", "usage limit reached", [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "claude-opus-5",
      ]),
    ).toEqual(["pi/anthropic/claude-opus-5"]);
    expect(
      oneShotFallbackModels(
        "pi/anthropic/claude-fable-5-1",
        "usage limit reached",
        ["claude-opus-5", "gpt-6-astra", "gpt-6-astra"],
      ),
    ).toEqual(["pi/openai/gpt-6-astra"]);
  });

  test("keeps Haiku on its configured fallback and never hops on caller errors", () => {
    expect(
      oneShotFallbackModels(
        "pi/anthropic/claude-haiku-4-5",
        "no usable Claude account in the pool",
        ["gpt-6-astra"],
      ),
    ).toEqual(["pi/openai/gpt-5.6-luna"]);
    expect(
      oneShotFallbackModels(
        "pi/anthropic/claude-fable-5-1",
        "invalid model id",
        ["gpt-6-astra"],
      ),
    ).toEqual([]);
    expect(
      oneShotFallbackModels(
        "pi/anthropic/claude-fable-5-1",
        "quota",
        undefined,
      ),
    ).toEqual([]);
  });
});
