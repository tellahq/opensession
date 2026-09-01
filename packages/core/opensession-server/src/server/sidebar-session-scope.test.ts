import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "./types";
import {
  parseSidebarSessionScope,
  scopeSessionsForSidebar,
  sessionIsRecentTeamActivity,
  sidebarSessionScopeKey,
  TEAM_ACTIVITY_RECENT_MS,
  type SidebarSessionScope,
  type SidebarSessionScopeContext,
} from "./sidebar-session-scope";

function session(
  id: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    claudeSessionId: "",
    source: "opensession",
    branch: `branch-${id}`,
    worktreeDir: `/worktrees/${id}`,
    startedBy: "Ada",
    title: id,
    lastActivity: "2026-08-18T12:00:00.000Z",
    createdAt: "2026-08-18T11:00:00.000Z",
    isRunning: false,
    transcriptPath: "",
    ...overrides,
  };
}

function scope(
  overrides: Partial<SidebarSessionScope> = {},
): SidebarSessionScope {
  return {
    user: "Ada",
    person: "me",
    repo: "all",
    autoCreated: "hide",
    ...overrides,
  };
}

function context(
  overrides: Partial<SidebarSessionScopeContext> = {},
): SidebarSessionScopeContext {
  return {
    pins: new Set(),
    lanes: new Set(),
    snoozes: new Set(),
    hides: new Set(),
    mentions: new Set(),
    workspaces: new Map(),
    automations: new Map(),
    defaultRepo: "opensession",
    ...overrides,
  };
}

describe("parseSidebarSessionScope", () => {
  test("only opts into the sidebar projection explicitly", () => {
    expect(
      parseSidebarSessionScope(new URLSearchParams("archived=exclude"), "Ada"),
    ).toBeNull();
    expect(
      parseSidebarSessionScope(
        new URLSearchParams(
          "archived=exclude&view=sidebar&person=me&repo=tella-fusion&session=os-1",
        ),
        "Ada",
      ),
    ).toMatchObject({
      user: "Ada",
      person: "me",
      repo: "tella-fusion",
      selectedSessionId: "os-1",
      autoCreated: "hide",
    });
  });

  test("keys differ for lenses and selected work", () => {
    expect(sidebarSessionScopeKey(scope({ person: "me" }))).not.toBe(
      sidebarSessionScopeKey(scope({ person: "grace" })),
    );
    expect(sidebarSessionScopeKey(scope())).not.toBe(
      sidebarSessionScopeKey(scope({ selectedWorkspaceId: "ws-1" })),
    );
  });
});

