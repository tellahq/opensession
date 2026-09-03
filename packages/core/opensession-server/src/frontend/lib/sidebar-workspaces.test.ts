import { describe, expect, test } from "bun:test";
import {
  subagentsByWorkspace,
  subagentsForWorkspace,
  isAskWorkspace,
  isScratchWorkspace,
  sessionSharesSelectedSidebarGroup,
  sidebarWorkspaceIdForSession,
  spawnedSessionBelongsInSidebar,
  subagentsForSelectedWorkspace,
  workspaceMainSession,
  workspaceRowOwnsSelection,
  workspaceRowOwnsSession,
  workspaceRowShipsDirectlyToMain,
} from "./sidebar-workspaces";
import type { UnifiedSession } from "./types";

function session(
  id: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    claudeSessionId: null,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Michiel",
    title: id,
    lastActivity: "2026-08-18T10:00:00Z",
    createdAt: `2026-08-18T10:00:0${id.length}Z`,
    isRunning: false,
    transcriptPath: null,
    ...overrides,
  };
}

describe("isScratchWorkspace", () => {
  test("recognizes a workspace containing scratch sessions", () => {
    expect(isScratchWorkspace([{ mode: "scratch" }, { mode: "scratch" }])).toBe(
      true,
    );
  });

  test("does not treat repo-backed or empty workspaces as scratch", () => {
    expect(isScratchWorkspace([{ mode: "scratch" }, { mode: "code" }])).toBe(
      false,
    );
    expect(isScratchWorkspace([])).toBe(false);
  });
});

describe("isAskWorkspace", () => {
  test("recognizes a workspace of repo-less ask sessions", () => {
    expect(
      isAskWorkspace([
        { mode: "ask", repoLess: true },
        { mode: "ask", repoLess: true },
      ]),
    ).toBe(true);
  });

  test("a repo-scoped ask session stays in its repo's band", () => {
    // The regression this guards: thousands of older ask sessions record no
    // repo yet sit in a real checkout, so a `!repo` test would empty every
    // project band into the Ask band. Only the stored decision counts.
    expect(isAskWorkspace([{ mode: "ask" }])).toBe(false);
    expect(isAskWorkspace([{ mode: "ask", repoLess: false }])).toBe(false);
  });

  test("scratch is repo-less but is not Ask", () => {
    expect(isAskWorkspace([{ mode: "scratch", repoLess: true }])).toBe(false);
  });

  test("a mixed or empty workspace is not an Ask workspace", () => {
    expect(
      isAskWorkspace([{ mode: "ask", repoLess: true }, { mode: "code" }]),
    ).toBe(false);
    expect(isAskWorkspace([])).toBe(false);
  });
});

describe("workspaceRowShipsDirectlyToMain", () => {
  const directToMainBranches = { opensession: "main" };

  test("uses the sessions when a bare workspace names another repo", () => {
    expect(
      workspaceRowShipsDirectlyToMain(
        {
          workspace: {},
          sessions: [
            session("shared-main", { repo: "opensession", branch: "main" }),
          ],
        },
        "tella-fusion",
        directToMainBranches,
      ),
    ).toBe(true);
  });

  test("keeps an explicit workspace branch authoritative", () => {
    expect(
      workspaceRowShipsDirectlyToMain(
        {
          workspace: { branch: "feature" },
          sessions: [
            session("shared-main", { repo: "opensession", branch: "main" }),
          ],
        },
        "tella-fusion",
        directToMainBranches,
      ),
    ).toBe(false);
  });

  test("requires every repo-backed session to ship directly", () => {
    expect(
      workspaceRowShipsDirectlyToMain(
        {
          workspace: {},
          sessions: [
            session("shared-main", { repo: "opensession", branch: "main" }),
            session("feature", { repo: "tella-fusion", branch: "feature" }),
          ],
        },
        "tella-fusion",
        directToMainBranches,
      ),
    ).toBe(false);
  });
});

