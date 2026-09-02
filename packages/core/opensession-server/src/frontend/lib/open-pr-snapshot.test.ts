import { describe, expect, test } from "bun:test";
import type { OpenPr } from "./api";
import { sameOpenPrSnapshot } from "./open-pr-snapshot";

function pr(number: number, title = `PR ${number}`): OpenPr {
  return {
    repo: "tellahq/opensession",
    branch: `change-${number}`,
    url: `https://github.com/tellahq/opensession/pull/${number}`,
    number,
    title,
    isDraft: false,
    reviewDecision: "",
    author: "jaap",
    person: "jaap",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  };
}

describe("sameOpenPrSnapshot", () => {
  test("recognizes a fresh but unchanged response", () => {
    expect(sameOpenPrSnapshot([pr(1)], [pr(1)])).toBe(true);
  });

  test("keeps row changes and ordering observable", () => {
    expect(sameOpenPrSnapshot([pr(1)], [pr(1, "Changed")])).toBe(false);
    expect(sameOpenPrSnapshot([pr(1), pr(2)], [pr(2), pr(1)])).toBe(false);
  });
});
