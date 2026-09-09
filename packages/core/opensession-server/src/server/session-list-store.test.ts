import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionListStore } from "./session-list-sqlite";
import type { UnifiedSession } from "./types";

const stores: SessionListStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function session(
  id: string,
  lastActivity: string,
  patch: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    createdBy: "Kent",
    startedBy: "Kent",
    title: id,
    lastActivity,
    createdAt: lastActivity,
    isRunning: false,
    transcriptPath: null,
    ...patch,
  } as UnifiedSession;
}

function memoryStore(): SessionListStore {
  const store = new SessionListStore(":memory:");
  stores.push(store);
  return store;
}

describe("SessionListStore", () => {
  test("finds live rows by branch through the branch index", () => {
    const store = memoryStore();
    store.upsertMany([
      session("on-branch", "2026-09-01T00:00:00.000Z", { branch: "feat-x" }),
      session("review-checkout", "2026-09-01T00:00:00.000Z", {
        branch: "feat-x-os-review",
      }),
      session("archived-on-branch", "2026-09-01T00:00:00.000Z", {
        branch: "feat-x",
        archived: true,
      }),
      session("elsewhere", "2026-09-01T00:00:00.000Z", { branch: "main" }),
    ]);
    expect(
      store
        .listLiveByBranch(["feat-x", "feat-x-os-review"])
        .map((row) => row.id)
        .sort(),
    ).toEqual(["on-branch", "review-checkout"]);
    expect(store.listLiveByBranch([])).toEqual([]);
    expect(
      store
        .queryPlan(
          "SELECT payload FROM session_list WHERE archived = 0 AND branch IN (?, ?)",
        )
        .join("\n"),
    ).toContain("idx_session_list_branch");
  });

  test("adds the branch column to an index built before it existed and drops coverage", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-list-store-"));
    const path = join(dir, "list.db");
    try {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE session_list_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE session_list (
          id TEXT PRIMARY KEY, source TEXT NOT NULL, archived INTEGER NOT NULL,
          last_activity_ms INTEGER NOT NULL, workspace_id TEXT, worktree_dir TEXT,
          automation TEXT, repo TEXT, started_by TEXT, created_by TEXT,
          desk INTEGER NOT NULL DEFAULT 0, is_running INTEGER NOT NULL DEFAULT 0,
          waiting_for_input INTEGER NOT NULL DEFAULT 0, manual_status TEXT,
          payload TEXT NOT NULL
        );
        INSERT INTO session_list_meta VALUES ('covered:include', '1'), ('covered:exclude', '1');
      `);
      legacy.close();

      const store = new SessionListStore(path);
      stores.push(store);
      // Coverage is gone: old rows have no branch, so the next rebuild must
      // refill every row rather than leave them unmatched by branch.
      expect(store.hasCoverage("include")).toBe(false);
      expect(store.hasCoverage("exclude")).toBe(false);
      store.upsert(
        session("later", "2026-09-01T00:00:00.000Z", { branch: "feat-y" }),
      );
      expect(store.listLiveByBranch(["feat-y"]).map((row) => row.id)).toEqual([
        "later",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses archive and activity index for a live list", () => {
    const store = memoryStore();
    const plan = store.queryPlan(
      "SELECT payload FROM session_list WHERE archived = 0 ORDER BY last_activity_ms DESC",
    );
    expect(plan.join("\n")).toContain("idx_session_list_archive_activity");
    expect(
      store
        .queryPlan(
          "SELECT DISTINCT workspace_id FROM session_list WHERE archived = 0 AND workspace_id IS NOT NULL",
        )
        .join("\n"),
    ).toContain("idx_session_list_archive_workspace");
    expect(
      store
        .queryPlan(
          "SELECT payload FROM session_list WHERE workspace_id = ? AND archived = 1 ORDER BY last_activity_ms DESC",
          "workspace-one",
        )
        .join("\n"),
    ).toContain("idx_session_list_workspace_activity");
    expect(
      store
        .queryPlan(
          "SELECT payload FROM session_list WHERE worktree_dir = ? AND archived = 1 ORDER BY last_activity_ms DESC",
          "/tmp/worktrees/one",
        )
        .join("\n"),
    ).toContain("idx_session_list_worktree_activity");
    expect(
      store
        .queryPlan(
          "SELECT payload FROM session_list WHERE automation = ? AND archived = 0 ORDER BY last_activity_ms DESC",
          "triage",
        )
        .join("\n"),
    ).toContain("idx_session_list_live_automation_activity");
  });

  test("lists active workspace ids without decoding session payloads", () => {
    const store = memoryStore();
    store.upsertMany([
      session("live-one", "2026-08-22T12:00:00.000Z", { workspaceId: "one" }),
      session("live-two", "2026-08-22T11:00:00.000Z", { workspaceId: "one" }),
      session("archived", "2026-08-22T10:00:00.000Z", {
        workspaceId: "two",
        archived: true,
      }),
    ]);

    expect(store.activeWorkspaceIds()).toEqual(["one"]);
  });

  test("returns only five ordinary runs per automation without parsing the rest", () => {
    const store = memoryStore();
    const rows: UnifiedSession[] = [
      session("human", "2026-08-22T12:00:00.000Z"),
    ];
    for (let index = 0; index < 20; index++) {
      rows.push(
        session(
          `auto-${index}`,
          `2026-08-22T11:${String(index).padStart(2, "0")}:00.000Z`,
          {
            automation: "triage",
          },
        ),
      );
    }
    store.upsertMany(rows);

    const listed = store.listSidebar();
    expect(listed.map((row) => row.id)).toContain("human");
    expect(listed.filter((row) => row.automation)).toHaveLength(5);
    expect(listed.find((row) => row.automation)?.automationRunCount).toBe(20);
  });

  test("keeps selected, running, waiting, and manually filed automation runs", () => {
    const store = memoryStore();
    const rows: UnifiedSession[] = [];
    for (let index = 0; index < 10; index++) {
      rows.push(
        session(
          `auto-${index}`,
          `2026-08-22T11:${String(index).padStart(2, "0")}:00.000Z`,
          {
            automation: "triage",
            ...(index === 0 ? { isRunning: true } : {}),
            ...(index === 1 ? { waitingForInput: true } : {}),
            ...(index === 2 ? { manualStatus: "pending" } : {}),
          },
        ),
      );
    }
    store.upsertMany(rows);

    const ids = new Set(store.listSidebar("auto-3").map((row) => row.id));
    expect(ids).toEqual(
      new Set([
        "auto-0",
        "auto-1",
        "auto-2",
        "auto-3",
        "auto-5",
        "auto-6",
        "auto-7",
        "auto-8",
        "auto-9",
      ]),
    );
  });

  test("includes an archived session when its direct route is selected", () => {
    const store = memoryStore();
    store.upsertMany([
      session("live", "2026-08-22T12:00:00.000Z"),
      session("archived", "2026-08-22T11:00:00.000Z", {
        archived: true,
        automation: "triage",
      }),
    ]);

    expect(store.listSidebar().map((row) => row.id)).toEqual(["live"]);
    expect(store.listSidebar("archived").map((row) => row.id)).toEqual([
      "live",
      "archived",
    ]);
  });

  test("updates archive columns and payload together", () => {
    const store = memoryStore();
    store.upsert(session("one", "2026-08-22T12:00:00.000Z"));

    store.setArchived("one", true, "manual");
    expect(store.list("exclude")).toHaveLength(0);
    expect(store.list("only")[0]).toMatchObject({
      id: "one",
      archived: true,
      archivedReason: "manual",
    });
  });

  test("queries every member of one workspace without scanning other rows", () => {
    const store = memoryStore();
    store.upsertMany([
      session("live", "2026-08-22T12:00:00.000Z", {
        workspaceId: "workspace-one",
      }),
      session("archived", "2026-08-22T11:00:00.000Z", {
        archived: true,
        workspaceId: "workspace-one",
      }),
      session("other", "2026-08-22T10:00:00.000Z", {
        workspaceId: "workspace-two",
      }),
    ]);

    expect(
      store.listWorkspaceMembers("workspace-one").map((row) => row.id),
    ).toEqual(["live", "archived"]);
  });

  test("queries one archived workspace through indexed identity fields", () => {
    const store = memoryStore();
    store.upsertMany([
      session("by-id", "2026-08-22T12:00:00.000Z", {
        archived: true,
        workspaceId: "workspace-one",
      }),
      session("legacy", "2026-08-22T11:00:00.000Z", {
        archived: true,
        worktreeDir: "/tmp/worktrees/one",
      }),
      session("other", "2026-08-22T10:00:00.000Z", {
        archived: true,
        workspaceId: "workspace-two",
      }),
    ]);

    expect(
      store
        .listWorkspace("workspace-one", "/tmp/worktrees/one")
        .map((row) => row.id),
    ).toEqual(["by-id", "legacy"]);
  });
});
