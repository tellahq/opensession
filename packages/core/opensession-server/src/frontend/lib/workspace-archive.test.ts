import { describe, expect, test } from "bun:test";
import { workspaceArchivedSessions } from "./workspace-archive";
import type { UnifiedSession } from "./types";

const session = (
  over: Partial<UnifiedSession> & { id: string },
): UnifiedSession => ({
  claudeSessionId: null,
  source: "opensession",
  branch: null,
  worktreeDir: null,
  startedBy: null,
  title: over.id,
  lastActivity: "2026-08-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  isRunning: false,
  transcriptPath: "",
  ...over,
});

const WT = "/home/ubuntu/worktrees/tella-fusion-codex/rehome-setup-controls";

describe("workspaceArchivedSessions", () => {
  test("lists the workspace's own archived sessions, newest first", () => {
    const rows = workspaceArchivedSessions({
      sessions: [
        session({ id: "live", workspaceId: "ws-1" }),
        session({
          id: "old",
          workspaceId: "ws-1",
          archived: true,
          lastActivity: "2026-07-01T00:00:00.000Z",
        }),
        session({
          id: "new",
          workspaceId: "ws-1",
          archived: true,
          lastActivity: "2026-07-09T00:00:00.000Z",
        }),
        session({ id: "elsewhere", workspaceId: "ws-2", archived: true }),
      ],
      workspaceId: "ws-1",
    });
    expect(rows.map((s) => s.id)).toEqual(["new", "old"]);
  });

  test("adopts a duplicate workspace's sessions through the shared worktree", () => {
    // The case this exists for: a PR with a hand-made workspace and the
    // agent's `ghpr-` one, whose closed tabs are filed under the second.
    const rows = workspaceArchivedSessions({
      sessions: [],
      fetched: [
        session({
          id: "sibling",
          workspaceId: "ws-ghpr",
          archived: true,
          worktreeDir: WT,
        }),
      ],
      workspaceId: "ws-mine",
      worktreeDir: WT,
    });
    expect(rows.map((s) => s.id)).toEqual(["sibling"]);
  });

  test("a shared checkout does not group sessions", () => {
    const shared = "/home/ubuntu/projects/opensession";
    expect(
      workspaceArchivedSessions({
        sessions: [
          session({ id: "other", archived: true, worktreeDir: shared }),
        ],
        workspaceId: "ws-mine",
        worktreeDir: shared,
      }),
    ).toEqual([]);
  });

  test("groups a workspace-less session by its isolated worktree", () => {
    const rows = workspaceArchivedSessions({
      sessions: [session({ id: "closed", archived: true, worktreeDir: WT })],
      workspaceId: null,
      worktreeDir: WT,
    });
    expect(rows.map((s) => s.id)).toEqual(["closed"]);
  });

  test("the open session keeps its live tab, so it never lists", () => {
    expect(
      workspaceArchivedSessions({
        sessions: [
          session({ id: "open", workspaceId: "ws-1", archived: true }),
        ],
        workspaceId: "ws-1",
        excludeId: "open",
      }),
    ).toEqual([]);
  });

  test("keeps automated and worker sessions", () => {
    const rows = workspaceArchivedSessions({
      sessions: [
        session({
          id: "worker",
          workspaceId: "ws-1",
          archived: true,
          parentSessionId: "p",
        }),
        session({
          id: "review",
          workspaceId: "ws-1",
          archived: true,
          automation: "github",
        }),
      ],
      workspaceId: "ws-1",
    });
    expect(rows.map((s) => s.id).sort()).toEqual(["review", "worker"]);
  });

  test("a session archived here lists before the fetch catches up", () => {
    const rows = workspaceArchivedSessions({
      sessions: [
        session({ id: "justClosed", workspaceId: "ws-1", archived: true }),
      ],
      fetched: [],
      workspaceId: "ws-1",
    });
    expect(rows.map((s) => s.id)).toEqual(["justClosed"]);
  });

  test("the in-memory row wins over the slim fetched copy", () => {
    const rows = workspaceArchivedSessions({
      sessions: [
        session({
          id: "a",
          workspaceId: "ws-1",
          archived: true,
          title: "Renamed",
        }),
      ],
      fetched: [
        session({
          id: "a",
          workspaceId: "ws-1",
          archived: true,
          title: "Stale",
          slim: true,
        }),
      ],
      workspaceId: "ws-1",
    });
    expect(rows.map((s) => s.title)).toEqual(["Renamed"]);
  });

  test("a session restored here does not come back from a stale fetch", () => {
    const rows = workspaceArchivedSessions({
      sessions: [session({ id: "a", workspaceId: "ws-1" })],
      fetched: [session({ id: "a", workspaceId: "ws-1", archived: true })],
      workspaceId: "ws-1",
    });
    expect(rows).toEqual([]);
  });

  test("no workspace and no isolated worktree means no history", () => {
    expect(
      workspaceArchivedSessions({
        sessions: [session({ id: "a", archived: true })],
        fetched: [session({ id: "b", archived: true })],
        workspaceId: null,
      }),
    ).toEqual([]);
  });
});
