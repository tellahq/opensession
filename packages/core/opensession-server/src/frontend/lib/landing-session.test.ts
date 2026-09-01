import { describe, expect, test } from "bun:test";
import {
  sessionNeverRan,
  defaultSessionWorkspaceView,
  mainSession,
  newSessionSource,
  workspaceLandingReady,
  workspaceSessionSeed,
  pinMainSessionFirst,
  pickLandingSession,
} from "./landing-session";
import type { UnifiedSession } from "./types";

function session(over: Partial<UnifiedSession>): UnifiedSession {
  return {
    id: "bks-x",
    source: "opensession",
    title: "New session",
    createdAt: "2026-07-01T00:00:00.000Z",
    lastActivity: "2026-07-01T00:00:00.000Z",
    isRunning: false,
    ...over,
  } as UnifiedSession;
}

describe("sessionNeverRan", () => {
  test("true for an untouched New session shell", () => {
    expect(sessionNeverRan(session({}))).toBe(true);
  });
  test("false once the session has run a turn", () => {
    expect(sessionNeverRan(session({ ran: true }))).toBe(false);
  });
  test("false when the tab contains a duplicated chat", () => {
    expect(
      sessionNeverRan(session({ duplicatedFromSessionId: "bks-source" })),
    ).toBe(false);
  });
  test("false while running or queued", () => {
    expect(sessionNeverRan(session({ isRunning: true }))).toBe(false);
    expect(sessionNeverRan(session({ queuedCount: 1 }))).toBe(false);
  });
  test("false once activity moved past creation", () => {
    expect(
      sessionNeverRan(session({ lastActivity: "2026-07-02T00:00:00.000Z" })),
    ).toBe(false);
  });
});

describe("defaultSessionWorkspaceView", () => {
  test("session-less PR-backed workspaces land on Review", () => {
    expect(
      defaultSessionWorkspaceView({ key: "ghpr-4972" }, false, false),
    ).toBe("review");
    expect(defaultSessionWorkspaceView({ prNumber: 4972 }, false, false)).toBe(
      "review",
    );
  });

  test("PR workspaces with sessions, plain workspaces, and dismissed Review tabs land on session", () => {
    expect(
      defaultSessionWorkspaceView({ key: "ghpr-4972" }, false, true),
    ).toBeNull();
    expect(
      defaultSessionWorkspaceView({ key: "plain-th_123" }, false, false),
    ).toBeNull();
    expect(
      defaultSessionWorkspaceView({ key: "ghpr-4972" }, true, false),
    ).toBeNull();
  });
});

describe("workspaceLandingReady", () => {
  test("waits for sessions before deciding a workspace is session-less", () => {
    expect(workspaceLandingReady(true, true)).toBe(false);
    expect(workspaceLandingReady(false, false)).toBe(false);
    expect(workspaceLandingReady(true, false)).toBe(true);
  });
});

