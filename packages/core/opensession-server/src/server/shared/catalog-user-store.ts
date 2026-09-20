/** Catalog-backed sidebar preferences. Legacy filename spellings are lookup
 * keys imported at boot, never file probes on the gateway request path. */
import {
  catalogDocuments,
  type ApplicationCatalogNamespace,
} from "../catalog-documents";
import { broadcastToUser } from "../ws-hub";
import { invalidateSidebarSessionResponses } from "../session-list-response-revision";
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
  function publish(user: string, value: T): void {
    if (!["lanes", "hides", "snoozes", "pins"].includes(name)) return;
    invalidateSidebarSessionResponses();
    broadcastToUser(
      user,
      name === "pins"
        ? { type: "pins_changed", user, pins: value }
        : { type: "user_map_changed", map: name, user },
    );
  }
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
      publish(user, cleaned);
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
      const cleaned = clean(documentField(stored, field));
      publish(user, cleaned);
      return cleaned;
    },
  };
}
