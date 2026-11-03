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
import { MemoryStore, openMemoryStore } from "./store";

export type MemoryRolloutMode =
  | "legacy"
  | "shadow"
  | "v2"
  | "repo-mirror"
  | "repo";

interface RuntimeStore {
  path: string;
  store: MemoryStore;
  migration?: Promise<LegacyImportResult>;
}

let runtime: RuntimeStore | undefined;
const LEGACY_MIGRATION_SEAL = "legacy-migration-v2";
const LEGACY_MIGRATION_VERSION = 2;

/**
 * Memory rollout mode.
 *
 *   repo         (default) git memory repositories are the record
 *                (memory-repo/); the v2 SQLite store is kept read-only for
 *                rollback.
 *   repo-mirror  v2 SQLite is the record and is mirrored one way into the
 *                repositories, with a parity check, before a flip.
 *   v2           SQLite memory-v2 is the record. Rollback target.
 *   legacy/shadow JSON stores; comparison seams from the v2 migration.
 */
export function memoryRolloutMode(): MemoryRolloutMode {
  const value = process.env.OPENSESSION_MEMORY_MODE?.trim().toLowerCase();
  return value === "legacy" ||
    value === "shadow" ||
    value === "v2" ||
    value === "repo-mirror"
    ? value
    : "repo";
}

/** Modes where memory-v2 SQLite is the record. */
export function v2IsRecord(mode = memoryRolloutMode()): boolean {
  return mode === "v2" || mode === "repo-mirror";
}

export function memoryDatabasePath(): string {
  return (
    process.env.OPENSESSION_MEMORY_DB ||
    `${stateDir("memory")}/memory-v2.sqlite`
  );
}

/** Lazily acquire the database. Importing this module has no live effects. */
export async function memoryStore(): Promise<MemoryStore> {
  const path = memoryDatabasePath();
  if (runtime?.path === path) return runtime.store;
  const store = await openMemoryStore(path);
  // A concurrent caller may have opened the same path while this one waited.
  if (runtime?.path === path) {
    store.close();
    return runtime.store;
  }
  runtime?.store.close();
  runtime = { path, store };
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
  const store = await memoryStore();
  if (!runtime) throw new Error("Memory runtime was not initialized.");
  runtime.migration ??= (async () => {
    const sealed = store.metadata(LEGACY_MIGRATION_SEAL);
    if (sealed) {
      const parsed = JSON.parse(sealed) as LegacyImportResult & {
        migrationVersion?: number;
      };
      if (
        parsed.migrationVersion === LEGACY_MIGRATION_VERSION &&
        !(await memoryImportIsDirty(sourceDirs))
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

    if (memoryRolloutMode() !== "legacy" && memoryRolloutMode() !== "shadow") {
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

    if (result.complete) await clearMemoryImportDirty(sourceDirs);

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
      sealed:
        memoryRolloutMode() !== "legacy" &&
        memoryRolloutMode() !== "shadow" &&
        result.complete,
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
