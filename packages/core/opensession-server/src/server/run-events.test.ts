import { describe, expect, test } from "bun:test";
import {
  contextRebuildNotice,
  isContextRebuildStep,
  isLikelyPromptCacheMiss,
  shouldPersistModelSwitch,
  type StepPromptUsage,
  type TurnUsage,
} from "./run-events";

const usage = (contextTokens: number, cacheReadTokens = 0): TurnUsage => ({
  inputTokens: contextTokens - cacheReadTokens,
  outputTokens: 100,
  cacheReadTokens,
  cacheCreationTokens: 0,
  contextTokens,
});

describe("isLikelyPromptCacheMiss", () => {
  test("warns on a large repeated Anthropic turn without a meaningful cache read", () => {
    expect(isLikelyPromptCacheMiss(usage(20_000), 2, "anthropic")).toBe(true);
    expect(isLikelyPromptCacheMiss(usage(20_000, 500), 2, "anthropic")).toBe(
      true,
    );
  });

  test("ignores first turns, small prompts, and other providers", () => {
    expect(isLikelyPromptCacheMiss(usage(20_000), 1, "anthropic")).toBe(false);
    expect(isLikelyPromptCacheMiss(usage(9_999), 2, "anthropic")).toBe(false);
    expect(isLikelyPromptCacheMiss(usage(20_000), 2, "openai")).toBe(false);
  });

  test("accepts either a substantial absolute or proportional cache read", () => {
    expect(isLikelyPromptCacheMiss(usage(20_000, 1_024), 2, "anthropic")).toBe(
      false,
    );
    expect(isLikelyPromptCacheMiss(usage(10_000, 500), 2, "anthropic")).toBe(
      false,
    );
  });
});

describe("shouldPersistModelSwitch", () => {
  test("keeps infrastructure fallbacks scoped to the current turn", () => {
    expect(
      shouldPersistModelSwitch({
        type: "model_switch",
        switchReason: "hit a transient engine error",
        temporaryFallback: true,
      }),
    ).toBe(false);
  });

  test("persists usage fallbacks and legacy model-switch events", () => {
    expect(
      shouldPersistModelSwitch({
        type: "model_switch",
        switchReason: "out of credits",
      }),
    ).toBe(true);
    expect(shouldPersistModelSwitch({ type: "model_switch" })).toBe(true);
    expect(
      shouldPersistModelSwitch({
        type: "model_switch",
        switchReason: "out of credits",
        temporaryFallback: true,
      }),
    ).toBe(false);
    expect(shouldPersistModelSwitch({ type: "done" })).toBe(false);
  });
});

describe("isContextRebuildStep", () => {
  const step = (
    cacheReadTokens: number,
    cacheCreationTokens: number,
  ): StepPromptUsage => ({
    cacheReadTokens,
    cacheCreationTokens,
    contextTokens: cacheReadTokens + cacheCreationTokens,
  });

  test("fires when a warm step is followed by a cold, freshly-written prompt", () => {
    // bks-019fc695, 2026-08-03: step 5 read 258k, step 6 read nothing and
    // wrote a 94k prefix — the SDK had compacted underneath pi.
    expect(isContextRebuildStep(step(257_998, 3_819), step(0, 94_429))).toBe(
      true,
    );
  });

  test("ignores an attempt's first step, where a cold cache is ordinary", () => {
    expect(isContextRebuildStep(undefined, step(0, 243_022))).toBe(false);
  });

  test("ignores a cold step whose predecessor was also cold or small", () => {
    // An account rotation re-prompts on a fresh pump: no warm predecessor.
    expect(isContextRebuildStep(step(0, 120_000), step(0, 94_000))).toBe(false);
    expect(isContextRebuildStep(step(12_000, 500), step(0, 94_000))).toBe(
      false,
    );
  });

  test("ignores an ordinary warm step and a trivially small rewrite", () => {
    expect(
      isContextRebuildStep(step(257_998, 3_819), step(261_000, 2_000)),
    ).toBe(false);
    expect(isContextRebuildStep(step(257_998, 3_819), step(0, 1_200))).toBe(
      false,
    );
  });

  test("the notice reports both sizes in thousands", () => {
    const notice = contextRebuildNotice(step(257_998, 3_819), step(0, 94_429));
    expect(notice).toContain("262k → 94k");
  });
});
