import { describe, expect, test } from "bun:test";
import { stackLayersTopFirst, stackMergePlan } from "./pr-stack";
import type { PrDetails, PrStack, PrStackLayer } from "./types";

function layer(
  position: number,
  over: Partial<PrStackLayer> = {},
): PrStackLayer {
  const number = 100 + position;
  return {
    number,
    title: `layer ${position}`,
    url: `https://github.com/o/r/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    headRefName: `feat-${position}`,
    baseRefName: position === 1 ? "main" : `feat-${position - 1}`,
    position,
    ...over,
  };
}

function pr(stack: PrStack | null, over: Partial<PrDetails> = {}): PrDetails {
  const current = stack?.layers.find((l) => l.position === stack.position);
  return {
    number: current?.number ?? 1,
    title: "t",
    url: "u",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviewDecision: "",
    author: "a",
    body: "",
    checks: [],
    stack,
    ...over,
  } as PrDetails;
}

function stackOf(layers: PrStackLayer[], position: number): PrStack {
  return {
    number: 7,
    baseRefName: "main",
    size: layers.length,
    position,
    layers,
  };
}

describe("stackLayersTopFirst", () => {
  test("reverses to top-first without mutating the input", () => {
    const layers = [layer(1), layer(2), layer(3)];
    const stack = stackOf(layers, 2);
    expect(stackLayersTopFirst(stack).map((l) => l.position)).toEqual([
      3, 2, 1,
    ]);
    expect(stack.layers.map((l) => l.position)).toEqual([1, 2, 3]);
  });
});

describe("stackMergePlan", () => {
  test("takes every open layer up to and including this one, bottom-first", () => {
    const plan = stackMergePlan(
      pr(stackOf([layer(1), layer(2), layer(3), layer(4)], 3)),
    );
    expect(plan?.layers.map((l) => l.number)).toEqual([101, 102, 103]);
    expect(plan?.blockedBy).toBeNull();
  });

  test("skips layers that already landed", () => {
    const plan = stackMergePlan(
      pr(
        stackOf(
          [layer(1, { state: "MERGED" }), layer(2), layer(3), layer(4)],
          3,
        ),
      ),
    );
    expect(plan?.layers.map((l) => l.number)).toEqual([102, 103]);
  });

  test("reports a draft below, which GitHub's atomic merge would refuse", () => {
    const plan = stackMergePlan(
      pr(stackOf([layer(1), layer(2, { isDraft: true }), layer(3)], 3)),
    );
    expect(plan?.blockedBy?.number).toBe(102);
    // The set is still what a merge would take — the caller decides.
    expect(plan?.layers).toHaveLength(3);
  });

  test("a draft above this layer is not in the way", () => {
    const plan = stackMergePlan(
      pr(stackOf([layer(1), layer(2), layer(3, { isDraft: true })], 2)),
    );
    expect(plan?.blockedBy).toBeNull();
    expect(plan?.layers).toHaveLength(2);
  });

  test("null for a PR with no stack, and for one that already landed", () => {
    expect(stackMergePlan(pr(null))).toBeNull();
    expect(
      stackMergePlan(pr(stackOf([layer(1), layer(2)], 2), { state: "MERGED" })),
    ).toBeNull();
  });
});
