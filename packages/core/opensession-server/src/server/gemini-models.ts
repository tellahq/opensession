/**
 * Model discovery for the `google` provider (a Gemini API key from Google AI
 * Studio). The Gemini API does not serve the OpenAI `/models` shape on its
 * native base URL, so this reads `GET /v1beta/models` with the key in
 * `x-goog-api-key` and maps Google's own limits onto catalog rows.
 *
 * Rows are recorded only for models Pi's bundled Gemini catalog does not
 * already describe: a configured row replaces Pi's entry, and Pi's entries
 * carry thinking-level maps and pricing that Google's list does not.
 */

import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import type { ProviderCatalogModel } from "./model-providers";

export const GEMINI_PROVIDER_ID = "google";
export const GEMINI_API_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
/** How many discovered models go into the picker. The rest stay type-in. */
const PICKER_LIMIT = 6;

/** Model families on the Gemini API that are not chat models for an agent. */
const NON_AGENT_MODEL =
  /(embedding|tts|image|live|audio|aqa|robotics|computer-use|learnlm|deep-research|veo|imagen|lyria|omni)/;

interface GeminiApiModel {
  name?: unknown;
  displayName?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  supportedGenerationMethods?: unknown;
  thinking?: unknown;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.floor(v)
    : undefined;
}

/** Whether Pi's bundled catalog already has this Gemini model. */
export function piKnowsGeminiModel(id: string): boolean {
  return Object.hasOwn(GOOGLE_MODELS, id);
}

/** One Gemini API model as a catalog row, or undefined when it is not a chat
 *  model an agent can run on. */
export function geminiCatalogRow(
  raw: GeminiApiModel,
): ProviderCatalogModel | undefined {
  if (typeof raw.name !== "string") return undefined;
  const id = raw.name.replace(/^models\//, "").trim();
  if (!/^(gemini|gemma)-/.test(id) || NON_AGENT_MODEL.test(id))
    return undefined;
  const methods = Array.isArray(raw.supportedGenerationMethods)
    ? raw.supportedGenerationMethods
    : [];
  if (!methods.includes("generateContent")) return undefined;
  const row: ProviderCatalogModel = { id, input: ["text", "image"] };
  if (typeof raw.displayName === "string" && raw.displayName.trim())
    row.name = raw.displayName.trim();
  const context = positiveInt(raw.inputTokenLimit);
  if (context) row.contextWindow = context;
  const output = positiveInt(raw.outputTokenLimit);
  if (output) row.maxTokens = output;
  if (typeof raw.thinking === "boolean") row.reasoning = raw.thinking;
  return row;
}

/** Fetch every chat model the key can use. Throws with a short reason. */
export async function fetchGeminiModels(
  apiKey: string,
  baseURL: string = GEMINI_API_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderCatalogModel[]> {
  const base = baseURL.replace(/\/+$/, "");
  const rows: ProviderCatalogModel[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${base}/models`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetchImpl(url, {
      headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new Error(
        `Google rejected the API key (HTTP ${res.status}). Check it in Google AI Studio.`,
      );
    if (!res.ok) throw new Error(`GET /models returned ${res.status}`);
    const body = (await res.json().catch(() => {
      throw new Error("GET /models did not return JSON");
    })) as { models?: unknown; nextPageToken?: unknown };
    for (const raw of Array.isArray(body.models) ? body.models : []) {
      const row =
        raw && typeof raw === "object"
          ? geminiCatalogRow(raw as GeminiApiModel)
          : undefined;
      if (row) rows.push(row);
    }
    pageToken =
      typeof body.nextPageToken === "string" ? body.nextPageToken : "";
    if (!pageToken) break;
  }
  if (!rows.length) throw new Error("GET /models returned no Gemini models");
  return rows;
}

/** Sort key: Gemini version, then tier, so the newest strong models lead. */
function rank(id: string): number[] {
  const version = id.match(/^gemini-(\d+)(?:\.(\d+))?/);
  const major = version ? Number(version[1]) : 0;
  const minor = version?.[2] ? Number(version[2]) : 0;
  const tier = /-lite\b/.test(id) ? 0 : /-flash\b/.test(id) ? 1 : 2;
  const stable = /preview|exp/.test(id) ? 0 : 1;
  return [major, minor, tier, stable];
}

function compareRank(a: string, b: string): number {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return rb[i]! - ra[i]!;
  }
  return a.localeCompare(b);
}

/**
 * The few discovered ids worth a picker row: Gemini models, newest version
 * first, without `-latest` aliases or dated snapshots, and without a preview
 * whose stable release is also listed.
 */
export function geminiPickerModels(ids: readonly string[]): string[] {
  const all = new Set(ids);
  return ids
    .filter((id) => id.startsWith("gemini-"))
    .filter((id) => !id.endsWith("-latest"))
    .filter((id) => !/-\d{2}-\d{4}$|-\d{3}$/.test(id))
    .filter((id) => !(id.endsWith("-preview") && all.has(id.slice(0, -8))))
    .sort(compareRank)
    .slice(0, PICKER_LIMIT);
}
