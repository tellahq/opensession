import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setMemoryDirForTest, saveScope } from "../../agents/slack/memory";
import {
  closeMemoryRuntime,
  ensureMemoryV2Ready,
  memoryStore,
} from "./runtime";

let dir: string;
let legacyDir: string;
let previousDir: string | null;
let previousDb: string | undefined;
let previousMode: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-runtime-"));
  legacyDir = join(dir, "legacy");
  mkdirSync(legacyDir);
  previousDir = __setMemoryDirForTest(legacyDir);
  previousDb = process.env.OPENSESSION_MEMORY_DB;
  previousMode = process.env.OPENSESSION_MEMORY_MODE;
  process.env.OPENSESSION_MEMORY_DB = join(dir, "memory.sqlite");
  process.env.OPENSESSION_MEMORY_MODE = "v2";
});

afterEach(() => {
  closeMemoryRuntime();
  __setMemoryDirForTest(previousDir);
  if (previousDb === undefined) delete process.env.OPENSESSION_MEMORY_DB;
  else process.env.OPENSESSION_MEMORY_DB = previousDb;
  if (previousMode === undefined) delete process.env.OPENSESSION_MEMORY_MODE;
  else process.env.OPENSESSION_MEMORY_MODE = previousMode;
  rmSync(dir, { recursive: true, force: true });
});

