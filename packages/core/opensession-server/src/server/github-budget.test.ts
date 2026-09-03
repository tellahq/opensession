import { describe, expect, test } from "bun:test";
import { parseGithubGraphqlBucket } from "./github-budget";

describe("parseGithubGraphqlBucket", () => {
  test("reads the GraphQL rateLimit object", () => {
    expect(
      parseGithubGraphqlBucket({
        limit: 9950,
        used: 1158,
        remaining: 8792,
        resetAt: "2026-09-03T10:12:28Z",
      }),
    ).toEqual({
      limit: 9950,
      used: 1158,
      remaining: 8792,
      resetAt: Date.parse("2026-09-03T10:12:28Z"),
    });
  });

  test("reads the REST rate_limit resource with an epoch reset", () => {
    expect(
      parseGithubGraphqlBucket({
        limit: 9950,
        used: 0,
        remaining: 9950,
        resetAt: 1788430348,
      })?.resetAt,
    ).toBe(1788430348_000);
  });

  test("rejects anything incomplete", () => {
    expect(parseGithubGraphqlBucket(undefined)).toBeNull();
    expect(parseGithubGraphqlBucket({ limit: 9950 })).toBeNull();
    expect(
      parseGithubGraphqlBucket({
        limit: "a",
        used: 1,
        remaining: 1,
        resetAt: 1,
      }),
    ).toBeNull();
  });
});
