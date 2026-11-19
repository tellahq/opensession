/**
 * Opt-in model discovery for OpenAI-compatible providers: `GET
 * {baseURL}/models` with the provider's own key. The stock OpenAI models object
 * is ids-only, so discovery mainly fills the picker; extended fields a gateway
 * sends (context_length, max_output_tokens, input_modalities, …) are recorded
 * beneath the operator's own catalog rows, which always win.
 */

import {
  addPickerModels,
  catalogRows,
  configuredPickerModels,
  modelProviders,
  setProviderDiscovered,
  type ProviderCatalogModel,
} from "./model-providers";
import {
  fetchGeminiModels,
  GEMINI_API_BASE_URL,
  GEMINI_PROVIDER_ID,
  geminiPickerModels,
  piKnowsGeminiModel,
} from "./gemini-models";

const DISCOVERY_TIMEOUT_MS = 15_000;

/** `{baseURL}/models`, tolerating a trailing slash on the base URL. */
export function discoveryUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/models`;
}

/** Fetch and normalize a provider's model list. Throws with a short reason on
 *  a network or shape failure; the caller decides what to keep. */
export async function fetchProviderModels(
  baseURL: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, ProviderCatalogModel>> {
  const res = await fetchImpl(discoveryUrl(baseURL), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /models returned ${res.status}`);
  const body = await res.json().catch(() => {
    throw new Error("GET /models did not return JSON");
  });
  const models = catalogRows(body);
  if (!Object.keys(models).length)
    throw new Error("GET /models returned no model ids");
  return models;
}

/**
 * Discover a configured provider's models, record them under `discovered`,
 * and add their ids to pickerModels. Operator-pinned picker ids are never
 * removed, and a failed poll leaves the stored config untouched.
 */
export async function discoverProviderModels(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: string[]; added: number }> {
  const provider = modelProviders()[id];
  if (!provider?.apiKey) throw new Error(`Provider "${id}" has no API key`);
  if (id === GEMINI_PROVIDER_ID && !provider.api) {
    return discoverGeminiModels(provider.apiKey, provider.baseURL, fetchImpl);
  }
  if (!provider.baseURL) throw new Error(`Provider "${id}" has no base URL`);
  const models = await fetchProviderModels(
    provider.baseURL,
    provider.apiKey,
    fetchImpl,
  );
  await setProviderDiscovered(id, { at: new Date().toISOString(), models });
  const ids = Object.keys(models).map((m) => `pi/${id}/${m}`);
  return { models: Object.keys(models), added: await addNewPickerModels(ids) };
}

/** Whether a provider can list its models: it has a base URL, or it is the
 *  Gemini API, whose native model list needs none. */
export function canDiscoverModels(
  id: string,
  provider: { baseURL?: string; api?: string } | undefined,
): boolean {
  return !!provider?.baseURL || (id === GEMINI_PROVIDER_ID && !provider?.api);
}

/**
 * The Gemini API's own model list. Only models Pi does not already describe
 * are recorded as catalog rows, so Pi keeps its pricing and thinking maps for
 * the rest. The picker gets the newest few chat models; every listed model
 * stays usable by id.
 */
async function discoverGeminiModels(
  apiKey: string,
  baseURL: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ models: string[]; added: number }> {
  const rows = await fetchGeminiModels(
    apiKey,
    baseURL || GEMINI_API_BASE_URL,
    fetchImpl,
  );
  const unknown: Record<string, ProviderCatalogModel> = {};
  for (const row of rows)
    if (!piKnowsGeminiModel(row.id)) unknown[row.id] = row;
  await setProviderDiscovered(GEMINI_PROVIDER_ID, {
    at: new Date().toISOString(),
    models: unknown,
  });
  const listed = rows.map((row) => row.id);
  const ids = geminiPickerModels(listed).map(
    (m) => `pi/${GEMINI_PROVIDER_ID}/${m}`,
  );
  return { models: listed, added: await addNewPickerModels(ids) };
}

/** Add picker ids, returning how many were new. */
async function addNewPickerModels(ids: string[]): Promise<number> {
  const before = new Set(configuredPickerModels());
  await addPickerModels(ids);
  return ids.filter((m) => !before.has(m)).length;
}
