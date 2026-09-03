import { expect, test } from "bun:test";
import type { GitStatusInfo, PrDetails } from "../lib/types";
import { deriveHeadline } from "../lib/pr-headline";

const statusBarSource = await Bun.file(
  new URL("./PrStatusBar.tsx", import.meta.url),
).text();
const panelSource = await Bun.file(
  new URL("./PrPanel.tsx", import.meta.url),
).text();

function gitStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    branch: "main",
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    behindBase: 0,
    baseBranch: "main",
    uncommittedFiles: 0,
    sharedCheckout: false,
    ...overrides,
  };
}

test("does not offer PR, Pull, or Push status for a shared checkout", () => {
  const shared = gitStatus({ sharedCheckout: true, ahead: 71, behind: 187 });
  expect(deriveHeadline(null, shared)).toEqual({
    key: "clean",
    label: "Up to date",
    tone: "muted",
  });
  // A transient GitHub failure does not make PR status relevant: shared
  // checkouts do not create per-session PRs.
  expect(deriveHeadline(null, shared, true).key).toBe("clean");
});

test("says the PR status is unavailable rather than claiming there is no PR", () => {
  // A failed PR read arrives as a null pr, exactly like a branch with no PR.
  // Claiming "No PR open" there offers Create PR on a branch that may already
  // have one, and nothing about it ever corrects itself.
  expect(
    deriveHeadline(null, gitStatus({ branch: "feature", ahead: 2 }), true),
  ).toEqual({
    key: "unavailable",
    label: "PR status unavailable",
    tone: "yellow",
  });
});

test("shows the pull request API failure reason beside both retry states", () => {
  expect(statusBarSource).toContain(
    'errorMessage(prResource.error, "Couldn’t load pull request.")',
  );
  expect(statusBarSource).toContain("{prLoadError}");
  expect(panelSource).toContain(
    '<span className="text-pretty">{loadError}</span>',
  );
});

test("a successful read with no PR still says No PR open", () => {
  expect(
    deriveHeadline(null, gitStatus({ branch: "feature", ahead: 2 }), false).key,
  ).toBe("no-pr");
});

test("keeps Pull for an isolated worktree behind its own upstream", () => {
  expect(deriveHeadline(null, gitStatus({ behind: 2 }))).toEqual({
    key: "behind",
    label: "Behind by 2 commits",
    tone: "yellow",
  });
});

test("offers Merge instead of Pull when a behind PR has no conflicts", () => {
  const pr: PrDetails = {
    number: 42,
    title: "Behind but mergeable",
    url: "https://github.com/tellahq/app/pull/42",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "APPROVED",
    author: "octocat",
    body: "",
    checks: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "BEHIND",
  };

  expect(deriveHeadline(pr, gitStatus({ behind: 2, behindBase: 3 }))).toEqual({
    key: "ready",
    label: "Ready to merge",
    tone: "green",
  });
  expect(
    deriveHeadline(
      { ...pr, mergeable: "CONFLICTING" },
      gitStatus({ behind: 2, behindBase: 3 }),
    ),
  ).toEqual({ key: "conflicts", label: "Merge conflicts", tone: "red" });
});
