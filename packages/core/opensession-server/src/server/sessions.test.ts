import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedSession } from "./types";

let home: string;
let priorHome: string | undefined;
let priorSessionsDir: string | undefined;
let priorCodexHome: string | undefined;
let priorConfig: string | undefined;
let priorGhBackoff: number | undefined;

beforeAll(async () => {
  priorHome = process.env.HOME;
  home = join(tmpdir(), `backstage-sessions-test-${crypto.randomUUID()}`);
  process.env.HOME = home;
  mkdirSync(join(home, ".opensession-sessions"), { recursive: true });
  mkdirSync(join(home, ".slack-sessions"), { recursive: true });
  // The PR-cache assertions need a repo that actually carries a ghRepo:
  // prRepos() filters those out, and the only BUILT-IN repo is `opensession`
  // with an empty ghRepo (the registry became config-driven), so with no
  // config there are no PR repos at all — markCachedPrReviewed can't resolve
  // its ghRepo argument to a repo id and returns without mutating anything.
  // OPENSESSION_CONFIG is re-read per call (getConfig caches on path+mtime),
  // so setting it here reaches modules other test files already loaded.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      repos: {
        opensession: {
          repo: "/home/ubuntu/projects/opensession",
          ghRepo: "tellahq/backstage",
          label: "Open Session",
        },
      },
    }),
  );
  priorConfig = process.env.OPENSESSION_CONFIG;
  process.env.OPENSESSION_CONFIG = join(home, "config.json");
  // Close the GitHub gate for the whole file. Without it the PR cache's
  // SWR refresh fires a real `gh` call on first access and replaces the
  // seeded snapshot with live data — a network call from a unit test, and a
  // race that makes the cached-review assertion pass or fail on timing.
  priorGhBackoff = (await import("./github-limit")).__setGhBackoffForTest(
    Date.now() + 60 * 60_000,
  );
  // The HOME override only reaches paths.ts / codex-accounts.ts if nothing
  // evaluated them yet — and bun test file order guarantees nothing
  // (another test file importing the server graph poisons the cached
  // OPENSESSION_SESSIONS_DIR / codex-accounts' HOME with the real store, which
  // then leaks live sessions/rollouts into these assertions). The live-
  // binding seams repoint them regardless of who loaded the module first;
  // the cache-busted sessions.ts imports below re-read OPENSESSION_SESSIONS_DIR
  // at their load (findCodexRollout is reached through a bare import of
  // ./codex-accounts either way, so it needs the same live-binding seam).
  const paths = await import("./paths");
  priorSessionsDir = paths.__setSessionsDirForTest(
    join(home, ".opensession-sessions"),
  );
  const codexAccounts = await import("./codex-accounts");
  priorCodexHome = codexAccounts.__setCodexHomeForTest(home);
});

afterAll(async () => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = priorConfig;
  if (priorGhBackoff !== undefined) {
    (await import("./github-limit")).__setGhBackoffForTest(priorGhBackoff);
  }
  if (priorSessionsDir !== undefined) {
    (await import("./paths")).__setSessionsDirForTest(priorSessionsDir);
  }
  if (priorCodexHome !== undefined) {
    (await import("./codex-accounts")).__setCodexHomeForTest(priorCodexHome);
  }
  // The review-cache test reseeded the shared PR cache from this file's
  // scratch snapshot; reload it from the restored state root so later test
  // files see the same data they would have before this file ran.
  (await import("./pr-cache")).loadPrCacheSnapshot();
  rmSync(home, { recursive: true, force: true });
});

function writeSession(id: string, data: Record<string, unknown>): void {
  writeFileSync(
    join(home, ".opensession-sessions", `${id}.json`),
    JSON.stringify(
      {
        id,
        claudeSessionId: "",
        branch: "",
        worktreeDir: "/home/ubuntu/projects/opensession",
        createdBy: "Alex",
        createdAt: "2026-07-02T18:00:00.000Z",
        lastActivity: "2026-07-02T18:00:00.000Z",
        mode: "ask",
        source: "opensession",
        ...data,
      },
      null,
      2,
    ),
  );
}

function writeSlackSession(id: string, data: Record<string, unknown>): void {
  writeFileSync(
    join(home, ".slack-sessions", `${id}.json`),
    JSON.stringify(data, null, 2),
  );
}