describe("mainSession", () => {
  test("prefers the oldest human session that actually ran", () => {
    const review = session({
      id: "bks-ghpr-42-review",
      workspaceId: "ws-1",
      automation: "github-pr-review",
      ran: true,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const shell = session({
      id: "shell",
      workspaceId: "ws-1",
      createdAt: "2026-07-02T00:00:00.000Z",
      lastActivity: "2026-07-02T00:00:00.000Z",
    });
    const human = session({
      id: "human",
      workspaceId: "ws-1",
      ran: true,
      createdAt: "2026-07-03T00:00:00.000Z",
    });
    expect(mainSession([review, shell, human])?.id).toBe("human");
  });

  test("pins the main session ahead of a persisted sibling order", () => {
    const main = session({ id: "main", ran: true });
    const sibling = session({
      id: "sibling",
      ran: true,
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    expect(pinMainSessionFirst([main, sibling], ["sibling", "main"])).toEqual([
      "main",
      "sibling",
    ]);
  });
});

describe("newSessionSource", () => {
  test("uses archived history when Review is the workspace's only tab", () => {
    const archived = session({ id: "archived", archived: true, ran: true });
    expect(newSessionSource(null, [], [archived])).toBe(archived);
  });

  test("prefers the open or live session over archived history", () => {
    const current = session({ id: "current", ran: true });
    const live = session({ id: "live", ran: true });
    const archived = session({ id: "archived", archived: true, ran: true });
    expect(newSessionSource(current, [live], [archived])).toBe(current);
    expect(newSessionSource(null, [live], [archived])).toBe(live);
  });
});

describe("workspaceSessionSeed", () => {
  test("projects a Review-only workspace into an immediate local tab", () => {
    const seed = workspaceSessionSeed(
      {
        id: "ws-1",
        name: "Review PR 42",
        repo: "opensession",
        branch: "fix-tabs",
        worktreeDir: "/tmp/fix-tabs",
        createdBy: "Kent",
        createdAt: "2026-08-22T09:00:00.000Z",
      },
      "Kent",
    );
    expect(seed).toMatchObject({
      id: "workspace:ws-1",
      workspaceId: "ws-1",
      repo: "opensession",
      branch: "fix-tabs",
      worktreeDir: "/tmp/fix-tabs",
      mode: "code",
      startedBy: "Kent",
    });
  });
});

describe("pickLandingSession", () => {
  const wsId = "ws-1";
  test("oldest live session with content wins", () => {
    const a = session({
      id: "a",
      workspaceId: wsId,
      ran: true,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const b = session({
      id: "b",
      workspaceId: wsId,
      ran: true,
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    expect(pickLandingSession([b, a], wsId)?.id).toBe("a");
  });
  test("empty shell loses to archived history (lost-history bug)", () => {
    const shell = session({
      id: "shell",
      workspaceId: wsId,
      createdAt: "2026-07-23T00:00:00.000Z",
      lastActivity: "2026-07-23T00:00:00.000Z",
    });
    const real = session({
      id: "real",
      workspaceId: wsId,
      ran: true,
      archived: true,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastActivity: "2026-07-10T00:00:00.000Z",
    });
    expect(pickLandingSession([shell, real], wsId)?.id).toBe("real");
  });
  test("newest archived conversation wins among archived", () => {
    const older = session({
      id: "older",
      workspaceId: wsId,
      ran: true,
      archived: true,
      lastActivity: "2026-07-05T00:00:00.000Z",
    });
    const newer = session({
      id: "newer",
      workspaceId: wsId,
      ran: true,
      archived: true,
      lastActivity: "2026-07-10T00:00:00.000Z",
    });
    expect(pickLandingSession([older, newer], wsId)?.id).toBe("newer");
  });
  test("a shell still wins when the workspace has no history anywhere", () => {
    const shell = session({ id: "shell", workspaceId: wsId });
    expect(pickLandingSession([shell], wsId)?.id).toBe("shell");
  });
  test("remembered session wins over the oldest live session", () => {
    const a = session({
      id: "a",
      workspaceId: wsId,
      ran: true,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const b = session({
      id: "b",
      workspaceId: wsId,
      ran: true,
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    expect(pickLandingSession([a, b], wsId, "b")?.id).toBe("b");
  });
  test("a stale remembered id (archived / other workspace) falls back", () => {
    const live = session({ id: "live", workspaceId: wsId, ran: true });
    const gone = session({
      id: "gone",
      workspaceId: wsId,
      ran: true,
      archived: true,
    });
    expect(pickLandingSession([live, gone], wsId, "gone")?.id).toBe("live");
    expect(pickLandingSession([live], wsId, "elsewhere")?.id).toBe("live");
  });
  test("sessions in other workspaces are ignored", () => {
    const other = session({
      id: "other",
      workspaceId: "ws-2",
      ran: true,
    });
    expect(pickLandingSession([other], wsId)).toBeUndefined();
  });
});
