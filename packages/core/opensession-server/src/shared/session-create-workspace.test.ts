import { describe, expect, test } from "bun:test";
import { canJoinCreateWorkspace } from "./session-create-workspace";

const codeWorkspace = {
  repo: "acme-app",
  branch: "feature",
  worktreeDir: "/tmp/acme-app-feature",
};

describe("create workspace compatibility", () => {
  test.each(["code", "ask", "scratch"] as const)(
    "%s cannot cross repository boundaries",
    (mode) => {
      expect(
        canJoinCreateWorkspace(codeWorkspace, { repo: "acme-docs", mode }),
      ).toBe(false);
      expect(
        canJoinCreateWorkspace(
          { repo: "acme-app" },
          { repo: "acme-docs", mode },
        ),
      ).toBe(false);
    },
  );

  test("code can share or stack in its own repository", () => {
    expect(
      canJoinCreateWorkspace(codeWorkspace, { repo: "acme-app", mode: "code" }),
    ).toBe(true);
  });

  test("a pinned Ask checkout cannot join even a same-repo owned worktree", () => {
    expect(
      canJoinCreateWorkspace(codeWorkspace, { repo: "acme-app", mode: "ask" }),
    ).toBe(false);
    expect(
      canJoinCreateWorkspace(
        { repo: "acme-app" },
        { repo: "acme-app", mode: "ask" },
      ),
    ).toBe(true);
  });

  test("a PR Ask may join only its own branch's worktree", () => {
    expect(
      canJoinCreateWorkspace(codeWorkspace, {
        repo: "acme-app",
        mode: "ask",
        fromPr: true,
        branch: "feature",
      }),
    ).toBe(true);
    expect(
      canJoinCreateWorkspace(codeWorkspace, {
        repo: "acme-app",
        mode: "ask",
        fromPr: true,
        branch: "other",
      }),
    ).toBe(false);
    expect(
      canJoinCreateWorkspace(codeWorkspace, {
        repo: "acme-docs",
        mode: "ask",
        fromPr: true,
        branch: "feature",
      }),
    ).toBe(false);
  });

  test("repo-less asks and scratch sessions stay repo-less and share scratch destinations", () => {
    for (const mode of ["ask", "scratch"] as const) {
      expect(canJoinCreateWorkspace(codeWorkspace, { mode })).toBe(false);
      expect(canJoinCreateWorkspace({}, { mode })).toBe(true);
      expect(
        canJoinCreateWorkspace({ worktreeDir: "/tmp/acme-scratch" }, { mode }),
      ).toBe(true);
      expect(
        canJoinCreateWorkspace(
          { branch: "feature", worktreeDir: "/tmp/acme-code" },
          { mode },
        ),
      ).toBe(false);
    }
    expect(canJoinCreateWorkspace({}, { repo: "acme-app", mode: "code" })).toBe(
      false,
    );
  });
});
