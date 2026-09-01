import { describe, expect, test } from "bun:test";
import { dedupeTargets, matchFocusTarget, type PrTarget } from "./pr-focus";

/** The panel's own shape: a primary repo tab plus branch-keyed PR tabs. */
function targets(): PrTarget[] {
  return [
    { key: "gitops", repo: "gitops", primary: true, label: "gitops" },
    {
      key: "gitops grid-pool",
      repo: "gitops",
      branch: "grid-pool",
      number: 955,
      linked: true,
      label: "gitops #955",
    },
    {
      key: "gitops node-taints",
      repo: "gitops",
      branch: "node-taints",
      number: 961,
      discovered: true,
      label: "gitops #961",
    },
    {
      key: "tella-fusion webapp",
      repo: "tella-fusion",
      branch: "webapp",
      number: 5528,
      linked: true,
      label: "tella-fusion #5528",
    },
  ];
}

describe("matchFocusTarget", () => {
  test("a number picks its own PR, not the first one in the repo", () => {
    expect(
      matchFocusTarget(targets(), { repo: "gitops", number: 955 })?.key,
    ).toBe("gitops grid-pool");
    expect(
      matchFocusTarget(targets(), { repo: "gitops", number: 961 })?.key,
    ).toBe("gitops node-taints");
  });

  test("the number wins over a branch that names another PR", () => {
    // The server fills the branch in from its caches; a stale one must not
    // beat the number the reader actually clicked.
    expect(
      matchFocusTarget(targets(), {
        repo: "gitops",
        branch: "node-taints",
        number: 955,
      })?.key,
    ).toBe("gitops grid-pool");
  });

  test("falls back to the branch when the number is unknown", () => {
    expect(
      matchFocusTarget(targets(), { repo: "gitops", branch: "node-taints" })
        ?.key,
    ).toBe("gitops node-taints");
  });

  test("no branch means the repo's own tab, which holds no number", () => {
    expect(matchFocusTarget(targets(), { repo: "gitops" })?.key).toBe("gitops");
  });

  test("a number the panel doesn't offer lands on the repo's primary tab", () => {
    // The mentioned PR is this session's own — its target is keyed by repo,
    // and the branch is resolved server-side, so there is nothing to match.
    expect(
      matchFocusTarget(targets(), { repo: "gitops", number: 12 })?.key,
    ).toBe("gitops");
  });

  test("never crosses into another repo", () => {
    expect(
      matchFocusTarget(targets(), { repo: "shared-infra", number: 955 }),
    ).toBeUndefined();
    expect(matchFocusTarget(targets(), { number: 955 })).toBeUndefined();
  });

  test("a repo with only PR tabs falls back to its first", () => {
    const linkedOnly = targets().filter((t) => !t.primary);
    expect(matchFocusTarget(linkedOnly, { repo: "gitops" })?.key).toBe(
      "gitops grid-pool",
    );
  });
});

describe("dedupeTargets", () => {
  test("one tab per PR when it is both linked and discovered", () => {
    const both: PrTarget[] = [
      {
        key: "gitops grid-pool",
        repo: "gitops",
        branch: "grid-pool",
        number: 955,
        linked: true,
        label: "gitops #955",
      },
      {
        key: "gitops grid-pool",
        repo: "gitops",
        branch: "grid-pool",
        number: 955,
        discovered: true,
        label: "gitops #955",
      },
    ];
    const kept = dedupeTargets(both);
    expect(kept).toHaveLength(1);
    // The explicit link wins: it owns the unlink affordance.
    expect(kept[0]?.linked).toBe(true);
  });

  test("a repo tab never collides with a branch-keyed one", () => {
    expect(dedupeTargets(targets())).toHaveLength(4);
  });
});
