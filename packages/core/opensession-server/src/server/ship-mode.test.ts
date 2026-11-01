import { describe, expect, test } from "bun:test";
import {
  buildGoalShippingInstructions,
  buildShipButtons,
  buildShipPrompt,
  buildWorktreePublicationNote,
  parseShipActions,
  parseShipMode,
  resolveShipMode,
  scanPublication,
} from "./ship-mode";

const prRepo = { id: "app", defaultBranch: "main" } as const;
const directRepo = {
  id: "app",
  defaultBranch: "trunk",
  publicationMode: "direct",
} as const;
const storageRepo = {
  id: "store",
  defaultBranch: "main",
  host: "codestorage",
  publicationMode: "direct",
} as const;

describe("resolveShipMode", () => {
  test("follows the repository when nothing overrides it", () => {
    expect(resolveShipMode({ repo: prRepo })).toEqual({
      mode: "pull-request",
      requested: "pull-request",
      reason: "repository",
    });
    expect(resolveShipMode({ repo: directRepo }).mode).toBe("direct");
  });

  test("a session override wins in both directions", () => {
    expect(resolveShipMode({ repo: prRepo, override: "direct" })).toEqual({
      mode: "direct",
      requested: "direct",
      reason: "override",
    });
    expect(
      resolveShipMode({ repo: directRepo, override: "pull-request" }).mode,
    ).toBe("pull-request");
  });

  // Each of these used to keep a direct repository on the PR flow inside
  // buildBranchNote; an override must not route around any of them.
  test.each([
    ["code-storage", { repo: storageRepo }],
    ["automation", { repo: directRepo, automation: true }],
    ["open-pr", { repo: directRepo, openPr: true }],
    ["stacked", { repo: directRepo, stacked: true }],
    ["existing-branch", { repo: directRepo, existingBranch: true }],
    ["pstack", { repo: directRepo, pstackMode: true }],
  ] as const)("%s keeps the change-request flow", (reason, input) => {
    for (const override of [undefined, "direct"] as const)
      expect(resolveShipMode({ ...input, override })).toEqual({
        mode: "pull-request",
        requested: "direct",
        reason,
      });
  });

  test("parseShipMode accepts only the two modes", () => {
    expect(parseShipMode("direct")).toBe("direct");
    expect(parseShipMode("pull-request")).toBe("pull-request");
    expect(parseShipMode("force")).toBeUndefined();
    expect(parseShipMode(undefined)).toBeUndefined();
  });
});

describe("buildWorktreePublicationNote", () => {
  const base = { worktreeDir: "/w/app-feat", branch: "feat" };

  test("direct pushes the checked commit to the default branch", () => {
    const note = buildWorktreePublicationNote({
      ...base,
      repo: directRepo,
      mode: "direct",
    });
    expect(note).toContain("## Branch discipline (direct publication)");
    expect(note).toContain("git push origin HEAD:refs/heads/trunk");
    expect(note).toContain("Never force-push or delete the default branch");
    expect(note).not.toContain("gh pr create");
  });

  test("pull-request keeps one PR per workspace and never merges", () => {
    const note = buildWorktreePublicationNote({
      ...base,
      repo: prRepo,
      mode: "pull-request",
    });
    expect(note).toContain("## Branch discipline (shared worktree)");
    expect(note).toContain(
      "Only run `gh pr create` when the branch has no open PR",
    );
    expect(note).toContain("Never merge a pull request unless");
    expect(note).not.toContain("refs/heads/main");
  });

  test("Code Storage pushes the branch as the change request", () => {
    const note = buildWorktreePublicationNote({
      ...base,
      repo: storageRepo,
      mode: "pull-request",
    });
    expect(note).toContain("a pushed branch IS the change request");
    expect(note).not.toContain("gh pr create");
  });

  test("a stacked branch has no trunk conflict note", () => {
    const note = buildWorktreePublicationNote({
      ...base,
      repo: prRepo,
      mode: "pull-request",
      stacked: true,
    });
    expect(note).not.toContain("## Merge conflicts");
  });
});

describe("unattended flows never push to the default branch", () => {
  test("goals on a direct repository still open a PR", () => {
    const text = buildGoalShippingInstructions({
      repo: { ...directRepo, sharedCheckout: false },
      cwd: "/w/goal",
    });
    expect(text).toContain("gh pr create --base trunk");
    expect(text).toContain("NEVER merge");
  });

  test("security scans open one change request per finding", () => {
    const pr = scanPublication({ ...directRepo, ghRepo: "acme/app" }, "OS");
    expect(pr.publishStep).toContain(
      "gh pr create --repo acme/app --base trunk",
    );
    expect(pr.publishStep).toContain("NEVER run `gh pr merge`");
    const cs = scanPublication({ ...storageRepo, ghRepo: "" }, "OS");
    expect(cs.publishStep).toContain("a pushed branch IS the change request");
    expect(cs.publishStep).not.toContain("gh pr");
  });
});

describe("Ship button", () => {
  test("direct: checks, integrates the trunk, pushes, watches the rollout", () => {
    const prompt = buildShipPrompt({
      repo: directRepo,
      mode: "direct",
      checkout: "worktree",
    });
    expect(prompt).toContain("required checks");
    expect(prompt).toContain("integrate `origin/trunk`");
    expect(prompt).toContain("git push origin HEAD:refs/heads/trunk");
    expect(prompt).toContain("watch the rollout");
    expect(prompt).toContain("never force-push");
  });

  test("pull-request: opens the PR, or updates the open one", () => {
    expect(
      buildShipPrompt({
        repo: prRepo,
        mode: "pull-request",
        checkout: "worktree",
      }),
    ).toBe("Commit any remaining work, push the branch, and open a PR for it.");
    const update = buildShipPrompt({
      repo: prRepo,
      mode: "pull-request",
      checkout: "worktree",
      openPr: { number: 42 },
    });
    expect(update).toContain("update PR #42");
    expect(update).toContain("Don't merge it");
  });

  test("buttons put Ship first, then the repository's own", () => {
    const buttons = buildShipButtons({
      repo: prRepo,
      mode: "pull-request",
      checkout: "worktree",
      openPr: { number: 7 },
      custom: [{ label: "Rebase", prompt: "Rebase onto origin/main." }],
    });
    expect(buttons.map((b) => [b.id, b.label, !!b.primary])).toEqual([
      ["ship", "Update PR", true],
      ["custom-0", "Rebase", false],
    ]);
    expect(
      buildShipButtons({
        repo: directRepo,
        mode: "direct",
        checkout: "worktree",
      })[0].label,
    ).toBe("Ship");
  });

  test("parseShipActions drops malformed entries and caps the list", () => {
    expect(parseShipActions("nope")).toBeUndefined();
    expect(
      parseShipActions([
        { label: " Ship & monitor ", prompt: " Ship it, then watch. " },
        { label: "", prompt: "x" },
        { label: "No prompt" },
        null,
        ...Array.from({ length: 10 }, (_, i) => ({
          label: `A${i}`,
          prompt: "p",
        })),
      ]),
    ).toHaveLength(6);
    expect(
      parseShipActions([{ label: " Ship & monitor ", prompt: " Watch. " }]),
    ).toEqual([{ label: "Ship & monitor", prompt: "Watch." }]);
  });
});
