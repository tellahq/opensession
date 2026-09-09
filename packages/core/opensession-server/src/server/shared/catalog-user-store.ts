/** Catalog-backed sidebar preferences. Legacy filename spellings are lookup
 * keys imported at boot, never file probes on the gateway request path. */
import {
  catalogDocuments,
  type ApplicationCatalogNamespace,
} from "../catalog-documents";
import { canonicalName, legacyNames } from "./user-store-key";

export function documentField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object" && field in value
    ? Reflect.get(value, field)
    : undefined;
}

export function catalogUserStore<T>(options: {
  name: ApplicationCatalogNamespace;
  field: string;
  clean: (value: unknown) => T;
}) {
  const { name, field, clean } = options;
  const documents = catalogDocuments(name);
  async function raw(user: string): Promise<unknown | null> {
    const keys = [canonicalName(user), ...legacyNames(user)];
    const values = new Map(
      (await documents.getEntries(keys)).map(({ key, value }) => [key, value]),
    );
    for (const key of keys) {
      if (values.has(key)) return values.get(key);
    }
    return null;
  }
  return {
    async get(user: string): Promise<T> {
      return clean(documentField(await raw(user), field));
    },
    async set(user: string, value: unknown): Promise<T> {
      const cleaned = clean(value);
      await documents.set(canonicalName(user), { [field]: cleaned });
      return cleaned;
    },
    /** Read-mutate-write under the catalog CAS. The result is cleaned like
     * `set`, so a mutation may hand back any shape (a map delta merge). */
    async update(user: string, mutate: (value: T) => unknown): Promise<T> {
      const fallback = await raw(user);
      const stored = await documents.update(canonicalName(user), (current) => ({
        [field]: clean(
          mutate(clean(documentField(current ?? fallback, field))),
        ),
      }));
      return clean(documentField(stored, field));
    },
  };
}