describe("spawnedSessionBelongsInSidebar", () => {
  test("keeps an unclaimed spawned deep link out of the sidebar", () => {
    expect(
      spawnedSessionBelongsInSidebar({ spawnedBy: "parent" }, false, false),
    ).toBe(false);
  });

  test("includes spawned sessions that need attention or were claimed", () => {
    const session = { spawnedBy: "parent" };
    expect(spawnedSessionBelongsInSidebar(session, true, false)).toBe(true);
    expect(spawnedSessionBelongsInSidebar(session, false, true)).toBe(true);
  });
});

describe("sessionSharesSelectedSidebarGroup", () => {
  test("keeps the complete selected workspace through sidebar filters", () => {
    const selected = session("selected", { workspaceId: "ws-selected" });
    expect(
      sessionSharesSelectedSidebarGroup(
        session("sibling", { workspaceId: "ws-selected" }),
        selected,
      ),
    ).toBe(true);
    expect(
      sessionSharesSelectedSidebarGroup(
        session("other", { workspaceId: "ws-other" }),
        selected,
      ),
    ).toBe(false);
  });

  test("keeps a selected workspace route before it has a selected session", () => {
    expect(
      sessionSharesSelectedSidebarGroup(
        session("draft-tab", { workspaceId: "ws-draft" }),
        null,
        "ws-draft",
      ),
    ).toBe(true);
  });

  test("keeps legacy shared-worktree rows and session aliases whole", () => {
    const selected = session("canonical", {
      aliasIds: ["legacy"],
      worktreeDir: "/tmp/worktrees/feature",
    });
    expect(
      sessionSharesSelectedSidebarGroup(
        session("sibling", { worktreeDir: "/tmp/worktrees/feature" }),
        selected,
      ),
    ).toBe(true);
    expect(sessionSharesSelectedSidebarGroup(session("legacy"), selected)).toBe(
      true,
    );
  });
});

describe("sidebarWorkspaceIdForSession", () => {
  test("keeps temporary child workspaces nested beneath the root workspace", () => {
    const root = session("root", { workspaceId: "ws-root" });
    const child = session("child", {
      parentSessionId: "root",
      workspaceId: "ws-child",
    });
    const grandchild = session("grandchild", {
      parentSessionId: "child",
      workspaceId: "ws-grandchild",
    });

    expect(
      sidebarWorkspaceIdForSession([root, child, grandchild], grandchild),
    ).toBe("ws-root");
  });

  test("uses a top-level session's own workspace", () => {
    const selected = session("selected", { workspaceId: "ws-selected" });
    expect(sidebarWorkspaceIdForSession([selected], selected)).toBe(
      "ws-selected",
    );
  });

  test("preserves workspace-less roots and tolerates a missing parent", () => {
    const root = session("root");
    const child = session("child", {
      parentSessionId: "root",
      workspaceId: "ws-child",
    });
    expect(sidebarWorkspaceIdForSession([root, child], child)).toBeNull();
    expect(sidebarWorkspaceIdForSession([child], child)).toBe("ws-child");
  });
});

