import { describe, expect, test } from "bun:test";
import { analyzeCodeFlow } from "./code-flow-analyzer";
import { codeFlowHttpError } from "./code-flow";
import { buildChangedTrees } from "./vendor/calldiff/core";
import { buildFunctionIndex } from "./vendor/calldiff/extract";

describe("code-flow analysis bounds", () => {
  test("only exposes stable public errors", () => {
    expect(
      codeFlowHttpError(new Error("Code-flow analysis is busy; try again")),
    ).toEqual({
      message: "Code-flow analysis is busy; try again",
      status: 429,
    });
    expect(codeFlowHttpError(new Error("Git snapshot unavailable"))).toEqual({
      message: "Couldn't analyze code flow. Try again.",
      status: 502,
    });
  });
  test("normalizes renamed files before matching functions", () => {
    const result = analyzeCodeFlow({
      repo: "test",
      base: "a",
      head: "b",
      diffVersion: "v1",
      skippedFiles: 0,
      pairs: [
        {
          oldPath: "old.ts",
          path: "new.ts",
          before: "export function run() { return save(); }",
          after: "export function run() { return save(); }",
        },
      ],
    });
    expect(result.trees).toEqual([]);
  });

  test("returns a bounded partial tree instead of a false empty result", () => {
    const before = buildFunctionIndex([
      {
        path: "run.ts",
        content: "export function run() { return oldCall(); }",
      },
    ]);
    const after = buildFunctionIndex([
      {
        path: "run.ts",
        content: "export function run() { first(); second(); third(); }",
      },
    ]);
    const result = buildChangedTrees(before, after, { maxNodes: 2 });
    expect(result.truncated).toBe(true);
    expect(result.trees).toHaveLength(1);
    expect(result.trees[0]?.tree.children).toHaveLength(1);
  });

  test("reports when the function index reaches its cap", () => {
    const content = Array.from(
      { length: 801 },
      (_, index) => `export function fn${index}() { return call${index}(); }`,
    ).join("\n");
    const index = buildFunctionIndex([{ path: "many.ts", content }]);
    expect(index.size).toBe(800);
    expect(index.truncated).toBe(true);
  });
});
