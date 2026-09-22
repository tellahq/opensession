import { describe, expect, test } from "bun:test";
import { NO_REPO } from "./session-repo";
import {
  newSessionDefaultRepo,
  refreshedNewSessionRepo,
  newSessionWorkspaceScope,
  newSessionWorkspaceDestination,
} from "./new-session-repo";

describe("newSessionDefaultRepo", () => {
  test("starts in Scratch when no repositories are registered", () => {
    expect(newSessionDefaultRepo([], "")).toBe(NO_REPO);
  });

  test("keeps an available workspace choice", () => {
    expect(
      newSessionDefaultRepo(
        [{ id: "app", default: true }, { id: "docs" }],
        "docs",
      ),
    ).toBe("docs");
  });

  test("falls back to the registered default", () => {
    expect(
      newSessionDefaultRepo(
        [{ id: "app", default: true }, { id: "docs" }],
        "missing",
      ),
    ).toBe("app");
  });

  test("falls back to the first repository when none is flagged", () => {
    expect(newSessionDefaultRepo([{ id: "app" }, { id: "docs" }], "auto")).toBe(
      "app",
    );
  });
});

describe("repository refresh in a workspace composer", () => {
  const options = [{ id: "original" }, { id: "created" }];

  test("keeps the newly registered repository instead of restoring the scoped one", () => {
    expect(
      refreshedNewSessionRepo("created", options, "original", "original"),
    ).toBe("created");
    expect(
      refreshedNewSessionRepo("created", [...options], "original", "original"),
    ).toBe("created");
  });

  test("keeps the original workspace and explicit no-repo choices", () => {
    expect(
      refreshedNewSessionRepo("original", options, "created", "original"),
    ).toBe("original");
    expect(
      refreshedNewSessionRepo(NO_REPO, options, "original", "original"),
    ).toBe(NO_REPO);
  });

  test("falls back only when the selection is unavailable", () => {
    expect(
      refreshedNewSessionRepo("missing", options, "created", "original"),
    ).toBe("original");
    expect(refreshedNewSessionRepo("missing", options, "created", "gone")).toBe(
      "created",
    );
  });
});

describe("workspace composer project scope", () => {
  const scope = {
    repo: "original",
    workspaceId: "workspace-original",
    forceBranch: "existing-branch",
  };

  test("a new project inherits neither the old workspace nor its branch", () => {
    expect(newSessionWorkspaceScope("created", scope)).toEqual({});
  });

  test("the original project still shares its workspace and branch", () => {
    expect(newSessionWorkspaceScope("original", scope)).toEqual({
      workspaceId: "workspace-original",
      forceBranch: "existing-branch",
    });
  });

  test("repo-less workspace scopes remain usable", () => {
    expect(
      newSessionWorkspaceScope(NO_REPO, { workspaceId: "scratch" }),
    ).toEqual({
      workspaceId: "scratch",
      forceBranch: undefined,
    });
  });
});

describe("create destination after palette changes", () => {
  const workspaces = [
    {
      id: "ws-app",
      repo: "acme-app",
      branch: "feature",
      worktreeDir: "/tmp/acme-app-feature",
    },
  ];

  test("scoped repo changes and dropping the repo release both destination and branch", () => {
    const scope = {
      repo: "acme-app",
      workspaceId: "ws-app",
      forceBranch: "feature",
    };
    for (const repo of ["acme-docs", NO_REPO]) {
      expect(newSessionWorkspaceScope(repo, scope)).toEqual({});
      expect(
        newSessionWorkspaceDestination(
          workspaces,
          scope.workspaceId,
          repo,
          "ask",
        ),
      ).toBeUndefined();
    }
    expect(
      newSessionWorkspaceScope("acme-app", { workspaceId: "ws-scratch" }),
    ).toEqual({});
  });

  test("same-repo Ask releases a code workspace but Code retains it", () => {
    expect(
      newSessionWorkspaceDestination(workspaces, "ws-app", "acme-app", "ask"),
    ).toBeUndefined();
    expect(
      newSessionWorkspaceDestination(workspaces, "ws-app", "acme-app", "code"),
    ).toBe("ws-app");
    expect(
      newSessionWorkspaceDestination(workspaces, "ws-app", "acme-app", "ask", {
        branch: "feature",
      }),
    ).toBe("ws-app");
  });

  test("missing workspace metadata cannot authorize optimistic adoption", () => {
    expect(
      newSessionWorkspaceDestination([], "ws-app", "acme-app", "code"),
    ).toBeUndefined();
  });
});
