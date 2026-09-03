import { describe, expect, test } from "bun:test";
import {
  repoSelectionHint,
  toggleRepoSelection,
  type RepoSelection,
} from "./repo-selection";

describe("toggleRepoSelection", () => {
  test("adds a repo beside the session's own, in pick order", () => {
    let selection: RepoSelection = { repo: "tella-fusion", extras: [] };
    selection = toggleRepoSelection(selection, "gitops");
    selection = toggleRepoSelection(selection, "infra");
    expect(selection).toEqual({
      repo: "tella-fusion",
      extras: ["gitops", "infra"],
    });
  });

  test("removes an attached repo without disturbing the rest", () => {
    expect(
      toggleRepoSelection(
        { repo: "tella-fusion", extras: ["gitops", "infra"] },
        "gitops",
      ),
    ).toEqual({ repo: "tella-fusion", extras: ["infra"] });
  });

  test("removing the session's own repo promotes the next one", () => {
    expect(
      toggleRepoSelection(
        { repo: "tella-fusion", extras: ["gitops", "infra"] },
        "tella-fusion",
      ),
    ).toEqual({ repo: "gitops", extras: ["infra"] });
  });

  test("refuses to leave nothing picked", () => {
    const only: RepoSelection = { repo: "tella-fusion", extras: [] };
    expect(toggleRepoSelection(only, "tella-fusion")).toBe(only);
  });
});

describe("repoSelectionHint", () => {
  const label = (id: string) => (id === "gitops" ? "GitOps" : id);

  test("teaches the gesture while one repo is picked", () => {
    expect(repoSelectionHint([], label, "⌘")).toBe(
      "⌘-click to work in more than one repo.",
    );
  });

  test("names the attached repos once there are some", () => {
    expect(repoSelectionHint(["gitops"], label, "⌘")).toBe(
      "Also working in GitOps.",
    );
    expect(repoSelectionHint(["gitops", "infra"], label, "Ctrl")).toBe(
      "Also working in GitOps and infra.",
    );
    expect(
      repoSelectionHint(["gitops", "infra", "tella-mac"], label, "⌘"),
    ).toBe("Also working in GitOps, infra and tella-mac.");
  });
});
