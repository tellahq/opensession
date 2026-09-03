/**
 * The `?archived=` slices of GET /api/sessions.
 *
 * Two things are worth pinning here. The variant parse decides whether a
 * client sees the whole list or none of it, and its failure mode is an empty
 * screen rather than an error. And the slim archived row is a CONTRACT with
 * the surfaces that render it — Archived.tsx, the sidebar's archived badge and
 * the tab strip's history menu — so a field quietly dropped from the row shows
 * up as blank text in the UI, not as a type error.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type CreateSessionOpts,
  type SessionControl,
  registerSessionControl,
  tryGetSessionControl,
} from "../session-control";
import type { PrInfo } from "../pr-cache";
import { mergeFooterPrRefs } from "../session-pr-target";
import type { UnifiedSession } from "../types";
import {
  archivedScope,
  archivedIndexRow,
  handleSessionsRoutes,
  nativeCreateRepoOptions,
  sessionListRow,
  sessionRan,
  sessionsVariant,
  sidebarLiveSessions,
} from "./sessions";

function paramsOf(query: string) {
  return new URL(`http://x/api/sessions${query}`).searchParams;
}

function variantOf(query: string) {
  return sessionsVariant(paramsOf(query));
}

function scopeOf(query: string) {
  return archivedScope(paramsOf(query), sessionsVariant(paramsOf(query)));
}

type TestSession = UnifiedSession & {
  waitingForInput?: boolean;
  queuedCount?: number;
  workspacePreparing?: boolean;
  ran?: boolean;
  rev?: number;
};

function archivedSession(over: Partial<TestSession> = {}): TestSession {
  return {
    id: "os-019fea32-b27e-7000-9131-0f5484659833",
    claudeSessionId: "ses_1",
    source: "opensession",
    branch: "feature/thing",
    worktreeDir: "/home/ubuntu/worktrees/thing",
    startedBy: "Ada",
    title: "Make the thing faster",
    lastActivity: "2026-08-09T10:05:00.000Z",
    createdAt: "2026-08-09T09:00:00.000Z",
    isRunning: false,
    transcriptPath: "/transcripts/ses_1.jsonl",
    mode: "code",
    repo: "opensession",
    workspaceId: "ws-1",
    archived: true,
    archivedReason: "idle",
    ...over,
  };
}

describe("sessionsVariant", () => {
  test("no parameters means the whole list", () => {
    expect(variantOf("")).toBe("include");
  });

  test("an unrecognised value degrades to the whole list, not an empty one", () => {
    expect(variantOf("?archived=yes")).toBe("include");
    expect(variantOf("?archived=")).toBe("include");
    // slim is meaningless without `only`, and must not imply it.
    expect(variantOf("?slim=1")).toBe("include");
  });

  test("exclude and only select their slice", () => {
    expect(variantOf("?archived=exclude")).toBe("exclude");
    expect(variantOf("?archived=only")).toBe("only");
    expect(variantOf("?archived=only&slim=1")).toBe("only-slim");
  });
});

describe("archivedScope", () => {
  test("scopes an archived slice to one workspace", () => {
    expect(scopeOf("?archived=only&slim=1&workspace=ws-1")).toMatchObject({
      workspaceId: "ws-1",
    });
    expect(scopeOf("?archived=only&workspace=ws-1")).toMatchObject({
      workspaceId: "ws-1",
    });
  });

  test("the live list is never scoped", () => {
    // The sidebar and the tab strip poll it whole; narrowing it here would
    // silently empty them.
    expect(scopeOf("?archived=exclude&workspace=ws-1")).toBeNull();
    expect(scopeOf("?workspace=ws-1")).toBeNull();
  });

  test("no workspace means the whole index", () => {
    expect(scopeOf("?archived=only&slim=1")).toBeNull();
  });

  test("an unknown workspace scopes by id, so a stale link shows nothing", () => {
    // Failing open here would hand the whole instance's history to a link
    // naming a workspace that no longer exists.
    expect(scopeOf("?archived=only&workspace=ws-gone")).toEqual({
      workspaceId: "ws-gone",
      worktreeDir: undefined,
    });
  });
});

describe("sidebarLiveSessions", () => {
  test("keeps ordinary sessions and only recent automation history", () => {
    const ordinary = archivedSession({ id: "ordinary", archived: false });
    const runs = Array.from({ length: 8 }, (_, index) =>
      archivedSession({
        id: `run-${index}`,
        archived: false,
        automation: "nightly",
        lastActivity: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
        ...(index === 0 ? { isRunning: true } : {}),
        ...(index === 1 ? { manualStatus: "pending" } : {}),
      }),
    );

    const result = sidebarLiveSessions([ordinary, ...runs]);
    expect(result.map((session) => session.id)).toEqual([
      "ordinary",
      "run-0",
      "run-1",
      "run-3",
      "run-4",
      "run-5",
      "run-6",
      "run-7",
    ]);
    expect(result[0].automationRunCount).toBeUndefined();
    expect(
      result
        .filter((session) => session.automation)
        .every((session) => session.automationRunCount === 8),
    ).toBe(true);
  });

  test("keeps just-finished automation runs beyond the history cap", () => {
    const now = Date.now();
    const minutesAgo = [0, 1, 2, 3, 4, 10, 20, 30];
    const runs = minutesAgo.map((minutes, index) =>
      archivedSession({
        id: `run-${index}`,
        archived: false,
        automation: "busy-automation",
        lastActivity: new Date(now - minutes * 60_000).toISOString(),
      }),
    );

    expect(sidebarLiveSessions(runs).map((session) => session.id)).toEqual([
      "run-0",
      "run-1",
      "run-2",
      "run-3",
      "run-4",
      "run-5",
    ]);
  });
});

describe("archivedIndexRow", () => {
  test("keeps the positive repo-less marker", () => {
    expect(archivedIndexRow(archivedSession({ repoLess: true }))).toMatchObject(
      {
        repoLess: true,
      },
    );
  });

  test("carries what the Archived surfaces render", () => {
    const row = archivedIndexRow(archivedSession());
    // Archived.tsx renders these; the sidebar badge filters on startedBy
    // and repo; the tab strip's history menu groups on workspaceId or a
    // shared worktreeDir and sorts on lastActivity.
    expect(row).toMatchObject({
      id: "os-019fea32-b27e-7000-9131-0f5484659833",
      title: "Make the thing faster",
      source: "opensession",
      mode: "code",
      startedBy: "Ada",
      lastActivity: "2026-08-09T10:05:00.000Z",
      archivedReason: "idle",
      repo: "opensession",
      workspaceId: "ws-1",
      worktreeDir: "/home/ubuntu/worktrees/thing",
    });
  });

  test("keeps the agent-started marker the history and sidebar rows read", () => {
    expect(
      archivedIndexRow(archivedSession({ agentStarted: true })).agentStarted,
    ).toBe(true);
    expect(archivedIndexRow(archivedSession())).not.toHaveProperty(
      "agentStarted",
    );
  });

  test("keeps the worker marker the history menu reads", () => {
    // A workspace closes far more agent runs than conversations, and the
    // menu marks them so the sessions people had still stand out.
    const row = archivedIndexRow(
      archivedSession({
        parentSessionId: "os-019fea32-0000-7000-0000-000000000000",
      }),
    );
    expect(row.parentSessionId).toBe("os-019fea32-0000-7000-0000-000000000000");
    expect(archivedIndexRow(archivedSession())).not.toHaveProperty(
      "parentSessionId",
    );
  });

  test("is archived by construction, so client filters still match", () => {
    // The row only ever comes from the archived slice, and the clients that
    // merge it into their session list filter on `archived`.
    expect(archivedIndexRow(archivedSession()).archived).toBe(true);
  });

  test("drops the weight nobody reads on those surfaces", () => {
    const row = archivedIndexRow(
      archivedSession({
        walkthrough: { title: "Demo", body: "x".repeat(400) } as never,
        prs: [{ repo: "opensession", branch: "feature/thing" }] as never,
        prTitle: "Make the thing faster",
        attachedRepos: [{ project: "tella-fusion" }] as never,
      }),
    );
    for (const fat of ["walkthrough", "prs", "prTitle", "attachedRepos"])
      expect(row).not.toHaveProperty(fat);
  });

  test("omits absent optionals rather than spending bytes on nulls", () => {
    const row = archivedIndexRow(
      archivedSession({
        mode: undefined,
        repo: undefined,
        workspaceId: null,
        archivedReason: undefined,
        automation: undefined,
      }),
    );
    for (const absent of [
      "mode",
      "repo",
      "workspaceId",
      "archivedReason",
      "automation",
      "aliasIds",
      "desk",
    ])
      expect(row).not.toHaveProperty(absent);
  });

  test("keeps the first external ref's identity, which is the repo fallback", () => {
    // sessionRepo() files a repo-less feed session under its feed rather
    // than the default repo — the kind is the whole reason it can. The
    // ref's url/title are the expensive part and nothing here reads them.
    const row = archivedIndexRow(
      archivedSession({
        repo: undefined,
        externalRefs: [
          {
            kind: "tella-video",
            id: "vid_1",
            url: "https://tella.tv/video/x",
            title: "A video with a long title",
          },
          { kind: "plain", id: "th_1" },
        ],
      }),
    );
    expect(row.externalRefs).toEqual([{ kind: "tella-video", id: "vid_1" }]);
  });

  test("is a whole list row, so a client can merge it into its list", () => {
    // The point of carrying every REQUIRED field: consumers read an index
    // row like any other session instead of threading a second type
    // through the sidebar, the tab strip and the palette.
    const full = archivedSession();
    const row = archivedIndexRow(full);
    for (const required of [
      "id",
      "source",
      "branch",
      "worktreeDir",
      "startedBy",
      "title",
      "lastActivity",
      "createdAt",
      "isRunning",
    ] as const)
      expect(row[required]).toEqual(full[required]);
  });

  test("summarizes the engine ids as `ran`, like the live list does", () => {
    // One rule reads across both slices: pickLandingSession falls back to
    // the newest archived session that RAN when every live row in a
    // workspace is an abandoned shell.
    expect(archivedIndexRow(archivedSession({ ran: true })).ran).toBe(true);
    const shell = archivedIndexRow(archivedSession({ ran: undefined }));
    expect(shell).not.toHaveProperty("ran");
    for (const detail of ["claudeSessionId", "transcriptPath"])
      expect(
        archivedIndexRow(archivedSession({ ran: true })),
      ).not.toHaveProperty(detail);
  });

  test("carries alias ids so a link naming an old id still resolves", () => {
    const row = archivedIndexRow(
      archivedSession({
        aliasIds: ["bks-019f0000-0000-7000-0000-000000000000"],
      }),
    );
    expect(row.aliasIds).toEqual(["bks-019f0000-0000-7000-0000-000000000000"]);
  });
});

describe("mergeFooterPrRefs", () => {
  const pr = {
    url: "https://github.com/tellahq/tella-fusion/pull/6072",
    state: "OPEN",
    number: 6072,
    title: "Make crop controls truthful",
    isDraft: false,
    additions: 258,
    deletions: 92,
    changedFiles: 3,
    reviewDecision: "",
    author: "jfrolich",
    createdAt: "2026-08-31T08:00:00.000Z",
    updatedAt: "2026-08-31T09:00:00.000Z",
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: "MERGEABLE",
    reviewRequested: [],
    reviewedBy: [],
    assignees: [],
    sessionRef: "bks-crop",
  } satisfies PrInfo;

  test("restores a footer-discovered PR on a materialized session row", () => {
    const refs = mergeFooterPrRefs(archivedSession({ id: "bks-crop" }), [
      { repo: "tella-fusion", branch: "fix-crop", pr },
    ]);

    expect(refs).toEqual([
      expect.objectContaining({
        repo: "tella-fusion",
        branch: "fix-crop",
        source: "discovered",
        number: 6072,
        state: "OPEN",
      }),
    ]);
  });

  test("refreshes an existing ref without losing how it was attached", () => {
    const refs = mergeFooterPrRefs(
      archivedSession({
        prs: [
          {
            repo: "tella-fusion",
            branch: "fix-crop",
            source: "primary",
            number: 6072,
            state: "CLOSED",
          },
        ],
      }),
      [{ repo: "tella-fusion", branch: "fix-crop", pr }],
    );

    expect(refs).toEqual([
      expect.objectContaining({ source: "primary", state: "OPEN" }),
    ]);
  });
});

describe("sessionListRow", () => {
  test("drops run-resume fields no list client reads", () => {
    const row = sessionListRow(
      archivedSession({
        lastEngineModel: "pi/anthropic/claude-opus-5",
        lastEngineProvider: "pi",
        mcpServers: ["github", "linear"],
        piSessionId: "pi-session",
        presetNote: "Long workspace preset instructions",
        slackThread: { channel: "C1", threadTs: "1.2" },
        slackThreads: [{ channel: "C1", threadTs: "1.2" }],
        rev: 12,
      }),
    );
    for (const internal of [
      "lastEngineModel",
      "lastEngineProvider",
      "mcpServers",
      "presetNote",
      "slackThread",
      "slackThreads",
      "rev",
    ])
      expect(row).not.toHaveProperty(internal);
  });

  test("drops the fields only the open session reads", () => {
    // The summary/detail split. Each of these is on GET /api/sessions/:id,
    // which the open session hydrates from — dropping one here without
    // hydrating there shows up as a missing model divider or a session
    // that can't fork, not as a type error.
    const row = sessionListRow(
      archivedSession({
        claudeSessionId: "ses_1",
        codexThreadId: "thread_1",
        piSessionId: "pi-session",
        modelHistory: [{ model: "claude-opus-5", at: "2026-08-09" }],
        transcriptPath: "/transcripts/ses_1.jsonl",
      }),
    );
    for (const detail of [
      "claudeSessionId",
      "codexThreadId",
      "piSessionId",
      "modelHistory",
      "transcriptPath",
    ])
      expect(row).not.toHaveProperty(detail);
  });

  test("keeps worktreeDir, which is a list field however much it reads like detail", () => {
    // Both sidebars group sessions filed before workspace ids on it, and
    // both persist `wt:<dir>` as a row key in the shared hides/pins
    // overlays. Dropping it would empty those rows, not just their paths.
    expect(sessionListRow(archivedSession()).worktreeDir).toBe(
      "/home/ubuntu/worktrees/thing",
    );
  });

  test("carries `ran` through, and spends nothing on a session that never did", () => {
    // enrichSession derives it; this projection must not treat it as one
    // of the falsy defaults it strips, or every workspace would land on an
    // abandoned "New session" shell.
    expect(sessionListRow(archivedSession({ ran: true })).ran).toBe(true);
    expect(sessionListRow(archivedSession())).not.toHaveProperty("ran");
  });

  test("drops malformed automation ids at the list boundary", () => {
    const malformed = archivedSession({
      automation: true as unknown as string,
    });
    expect(sessionListRow(malformed)).not.toHaveProperty("automation");
    expect(
      sessionListRow(archivedSession({ automation: "  daily scan  " }))
        .automation,
    ).toBe("daily scan");
  });

  test("omits defaults while preserving values that change list UI", () => {
    const row = sessionListRow(
      archivedSession({
        isRunning: false,
        waitingForInput: false,
        queuedCount: 0,
        branch: null,
        createdBy: null,
        startedBy: null,
        workspaceId: null,
        fastMode: false,
        prIsDraft: false,
        prReviewDecision: "",
        prReviewRequested: [],
        prReviewedBy: [],
        aliasIds: [],
        attachedRepos: [],
        linkedPrs: [],
      }),
    );
    for (const absent of [
      "isRunning",
      "waitingForInput",
      "queuedCount",
      "branch",
      "createdBy",
      "startedBy",
      "workspaceId",
      "fastMode",
      "prIsDraft",
      "prReviewDecision",
      "prReviewRequested",
      "prReviewedBy",
      "aliasIds",
      "attachedRepos",
      "linkedPrs",
    ])
      expect(row).not.toHaveProperty(absent);

    const live = sessionListRow(
      archivedSession({
        isRunning: true,
        waitingForInput: true,
        queuedCount: 2,
        prIsDraft: true,
        prReviewRequested: ["kent"],
      }),
    );
    expect(live).toMatchObject({
      isRunning: true,
      waitingForInput: true,
      queuedCount: 2,
      prIsDraft: true,
      prReviewRequested: ["kent"],
    });
  });

  test("keeps rich fields used by list and native session surfaces", () => {
    const full = archivedSession({
      usage: { turns: 4 } as never,
      walkthrough: { title: "Demo" } as never,
      prs: [{ repo: "opensession", branch: "feature/thing" }] as never,
    });
    const row = sessionListRow(full);
    for (const kept of ["usage", "walkthrough", "prs"] as const)
      expect(row[kept]).toEqual(full[kept]);
  });
});

describe("sessionRan", () => {
  test("any engine's session id counts, so no engine drops out of the answer", () => {
    // One id per engine, and a session only ever has the one its runs used.
    // Missing an engine here would make every session on it look untouched.
    for (const id of [
      "claudeSessionId",
      "codexThreadId",
      "piSessionId",
    ] as const)
      expect(sessionRan(archivedSession({ [id]: "x" } as never))).toBe(true);
  });

  test("a shell that never ran a turn has none of them", () => {
    expect(
      sessionRan(
        archivedSession({
          claudeSessionId: null,
          codexThreadId: undefined,
          piSessionId: undefined,
        }),
      ),
    ).toBe(false);
  });
});

describe("nativeCreateRepoOptions", () => {
  test("translates only repo-less Ask into the explicit control flag", () => {
    expect(nativeCreateRepoOptions("ask", "none")).toEqual({ repoLess: true });
    expect(nativeCreateRepoOptions("ask", undefined)).toEqual({});
    expect(nativeCreateRepoOptions("ask", "opensession")).toEqual({
      repo: "opensession",
    });
  });
});

describe("native session fork create", () => {
  const previousControl = tryGetSessionControl();
  afterEach(() => registerSessionControl(previousControl as SessionControl));

  async function create(forkFrom: unknown): Promise<CreateSessionOpts[]> {
    const created: CreateSessionOpts[] = [];
    registerSessionControl({
      createSession: async (input: CreateSessionOpts) => {
        created.push(input);
        return { id: "os-fork", createdBy: "Ada", createdAt: "now" };
      },
    } as unknown as SessionControl);
    const path = "/api/sessions";
    const url = new URL(`http://localhost${path}`);
    const response = await handleSessionsRoutes({
      req: new Request(url, {
        method: "POST",
        body: JSON.stringify({
          prompt: "Try another direction",
          mode: "ask",
          forkFrom,
          user: "Ada",
        }),
      }),
      url,
      path,
      publicPrefix: "",
    });
    expect(response?.status).toBe(200);
    return created;
  }

  test("carries a tip fork payload", async () => {
    const created = await create({ sourceId: "os-source" });
    expect(created[0]?.forkFrom).toEqual({ sourceId: "os-source" });
  });

  test("carries a message fork payload", async () => {
    const created = await create({
      sourceId: "os-source",
      messageId: "msg-42",
    });
    expect(created[0]?.forkFrom).toEqual({
      sourceId: "os-source",
      messageId: "msg-42",
    });
  });
});

describe("native session create attachments", () => {
  const previousControl = tryGetSessionControl();
  afterEach(() => registerSessionControl(previousControl as SessionControl));

  test("accepts a file-only composer and carries its staged ref", async () => {
    const created: CreateSessionOpts[] = [];
    registerSessionControl({
      createSession: async (input: CreateSessionOpts) => {
        created.push(input);
        return { id: "os-file", createdBy: "Ada", createdAt: "now" };
      },
    } as unknown as SessionControl);
    const path = "/api/sessions";
    const url = new URL(`http://localhost${path}`);
    const files = [
      {
        name: "incident.pdf",
        type: "application/pdf",
        path: "/uploads/incident.pdf",
      },
    ];
    const response = await handleSessionsRoutes({
      req: new Request(url, {
        method: "POST",
        body: JSON.stringify({ prompt: "", mode: "ask", files, user: "Ada" }),
      }),
      url,
      path,
      publicPrefix: "",
    });

    expect(response?.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0]?.prompt).toBe("");
    expect(created[0]?.files).toEqual(files);
  });
});