describe("subagentsForWorkspace", () => {
  test("returns every unarchived child of the selected workspace", () => {
    const sessions = [
      session("parent", { workspaceId: "ws-1" }),
      session("running", {
        parentSessionId: "parent",
        workspaceId: "ws-1",
        isRunning: true,
      }),
      session("waiting", {
        parentSessionId: "parent",
        waitingForInput: true,
      }),
      session("queued", {
        parentSessionId: "parent",
        queuedCount: 1,
      }),
      session("idle", { parentSessionId: "parent" }),
      session("archived", {
        parentSessionId: "parent",
        isRunning: true,
        archived: true,
      }),
      session("other", {
        workspaceId: "ws-2",
        parentSessionId: "other-parent",
        isRunning: true,
      }),
    ];

    expect(
      subagentsForWorkspace(sessions, "ws-1").map(({ session }) => session.id),
    ).toEqual(["idle", "queued", "running", "waiting"]);
    expect(subagentsForWorkspace(sessions, "ws-3")).toEqual([]);
    expect(subagentsForWorkspace(sessions, null)).toEqual([]);
  });

  test("follows nested parent edges across temporary child workspaces", () => {
    const sessions = [
      session("root", { workspaceId: "ws-1" }),
      session("child", {
        workspaceId: "ws-child",
        parentSessionId: "root",
        isRunning: true,
        createdAt: "2026-08-18T10:00:01Z",
      }),
      session("grandchild", {
        parentSessionId: "child",
        isRunning: true,
        createdAt: "2026-08-18T10:00:02Z",
      }),
      session("other-root", { workspaceId: "ws-2" }),
    ];

    expect(
      subagentsForWorkspace(sessions, "ws-1").map(({ session, depth }) => [
        session.id,
        depth,
      ]),
    ).toEqual([
      ["child", 1],
      ["grandchild", 2],
    ]);
    expect(
      subagentsByWorkspace(sessions)
        .get("ws-1")
        ?.map(({ session }) => session.id),
    ).toEqual(["child", "grandchild"]);
    expect(subagentsByWorkspace(sessions).has("ws-child")).toBe(false);
  });

  test("lists isolated workers but hides disposable inline workers", () => {
    const sessions = [
      session("root", {
        workspaceId: "ws-root",
        worktreeDir: "/worktrees/root",
      }),
      session("inline", {
        workspaceId: "ws-root",
        worktreeDir: "/worktrees/root",
        parentSessionId: "root",
        createdAt: "2026-08-18T10:00:01Z",
      }),
      session("own-worktree", {
        workspaceId: "ws-root",
        worktreeDir: "/worktrees/isolated",
        parentSessionId: "root",
        createdAt: "2026-08-18T10:00:02Z",
      }),
      session("own-workspace", {
        workspaceId: "ws-worker",
        worktreeDir: null,
        parentSessionId: "root",
        createdAt: "2026-08-18T10:00:03Z",
      }),
    ];

    const groups = subagentsByWorkspace(sessions);
    expect(
      groups.get("ws-root")?.map(({ session, inline }) => [session.id, inline]),
    ).toEqual([
      ["inline", true],
      ["own-worktree", false],
      ["own-workspace", false],
    ]);
    expect(
      subagentsForSelectedWorkspace(groups, "ws-root", "ws-root").map(
        ({ session }) => session.id,
      ),
    ).toEqual(["own-worktree", "own-workspace"]);
  });

  test("marks only workers whose PRs all belong to the root", () => {
    const root = session("root", {
      workspaceId: "ws-root",
      repo: "opensession",
      branch: "root-pr",
      prNumber: 10,
      prUrl: "https://github.com/tellahq/opensession/pull/10",
    });
    const same = session("same", {
      workspaceId: "ws-same",
      parentSessionId: "root",
      repo: "opensession",
      branch: "root-pr",
      prNumber: 10,
      prUrl: "https://github.com/tellahq/opensession/pull/10/files",
      createdAt: "2026-08-18T10:00:01Z",
    });
    const distinct = session("distinct", {
      workspaceId: "ws-distinct",
      parentSessionId: "root",
      repo: "opensession",
      branch: "worker-pr",
      prNumber: 11,
      prUrl: "https://github.com/tellahq/opensession/pull/11",
      createdAt: "2026-08-18T10:00:02Z",
    });
    const sameAndDistinct = session("same-and-distinct", {
      workspaceId: "ws-multiple",
      parentSessionId: "root",
      prs: [
        {
          repo: "opensession",
          branch: "root-pr",
          source: "primary",
          number: 10,
        },
        {
          repo: "opensession",
          branch: "linked-pr",
          source: "linked",
          number: 12,
        },
      ],
      createdAt: "2026-08-18T10:00:03Z",
    });

    expect(
      subagentsByWorkspace([root, same, distinct, sameAndDistinct])
        .get("ws-root")
        ?.map(({ session, sharesRootPr }) => [session.id, sharesRootPr]),
    ).toEqual([
      ["same", true],
      ["distinct", false],
      ["same-and-distinct", false],
    ]);
  });

  test("keeps idle workers nested after their PR merges or closes", () => {
    const parent = session("parent", { workspaceId: "ws-parent" });
    const merged = session("merged", {
      workspaceId: "ws-merged-worker",
      parentSessionId: "parent",
      prUrl: "https://github.com/tellahq/example/pull/3",
      prState: "MERGED",
      createdAt: "2026-08-18T10:00:01Z",
    });
    const closed = session("closed", {
      workspaceId: "ws-closed-worker",
      parentSessionId: "parent",
      prUrl: "https://github.com/tellahq/example/pull/4",
      prState: "CLOSED",
      createdAt: "2026-08-18T10:00:02Z",
    });

    expect(
      subagentsForWorkspace([parent, merged, closed], "ws-parent").map(
        ({ session }) => session.id,
      ),
    ).toEqual(["merged", "closed"]);
  });

  test("expands child rows only for the selected root workspace", () => {
    const child = session("child", {
      parentSessionId: "parent",
      isRunning: true,
    });
    const groups = new Map([
      [
        "ws-parent",
        [{ session: child, depth: 1, inline: false, sharesRootPr: false }],
      ],
    ]);

    expect(
      subagentsForSelectedWorkspace(groups, "ws-parent", "ws-other"),
    ).toEqual([]);
    expect(
      subagentsForSelectedWorkspace(groups, "ws-parent", "ws-parent"),
    ).toEqual([
      { session: child, depth: 1, inline: false, sharesRootPr: false },
    ]);
  });

  test("does not nest a selected worker beneath its own temporary workspace", () => {
    const worker = session("worker", {
      workspaceId: "ws-worker",
      parentSessionId: "missing-parent",
      isRunning: true,
    });

    expect(subagentsForWorkspace([worker], "ws-worker")).toEqual([]);
  });

  test("deduplicates child sessions by id", () => {
    const child = session("child", {
      workspaceId: "ws-1",
      parentSessionId: "parent",
      isRunning: true,
    });
    const rows = subagentsForWorkspace(
      [session("parent", { workspaceId: "ws-1" }), child, { ...child }],
      "ws-1",
    );
    expect(rows.map(({ session }) => session.id)).toEqual(["child"]);
  });
});

