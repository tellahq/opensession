import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setMemoryDirForTest } from "../../agents/slack/memory";
import { closeMemoryRuntime, ensureMemoryV2Ready } from "../memory-v2";
import { configuredIdentity } from "../config";
import type { RouteContext } from "./context";
import { handleMemoryRoutes } from "./memory";

let dir: string;
let previousMemoryDir: string | null;
let previousDb: string | undefined;
let previousMode: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-route-"));
  const legacyDir = join(dir, "legacy");
  mkdirSync(legacyDir);
  previousMemoryDir = __setMemoryDirForTest(legacyDir);
  previousDb = process.env.OPENSESSION_MEMORY_DB;
  previousMode = process.env.OPENSESSION_MEMORY_MODE;
  process.env.OPENSESSION_MEMORY_DB = join(dir, "memory.sqlite");
  process.env.OPENSESSION_MEMORY_MODE = "v2";
});

afterEach(() => {
  closeMemoryRuntime();
  __setMemoryDirForTest(previousMemoryDir);
  if (previousDb === undefined) delete process.env.OPENSESSION_MEMORY_DB;
  else process.env.OPENSESSION_MEMORY_DB = previousDb;
  if (previousMode === undefined) delete process.env.OPENSESSION_MEMORY_MODE;
  else process.env.OPENSESSION_MEMORY_MODE = previousMode;
  rmSync(dir, { recursive: true, force: true });
});

function context(path: string, init?: RequestInit): RouteContext {
  const url = new URL(`http://localhost${path}`);
  const team = configuredIdentity().team;
  const admin = team.find((member) => member.admin === true) || team[0];
  return {
    req: new Request(url, init),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: admin?.github ? { login: admin.github, name: admin.name } : null,
  };
}

describe("memory v2 routes", () => {
  test("creates, pages, reads details, pins, and archives structured memory", async () => {
    const createdResponse = await handleMemoryRoutes(
      context("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scopeKey: "repo-opensession",
          summary: "Backend changes require a deliberate service restart.",
          details: "Restart only after verification.",
          kind: "constraint",
        }),
      }),
    );
    expect(createdResponse?.status).toBe(200);
    const created = await createdResponse!.json();
    expect(created.entry.hasDetails).toBe(true);
    expect(created.entry.details).toBeUndefined();

    const page = await (await handleMemoryRoutes(
      context("/api/memory?scopeKey=repo-opensession&limit=20"),
    ))!.json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0].details).toBeUndefined();

    const read = await (await handleMemoryRoutes(
      context(`/api/memory/${created.entry.id}?scopeKey=repo-opensession`),
    ))!.json();
    expect(read.entry.details).toBe("Restart only after verification.");

    const pinned = await (await handleMemoryRoutes(
      context(`/api/memory/${created.entry.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopeKey: "repo-opensession", action: "pin" }),
      }),
    ))!.json();
    expect(pinned.entry.tier).toBe("pinned");
    expect(pinned.entry.source.type).toBe("settings");

    const scopes = await (await handleMemoryRoutes(
      context("/api/memory/scopes"),
    ))!.json();
    const repo = scopes.scopes.find(
      (item: any) => item.scope.key === "repo-opensession",
    );
    expect(repo.pinnedCount).toBe(1);
    expect(scopes.stats.ambientBudgetBytes).toBe(2_500);
  });

  test("rejects verbose summaries and non-expiring status", async () => {
    for (const body of [
      {
        scopeKey: "workspace",
        summary: "One. Two. Three.",
        kind: "decision",
      },
      {
        scopeKey: "workspace",
        summary: "The incident is active.",
        kind: "status",
      },
    ]) {
      const response = await handleMemoryRoutes(
        context("/api/memory", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response?.status).toBe(400);
    }
  });

  test("preserves provenance when Settings edits an imported or agent-verified memory", async () => {
    const { store } = await ensureMemoryV2Ready();
    const original = store.create({
      scopeKey: "repo-opensession",
      summary: "Use Bun for repository scripts.",
      kind: "constraint",
      tier: "retrievable",
      source: { type: "agent-verified", sessionId: "session-source" },
    });
    const response = await handleMemoryRoutes(
      context(`/api/memory/${original.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scopeKey: "repo-opensession",
          summary: "Use Bun for all repository scripts.",
        }),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.entry.source).toEqual({
      type: "agent-verified",
      sessionId: "session-source",
    });
  });

  test("keeps another teammate's private memory out of direct route reads", async () => {
    const team = configuredIdentity().team;
    const viewer = team[0];
    const other = team.find(
      (member) => member.slackId && member.github !== viewer?.github,
    );
    if (!viewer?.github || !other?.slackId) return;
    const { store } = await ensureMemoryV2Ready();
    const privateRecord = store.create({
      scopeKey: `user-${other.slackId}`,
      summary: "A private teammate preference.",
      kind: "preference",
      tier: "retrievable",
      source: { type: "user-explicit" },
    });
    const ctx = context(
      `/api/memory/${privateRecord.id}?scopeKey=${privateRecord.scopeKey}`,
    );
    ctx.authUser = { login: viewer.github, name: viewer.name };
    const response = await handleMemoryRoutes(ctx);
    expect(response?.status).toBe(404);
  });

  test("keeps the legacy rollback route usable but requires archive before delete", async () => {
    process.env.OPENSESSION_MEMORY_MODE = "legacy";
    const created = await (await handleMemoryRoutes(
      context("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scopeKey: "repo-opensession",
          summary: "A rollback-compatible fact.",
        }),
      }),
    ))!.json();
    const id = created.entry.id;
    const activeDelete = await handleMemoryRoutes(
      context(`/api/memory/${id}?scopeKey=repo-opensession&confirm=true`, {
        method: "DELETE",
      }),
    );
    expect(activeDelete?.status).toBe(400);
    const archived = await handleMemoryRoutes(
      context(`/api/memory/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scopeKey: "repo-opensession",
          action: "archive",
        }),
      }),
    );
    expect(archived?.status).toBe(200);
    const removed = await handleMemoryRoutes(
      context(`/api/memory/${id}?scopeKey=repo-opensession&confirm=true`, {
        method: "DELETE",
      }),
    );
    expect(removed?.status).toBe(200);
  });

  test("applies private-scope authorization to legacy creates and merges", async () => {
    const team = configuredIdentity().team;
    const viewer = team[0];
    const other = team.find(
      (member) => member.slackId && member.github !== viewer?.github,
    );
    if (!viewer?.github || !other?.slackId) return;
    process.env.OPENSESSION_MEMORY_MODE = "legacy";
    for (const [path, body] of [
      [
        "/api/memory",
        {
          scopeKey: `user-${other.slackId}`,
          summary: "Unauthorized private write.",
        },
      ],
      [
        "/api/memory/merge",
        {
          scopeKey: `user-${other.slackId}`,
          ids: ["one", "two"],
          summary: "Unauthorized private merge.",
        },
      ],
    ] as const) {
      const ctx = context(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      ctx.authUser = { login: viewer.github, name: viewer.name };
      expect((await handleMemoryRoutes(ctx))?.status).toBe(404);
    }
  });
});
