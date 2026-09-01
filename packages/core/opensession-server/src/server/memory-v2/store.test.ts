import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuplicateMemoryError, MemoryStore } from "./store";
import type { CreateMemoryInput } from "./types";

const stores: Array<{ store: MemoryStore; dir: string }> = [];

afterEach(() => {
  for (const item of stores.splice(0)) {
    item.store.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

function fresh(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "memory-v2-store-"));
  const store = new MemoryStore(join(dir, "memory.db"));
  stores.push({ store, dir });
  return store;
}

function input(
  summary: string,
  overrides: Partial<CreateMemoryInput> = {},
): CreateMemoryInput {
  return {
    scopeKey: "repo-opensession",
    summary,
    kind: "gotcha",
    tier: "retrievable",
    source: { type: "agent-verified", sessionId: "os-1", turnId: "turn-1" },
    tags: ["Runner", "deploy"],
    ...overrides,
  };
}

describe("memory v2 CRUD", () => {
  test("roundtrips structured records and enforces the summary limit", () => {
    const store = fresh();
    const created = store.create(
      input("Restart the service after backend changes.", {
        details: "systemctl restart opensession",
      }),
    );
    expect(store.get(created.id)).toEqual(created);
    expect(created.fingerprint).toHaveLength(64);
    expect(created.tags).toEqual(["runner", "deploy"]);
    expect(() => store.create(input("x".repeat(401)))).toThrow(
      "400 characters",
    );
    expect(() => store.create(input("One. Two. Three."))).toThrow(
      "one or two sentences",
    );
    expect(() =>
      store.create(input("Bounded details.", { details: "x".repeat(20_001) })),
    ).toThrow("20000 bytes");
    expect(() =>
      store.create(
        input("Bounded tags.", {
          tags: Array.from({ length: 13 }, (_, i) => `tag-${i}`),
        }),
      ),
    ).toThrow("12 items");
  });

  test("rejects normalized exact duplicates in one scope but permits another scope", () => {
    const store = fresh();
    const first = store.create(
      input("Restart after backend changes.", { details: "Use systemctl." }),
    );
    expect(() =>
      store.create(
        input("  RESTART  after backend changes. ", {
          details: " Use  systemctl. ",
        }),
      ),
    ).toThrow(DuplicateMemoryError);
    expect(() =>
      store.create(
        input(first.summary, { details: first.details, scopeKey: "workspace" }),
      ),
    ).not.toThrow();
  });

  test("updates, paginates, filters, and hard deletes", () => {
    const store = fresh();
    const base = new Date("2026-01-01T00:00:00.000Z");
    const one = store.create(
      input("One", { createdAt: base.toISOString() }),
      base,
    );
    const two = store.create(
      input("Two", { createdAt: "2026-01-02T00:00:00.000Z", kind: "decision" }),
      new Date("2026-01-02"),
    );
    const three = store.create(
      input("Three", { createdAt: "2026-01-03T00:00:00.000Z" }),
      new Date("2026-01-03"),
    );
    const firstPage = store.list({}, { limit: 2 });
    expect(firstPage.items.map((item) => item.id)).toEqual([three.id, two.id]);
    expect(
      store
        .list({}, { limit: 2, cursor: firstPage.nextCursor })
        .items.map((item) => item.id),
    ).toEqual([one.id]);
    expect(
      store.list({ kinds: ["decision"] }).items.map((item) => item.id),
    ).toEqual([two.id]);

    const updated = store.update(one.id, {
      summary: "One updated",
      tier: "pinned",
      tags: ["important"],
    });
    expect(updated.summary).toBe("One updated");
    expect(updated.tier).toBe("pinned");
    expect(store.delete(one.id)).toBe(true);
    expect(store.get(one.id)).toBeNull();
  });

  test("reports per-scope ambient and review aggregates", () => {
    const store = fresh();
    store.create(
      input("Pinned preference", {
        tier: "pinned",
        kind: "preference",
        lastConfirmedAt: "2026-02-01T00:00:00Z",
      }),
    );
    const review = store.create(input("Review candidate"));
    store.create(
      input("Other scope pin", { scopeKey: "workspace", tier: "pinned" }),
    );
    store.archive(review.id);
    const stats = store.stats();
    expect(stats).toMatchObject({ total: 3, active: 2, pinned: 2, review: 1 });
    expect(stats.ambientSummaryChars).toBe(
      "Pinned preference".length + "Other scope pin".length,
    );
    expect(stats.scopes.map((scope) => scope.scopeKey)).toEqual([
      "repo-opensession",
      "workspace",
    ]);
    expect(
      store.list({ confirmed: false }).items.map((item) => item.summary),
    ).toEqual(["Other scope pin"]);
    expect(
      store.list({ confirmed: true }).items.map((item) => item.summary),
    ).toEqual(["Pinned preference"]);
  });
});

describe("search and retrieval", () => {
  test("searches summaries, details, and tags with paginated compact results", () => {
    const store = fresh();
    const actor = store.create(
      input("Actor sessions need a deliberate restart", {
        details: "The run host reconnects after restart.",
        tags: ["actor", "runner"],
      }),
    );
    store.create(
      input("Frontend changes rebuild in process", { tags: ["frontend"] }),
    );
    expect(store.search("actor restart").items.map((item) => item.id)).toEqual([
      actor.id,
    ]);
    expect(
      store.search("reconnect", { includeDetails: false }).items[0].details,
    ).toBeUndefined();
    expect(
      store.search("reconnect", { includeDetails: true }).items[0].details,
    ).toContain("reconnects");

    const first = store.search("changes", { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(
      store.search("changes", { limit: 1, cursor: first.nextCursor }).items,
    ).toHaveLength(1);
  });

  test("finds related write candidates and records retrieval telemetry", () => {
    const store = fresh();
    const existing = store.create(
      input("Actor run hosts reconnect after a server restart."),
    );
    const candidates = store.findRelatedCandidates(
      input("Actor sessions reconnect after restart."),
    );
    expect(candidates[0].record.id).toBe(existing.id);
    expect(store.markRetrieved([existing.id, existing.id])).toBe(1);
    expect(store.get(existing.id)?.retrievalCount).toBe(1);
    expect(store.get(existing.id)?.lastRetrievedAt).toBeDefined();
  });
});

describe("memory lifecycle", () => {
  test("archives, restores, confirms, supersedes, and expires atomically", () => {
    const store = fresh();
    const old = store.create(input("The old deployment fact."));
    expect(store.archive(old.id).state).toBe("archived");
    expect(store.list().items).toHaveLength(0);
    expect(store.restore(old.id).state).toBe("active");
    expect(
      store.confirm(old.id, new Date("2026-04-01T00:00:00Z")).lastConfirmedAt,
    ).toBe("2026-04-01T00:00:00.000Z");

    const replacement = store.supersede({
      ...input("The corrected deployment fact."),
      supersedes: [old.id],
    });
    expect(replacement.supersedes).toEqual([old.id]);
    expect(store.get(old.id)?.state).toBe("superseded");
    expect(store.get(old.id)?.supersededBy).toBe(replacement.id);

    const expiring = store.create(
      input("Temporary incident status", {
        kind: "status",
        expiresAt: "2026-05-02T00:00:00Z",
      }),
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(store.expireDue(new Date("2026-05-03T00:00:00Z"))).toBe(1);
    expect(store.get(expiring.id)?.state).toBe("expired");
    expect(() => store.update(expiring.id, { expiresAt: null })).toThrow(
      "Only active memories",
    );
    const activeStatus = store.create(
      input("Another temporary incident status", {
        kind: "status",
        expiresAt: "2026-05-04T00:00:00Z",
      }),
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(() => store.update(activeStatus.id, { expiresAt: null })).toThrow(
      "require expiresAt",
    );
  });

  test("rolls back a cross-scope supersession", () => {
    const store = fresh();
    const old = store.create(input("Scoped fact", { scopeKey: "workspace" }));
    expect(() =>
      store.supersede({ ...input("Replacement"), supersedes: [old.id] }),
    ).toThrow("across scopes");
    expect(store.get(old.id)?.state).toBe("active");
    expect(store.search("Replacement").items).toHaveLength(0);
  });

  test("legacy ids remain usable for lifecycle mutations", () => {
    const store = fresh();
    const imported = store.importLegacy(
      "/legacy/workspace.json#workspace",
      "old-id",
      {
        scopeKey: "workspace",
        summary: "Legacy alias mutation fact.",
        kind: "reference",
        tier: "retrievable",
        source: { type: "slack" },
      },
      "active",
    );
    expect(store.archive("old-id").state).toBe("archived");
    expect(store.restore("old-id").state).toBe("active");
    expect(store.confirm("old-id").lastConfirmedAt).toBeTruthy();
    expect(
      store.update("old-id", { summary: "Updated through its legacy alias." })
        .id,
    ).toBe(imported.record.id);
    expect(store.delete("old-id")).toBe(true);
    expect(store.get(imported.record.id)).toBeNull();
  });
});
