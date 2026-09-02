import { z } from "zod";
import { request } from "./request";
import { ENGINE_IDS, type EngineId, type EngineOption } from "../model-engine";

// ── Engines ──
//
// Which engines a session may run on, and the per-model default engine map.
// Both ride /api/models beside the model catalog — an engine is not a separate
// catalog, it is how one shared model list gets routed (see lib/model-engine).
// Older servers do not send either field; every caller here degrades to "one
// engine, no defaults", which is also the correct end state on an instance
// with a single engine configured.

export interface EngineCatalog {
  engines: EngineOption[];
  /** Base model key (see modelEngineKey) -> its default engine. */
  modelEngines: Record<string, EngineId>;
}

const EMPTY: EngineCatalog = { engines: [], modelEngines: {} };
const engineIdSchema = z.enum(ENGINE_IDS);
const engineEntrySchema = z.object({
  id: engineIdSchema,
  label: z.string(),
  available: z.literal(false).optional().catch(undefined),
});
const engineCatalogPayloadSchema = z
  .object({
    engines: z.array(z.unknown()).catch([]),
    modelEngines: z.record(z.string(), z.unknown()).catch({}),
  })
  .catch({ engines: [], modelEngines: {} });
const CACHE_MS = 60_000;
let cache: { value: EngineCatalog; fetchedAt: number } | null = null;
let pending: Promise<EngineCatalog> | null = null;

function normalize(
  body: z.output<typeof engineCatalogPayloadSchema>,
): EngineCatalog {
  const engines = body.engines.flatMap((entry) => {
    const result = engineEntrySchema.safeParse(entry);
    return result.success
      ? [
          {
            id: result.data.id,
            label: result.data.label,
            available: result.data.available !== false,
          },
        ]
      : [];
  });
  const modelEngines = Object.fromEntries(
    Object.entries(body.modelEngines).flatMap(([model, engine]) => {
      const result = engineIdSchema.safeParse(engine);
      return result.success ? [[model, result.data]] : [];
    }),
  );
  return { engines, modelEngines };
}

async function refreshEngines(): Promise<EngineCatalog> {
  if (pending) return pending;
  pending = request<unknown>("/models", { label: "Failed to fetch engines" })
    .then((body) => {
      const value = normalize(engineCatalogPayloadSchema.parse(body));
      cache = { value, fetchedAt: Date.now() };
      return value;
    })
    .catch(() => cache?.value ?? EMPTY)
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Engines + per-model defaults, cached like the model catalog beside it. */
export async function fetchEngines(): Promise<EngineCatalog> {
  if (cache) {
    if (Date.now() - cache.fetchedAt > CACHE_MS) void refreshEngines();
    return cache.value;
  }
  return refreshEngines();
}

/** Drop the cache after a write so the next read sees the new map. */
export function invalidateEnginesCache(): void {
  cache = null;
}

/** Set (engine id) or clear (null) the default engine for one base model. */
export async function setModelEngineDefault(
  model: string,
  engine: EngineId | null,
): Promise<Record<string, EngineId>> {
  const body = await request<{ modelEngines?: Record<string, EngineId> }>(
    "/models/engine-default",
    {
      method: "PUT",
      body: { model, engine },
      label: "Failed to save the default engine",
    },
  );
  invalidateEnginesCache();
  return body?.modelEngines ?? {};
}