describe("memory v2 runtime migration", () => {
  test("seals a verified import and survives JSON cleanup plus restart", async () => {
    const file = join(legacyDir, "repo-opensession.json");
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          {
            id: "legacy-1",
            text: "A durable imported fact.",
            by: "Fable",
            at: "2026-01-02T03:04:05Z",
          },
        ],
      }),
    );
    const first = await ensureMemoryV2Ready();
    expect(first.migration.complete).toBe(true);
    expect(first.migration.mapped).toBe(1);
    expect(memoryStore().metadata("legacy-migration-v2")).toContain(
      first.migration.sourceDigest,
    );
    unlinkSync(file);
    closeMemoryRuntime();

    const restarted = await ensureMemoryV2Ready();
    expect(restarted.migration.complete).toBe(true);
    expect(restarted.store.get("legacy-1")?.summary).toBe(
      "A durable imported fact.",
    );
    expect(JSON.parse(restarted.store.legacyRaw("legacy-1") || "{}").by).toBe(
      "Fable",
    );
  });

  test("fails closed and does not seal a malformed source", async () => {
    writeFileSync(join(legacyDir, "workspace.json"), "not json");
    await expect(ensureMemoryV2Ready()).rejects.toThrow(
      "migration is incomplete",
    );
    expect(memoryStore().metadata("legacy-migration-v2")).toBeNull();
  });

  test("upgrades an older seal and backfills raw legacy provenance", async () => {
    const file = join(legacyDir, "workspace.json");
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          {
            id: "legacy-old-seal",
            text: "A record from an older migration seal.",
            by: "Fable",
            at: "2025-01-02T03:04:05Z",
          },
        ],
      }),
    );
    const store = memoryStore();
    store.importLegacy(
      `${file}#workspace`,
      "legacy-old-seal",
      {
        scopeKey: "workspace",
        summary: "A record from an older migration seal.",
        kind: "reference",
        tier: "retrievable",
        source: { type: "slack" },
      },
      "active",
    );
    store.setMetadata(
      "legacy-migration-v2",
      JSON.stringify({ complete: true }),
    );
    const result = await ensureMemoryV2Ready();
    expect(result.migration.complete).toBe(true);
    expect(
      JSON.parse(result.store.legacyRaw("legacy-old-seal") || "{}").by,
    ).toBe("Fable");
    expect(
      JSON.parse(result.store.metadata("legacy-migration-v2") || "{}")
        .migrationVersion,
    ).toBe(2);
  });

  test("imports JSON written during a legacy rollback before resealing v2", async () => {
    await ensureMemoryV2Ready();
    process.env.OPENSESSION_MEMORY_MODE = "legacy";
    await saveScope("workspace", [
      {
        id: "rollback-write",
        text: "A fact written while legacy mode was active.",
        by: "Fable",
        at: "2026-04-01T00:00:00Z",
      },
    ]);
    process.env.OPENSESSION_MEMORY_MODE = "v2";
    closeMemoryRuntime();
    const restarted = await ensureMemoryV2Ready();
    expect(restarted.store.get("rollback-write")?.summary).toBe(
      "A fact written while legacy mode was active.",
    );
  });

  test("refreshes shadow retrieval after a same-process JSON write", async () => {
    process.env.OPENSESSION_MEMORY_MODE = "shadow";
    await ensureMemoryV2Ready();
    await saveScope("workspace", [
      {
        id: "shadow-write",
        text: "A fact written during shadow comparison.",
        by: "Fable",
        at: "2026-04-02T00:00:00Z",
      },
    ]);
    expect(memoryStore().get("shadow-write")?.summary).toBe(
      "A fact written during shadow comparison.",
    );
  });

  test("reconciles edits and lifecycle changes made during legacy rollback", async () => {
    await saveScope("workspace", [
      {
        id: "rollback-edit",
        text: "The original rollback fact.",
        by: "Fable",
        at: "2026-04-03T00:00:00Z",
      },
    ]);
    const first = await ensureMemoryV2Ready();
    expect(first.store.get("rollback-edit")?.state).toBe("active");
    process.env.OPENSESSION_MEMORY_MODE = "legacy";
    await saveScope("workspace", [
      {
        id: "rollback-edit",
        text: "The corrected rollback fact.",
        by: "Fable",
        at: "2026-04-04T00:00:00Z",
        archivedAt: "2026-04-05T00:00:00Z",
      },
    ]);
    process.env.OPENSESSION_MEMORY_MODE = "v2";
    closeMemoryRuntime();
    const restarted = await ensureMemoryV2Ready();
    expect(restarted.store.get("rollback-edit")?.summary).toBe(
      "The corrected rollback fact.",
    );
    expect(restarted.store.get("rollback-edit")?.state).toBe("archived");
  });

  test("archives rows deleted during legacy rollback while retaining their aliases", async () => {
    await saveScope("workspace", [
      {
        id: "rollback-delete",
        text: "A rollback fact that will be removed.",
        by: "Fable",
        at: "2026-04-05T00:00:00Z",
      },
    ]);
    await ensureMemoryV2Ready();
    process.env.OPENSESSION_MEMORY_MODE = "legacy";
    await saveScope("workspace", []);
    process.env.OPENSESSION_MEMORY_MODE = "v2";
    closeMemoryRuntime();
    const restarted = await ensureMemoryV2Ready();
    expect(restarted.store.get("rollback-delete")?.state).toBe("archived");
    expect(restarted.store.legacyRaw("rollback-delete")).toContain(
      "will be removed",
    );
    process.env.OPENSESSION_MEMORY_MODE = "legacy";
    await saveScope("workspace", [
      {
        id: "rollback-delete",
        text: "A rollback fact that will be removed.",
        by: "Fable",
        at: "2026-04-05T00:00:00Z",
      },
    ]);
    process.env.OPENSESSION_MEMORY_MODE = "v2";
    closeMemoryRuntime();
    const restored = await ensureMemoryV2Ready();
    expect(restored.store.get("rollback-delete")?.state).toBe("active");
  });

  test("does not overwrite later v2 edits from unchanged source JSON", async () => {
    await saveScope("workspace", [
      {
        id: "v2-edit",
        text: "The source JSON fact.",
        by: "Fable",
        at: "2026-04-06T00:00:00Z",
      },
    ]);
    const first = await ensureMemoryV2Ready();
    first.store.update("v2-edit", { summary: "The reviewed v2 fact." });
    closeMemoryRuntime();
    const restarted = await ensureMemoryV2Ready();
    expect(restarted.store.get("v2-edit")?.summary).toBe(
      "The reviewed v2 fact.",
    );
  });
});
