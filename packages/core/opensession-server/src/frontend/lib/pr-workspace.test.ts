import { describe, expect, it } from "bun:test";
import { findPrWorkspaceId, workspaceCarriesPr } from "./pr-workspace";
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

  it("does not match another repository", () => {
    expect(
      workspaceCarriesPr(ws({ id: "w1", repo: "tella-fusion", prNumber: 8 }), {
        repo: "opensession",
        number: 8,
      }),
    ).toBe(false);
  });
});

describe("findPrWorkspaceId", () => {
  it("matches a workspace minted for the PR number", () => {
    const workspaces = [
      ws({ id: "w1", repo: "opensession", prNumber: 7 }),
      ws({ id: "w2", repo: "opensession", prNumber: 8 }),
    ];
    expect(
      findPrWorkspaceId(workspaces, [], { repo: "opensession", number: 8 }),
    ).toBe("w2");
  });

  it("does not match the same number in another repo", () => {
    const workspaces = [ws({ id: "w1", repo: "tella-fusion", prNumber: 8 })];
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
