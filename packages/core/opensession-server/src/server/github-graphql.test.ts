import { describe, expect, test } from "bun:test";
import {
  githubRetryAt,
  isGithubGraphqlRateLimited,
  withRateLimitSelection,
} from "./github-graphql";

describe("withRateLimitSelection", () => {
  test("adds rateLimit to the operation, before trailing fragments", () => {
    const query = `query($owner: String!) {
  repository(owner: $owner, name: "web") {
    pr1: pullRequest(number: 1) { ...Summary }
  }
}
fragment Summary on PullRequest {
  number
}`;
    const out = withRateLimitSelection(query);
    const rateLimit = out.indexOf("rateLimit {");
    expect(rateLimit).toBeGreaterThan(out.indexOf("pr1:"));
    expect(rateLimit).toBeLessThan(out.indexOf("fragment Summary"));
    expect(out.slice(out.indexOf("fragment Summary"))).toBe(
      query.slice(query.indexOf("fragment Summary")),
    );
  });

  test("leaves mutations and queries that already ask for it alone", () => {
    const mutation = "mutation { addComment(input: {}) { clientMutationId } }";
    expect(withRateLimitSelection(mutation)).toBe(mutation);
    const asked = "query { viewer { login } rateLimit { cost } }";
    expect(withRateLimitSelection(asked)).toBe(asked);
    expect(withRateLimitSelection("{ viewer { login } }")).toContain(
      "rateLimit { cost limit used remaining resetAt }",
    );
  });
});

describe("GitHub GraphQL rate limits", () => {
  const headers = (values: Record<string, string> = {}) => new Headers(values);

  test("recognises refusals GitHub sends with HTTP 200", () => {
    expect(
      isGithubGraphqlRateLimited(
        200,
        headers(),
        [{ type: "RATE_LIMITED" }],
        "",
      ),
    ).toBe(true);
    expect(
      isGithubGraphqlRateLimited(
        200,
        headers(),
        [{ message: "API rate limit already exceeded for user ID 1." }],
        "",
      ),
    ).toBe(true);
    expect(
      isGithubGraphqlRateLimited(
        200,
        headers({ "x-ratelimit-remaining": "0" }),
        [{ message: "Something went wrong" }],
        "",
      ),
    ).toBe(true);
    expect(
      isGithubGraphqlRateLimited(
        200,
        headers(),
        [{ type: "NOT_FOUND", message: "Could not resolve" }],
        "",
      ),
    ).toBe(false);
  });

  test("recognises HTTP refusals and leaves other 403s alone", () => {
    expect(isGithubGraphqlRateLimited(429, headers(), undefined, "")).toBe(
      true,
    );
    expect(
      isGithubGraphqlRateLimited(
        403,
        headers({ "retry-after": "60" }),
        undefined,
        "",
      ),
    ).toBe(true);
    expect(
      isGithubGraphqlRateLimited(
        403,
        headers(),
        undefined,
        '{"message":"Resource not accessible by integration"}',
      ),
    ).toBe(false);
  });

  test("reads the pause from retry-after, then the reset header", () => {
    expect(githubRetryAt(headers({ "retry-after": "30" }), 1_000)).toBe(31_000);
    expect(
      githubRetryAt(headers({ "x-ratelimit-reset": "2000" }), 1_000_000),
    ).toBe(2_000_000);
    expect(
      githubRetryAt(headers({ "x-ratelimit-reset": "1" }), 1_000_000),
    ).toBeUndefined();
  });
});
