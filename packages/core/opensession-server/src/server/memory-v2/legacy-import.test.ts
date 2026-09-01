import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importLegacyMemoryDirectory } from "./legacy-import";
import { MemoryStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("legacy JSON migration", () => {
  test("preserves original text, maps lifecycle, and is idempotent without modifying JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-v2-import-"));
    dirs.push(dir);
    const legacyDir = join(dir, "legacy");
    const dbPath = join(dir, "memory.db");
    await Bun.write(join(legacyDir, ".keep"), "");
    const file = join(legacyDir, "repo-opensession.json");
    const longText = `Operational detail ${"with supporting evidence ".repeat(30)}`;
    const original = JSON.stringify(
      {
        entries: [
          {
            id: "old-1",
            text: longText,
            by: "Fable",
            at: "2026-02-01T10:00:00Z",
            supersedes: ["old-3"],
          },
          {
            id: "old-2",
            text: "A retired fact",
            archivedAt: "2026-02-02T10:00:00Z",
          },
          {
            id: "old-3",
            text: "A replaced fact",
            archivedAt: "2026-02-02T10:00:00Z",
            supersededBy: "old-1",
          },
        ],
      },
      null,
      2,
    );
    writeFileSync(file, original);

    const store = new MemoryStore(dbPath);
    try {
      const first = await importLegacyMemoryDirectory(store, legacyDir);
      expect(first).toMatchObject({
        files: 1,
        discovered: 3,
        imported: 3,
        alreadyImported: 0,
        mapped: 3,
        skipped: 0,
        complete: true,
        errors: [],
      });
      const all = store.list(
        { states: ["active", "archived", "superseded"] },
        { limit: 10 },
      ).items;
      expect(all).toHaveLength(3);
      const importedLong = all.find((item) => item.details === longText);
      const replaced = all.find((item) => item.details === "A replaced fact");
      expect(importedLong?.summary.length).toBeLessThanOrEqual(400);
      expect(importedLong?.tier).toBe("retrievable");
      expect(importedLong?.source.type).toBe("agent-verified");
      expect(store.get("old-1")?.id).toBe(importedLong?.id);
      expect(JSON.parse(store.legacyRaw("old-1") || "{}").by).toBe("Fable");
      expect(all.find((item) => item.details === "A retired fact")?.state).toBe(
        "archived",
      );
      expect(replaced?.state).toBe("superseded");
      expect(replaced?.supersededBy).toBe(importedLong?.id);
      expect(importedLong?.supersedes).toEqual([replaced!.id]);

      const second = await importLegacyMemoryDirectory(store, legacyDir);
      expect(second).toMatchObject({
        imported: 0,
        alreadyImported: 3,
        mapped: 3,
        complete: true,
        errors: [],
      });
      expect(
        store.list({ states: ["active", "archived", "superseded"] }).items,
      ).toHaveLength(3);
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      store.close();
    }
  });

  test("shares an existing exact record instead of duplicating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-v2-import-dedup-"));
    dirs.push(dir);
    const legacyDir = join(dir, "legacy");
    const file = join(legacyDir, "workspace.json");
    await Bun.write(
      file,
      JSON.stringify({
        entries: [{ id: "old-1", text: "Keep responses concise." }],
      }),
    );
    const store = new MemoryStore(join(dir, "memory.db"));
    try {
      const existing = store.create({
        scopeKey: "workspace",
        summary: "Keep responses concise.",
        details: "Keep responses concise.",
        kind: "preference",
        tier: "pinned",
        source: { type: "user-explicit" },
      });
      expect(
        (await importLegacyMemoryDirectory(store, legacyDir)).imported,
      ).toBe(1);
      expect(store.list().items).toHaveLength(1);
      expect(store.list().items[0].id).toBe(existing.id);
      expect(
        (await importLegacyMemoryDirectory(store, legacyDir)).alreadyImported,
      ).toBe(1);
    } finally {
      store.close();
    }
  });

  test("does not archive a native record when its deduplicated legacy alias is removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-v2-import-native-dedup-"));
    dirs.push(dir);
    const legacyDir = join(dir, "legacy");
    const store = new MemoryStore(join(dir, "memory.db"));
    try {
      const native = store.create({
        scopeKey: "workspace",
        summary: "A fact already reviewed in Settings.",
        details: "A fact already reviewed in Settings.",
        kind: "reference",
        tier: "retrievable",
        source: { type: "settings" },
      });
      await Bun.write(
        join(legacyDir, "workspace.json"),
        JSON.stringify({
          entries: [
            {
              id: "native-alias",
              text: "A fact already reviewed in Settings.",
              by: "Fable",
              at: "2026-08-20T00:00:00Z",
            },
          ],
        }),
      );
      await importLegacyMemoryDirectory(store, legacyDir);
      expect(store.get("native-alias")?.id).toBe(native.id);
      await Bun.write(
        join(legacyDir, "workspace.json"),
        JSON.stringify({ entries: [] }),
      );
      await importLegacyMemoryDirectory(store, legacyDir);
      expect(store.get(native.id)?.state).toBe("active");
      expect(store.legacyRaw("native-alias")).toContain("reviewed in Settings");
    } finally {
      store.close();
    }
  });

  test("fails closed when one legacy file reuses an id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-v2-import-duplicate-id-"));
    dirs.push(dir);
    const legacyDir = join(dir, "legacy");
    await Bun.write(
      join(legacyDir, "workspace.json"),
      JSON.stringify({
        entries: [
          { id: "same-id", text: "First fact.", at: "2025-01-01T00:00:00Z" },
          {
            id: "same-id",
            text: "Different fact.",
            at: "2025-01-02T00:00:00Z",
          },
        ],
      }),
    );
    const store = new MemoryStore(join(dir, "memory.db"));
    try {
      const result = await importLegacyMemoryDirectory(store, legacyDir);
      expect(result.complete).toBe(false);
      expect(result.discovered).toBe(2);
      expect(result.mapped).toBe(1);
      expect(result.errors[0]?.error).toContain("Duplicate legacy memory id");
    } finally {
      store.close();
    }
  });
});
