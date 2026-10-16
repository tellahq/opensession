import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionListStore } from "./session-list-sqlite";
import type { UnifiedSession } from "./types";

let store: SessionListStore;
beforeEach(() => {
  store = new SessionListStore(":memory:");
});
afterEach(() => store.close());
const a = { githubAccountId: 101 };
const b = { githubAccountId: 202 };
function row(id: string, extra: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id,
    claudeSessionId: null,
    source: "opensession",
    title: id,
    branch: "same",
    worktreeDir: "/worktrees/same",
    workspaceId: "workspace",
    createdBy: "Alice",
    startedBy: "Alice",
    transcriptPath: null,
    createdAt: "2026-01-01",
    lastActivity: "2026-01-01",
    isRunning: false,
    ...extra,
  };
}
function seed() {
  const shared = row("shared");
  const privateA = row("private-a", {
    accessScope: { kind: "personal", ownerGithubAccountId: 101 },
  });
  const privateB = row("private-b", {
    accessScope: { kind: "personal", ownerGithubAccountId: 202 },
  });
  store.replaceAll([shared, privateA, privateB]);
  store.resetScopeReplica("test");
  store.applyScopeDelta(store.scopeState()!, {
    fence: { incarnation: "test", generation: 2 },
    rows: [
      {
        id: "private-a",
        canonicalId: "private-a",
        owner: 101,
        deleted: false,
        generation: 1,
      },
      {
        id: "private-b",
        canonicalId: "private-b",
        owner: 202,
        deleted: false,
        generation: 2,
      },
    ],
  });
  return { shared, privateA, privateB };
}

test("all unattributed list-index selectors and exact reads see shared rows only", () => {
  const { privateA } = seed();
  expect(store.count()).toBe(1);
  expect(store.get("private-a")).toBeNull();
  expect(store.getWithVisibilityGroup("private-a")).toBeNull();
  expect(store.listVisibilityGroup(privateA)).toEqual([]);
  for (const rows of [
    store.list(),
    store.listSidebar("private-a"),
    store.listLiveByBranch(["same"]),
    store.listWorkspaceMembers("workspace"),
  ]) {
    expect(rows.map((row) => row.id)).toEqual(["shared"]);
  }
  expect(store.get("private-a", b)).toBeNull();
  expect(store.get("private-a", a)?.id).toBe("private-a");
  expect(store.count(a)).toBe(2);
  expect(
    store
      .list("include", a)
      .map((row) => row.id)
      .sort(),
  ).toEqual(["private-a", "shared"]);
  store.setArchived("private-a", true);
  expect(store.get("private-a", a)?.archived).toBeUndefined();
});

test("automation rank/count, selected archived ids and workspace counts cannot leak private rows", () => {
  seed();
  store.upsert(
    row("private-archived", {
      archived: true,
      accessScope: { kind: "personal", ownerGithubAccountId: 101 },
    }),
  );
  store.upsert(
    row("private-workspace", {
      workspaceId: "secret",
      accessScope: { kind: "personal", ownerGithubAccountId: 101 },
    }),
  );
  for (let i = 0; i < 10; i++)
    store.upsert(
      row(`automation-private-${i}`, {
        automation: "shared-goal",
        accessScope: { kind: "personal", ownerGithubAccountId: 101 },
      }),
    );
  store.upsert(row("automation-shared", { automation: "shared-goal" }));
  const sidebar = store.listSidebar("private-archived");
  expect(sidebar.map((row) => row.id).sort()).toEqual([
    "automation-shared",
    "shared",
  ]);
  expect(
    sidebar.find((row) => row.id === "automation-shared")?.automationRunCount,
  ).toBe(1);
  expect(store.activeWorkspaceIds()).toEqual(["workspace"]);
  expect(store.listWorkspace("workspace", "/worktrees/same")).toEqual([]);
});

test("scoped counts and activity lists use the owner index instead of parsing every payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-access-query-plan-"));
  const path = join(dir, "list.db");
  const indexed = new SessionListStore(path);
  const db = new Database(path, { readonly: true });
  try {
    indexed.replaceAll([
      row("shared"),
      row("personal", {
        accessScope: { kind: "personal", ownerGithubAccountId: 101 },
      }),
    ]);
    indexed.resetScopeReplica("test");
    indexed.applyScopeDelta(indexed.scopeState()!, {
      fence: { incarnation: "test", generation: 1 },
      rows: [
        {
          id: "personal",
          canonicalId: "personal",
          owner: 101,
          deleted: false,
          generation: 1,
        },
      ],
    });
    for (const principal of [undefined, a]) {
      const predicate = principal
        ? `access_owner IN (0, ${principal.githubAccountId})`
        : "access_owner=0";
      for (const sql of [
        `SELECT count(*) FROM session_list WHERE ${predicate}`,
        `SELECT payload FROM session_list WHERE ${predicate} ORDER BY last_activity_ms DESC, id LIMIT 10`,
      ]) {
        const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as {
          detail: string;
        }[];
        expect(
          plan.some(({ detail }) =>
            /USING (?:COVERING )?INDEX idx_session_list_access_owner_activity/.test(
              detail,
            ),
          ),
        ).toBe(true);
        expect(
          plan.some(({ detail }) => detail.startsWith("SCAN session_list")),
        ).toBe(false);
      }
    }
    expect(indexed.count()).toBe(1);
    expect(indexed.count(a)).toBe(2);
  } finally {
    db.close();
    indexed.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed scopes in stale index payloads do not degrade to shared", () => {
  for (const [i, accessScope] of [
    null,
    {},
    { kind: "personal" },
    { kind: "personal", ownerGithubAccountId: "101" },
    { kind: "future" },
  ].entries()) {
    store.upsert(
      row(`malformed-${i}`, {
        accessScope,
      } as unknown as Partial<UnifiedSession>),
    );
  }
  expect(store.count()).toBe(0);
  expect(store.count(a)).toBe(0);
  expect(store.listSidebar()).toEqual([]);
});
