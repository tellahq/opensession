/**
 * Application documents live in the session kernel's central catalog. The
 * gateway awaits RPCs; it never opens SQLite or falls back to JSON files on a
 * read. Legacy JSON is imported once at boot and retained as an async export
 * for operator tools. Session documents have their own actor-owned protocol.
 */
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_DOCUMENT_MAX_VALUE_BYTES,
  sessionCatalogDocument,
} from "./session-kernel";

export const APPLICATION_CATALOG_NAMESPACES = [
  "automations",
  "workspaces",
  "pins",
  "lanes",
  "snoozes",
  "hides",
  "settlements",
  "mentions",
  "personal-prompts",
  "personal-output-styles",
] as const;

export type ApplicationCatalogNamespace =
  (typeof APPLICATION_CATALOG_NAMESPACES)[number];

/** Path compatibility probes are asynchronous too. Do not call stateDir here. */
export async function legacyCatalogDirectory(
  namespace: string,
): Promise<string> {
  if (process.env.OPENSESSION_STATE_DIR)
    return join(process.env.OPENSESSION_STATE_DIR, `.opensession-${namespace}`);
  const home = process.env.HOME || homedir();
  const current = join(home, ".opensession", namespace);
  const legacy = join(home, `.opensession-${namespace}`);
  try {
    await access(current);
    return current;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await access(legacy);
    return legacy;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return current;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateNamespace(namespace: string): void {
  if (!APPLICATION_CATALOG_NAMESPACES.some((name) => name === namespace))
    throw new Error(`Unsupported application catalog namespace: ${namespace}`);
}

function validateKey(key: string): void {
  if (
    !key ||
    key.length > 256 ||
    key === "." ||
    key === ".." ||
    /[\\/\u0000-\u001f]/.test(key)
  )
    throw new Error("Invalid application catalog document key");
}

/** Idempotent import before the gateway accepts traffic. A partial import can
 * resume: seeds never overwrite a committed document or a deletion tombstone.
 * Invalid legacy JSON fails the import rather than silently losing state. */
export async function importApplicationCatalog(): Promise<void> {
  for (const namespace of APPLICATION_CATALOG_NAMESPACES) {
    if (await sessionCatalogDocument({ op: "import_complete", namespace }))
      continue;
    const directory = await legacyCatalogDirectory(namespace);
    let files: string[];
    try {
      files = (await readdir(directory))
        .filter((file) => file.endsWith(".json"))
        .sort();
    } catch (error) {
      if (!isMissing(error)) throw error;
      files = [];
    }
    // One maximum-size document still fits the RPC body after JSON escaping.
    for (const file of files) {
      const key = file.slice(0, -5);
      validateKey(key);
      const path = join(directory, file);
      if ((await stat(path)).size > CATALOG_DOCUMENT_MAX_VALUE_BYTES)
        throw new Error(
          `Legacy catalog document exceeds the import bound: ${namespace}/${key}`,
        );
      const value = await readFile(path, "utf8");
      JSON.parse(value);
      await sessionCatalogDocument({
        op: "seed",
        namespace,
        rows: [{ key, value }],
      });
    }
    await sessionCatalogDocument({ op: "mark_import_complete", namespace });
  }
}

// Serialize a local read/mutate/export sequence. The kernel CAS also protects
// against another gateway generation; there is no get-then-blind-write API.
const mutations = new Map<string, Promise<unknown>>();
const failedExports = new Set<string>();
async function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = mutations.get(key);
  const next = (previous ? previous.catch(() => {}) : Promise.resolve()).then(
    run,
  );
  mutations.set(key, next);
  try {
    return await next;
  } finally {
    if (mutations.get(key) === next) mutations.delete(key);
  }
}

async function exportDocument(
  namespace: string,
  key: string,
  value: unknown,
): Promise<void> {
  const directory = await legacyCatalogDirectory(namespace);
  const path = join(directory, `${key}.json`);
  if (value === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.tmp.${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function exportCommitted(
  namespace: string,
  key: string,
  value: unknown,
): Promise<void> {
  const identity = `${namespace}\u0000${key}`;
  try {
    await exportDocument(namespace, key, value);
    failedExports.delete(identity);
  } catch (error) {
    failedExports.add(identity);
    // The catalog commit succeeded. An optional legacy export must not make
    // callers skip their memory projection or report the mutation as failed.
    console.warn(
      `[catalog] legacy export failed for ${namespace}/${key}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export function catalogDocuments(namespace: string) {
  validateNamespace(namespace);
  async function update<T>(
    key: string,
    mutate: (value: unknown | null) => T | null,
  ): Promise<T | null> {
    validateKey(key);
    return serial(`${namespace}\u0000${key}`, async () => {
      let current = await sessionCatalogDocument({ op: "get", namespace, key });
      for (let attempt = 0; attempt < 32; attempt++) {
        const value = mutate(
          current?.value == null ? null : JSON.parse(current.value),
        );
        const encoded = value === null ? null : JSON.stringify(value);
        if (encoded === undefined)
          throw new Error("Catalog documents must be JSON serializable");
        if (current && current.value === encoded) {
          if (failedExports.has(`${namespace}\u0000${key}`))
            await exportCommitted(namespace, key, value);
          return value;
        }
        const result = await sessionCatalogDocument({
          op: "put",
          namespace,
          key,
          expectedRev: current?.rev ?? null,
          value: encoded,
          requestId: randomUUID(),
        });
        if (result.status === "conflict") {
          current = result.current;
          continue;
        }
        await exportCommitted(namespace, key, value);
        return value;
      }
      throw new Error(`Application catalog mutation contention: ${namespace}`);
    });
  }
  async function getEntries(
    keys: string[],
  ): Promise<Array<{ key: string; value: unknown }>> {
    for (const key of keys) validateKey(key);
    const result: Array<{ key: string; value: unknown }> = [];
    async function batch(selected: string[]): Promise<void> {
      try {
        const rows = await sessionCatalogDocument({
          op: "get_many",
          namespace,
          keys: selected,
        });
        for (const row of rows)
          result.push({
            key: row.key,
            value: row.value === null ? null : JSON.parse(row.value),
          });
      } catch (error) {
        // Small workspace/user records normally fit in one round trip. Split
        // only a size rejection; outages and unknown RPC errors must propagate.
        if (
          selected.length < 2 ||
          !(error instanceof Error) ||
          !/Catalog document key batch selects .*over .*byte response bound/.test(
            error.message,
          )
        )
          throw error;
        const middle = Math.ceil(selected.length / 2);
        await batch(selected.slice(0, middle));
        await batch(selected.slice(middle));
      }
    }
    for (let offset = 0; offset < keys.length; offset += 200)
      await batch(keys.slice(offset, offset + 200));
    return result;
  }
  return {
    async get(key: string): Promise<unknown | null> {
      validateKey(key);
      const current = await sessionCatalogDocument({
        op: "get",
        namespace,
        key,
      });
      return current?.value == null ? null : JSON.parse(current.value);
    },
    getEntries,
    async getMany(
      keys: string[],
    ): Promise<Array<{ key: string; value: unknown }>> {
      return (await getEntries(keys)).filter((row) => row.value !== null);
    },
    async list(): Promise<Array<{ key: string; value: unknown }>> {
      const result: Array<{ key: string; value: unknown }> = [];
      let afterKey = "";
      for (;;) {
        const rows = await sessionCatalogDocument({
          op: "page",
          namespace,
          afterKey,
          limit: 200,
        });
        for (const row of rows)
          if (row.value !== null)
            result.push({ key: row.key, value: JSON.parse(row.value) });
        const last = rows.at(-1);
        if (!last) return result;
        afterKey = last.key;
      }
    },
    async set(key: string, value: unknown): Promise<void> {
      await update(key, () => value);
    },
    async delete(key: string): Promise<boolean> {
      let existed = false;
      await update(key, (value) => {
        existed = value !== null;
        return null;
      });
      return existed;
    },
    update,
  };
}
