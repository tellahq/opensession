import { describe, expect, test } from "bun:test";
import { savedShippedChangeDraft } from "./shipped-change-draft";

const draft = {
  repoId: "acme",
  branch: "feature",
  prNumber: 7,
  message: "Search now finds archived sessions.",
  activity: "2026-01-01T00:00:00.000Z",
  at: "2026-01-01T00:00:05.000Z",
};

describe("savedShippedChangeDraft", () => {
  test("reuses a draft written for this PR while the session is unchanged", () => {
    expect(
      savedShippedChangeDraft(
        { lastActivity: draft.activity, shippedChangeDraft: draft },
        { repoId: "acme", branch: "feature" },
      ),
    ).toBe(draft);
  });

  test("writes again once the session has moved on or the PR differs", () => {
    expect(
      savedShippedChangeDraft(
        {
          lastActivity: "2026-01-02T00:00:00.000Z",
          shippedChangeDraft: draft,
        },
        { repoId: "acme", branch: "feature" },
      ),
    ).toBeUndefined();
    expect(
      savedShippedChangeDraft(
        { lastActivity: draft.activity, shippedChangeDraft: draft },
        { repoId: "acme", branch: "other" },
      ),
    ).toBeUndefined();
    expect(
      savedShippedChangeDraft(
        { lastActivity: draft.activity },
        { repoId: "acme", branch: "feature" },
      ),
    ).toBeUndefined();
  });
});
