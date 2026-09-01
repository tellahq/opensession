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
  if (!provider.baseURL) throw new Error(`Provider "${id}" has no base URL`);
  const models = await fetchProviderModels(
    provider.baseURL,
    provider.apiKey,
    fetchImpl,
  );
  setProviderDiscovered(id, { at: new Date().toISOString(), models });
  const ids = Object.keys(models).map((m) => `pi/${id}/${m}`);
  const before = new Set(configuredPickerModels());
  addPickerModels(ids);
  return {
    models: Object.keys(models),
    added: ids.filter((m) => !before.has(m)).length,
  };
}