describe("workspaceMainSession", () => {
  test("opens the workspace root even when a subagent was opened last", () => {
    const root = session("root", { workspaceId: "ws-1" });
    const child = session("child", {
      workspaceId: "ws-1",
      parentSessionId: "root",
    });
    expect(workspaceMainSession({ sessions: [child, root] })?.id).toBe("root");
  });

  test("uses the oldest row session when no parent edge is available", () => {
    const first = session("first", { workspaceId: "ws-1" });
    const second = session("second", { workspaceId: "ws-1" });
    expect(workspaceMainSession({ sessions: [first, second] })?.id).toBe(
      "first",
    );
    expect(workspaceMainSession({ sessions: [] })).toBeNull();
  });
});

describe("workspaceRowOwnsSelection", () => {
  test("selects a parked workspace draft without a session", () => {
    const draft = {
      key: "workspace:ws-draft",
      workspace: { id: "ws-draft" },
      sessions: [],
    };
    expect(workspaceRowOwnsSelection(draft, null, "ws-draft")).toBe(true);
    expect(workspaceRowOwnsSelection(draft, null, "ws-other")).toBe(false);
  });
});

describe("workspaceRowOwnsSession", () => {
  test("selects the parent workspace for an automation tab", () => {
    expect(
      workspaceRowOwnsSession(
        {
          key: "workspace:ws-1",
          workspace: { id: "ws-1" },
          sessions: [{ id: "main" }],
        },
        { id: "automation", workspaceId: "ws-1", worktreeDir: "/tmp/worktree" },
      ),
    ).toBe(true);
  });

  test("selects a standalone shared-worktree parent", () => {
    expect(
      workspaceRowOwnsSession(
        {
          key: "wt:/tmp/worktree",
          workspace: null,
          sessions: [{ id: "main" }],
        },
        { id: "automation", workspaceId: null, worktreeDir: "/tmp/worktree" },
      ),
    ).toBe(true);
  });

  test("does not select an unrelated workspace", () => {
    expect(
      workspaceRowOwnsSession(
        {
          key: "workspace:ws-2",
          workspace: { id: "ws-2" },
          sessions: [{ id: "other" }],
        },
        { id: "automation", workspaceId: "ws-1", worktreeDir: "/tmp/worktree" },
      ),
    ).toBe(false);
  });
});
