import { createHash } from "crypto";
import { audit } from "../audit";
import { stateDir } from "../paths";
import {
  clearMemoryImportDirty,
  memoryImportDirs,
  memoryImportIsDirty,
} from "../../agents/slack/memory";
import {
  importLegacyMemoryDirectory,
  type LegacyImportResult,
} from "./legacy-import";
import { MemoryStore } from "./store";

export type MemoryRolloutMode = "legacy" | "shadow" | "v2";

interface RuntimeStore {
  path: string;
  store: MemoryStore;
  migration?: Promise<LegacyImportResult>;
}

let runtime: RuntimeStore | undefined;
const LEGACY_MIGRATION_SEAL = "legacy-migration-v2";
const LEGACY_MIGRATION_VERSION = 2;

/**
 * Memory rollout mode. V2 is the default; legacy and shadow exist as fast
 * rollback and comparison seams while an instance is being migrated.
 */
export function memoryRolloutMode(): MemoryRolloutMode {
  const value = process.env.OPENSESSION_MEMORY_MODE?.trim().toLowerCase();
  return value === "legacy" || value === "shadow" ? value : "v2";
}

export function memoryDatabasePath(): string {
  return (
    process.env.OPENSESSION_MEMORY_DB ||
    `${stateDir("memory")}/memory-v2.sqlite`
  );
}

/** Lazily acquire the database. Importing this module has no live effects. */
export function memoryStore(): MemoryStore {
  const path = memoryDatabasePath();
  if (runtime?.path === path) return runtime.store;
  runtime?.store.close();
  runtime = { path, store: new MemoryStore(path) };
  return runtime.store;
}

/**
 * Copy every legacy JSON record into v2 once per process and database path.
 * The importer journals each source row, so a restart or concurrent caller is
 * still idempotent. Source JSON remains untouched until the operator removes
 * it after verification.
 */
export async function ensureMemoryV2Ready(): Promise<{
  store: MemoryStore;
  migration: LegacyImportResult;
}> {
  const sourceDirs = memoryImportDirs();
  const store = memoryStore();
  if (!runtime) throw new Error("Memory runtime was not initialized.");
  runtime.migration ??= (async () => {
    const sealed = store.metadata(LEGACY_MIGRATION_SEAL);
    if (sealed) {
      const parsed = JSON.parse(sealed) as LegacyImportResult & {
        migrationVersion?: number;
      };
      if (
        parsed.migrationVersion === LEGACY_MIGRATION_VERSION &&
        !memoryImportIsDirty(sourceDirs)
      ) {
        return { ...parsed, complete: true, errors: [] };
      }
    }

    const results: LegacyImportResult[] = [];
    for (const directory of sourceDirs) {
      results.push(await importLegacyMemoryDirectory(store, directory));
    }
    const digest = createHash("sha256");
    const result = results.reduce<LegacyImportResult>(
      (all, item, index) => {
        digest
          .update(sourceDirs[index] || "")
          .update("\0")
          .update(item.sourceDigest)
          .update("\0");
        all.files += item.files;
        all.discovered += item.discovered;
        all.imported += item.imported;
        all.alreadyImported += item.alreadyImported;
        all.mapped += item.mapped;
        all.skipped += item.skipped;
        all.errors.push(...item.errors);
        return all;
      },
      {
        files: 0,
        discovered: 0,
        imported: 0,
        alreadyImported: 0,
        mapped: 0,
        skipped: 0,
        complete: false,
        sourceDigest: "",
        errors: [],
      },
    );
    result.complete =
      result.errors.length === 0 &&
      result.mapped === result.discovered - result.skipped;
    result.sourceDigest = digest.digest("hex");

    if (memoryRolloutMode() === "v2") {
      if (!result.complete) {
        throw new Error(
          `Memory v2 migration is incomplete: ${result.mapped}/${result.discovered - result.skipped} valid rows mapped, ${result.errors.length} errors.`,
        );
      }
      store.setMetadata(
        LEGACY_MIGRATION_SEAL,
        JSON.stringify({
          ...result,
          errors: [],
          migrationVersion: LEGACY_MIGRATION_VERSION,
          sourceDirs,
          sealedAt: new Date().toISOString(),
        }),
      );
    }

    if (result.complete) clearMemoryImportDirty(sourceDirs);

    audit({
      kind: "memory_v2_migration",
      files: result.files,
      discovered: result.discovered,
      imported: result.imported,
      already_imported: result.alreadyImported,
      mapped: result.mapped,
      skipped: result.skipped,
      errors: result.errors.length,
      complete: result.complete,
      source_digest: result.sourceDigest,
      sealed: memoryRolloutMode() === "v2" && result.complete,
    });
    return result;
  })();
  return { store, migration: await runtime.migration };
}

/** Shadow writes land in JSON first. Drop only the cached import result so the
 * next comparison sees that write without closing the shared SQLite handle. */
export async function refreshMemoryV2Shadow(): Promise<void> {
  if (memoryRolloutMode() !== "shadow") return;
  if (runtime) runtime.migration = undefined;
  await ensureMemoryV2Ready();
}

/** Test seam for a repointed state root or database. */
export function closeMemoryRuntime(): void {
  runtime?.store.close();
  runtime = undefined;
}