function uuidV7ForDate(iso: string): string {
  const hex = Date.parse(iso).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

describe("removeTombstonedSessionArtifacts", () => {
  it("removes a ghost session without re-entering its mailbox", async () => {
    const id = `bks-tombstoned-ghost-${crypto.randomUUID()}`;
    const path = join(home, ".opensession-sessions", `${id}.json`);
    writeSession(id, { title: "Deleted ghost" });
    expect(existsSync(path)).toBe(true);

    const { removeTombstonedSessionArtifacts } = await import(
      `./sessions.ts?tombstoned=${crypto.randomUUID()}`
    );
    removeTombstonedSessionArtifacts({
      id,
      source: "opensession",
    } as UnifiedSession);

    expect(existsSync(path)).toBe(false);
  });
});

describe("getAllSessions", () => {
  it("resolves an exact Slack deep link directly from its owning file", async () => {
    const key = `C123-${Date.now()}.123456`;
    writeSlackSession(key, {
      channel: "C123",
      threadTs: key.slice("C123-".length),
      userId: "Alex Example",
      claudeSessionId: "engine-slack-direct",
      worktreeDir: "/tmp/slack-direct",
      branch: "fix-slack-link",
      title: "Fix Slack link",
      createdAt: "2026-08-28T13:36:09.000Z",
      lastActivity: "2026-08-28T14:02:17.000Z",
    });

    const { readSlackSession } = await import(
      `./sessions.ts?slack-direct=${crypto.randomUUID()}`
    );
    expect(readSlackSession(`slack-${key}`)).toMatchObject({
      id: `slack-${key}`,
      source: "slack",
      title: "Fix Slack link",
      claudeSessionId: "engine-slack-direct",
      slackThread: { channel: "C123", threadTs: key.slice("C123-".length) },
    });
    expect(readSlackSession("slack-../message-queue")).toBeNull();
  });

  it("refreshes the legacy transcript index without blocking sync reads", async () => {
    const sessionId = `legacy-transcript-${crypto.randomUUID()}`;
    const projectDir = join(home, ".claude", "projects", "-legacy-worktree");
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(transcriptPath, "");
    writeSession("bks-legacy-transcript-index", {
      claudeSessionId: sessionId,
      model: "claude-fable-5-1",
      worktreeDir: null,
    });

    const { getAllSessionsAsync, readNativeSession } = await import(
      `./sessions.ts?legacy-index=${crypto.randomUUID()}`
    );
    // A cold synchronous lookup starts the cooperative refresh but never
    // traverses every project directory on the caller's stack.
    expect(
      readNativeSession("bks-legacy-transcript-index")?.transcriptPath,
    ).toBeNull();

    await getAllSessionsAsync();
    expect(
      readNativeSession("bks-legacy-transcript-index")?.transcriptPath,
    ).toBe(transcriptPath);
  });

  it("reads one native session without scanning the directory", async () => {
    writeSession("os-direct-detail", {
      title: "Direct detail",
      model: "pi/dial/opus-fable",
      workspaceId: "ws-direct",
      piSessionId: "pi-direct",
    });
    const { readNativeSession } = await import(
      `./sessions.ts?direct=${crypto.randomUUID()}`
    );
    expect(readNativeSession("os-direct-detail")).toMatchObject({
      id: "os-direct-detail",
      title: "Direct detail",
      source: "opensession",
      workspaceId: "ws-direct",
      piSessionId: "pi-direct",
    });
    expect(readNativeSession("../os-direct-detail")).toBeUndefined();
  });

  it("keeps the cooperative request scan byte-for-byte equivalent", async () => {
    writeSession("bks-cooperative-scan", {
      title: "Cooperative scan",
      model: "claude-fable-5-1",
      workspaceId: "ws-cooperative",
    });
    writeSession("bks-cooperative-archived", {
      title: "Archived cooperative scan",
      model: "claude-fable-5-1",
      workspaceId: "ws-cooperative-archived",
      archived: true,
    });
    const { getAllSessions, getAllSessionsAsync } = await import(
      `./sessions.ts?test=${crypto.randomUUID()}`
    );
    const select = (sessions: UnifiedSession[]) =>
      sessions.map(({ id, title, source, model, workspaceId }) => ({
        id,
        title,
        source,
        model,
        workspaceId,
      }));

    const full = getAllSessions();
    expect(select(await getAllSessionsAsync())).toEqual(select(full));
    expect(select(await getAllSessionsAsync("exclude"))).toEqual(
      select(full.filter((session: UnifiedSession) => !session.archived)),
    );
    expect(select(await getAllSessionsAsync("only"))).toEqual(
      select(full.filter((session: UnifiedSession) => session.archived)),
    );
  });

  it("does not resurrect an archived session through a live source alias", async () => {
    writeSession("bks-archived-shared-thread", {
      title: "Archived shared thread",
      model: "gpt-5.5",
      codexThreadId: "codex-thread-archived",
      archived: true,
    });
    writeSlackSession("C999-1719860000.000000", {
      branch: "archived-thread-branch",
      userId: "Alex",
      worktreeDir: "/home/ubuntu/projects/opensession",
      codexThreadId: "codex-thread-archived",
      model: "gpt-5.5",
      createdAt: "2026-07-02T18:01:00.000Z",
      lastActivity: "2026-07-02T18:01:00.000Z",
    });

    const { getAllSessionsAsync } = await import(
      `./sessions.ts?test=${crypto.randomUUID()}`
    );
    expect(
      (await getAllSessionsAsync("exclude")).some(
        (session: UnifiedSession) =>
          session.codexThreadId === "codex-thread-archived",
      ),
    ).toBe(false);
    const archived = (await getAllSessionsAsync("only")).filter(
      (session: UnifiedSession) =>
        session.codexThreadId === "codex-thread-archived",
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      id: "bks-archived-shared-thread",
      aliasIds: ["slack-C999-1719860000.000000"],
      archived: true,
    });
  });

  it("carries archive state from a merged-away alias to the canonical row", async () => {
    const aliasId = "slack-C998-1719860000.000000";
    writeSession("bks-live-canonical-archived-alias", {
      title: "Canonical row with archived alias",
      model: "gpt-5.5",
      codexThreadId: "codex-thread-archived-alias",
    });
    writeSlackSession("C998-1719860000.000000", {
      branch: "archived-alias-branch",
      userId: "Alex",
      worktreeDir: "/home/ubuntu/projects/opensession",
      codexThreadId: "codex-thread-archived-alias",
      model: "gpt-5.5",
      createdAt: "2026-07-02T18:02:00.000Z",
      lastActivity: "2026-07-02T18:02:00.000Z",
    });

    const { setArchived } = await import("./archive");
    setArchived(aliasId, true);
    try {
      const { getAllSessionsAsync } = await import(
        `./sessions.ts?test=${crypto.randomUUID()}`
      );
      expect(
        (await getAllSessionsAsync("exclude")).some(
          (session: UnifiedSession) =>
            session.codexThreadId === "codex-thread-archived-alias",
        ),
      ).toBe(false);
      const archived = (await getAllSessionsAsync("only")).filter(
        (session: UnifiedSession) =>
          session.codexThreadId === "codex-thread-archived-alias",
      );
      expect(archived).toHaveLength(1);
      expect(archived[0]).toMatchObject({
        id: "bks-live-canonical-archived-alias",
        aliasIds: [aliasId],
        archived: true,
      });
    } finally {
      setArchived(aliasId, false);
    }
  });

  it("keeps Codex worker sessions visible even when they have no workspace", async () => {
    writeSession("bks-codex-worker", {
      title: "Codex worker with no workspace",
      repo: "opensession",
      model: "gpt-5.5",
      codexThreadId: "codex-thread-1",
      workspaceId: null,
      automation: "Nightly review",
      automationId: "auto-nightly-review",
    });
    writeSession("bks-fable-orchestrator", {
      title: "Fable orchestrator with workspace",
      repo: "opensession",
      model: "claude-fable-5-1",
      claudeSessionId: "claude-session-1",
      workspaceId: "ws-demo",
    });

    const { getAllSessions } = await import(
      `./sessions.ts?test=${crypto.randomUUID()}`
    );
    const sessions = getAllSessions();

    const codex = sessions.find(
      (s: UnifiedSession) => s.id === "bks-codex-worker",
    );
    expect(codex).toMatchObject({
      id: "bks-codex-worker",
      source: "opensession",
      repo: "opensession",
      model: "gpt-5.5",
      codexThreadId: "codex-thread-1",
      workspaceId: null,
      automation: "Nightly review",
      automationId: "auto-nightly-review",
    });

    const fable = sessions.find(
      (s: UnifiedSession) => s.id === "bks-fable-orchestrator",
    );
    expect(fable).toMatchObject({
      id: "bks-fable-orchestrator",
      repo: "opensession",
      model: "claude-fable-5-1",
      workspaceId: "ws-demo",
    });
  });

  it("deduplicates Codex sessions by thread id and keeps dropped ids as aliases", async () => {
    writeSession("bks-codex-shared-thread", {
      title: "Open Session Codex thread",
      repo: "opensession",
      model: "gpt-5.5",
      codexThreadId: "codex-thread-shared",
    });
    writeSlackSession("C123-1719860000.000000", {
      branch: "codex-thread-branch",
      userId: "Alex",
      worktreeDir: "/home/ubuntu/projects/opensession",
      claudeSessionId: null,
      codexThreadId: "codex-thread-shared",
      model: "gpt-5.5",
      channel: "C123",
      threadTs: "1719860000.000000",
      createdAt: "2026-07-02T18:01:00.000Z",
      lastActivity: "2026-07-02T18:01:00.000Z",
    });

    const { getAllSessions } = await import(
      `./sessions.ts?test=${crypto.randomUUID()}`
    );
    const sessions = getAllSessions();
    const matches = sessions.filter(
      (s: UnifiedSession) => s.codexThreadId === "codex-thread-shared",
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      id: "bks-codex-shared-thread",
      source: "opensession",
      aliasIds: ["slack-C123-1719860000.000000"],
    });
  });

  it("resolves engine transcript paths for Claude and Codex sessions", async () => {
    const { getEngineTranscriptPath, getTranscriptPath, engineSessionPatch } =
      await import(`./sessions.ts?test=${crypto.randomUUID()}`);

    const cwd = "/home/ubuntu/projects/opensession";
    expect(getEngineTranscriptPath(cwd, "claude-session-1", "claude")).toBe(
      getTranscriptPath(cwd, "claude-session-1"),
    );
    expect(engineSessionPatch("claude", "claude-session-1")).toEqual({
      claudeSessionId: "claude-session-1",
    });

    const threadId = uuidV7ForDate("2026-07-02T18:30:00.000Z");
    const rolloutDir = join(home, ".codex", "sessions", "2026", "07", "02");
    mkdirSync(rolloutDir, { recursive: true });
    const rolloutPath = join(
      rolloutDir,
      `rollout-2026-07-02T18-30-00-${threadId}.jsonl`,
    );
    writeFileSync(rolloutPath, "");

    expect(getEngineTranscriptPath(cwd, threadId, "codex")).toBe(rolloutPath);
    expect(engineSessionPatch("codex", threadId)).toEqual({
      codexThreadId: threadId,
    });
    expect({
      claudeSessionId: "claude-session-1",
      ...engineSessionPatch("codex", threadId),
    }).toEqual({
      claudeSessionId: "claude-session-1",
      codexThreadId: threadId,
    });
  });

  it("reads back every engine session id engineSessionPatch writes", async () => {
    const { engineSessionPatch, engineSessionIdFor } = await import(
      `./sessions.ts?test=${crypto.randomUUID()}`
    );

    // The round trip is the invariant: a read rule that drifts from the write
    // rule returns undefined, which the caller can't tell from "first run" —
    // so it mints a fresh engine session and loses the conversation.
    for (const [provider, id] of [
      ["claude", "claude-session-1"],
      ["codex", uuidV7ForDate("2026-07-02T19:00:00.000Z")],
      ["pi", "ses_abc123"],
      ["pi", "pi-session-1"],
    ] as const) {
      expect(
        engineSessionIdFor(engineSessionPatch(provider, id), provider),
      ).toBe(id);
    }
  });

  it("falls back to the other engine transcript when the active provider has none", async () => {
    const codexThreadId = uuidV7ForDate("2026-07-02T18:45:00.000Z");
    const rolloutDir = join(home, ".codex", "sessions", "2026", "07", "02");
    mkdirSync(rolloutDir, { recursive: true });
    const rolloutPath = join(
      rolloutDir,
      `rollout-2026-07-02T18-45-00-${codexThreadId}.jsonl`,
    );
    writeFileSync(rolloutPath, "");
    writeSession("bks-switched-back-to-claude", {
      title: "Switched back to Claude before Claude transcript exists",
      model: "claude-fable-5-1",
      claudeSessionId: "missing-claude-transcript",
      codexThreadId,
    });

    const claudeDir = join(
      home,
      ".claude",
      "projects",
      "-home-ubuntu-projects-opensession",
    );
    mkdirSync(claudeDir, { recursive: true });
    const claudePath = join(claudeDir, "claude-only-transcript.jsonl");
    writeFileSync(claudePath, "");
    writeSession("bks-switched-to-codex", {
      title: "Switched to Codex before Codex transcript exists",
      model: "gpt-5.5",
      claudeSessionId: "claude-only-transcript",
      codexThreadId: "missing-codex-rollout",
    });

    const { getAllSessions } = await import(
      `./sessions.ts?test=${crypto.randomUUID()}`
    );
    const sessions = getAllSessions();

    expect(
      sessions.find(
        (s: UnifiedSession) => s.id === "bks-switched-back-to-claude",
      )?.transcriptPath,
    ).toBe(rolloutPath);
    expect(
      sessions.find((s: UnifiedSession) => s.id === "bks-switched-to-codex")
        ?.transcriptPath,
    ).toBe(claudePath);
  });

  it("removes a submitted review from the cached sidebar request immediately", async () => {
    writeFileSync(
      join(home, ".opensession-pr-cache.json"),
      JSON.stringify({
        version: 3,
        repos: {
          opensession: {
            "review-cache": {
              url: "https://github.com/tellahq/backstage/pull/123",
              state: "OPEN",
              number: 123,
              title: "Review cache test",
              isDraft: false,
              additions: 1,
              deletions: 0,
              changedFiles: 1,
              reviewDecision: "",
              author: "jfrolich",
              createdAt: "2026-07-27T09:00:00.000Z",
              updatedAt: "2026-07-27T09:00:00.000Z",
              checks: { total: 0, passed: 0, failed: 0, pending: 0 },
              mergeable: "MERGEABLE",
              reviewRequested: ["kent"],
              reviewedBy: [],
              assignees: [],
            },
          },
        },
        recentLimits: { opensession: 500 },
        probeEtags: {},
        lastFullRefresh: {},
      }),
    );
    writeSession("bks-review-cache", {
      title: "Review cache test",
      repo: "opensession",
      branch: "review-cache",
      startedBy: "Jaap",
    });

    const sessionsModule = await import(
      `./sessions.ts?test=${crypto.randomUUID()}`
    );
    // The PR cache lives in pr-cache.ts, which the cache-busting query on
    // sessions.ts does NOT reload — reseed the shared instance so it picks up
    // the snapshot written above (same pattern as the demo boot reseed).
    sessionsModule.loadPrCacheSnapshot();
    sessionsModule.markCachedPrReviewed(
      "tellahq/backstage",
      "review-cache",
      "kent",
      "COMMENT",
    );

    expect(sessionsModule.getOpenPrs()[0]?.reviewRequested).toEqual([]);
    expect(
      sessionsModule
        .getAllSessions()
        .find((session: UnifiedSession) => session.id === "bks-review-cache")
        ?.prReviewedBy,
    ).toEqual(["kent"]);
  });

  it("drops withdrawn review requests from the cached sidebar state immediately", async () => {
    writeFileSync(
      join(home, ".opensession-pr-cache.json"),
      JSON.stringify({
        version: 3,
        repos: {
          opensession: {
            "review-clear": {
              url: "https://github.com/tellahq/backstage/pull/124",
              state: "OPEN",
              number: 124,
              title: "Review clear test",
              isDraft: false,
              additions: 1,
              deletions: 0,
              changedFiles: 1,
              reviewDecision: "",
              author: "jfrolich",
              createdAt: "2026-07-27T09:00:00.000Z",
              updatedAt: "2026-07-27T09:00:00.000Z",
              checks: { total: 0, passed: 0, failed: 0, pending: 0 },
              mergeable: "MERGEABLE",
              reviewRequested: ["kent", "michiel"],
              reviewedBy: [],
              assignees: [],
            },
          },
        },
        recentLimits: { opensession: 500 },
        probeEtags: {},
        lastFullRefresh: {},
      }),
    );
    writeSession("bks-review-clear", {
      title: "Review clear test",
      repo: "opensession",
      branch: "review-clear",
      startedBy: "Jaap",
    });

    const sessionsModule = await import(
      `./sessions.ts?test=${crypto.randomUUID()}`
    );
    sessionsModule.loadPrCacheSnapshot();
    sessionsModule.markCachedPrReviewRequestsCleared(
      "tellahq/backstage",
      "review-clear",
    );

    expect(
      sessionsModule
        .getOpenPrs()
        .find((pr: { number: number }) => pr.number === 124)?.reviewRequested,
    ).toEqual([]);
    expect(
      sessionsModule
        .getAllSessions()
        .find((session: UnifiedSession) => session.id === "bks-review-clear")
        ?.prReviewRequested,
    ).toEqual([]);
  });
});
