import { describe, expect, it } from "bun:test";
import {
  findPrSessionId,
  findPrWorkspaceId,
  workspaceBranchList,
  workspaceCarriesPr,
} from "./pr-workspace";
import type { UnifiedSession, Workspace } from "./types";

const ws = (w: Partial<Workspace> & { id: string }): Workspace => ({
  name: w.id,
  createdBy: "someone",
  createdAt: new Date().toISOString(),
  ...w,
});

const session = (
  s: Partial<UnifiedSession> & { id: string },
): UnifiedSession => ({
  source: "opensession",
  branch: null,
  worktreeDir: null,
  startedBy: null,
  title: s.id,
  lastActivity: s.createdAt ?? new Date().toISOString(),
  createdAt: new Date().toISOString(),
  isRunning: false,
  ...s,
});

describe("workspaceCarriesPr", () => {
  it("matches either the PR number or branch within the same repo", () => {
    const workspace = ws({
      id: "w1",
      repo: "opensession",
      prNumber: 8,
      branch: "fix-sidebar",
    });

    expect(
      workspaceCarriesPr(workspace, { repo: "opensession", number: 8 }),
    ).toBe(true);
    expect(
      workspaceCarriesPr(workspace, {
        repo: "opensession",
        branch: "fix-sidebar",
      }),
    ).toBe(true);
  });

  it("matches a PR on any of the workspace's other branches", () => {
    const workspace = ws({
      id: "w1",
      repo: "opensession",
      branch: "coordinator",
      branches: [
        { repo: "opensession", branch: "thread-a", at: "2026-11-08T00:00:00Z" },
      ],
    });
    expect(
      workspaceCarriesPr(workspace, {
        repo: "opensession",
        branch: "thread-a",
      }),
    ).toBe(true);
    expect(
      workspaceCarriesPr(workspace, {
        repo: "opensession",
        branch: "thread-b",
      }),
    ).toBe(false);
  });

  it("does not match another repository", () => {
    expect(
      workspaceCarriesPr(ws({ id: "w1", repo: "tella-fusion", prNumber: 8 }), {
        repo: "opensession",
        number: 8,
      }),
    ).toBe(false);
  });
});

describe("workspaceBranchList", () => {
  it("lists the primary first, then each other branch once", () => {
    const at = "2026-11-08T00:00:00Z";
    expect(
      workspaceBranchList(
        ws({
          id: "w1",
          repo: "acme",
          branch: "main-work",
          branches: [
            { repo: "acme", branch: "main-work", at },
            { repo: "acme", branch: "thread-a", at },
          ],
        }),
      ),
    ).toEqual([
      { repo: "acme", branch: "main-work" },
      { repo: "acme", branch: "thread-a" },
    ]);
  });

  it("a coordinator workspace with no checkout lists only its threads' branches", () => {
    expect(
      workspaceBranchList(
        ws({
          id: "w1",
          repo: "acme",
          branches: [{ repo: "acme", branch: "thread-a", at: "x" }],
        }),
      ),
    ).toEqual([{ repo: "acme", branch: "thread-a" }]);
  });
});

