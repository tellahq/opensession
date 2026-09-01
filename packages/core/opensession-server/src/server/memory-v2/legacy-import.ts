import { createHash } from "crypto";
import { readdir } from "fs/promises";
import { basename, join } from "path";
import type { MemoryState } from "./types";
import { MemoryStore } from "./store";

interface LegacyEntry {
  id?: string;
  text?: string;
  by?: string;
  at?: string;
  supersedes?: string[];
  supersededBy?: string;
  archivedAt?: string;
}

interface LegacyStoreFile {
  entries?: LegacyEntry[];
}

export interface LegacyImportResult {
  files: number;
  discovered: number;
  imported: number;
  alreadyImported: number;
  /** Rows mapped to a v2 id during this run, including prior mappings. */
  mapped: number;
  skipped: number;
  /** True only when every valid discovered row is mapped and no file/row failed. */
  complete: boolean;
  sourceDigest: string;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Copy legacy JSON memories into v2. The source files are read only, full text
 * is retained in details, and a migration journal makes repeated runs no-ops.
 */
export async function importLegacyMemoryDirectory(
  store: MemoryStore,
  directory: string,
): Promise<LegacyImportResult> {
  const result: LegacyImportResult = {
    files: 0,
    discovered: 0,
    imported: 0,
    alreadyImported: 0,
    mapped: 0,
    skipped: 0,
    complete: false,
    sourceDigest: "",
    errors: [],
  };
  const digest = createHash("sha256");
  const relations: Array<{
    sourceKey: string;
    legacyId: string;
    entry: LegacyEntry;
  }> = [];
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error: any) {
    if (error?.code === "ENOENT") return finish(result, digest);
    result.errors.push({ file: directory, error: errorMessage(error) });
    return finish(result, digest);
  }

  for (const name of names) {
    const file = join(directory, name);
    result.files += 1;
    let parsed: LegacyStoreFile;
    try {
      const raw = await Bun.file(file).text();
      digest.update(name).update("\0").update(raw).update("\0");
      parsed = JSON.parse(raw) as LegacyStoreFile;
    } catch (error) {
      result.errors.push({ file, error: errorMessage(error) });
      continue;
    }
    if (!Array.isArray(parsed.entries)) {
      result.errors.push({ file, error: "Expected an entries array." });
      continue;
    }
    const scopeKey = basename(name, ".json");
    const sourceKey = `${file}#${scopeKey}`;
    const seenLegacyIds = new Set<string>();
    let sourceCanReconcile = true;
    for (let index = 0; index < parsed.entries.length; index += 1) {
      const entry = parsed.entries[index];
      result.discovered += 1;
      const text = typeof entry.text === "string" ? entry.text : "";
      if (!text.trim()) {
        result.skipped += 1;
        continue;
      }
      const legacyId = entry.id?.trim() || `row-${index}`;
      if (seenLegacyIds.has(legacyId)) {
        result.errors.push({
          file: `${file}:${legacyId}`,
          error: "Duplicate legacy memory id.",
        });
        sourceCanReconcile = false;
        continue;
      }
      seenLegacyIds.add(legacyId);
      const state: MemoryState = entry.supersededBy
        ? "superseded"
        : entry.archivedAt
          ? "archived"
          : "active";
      try {
        const imported = store.importLegacy(
          sourceKey,
          legacyId,
          {
            scopeKey,
            summary: legacySummary(text),
            details: text,
            kind: "reference",
            tier: "retrievable",
            source: { type: legacySourceType(scopeKey) },
            createdAt: validDateOrUndefined(entry.at),
            updatedAt: validDateOrUndefined(entry.at),
            tags: ["legacy-import"],
          },
          state,
          undefined,
          JSON.stringify(entry),
        );
        relations.push({ sourceKey, legacyId, entry });
        result.mapped += 1;
        if (imported.imported) result.imported += 1;
        else result.alreadyImported += 1;
      } catch (error) {
        result.errors.push({
          file: `${file}:${legacyId}`,
          error: errorMessage(error),
        });
        sourceCanReconcile = false;
      }
    }
    if (sourceCanReconcile)
      store.reconcileLegacySource(sourceKey, seenLegacyIds);
  }
  for (const relation of relations) {
    const memoryId = store.legacyMapping(relation.sourceKey, relation.legacyId);
    if (!memoryId) continue;
    const supersedes = (relation.entry.supersedes ?? [])
      .map((id) => store.legacyMapping(relation.sourceKey, id))
      .filter((id): id is string => !!id);
    const supersededBy = relation.entry.supersededBy
      ? (store.legacyMapping(relation.sourceKey, relation.entry.supersededBy) ??
        undefined)
      : undefined;
    store.setLegacyRelations(memoryId, supersedes, supersededBy);
  }
  return finish(result, digest);
}

export function legacySummary(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  const sentenceEnds = [...compact.matchAll(/[.!?]+(?:\s+|$)/g)];
  const bounded =
    sentenceEnds.length > 2
      ? compact.slice(
          0,
          sentenceEnds[1].index! + sentenceEnds[1][0].trimEnd().length,
        )
      : compact;
  const chars = Array.from(bounded);
  if (chars.length <= 400) return bounded;
  return `${chars.slice(0, 399).join("").trimEnd()}…`;
}

function legacySourceType(scopeKey: string): "slack" | "agent-verified" {
  return scopeKey === "workspace" ||
    scopeKey.startsWith("channel-") ||
    scopeKey.startsWith("user-")
    ? "slack"
    : "agent-verified";
}

function validDateOrUndefined(value?: string): string | undefined {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finish(
  result: LegacyImportResult,
  digest: ReturnType<typeof createHash>,
): LegacyImportResult {
  result.complete =
    result.errors.length === 0 &&
    result.mapped === result.discovered - result.skipped;
  result.sourceDigest = digest.digest("hex");
  return result;
}