describe("scopeSessionsForSidebar", () => {
  test("keeps a person's workspace whole and drops unrelated work", () => {
    const rows = [
      session("mine", { workspaceId: "ws-mine", startedBy: "Ada" }),
      session("teammate-tab", {
        workspaceId: "ws-mine",
        startedBy: "Grace",
      }),
      session("unrelated", {
        workspaceId: "ws-other",
        startedBy: "Grace",
      }),
    ];
    expect(
      scopeSessionsForSidebar(
        rows,
        scope(),
        context({
          workspaces: new Map([
            ["ws-mine", { createdBy: "Ada", repo: "opensession" }],
            ["ws-other", { createdBy: "Grace", repo: "opensession" }],
          ]),
        }),
      ).map((row) => row.id),
    ).toEqual(["mine", "teammate-tab"]);
  });

  test("adds every person's active window outside the current lens and repo", () => {
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    const rows = [
      session("mine", { startedBy: "Ada", repo: "opensession" }),
      session("running-teammate", {
        startedBy: "Grace",
        repo: "other-repo",
        isRunning: true,
      }),
      session("recent-teammate", {
        startedBy: "Lin",
        repo: "other-repo",
        claudeSessionId: "engine-recent",
        lastActivity: new Date(now - TEAM_ACTIVITY_RECENT_MS).toISOString(),
      }),
      session("recent-draft", {
        startedBy: "Sam",
        repo: "other-repo",
        lastActivity: new Date(now - 60_000).toISOString(),
      }),
      session("active-agent", {
        startedBy: undefined,
        automation: "review",
        repo: "other-repo",
        isRunning: true,
      }),
    ];

    expect(
      scopeSessionsForSidebar(
        rows,
        scope({ repo: "opensession" }),
        context(),
        now,
      ).map((row) => row.id),
    ).toEqual(["mine", "running-teammate", "recent-teammate", "active-agent"]);
    expect(sessionIsRecentTeamActivity(rows[3]!, now)).toBe(false);
  });

  test("keeps personal pins, claims, mentions and snoozes", () => {
    const rows = [
      session("pinned", { startedBy: "Grace" }),
      session("claimed", { startedBy: "Grace" }),
      session("mentioned", { startedBy: "Grace" }),
      session("snoozed", { workspaceId: "ws-snoozed", startedBy: "Grace" }),
    ];
    expect(
      scopeSessionsForSidebar(
        rows,
        scope(),
        context({
          pins: new Set(["pinned"]),
          lanes: new Set(["claimed"]),
          mentions: new Set(["mentioned"]),
          snoozes: new Set(["workspace:ws-snoozed"]),
        }),
      ).map((row) => row.id),
    ).toEqual(["pinned", "claimed", "mentioned", "snoozed"]);
  });

  test("drops hidden rows but resurfaces one needing input", () => {
    const rows = [
      session("hidden", { workspaceId: "ws-hidden" }),
      session("blocked", {
        workspaceId: "ws-blocked",
        waitingForInput: true,
      } as Partial<UnifiedSession>),
    ];
    const workspaces = new Map([
      ["ws-hidden", { createdBy: "Ada", repo: "opensession" }],
      ["ws-blocked", { createdBy: "Ada", repo: "opensession" }],
    ]);
    expect(
      scopeSessionsForSidebar(
        rows,
        scope(),
        context({
          workspaces,
          hides: new Set(["workspace:ws-hidden", "workspace:ws-blocked"]),
        }),
      ).map((row) => row.id),
    ).toEqual(["blocked"]);
  });

  test("keeps the selected workspace even in another person's lens", () => {
    const rows = [
      session("selected", { workspaceId: "ws-selected", startedBy: "Grace" }),
      session("sibling", { workspaceId: "ws-selected", startedBy: "Lin" }),
      session("other", { workspaceId: "ws-other", startedBy: "Grace" }),
    ];
    expect(
      scopeSessionsForSidebar(
        rows,
        scope({ selectedSessionId: "selected" }),
        context(),
      ).map((row) => row.id),
    ).toEqual(["selected", "sibling"]);
  });

  test("keeps a selected worker nested under its ancestor workspace", () => {
    const rows = [
      session("parent", {
        workspaceId: "ws-parent",
        startedBy: "Grace",
      }),
      session("parent-sibling", {
        workspaceId: "ws-parent",
        startedBy: "Grace",
      }),
      session("worker", {
        workspaceId: "ws-worker",
        parentSessionId: "parent",
        startedBy: "Grace",
        prUrl: "https://github.com/tellahq/example/pull/99",
        prState: "OPEN",
      }),
      session("worker-sibling", {
        workspaceId: "ws-worker",
        startedBy: "Grace",
      }),
      session("nested-worker", {
        workspaceId: "ws-nested",
        parentSessionId: "worker",
        startedBy: "Grace",
        prUrl: "https://github.com/tellahq/example/pull/1",
        prState: "OPEN",
      }),
      session("inline-review", {
        workspaceId: "ws-inline-review",
        parentSessionId: "worker",
        startedBy: "Grace",
        prs: [
          {
            repo: "example",
            branch: "parent-branch",
            source: "discovered",
            state: "OPEN",
            url: "https://github.com/tellahq/example/pull/99",
            number: 99,
          },
        ],
      }),
      session("merged-worker", {
        workspaceId: "ws-merged",
        parentSessionId: "worker",
        startedBy: "Grace",
        prUrl: "https://github.com/tellahq/example/pull/2",
        prState: "MERGED",
      }),
      session("unrelated", {
        workspaceId: "ws-unrelated",
        startedBy: "Grace",
      }),
    ];

    expect(
      scopeSessionsForSidebar(
        rows,
        scope({ selectedSessionId: "worker" }),
        context(),
      ).map((row) => row.id),
    ).toEqual([
      "parent",
      "parent-sibling",
      "worker",
      "worker-sibling",
      "nested-worker",
    ]);
  });

  test("filters automation runs by owner", () => {
    const rows = [
      session("mine", { automation: "nightly", startedBy: undefined }),
      session("other", { automation: "triage", startedBy: undefined }),
    ];
    expect(
      scopeSessionsForSidebar(
        rows,
        scope(),
        context({
          automations: new Map([
            ["nightly", { owner: "Ada" }],
            ["triage", { owner: "Grace" }],
          ]),
        }),
      ).map((row) => row.id),
    ).toEqual(["mine"]);
  });
});