describe("findPrWorkspaceId", () => {
  it("prefers the session that opened the PR over an empty PR workspace", () => {
    const workspaces = [
      ws({ id: "ws-pr", repo: "skills", prNumber: 13, branch: "motion" }),
      ws({ id: "ws-work", repo: "tella-fusion", branch: "motion" }),
    ];
    const prs: UnifiedSession["prs"] = [
      { repo: "skills", branch: "motion", number: 13, source: "discovered" },
    ];
    const sessions = [
      session({
        id: "os-person",
        repo: "tella-fusion",
        branch: "motion",
        workspaceId: "ws-work",
        createdAt: "2026-10-20T15:00:00.000Z",
        prs,
      }),
      // The review run filed under the PR workspace is newer.
      session({
        id: "bks-ghpr-skills-13-review",
        repo: "skills",
        branch: "motion",
        workspaceId: "ws-pr",
        createdAt: "2026-10-20T16:00:00.000Z",
        automation: "github-pr-review",
      }),
    ];

    expect(
      findPrWorkspaceId(workspaces, sessions, { repo: "skills", number: 13 }),
    ).toBe("ws-work");
    // Once a person works in the PR workspace, it is the PR's home again.
    expect(
      findPrWorkspaceId(
        workspaces,
        [...sessions, session({ id: "os-later", workspaceId: "ws-pr" })],
        { repo: "skills", number: 13 },
      ),
    ).toBe("ws-pr");
  });

  it("matches a workspace minted for the PR number", () => {
    const workspaces = [
      ws({ id: "w1", repo: "opensession", prNumber: 7, branch: "a" }),
      ws({ id: "w2", repo: "opensession", prNumber: 8, branch: "b" }),
    ];
    expect(
      findPrWorkspaceId(workspaces, [], { repo: "opensession", number: 8 }),
    ).toBe("w2");
  });

  it("leaves a number-only workspace for the server to resolve", () => {
    const workspaces = [ws({ id: "w1", repo: "opensession", prNumber: 8 })];
    expect(
      findPrWorkspaceId(workspaces, [], { repo: "opensession", number: 8 }),
    ).toBeNull();
  });

  it("does not match the same number in another repo", () => {
    const workspaces = [
      ws({ id: "w1", repo: "acme", prNumber: 8, branch: "b" }),
    ];
    expect(
      findPrWorkspaceId(workspaces, [], { repo: "opensession", number: 8 }),
    ).toBeNull();
  });

  it("falls back to a workspace on the PR branch", () => {
    const workspaces = [ws({ id: "w1", repo: "opensession", branch: "fix-x" })];
    expect(
      findPrWorkspaceId(workspaces, [], {
        repo: "opensession",
        branch: "fix-x",
      }),
    ).toBe("w1");
  });

  it("finds the workspace of the newest session carrying the PR", () => {
    const workspaces = [ws({ id: "w1" }), ws({ id: "w2" })];
    const sessions = [
      session({
        id: "s1",
        workspaceId: "w1",
        repo: "opensession",
        branch: "old",
        prNumber: 9,
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      session({
        id: "s2",
        workspaceId: "w2",
        repo: "opensession",
        branch: "new",
        prNumber: 9,
        createdAt: "2026-08-10T00:00:00.000Z",
      }),
    ];
    expect(
      findPrWorkspaceId(workspaces, sessions, {
        repo: "opensession",
        number: 9,
      }),
    ).toBe("w2");
  });

  it("ignores archived sessions", () => {
    const workspaces = [ws({ id: "w1" })];
    const sessions = [
      session({
        id: "s1",
        workspaceId: "w1",
        repo: "opensession",
        prNumber: 9,
        branch: "b",
        archived: true,
      }),
    ];
    expect(
      findPrWorkspaceId(workspaces, sessions, {
        repo: "opensession",
        number: 9,
      }),
    ).toBeNull();
  });

  it("returns null when the carrier's workspace is not loaded yet", () => {
    const sessions = [
      session({
        id: "s1",
        workspaceId: "w-unknown",
        repo: "opensession",
        prNumber: 9,
        branch: "b",
      }),
    ];
    expect(
      findPrWorkspaceId([], sessions, { repo: "opensession", number: 9 }),
    ).toBeNull();
  });
});

describe("findPrSessionId", () => {
  const prs: UnifiedSession["prs"] = [
    { repo: "acme", branch: "feat", number: 42, source: "discovered" },
  ];
  it("picks the newest live person session in the workspace carrying the PR", () => {
    const sessions = [
      session({
        id: "os-old",
        workspaceId: "w1",
        prs,
        createdAt: "2026-11-01T00:00:00Z",
      }),
      session({
        id: "os-new",
        workspaceId: "w1",
        prs,
        createdAt: "2026-11-02T00:00:00Z",
      }),
      session({
        id: "os-gone",
        workspaceId: "w1",
        prs,
        archived: true,
        createdAt: "2026-11-03T00:00:00Z",
      }),
      session({
        id: "bks-ghpr-acme-42-review",
        workspaceId: "w1",
        prs,
        createdAt: "2026-11-04T00:00:00Z",
      }),
      session({
        id: "os-other",
        workspaceId: "w2",
        prs,
        createdAt: "2026-11-05T00:00:00Z",
      }),
      session({
        id: "os-unrelated",
        workspaceId: "w1",
        createdAt: "2026-11-06T00:00:00Z",
      }),
    ];
    expect(findPrSessionId(sessions, "w1", { repo: "acme", number: 42 })).toBe(
      "os-new",
    );
  });

  it("ignores a review run when it is the only carrier", () => {
    const sessions = [
      session({ id: "bks-ghpr-acme-42-review", workspaceId: "w1", prs }),
    ];
    expect(
      findPrSessionId(sessions, "w1", { repo: "acme", number: 42 }),
    ).toBeNull();
  });

  it("returns null when no session in the workspace carries it", () => {
    const sessions = [session({ id: "os-a", workspaceId: "w1" })];
    expect(
      findPrSessionId(sessions, "w1", { repo: "acme", number: 42 }),
    ).toBeNull();
  });
});
