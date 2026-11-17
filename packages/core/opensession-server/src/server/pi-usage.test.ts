import { expect, test } from "bun:test";
import { usageDayFromCatalog } from "./pi-usage";

const row = {
  requests: 2,
  input: 10,
  output: 4,
  cacheRead: 100,
  cacheWrite: 6,
  costUsd: 1.5,
};

test("folds a catalog day into per-model and per-session usage", () => {
  const day = usageDayFromCatalog([
    { ...row, sessionId: "os-a", model: "claude-opus-5" },
    { ...row, sessionId: "os-a", model: "pi/openai/gpt-6.2-sol", costUsd: 0.5 },
    { ...row, sessionId: "bks-b", model: "claude-opus-5", output: 1 },
    { ...row, sessionId: "", model: "claude-haiku-4-5" },
  ]);
  expect(day).toMatchObject({
    requests: 8,
    input: 40,
    output: 13,
    cacheRead: 400,
    cacheWrite: 24,
    totalTokens: 477,
    costUsd: 5,
    unmeasured: false,
    sessionAttribution: "measured",
  });
  expect(day.byModel.map((usage) => [usage.model, usage.requests])).toEqual([
    ["claude-opus-5", 4],
    ["claude-haiku-4-5", 2],
    ["gpt-6.2-sol", 2],
  ]);
  // Unowned usage counts toward the day and its model, never a session.
  expect(day.bySession).toEqual({
    "os-a": { requests: 4, output: 8 },
    "bks-b": { requests: 2, output: 1 },
  });
});
