import { describe, expect, test } from "bun:test";
import {
  COMPACT_AT_TOKENS,
  compactionThresholdTokens,
  contextBreakdown,
  estimateFixedContext,
  piCompactionReserveTokens,
} from "./pi-context";

describe("compaction threshold", () => {
  test("a 1M window compacts at the fixed size, not near the ceiling", () => {
    expect(compactionThresholdTokens(1_000_000)).toBe(COMPACT_AT_TOKENS);
    expect(piCompactionReserveTokens(1_000_000)).toBe(
      1_000_000 - COMPACT_AT_TOKENS,
    );
  });

  test("a window under the fixed size keeps pi's default reserve", () => {
    expect(compactionThresholdTokens(272_000)).toBe(272_000 - 16_384);
    expect(piCompactionReserveTokens(272_000)).toBeUndefined();
    expect(piCompactionReserveTokens(200_000)).toBeUndefined();
  });

  test("a window just over the fixed size is left alone", () => {
    // 450K - 16,384 is still below 440K, so pi's default already compacts
    // earlier than the fixed size would.
    expect(piCompactionReserveTokens(450_000)).toBeUndefined();
    expect(piCompactionReserveTokens(460_000)).toBe(20_000);
  });

  test("an unknown window sets nothing", () => {
    expect(compactionThresholdTokens(0)).toBe(0);
    expect(piCompactionReserveTokens(0)).toBeUndefined();
    expect(piCompactionReserveTokens(Number.NaN)).toBeUndefined();
  });
});

describe("context breakdown", () => {
  const fixed = estimateFixedContext({
    systemPrompt: "s".repeat(4_000) + "a".repeat(2_000) + "k".repeat(400),
    instructionFiles: ["a".repeat(2_000)],
    skills: [{ name: "k".repeat(40), description: "k".repeat(300) }],
    tools: [
      { name: "bash", description: "x".repeat(380), parameters: {} },
      { name: "mcp_call", description: "y".repeat(780), parameters: {} },
    ],
    isMcpTool: (name) => name.startsWith("mcp_"),
  });

  test("the fixed estimate separates what the session wrote from the rest", () => {
    expect(fixed.instructions).toBe(500);
    expect(fixed.skills).toBe(100);
    expect(fixed.systemPrompt).toBe(1_600 - 500 - 100);
    expect(fixed.tools).toBeGreaterThan(95);
    expect(fixed.mcpTools).toBeGreaterThan(fixed.tools);
  });

  test("sections add up to the reported prompt size", () => {
    const breakdown = contextBreakdown({
      fixed,
      contextTokens: 50_000,
      summaryChars: 8_000,
      compactions: 2,
      contextWindow: 1_000_000,
    });
    expect(breakdown?.compactAtTokens).toBe(COMPACT_AT_TOKENS);
    expect(breakdown?.compactions).toBe(2);
    const sum = breakdown!.sections.reduce((n, s) => n + s.tokens, 0);
    expect(sum).toBe(50_000);
    expect(breakdown!.sections.find((s) => s.kind === "summary")?.tokens).toBe(
      2_000,
    );
    expect(
      breakdown!.sections.find((s) => s.kind === "messages")!.tokens,
    ).toBeGreaterThan(40_000);
  });

  test("an overshooting estimate is scaled, never negative", () => {
    const breakdown = contextBreakdown({ fixed, contextTokens: 900 });
    const sum = breakdown!.sections.reduce((n, s) => n + s.tokens, 0);
    expect(sum).toBeLessThanOrEqual(900);
    expect(breakdown!.sections.every((s) => s.tokens > 0)).toBe(true);
    expect(breakdown!.compactAtTokens).toBeUndefined();
  });

  test("no prompt size, no breakdown", () => {
    expect(contextBreakdown({ fixed, contextTokens: 0 })).toBeUndefined();
  });
});
