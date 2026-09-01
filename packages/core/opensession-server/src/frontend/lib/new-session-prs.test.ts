import { describe, expect, test } from "bun:test";
import { matchingPullRequests } from "./new-session-prs";

const pullRequests = [
  {
    repo: "opensession",
    number: 42,
    title: "Add searchable PR picker",
    branch: "feature/pr-search",
    author: "jaap",
    updatedAt: "2026-08-28T10:00:00Z",
  },
  {
    repo: "opensession",
    number: 41,
    title: "Older change",
    branch: "fix/older",
    author: "kent",
    updatedAt: "2026-08-27T10:00:00Z",
  },
  {
    repo: "tella-fusion",
    number: 42,
    title: "Same number, different repo",
    branch: "feature/other",
    author: "jaap",
    updatedAt: "2026-08-29T10:00:00Z",
  },
] as const;

describe("matchingPullRequests", () => {
  test("only returns pull requests from the chosen repo", () => {
    expect(
      matchingPullRequests(pullRequests, "opensession", "").map(
        (pr) => pr.title,
      ),
    ).toEqual(["Add searchable PR picker", "Older change"]);
  });

  test("searches number, title, branch, and author within that repo", () => {
    expect(
      matchingPullRequests(pullRequests, "opensession", "#42").map(
        (pr) => pr.number,
      ),
    ).toEqual([42]);
    expect(
      matchingPullRequests(pullRequests, "opensession", "searchable").map(
        (pr) => pr.number,
      ),
    ).toEqual([42]);
    expect(
      matchingPullRequests(pullRequests, "opensession", "feature/pr").map(
        (pr) => pr.number,
      ),
    ).toEqual([42]);
    expect(
      matchingPullRequests(pullRequests, "opensession", "kent").map(
        (pr) => pr.number,
      ),
    ).toEqual([41]);
  });
});
