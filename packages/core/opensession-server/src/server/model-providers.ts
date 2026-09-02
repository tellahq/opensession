/**
 * API-key model providers and subscription account preferences shared by Pi.
 * Stored in ~/.opensession-model-providers.json with mode 0600. Reads are
 * fresh per call; Settings writes preserve unknown fields.
 */

import { homeDir } from "./paths";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { chmodSync, existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";

const HOME = homeDir();

/** Bridge-config file path (exported for the state-path regression test). */
export function configPath(): string {
  return (
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG ||
    stateDir("model-providers.json")
  );
}

/** The reasoning levels a configured catalog row may list. Mirrors models.ts'
 *  SessionEffort, spelled out here so this module stays free of an import
 *  back into the registry. */
export const CATALOG_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CatalogEffort = (typeof CATALOG_EFFORTS)[number];

/** Per-model metadata an operator attaches to a provider (`catalog`,
 *  `catalogFile`) or that `/v1/models` discovery recorded. Every field but the
 *  id is optional: a missing one falls back to the conservative stub the
 *  runner registers for unknown models. Costs are USD per million tokens. */
export interface ProviderCatalogModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  /** Reasoning ladder offered in the picker; implies `reasoning`. */
  efforts?: CatalogEffort[];
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

/** The wire protocols a custom provider may declare. OpenAI-compatible only:
 *  a random slug never gets an Anthropic or OpenAI native protocol guessed. */
export const PROVIDER_APIS = ["openai-completions"] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

/** One configured third-party provider (xai, openrouter, groq, …). */
export interface ModelProviderConfig {
  apiKey?: string;
  baseURL?: string;
  /** Explicit protocol. Lets a provider id unknown to both Pi and Open
   *  Session run, the same way Wafer is injected. Needs `baseURL`. */
  api?: ProviderApi;
  /** Display name for the provider (defaults to the id). */
  name?: string;
  /** Operator-pinned per-model metadata, keyed by model id. */
  catalog?: Record<string, ProviderCatalogModel>;
  /** JSON file with more catalog rows; relative to the config file's
   *  directory (the state dir) unless absolute. Inline `catalog` rows win. */
  catalogFile?: string;
  /** Opt in to `GET {baseURL}/models` discovery of picker ids. */
  discoverModels?: boolean;
  /** What the last discovery recorded (ids plus any extended metadata).
   *  Overlaid beneath the operator catalog. */
  discovered?: { at: string; models: Record<string, ProviderCatalogModel> };
}

/** Cerebras' public, open-weight model catalog. Kept here so adding a key in
 * Settings is enough to make the provider useful. models.dev has since grown a
 * native cerebras entry (@ai-sdk/cerebras), but we keep the explicit
 * OpenAI-compatible injection: it carries the `interleaved` reasoning-echo
 * field the native catalog lacks, plus our variant/limit tuning. */
export const CEREBRAS_PICKER_MODELS = [
  "gpt-oss-120b",
  "gemma-4-31b",
  "zai-glm-4.7",
] as const;

/** OpenRouter published GLM-5.3 before Pi's bundled models.dev snapshot knew
 * about it. Keep the official model usable at its advertised limits while the
 * upstream catalog catches up. */
export const GLM_5_3_MODEL_ID = "z-ai/glm-5.3";

/** Canonicalize picker ids retained from GLM-5.3's pre-release alias. */
export function canonicalProviderPickerModelId(id: string): string {
  return id === "pi/openrouter/stealth/ox-alpha"
    ? `pi/openrouter/${GLM_5_3_MODEL_ID}`
    : id;
}

/** The reasoning levels Wafer's `reasoning_effort` accepts (docs.wafer.ai
 *  /serverless/api-reference). A subset of models.ts' SessionEffort, spelled
 *  out here so this module stays free of an import back into the registry. */
export type WaferEffort = "low" | "medium" | "high" | "max";

/** Wafer normalizes reasoning effort at its own edge rather than passing the
 *  upstream model's levels through, so one ladder serves the whole catalog —
 *  verified on the wire against every model here, including the DeepSeek and
 *  Kimi routes whose upstream catalogs list only low/high/max. `none` is
 *  omitted deliberately: it means "don't think", and these are coding models. */
const WAFER_EFFORTS: readonly WaferEffort[] = ["low", "medium", "high", "max"];

/** Wafer's catalog (docs.wafer.ai/wafer-pass) — one entry per `model` string
 * the OpenAI-compatible endpoint serves. Held here for the same reason as
 * Cerebras above: adding a key in Settings should be enough to make the
 * provider useful. models.dev does carry a `wafer.ai` provider, but its
 * catalog is missing the Kimi K3 and DeepSeek tiers, and the dot in its id is
 * not a legal provider slug for us (PROVIDER_ID_RE) — so the models are
 * injected explicitly under the plain `wafer` id instead.
 *
 * Every model gets the WAFER_EFFORTS variants above, which is also what turns
 * thinking on: Wafer serves every model with reasoning OFF until a request
 * carries an effort.
 *
 * The ids are LOWERCASE, unlike the mixed-case strings Wafer's own docs and
 * catalog print ("DeepSeek-V4-Flash-0731-Fast"). Model ids are case-insensitive
 * here and resolveModel() canonicalizes every one to lowercase, so a mixed-case
 * id reaches model provider lowercased and fails its case-SENSITIVE model lookup
 * ("Model not found: wafer/deepseek-v4-flash-0731-fast. Did you mean …?").
 * Wafer documents its own model names as case-insensitive, so the lowercase
 * form is what both ends accept. `name` carries the display casing. */
const WAFER_MODELS: Record<
  string,
  {
    name: string;
    context: number;
    output: number;
    cost: { input: number; output: number; cache_read: number };
    /** Only where Wafer documents vision input; text-only otherwise. */
    attachment?: boolean;
    /** Wafer strips sampling params on the Moonshot-routed models. */
    temperature?: boolean;
  }
> = {
  "deepseek-v4-flash-0731-fast": {
    name: "DeepSeek V4 Flash",
    context: 1_048_576,
    output: 384_000,
    cost: { input: 0.28, output: 0.56, cache_read: 0.07 },
  },
  "glm-5.2": {
    name: "GLM-5.2",
    context: 1_048_576,
    output: 131_072,
    cost: { input: 1.26, output: 3.96, cache_read: 0.23 },
  },
  "glm5.2-fast": {
    name: "GLM-5.2 Fast",
    context: 1_048_576,
    output: 131_072,
    cost: { input: 2.1, output: 6.6, cache_read: 0.21 },
  },
  "glm-5.1": {
    name: "GLM-5.1",
    context: 202_752,
    output: 131_072,
    cost: { input: 1.0, output: 3.2, cache_read: 0.1 },
  },
  "kimi-k3": {
    name: "Kimi K3",
    context: 1_048_576,
    output: 131_072,
    cost: { input: 3.0, output: 15.0, cache_read: 0.3 },
    attachment: true,
    temperature: false,
  },
  "kimi-k3-fast": {
    name: "Kimi K3 Fast",
    context: 1_048_576,
    output: 131_072,
    cost: { input: 4.5, output: 22.5, cache_read: 0.45 },
    attachment: true,
    temperature: false,
  },
  "kimi-k2.6": {
    name: "Kimi K2.6",
    context: 262_144,
    output: 65_536,
    cost: { input: 1.14, output: 4.8, cache_read: 0.19 },
    attachment: true,
    temperature: false,
  },
};

/** Wafer's model ids, in picker order. */
export const WAFER_PICKER_MODELS: readonly string[] = Object.keys(WAFER_MODELS);

/** Wafer treats model names as case-insensitive, so a hand-typed id resolves
 *  to the same entry the picker uses. Undefined when it isn't a Wafer model. */
function waferModel(model: string) {
  const id = Object.keys(WAFER_MODELS).find(
    (known) => known.toLowerCase() === model.toLowerCase(),
  );
  return id ? WAFER_MODELS[id] : undefined;
}

/** The reasoning ladder for a Wafer model (empty when it isn't one). */
export function waferModelEfforts(model: string): readonly WaferEffort[] {
  return waferModel(model) ? WAFER_EFFORTS : [];
}

/** Display name for a Wafer model ("" when it isn't one) — the slugs carry
 *  version and tier segments that the generic prettifier mangles. */
export function waferModelName(model: string): string {
  return waferModel(model)?.name || "";
}

export function defaultPickerModelsForProvider(id: string): readonly string[] {
  if (id === "cerebras") return CEREBRAS_PICKER_MODELS;
  if (id === "wafer") return WAFER_PICKER_MODELS;
  return [];
}

/** Provider metadata shaped for Pi's registerProvider. This covers both a
 * provider absent from Pi's built-in catalog (Wafer) and a model that landed
 * ahead of Pi's bundled models.dev snapshot (GLM-5.3 on OpenRouter). */
export interface PiProviderCatalog {
  name: string;
  api: "openai-completions";
  baseUrl: string;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    thinkingLevelMap: Record<string, string>;
    input: Array<"text" | "image">;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
  }>;
}

export function piProviderCatalog(id: string): PiProviderCatalog | undefined {
  if (id === "openrouter") {
    return {
      name: "OpenRouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      models: [
        {
          id: GLM_5_3_MODEL_ID,
          name: "GLM-5.3",
          reasoning: true,
          thinkingLevelMap: {},
          input: ["text"],
          cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
          contextWindow: 1_048_576,
          maxTokens: 131_072,
        },
      ],
    };
  }
  if (id !== "wafer") return undefined;
  return {
    name: "Wafer",
    api: "openai-completions",
    baseUrl: "https://pass.wafer.ai/v1",
    models: Object.entries(WAFER_MODELS).map(([modelId, m]) => ({
      id: modelId,
      name: m.name,
      reasoning: true,
      // Pi's six-rung ladder onto Wafer's four (WAFER_EFFORTS): pi-ai falls
      // back to the raw level for unmapped rungs, so only the two off-ladder
      // ones need entries. This is also the thinking switch — Wafer serves
      // reasoning OFF until a request carries an effort, same as on model provider.
      thinkingLevelMap: { minimal: "low", xhigh: "max" },
      input: m.attachment ? ["text", "image"] : ["text"],
      cost: {
        input: m.cost.input,
        output: m.cost.output,
        cacheRead: m.cost.cache_read,
        cacheWrite: 0,
      },
      contextWindow: m.context,
      maxTokens: m.output,
    })),
  };
}

/** Valid provider ids — matches model provider's own provider slugs. */
export const PROVIDER_ID_RE = /^[a-z0-9-]+$/;

/** Providers served by the subscription bridges — never raw API keys here. */
export const BRIDGE_PROVIDER_IDS = new Set(["anthropic", "openai"]);

export interface ModelProviderSettings {
  enabled: boolean;
  /** Account restriction, normalized from bridge.accounts (falling back to the
   *  legacy top-level bridgeAccountIds). Semantics differ by mode — meridian:
   *  optional restriction; native: required designated set (never the pool). */
  bridgeAccountIds?: string[];
  /** Loopback port for the native bridge (default 3456). */
  port?: number;
  /** Model ids (model provider/<provider>/<model>) to show in the UI picker. */
  pickerModels?: string[];
  /** Per-account rolling request ceiling on the native bridge (default 300/h). */
  bridgeMaxRequestsPerHour?: number;
  /** Optional restriction of which codex accounts (codex-accounts.ts ids) serve
   *  model provider/openai/* runs, in preference order (read from bridge.openaiAccounts).
   *  Absent = the normal codex pool pick. Independent of `enabled` (that flag
   *  only gates the Anthropic bridge); model provider/openai auth keys off the codex
   *  accounts pool, not this file — see model provider-openai-auth.ts. */
  openaiAccounts?: string[];
  /** The SuperGrok sibling: which xai-accounts.ts ids serve
   *  pi/xai-oauth/* runs, in preference order (read from bridge.xaiAccounts).
   *  Absent = the normal SuperGrok pool pick. */
  xaiAccounts?: string[];
  /** Third-party providers (id → apiKey/baseURL), injected into model provider
   *  config as provider.<id>.options. Independent of `enabled` (that flag only
   *  gates the Anthropic bridge). anthropic/openai never live here. */
  providers?: Record<string, ModelProviderConfig>;
  /** Opt-in: surface The Orchestrator presets in the model picker. */
  orchestrator?: boolean;
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? v.filter((x: unknown): x is string => typeof x === "string" && !!x)
    : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.floor(v)
    : undefined;
}

function nonNegative(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * One catalog row from either our camelCase shape or the snake_case fields a
 * gateway's extended `/v1/models` object tends to carry (`display_name`,
 * `context_length`, `max_output_tokens`, `input_modalities`). Pricing is read
 * only in our own per-million shape (`cost.input`/`cost.output`): the stock
 * OpenAI models object has none, and OpenRouter's per-token strings would
 * silently mis-scale. Undefined when the row is not an object.
 */
export function normalizeCatalogModel(
  id: string,
  raw: unknown,
): ProviderCatalogModel | undefined {
  const r = record(raw);
  if (!r || !id) return undefined;
  const out: ProviderCatalogModel = { id };
  const name = r.name ?? r.display_name ?? r.displayName;
  if (typeof name === "string" && name.trim()) out.name = name.trim();
  const context = positiveInt(
    r.contextWindow ?? r.context_window ?? r.context_length ?? r.contextLength,
  );
  if (context) out.contextWindow = context;
  const output = positiveInt(
    r.maxTokens ??
      r.max_tokens ??
      r.max_output_tokens ??
      r.maxOutputTokens ??
      r.max_completion_tokens,
  );
  if (output) out.maxTokens = output;
  const reasoning = r.reasoning ?? r.supports_reasoning ?? r.supportsReasoning;
  if (typeof reasoning === "boolean") out.reasoning = reasoning;
  const modalities = stringArray(
    r.input ?? r.input_modalities ?? r.inputModalities,
  );
  const vision = r.vision ?? r.supports_vision ?? r.supportsVision;
  if (modalities) {
    const lowered = modalities.map((m) => m.toLowerCase());
    out.input = lowered.includes("image") ? ["text", "image"] : ["text"];
  } else if (typeof vision === "boolean") {
    out.input = vision ? ["text", "image"] : ["text"];
  }
  const efforts = stringArray(r.efforts)
    ?.map((e) => e.toLowerCase())
    .filter((e): e is CatalogEffort =>
      (CATALOG_EFFORTS as readonly string[]).includes(e),
    );
  if (efforts?.length) {
    out.efforts = [...new Set(efforts)];
    out.reasoning = true;
  }
  const cost = record(r.cost ?? r.pricing);
  if (cost) {
    const input = nonNegative(cost.input);
    const outputCost = nonNegative(cost.output);
    if (input !== undefined && outputCost !== undefined) {
      out.cost = {
        input,
        output: outputCost,
        cacheRead: nonNegative(cost.cacheRead ?? cost.cache_read) ?? 0,
        cacheWrite: nonNegative(cost.cacheWrite ?? cost.cache_write) ?? 0,
      };
    }
  }
  return out;
}

/**
 * A catalog document in any of its accepted shapes: a map keyed by model id, a
 * list of rows carrying `id`, or either one wrapped as `{ "models": … }`. The
 * OpenAI `/v1/models` list (`{ "data": [ { "id": … } ] }`) is the same shape,
 * so discovery reuses this. Rows without a usable id are skipped.
 */
export function catalogRows(
  raw: unknown,
): Record<string, ProviderCatalogModel> {
  const out: Record<string, ProviderCatalogModel> = {};
  const wrapper = record(raw);
  const body =
    wrapper && ("models" in wrapper || "data" in wrapper)
      ? (wrapper.models ?? wrapper.data)
      : raw;
  if (Array.isArray(body)) {
    for (const row of body) {
      const r = record(row);
      const id = typeof r?.id === "string" ? r.id.trim() : "";
      const model = normalizeCatalogModel(id, r);
      if (model) out[id] = model;
    }
    return out;
  }
  for (const [id, row] of Object.entries(record(body) || {})) {
    const model = normalizeCatalogModel(id.trim(), row);
    if (model) out[id.trim()] = model;
  }
  return out;
}

/** Merge catalog layers; later layers win per model id, field by field. */
export function mergeCatalogs(
  ...layers: Array<Record<string, ProviderCatalogModel> | undefined>
): Record<string, ProviderCatalogModel> {
  const out: Record<string, ProviderCatalogModel> = {};
  for (const layer of layers) {
    for (const [id, row] of Object.entries(layer || {})) {
      out[id] = { ...out[id], ...row, id };
    }
  }
  return out;
}

/** Where a provider's `catalogFile` lives: as given when absolute, else next
 *  to the config file (the state dir). */
export function catalogFilePath(file: string): string {
  return isAbsolute(file) ? file : resolve(dirname(configPath()), file);
}

function readCatalogFile(
  file: string,
): Record<string, ProviderCatalogModel> | undefined {
  const path = catalogFilePath(file);
  if (!existsSync(path)) {
    console.warn(`[model-providers] Catalog file ${path} does not exist`);
    return undefined;
  }
  try {
    return catalogRows(JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    console.warn(`[model-providers] Failed to parse ${path}:`, e);
    return undefined;
  }
}

function canonicalPickerModels(v: unknown): string[] | undefined {
  const ids = stringArray(v);
  return ids
    ? [...new Set(ids.map(canonicalProviderPickerModelId))]
    : undefined;
}

function providerMap(
  v: unknown,
  loadCatalogFile: (
    file: string,
  ) => Record<string, ProviderCatalogModel> | undefined,
): Record<string, ModelProviderConfig> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, ModelProviderConfig> = {};
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (
      !PROVIDER_ID_RE.test(id) ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    )
      continue;
    const r = raw as Record<string, unknown>;
    const cfg: ModelProviderConfig = {
      ...(typeof r.apiKey === "string" && r.apiKey ? { apiKey: r.apiKey } : {}),
      ...(typeof r.baseURL === "string" && r.baseURL
        ? { baseURL: r.baseURL }
        : {}),
    };
    if (
      typeof r.api === "string" &&
      (PROVIDER_APIS as readonly string[]).includes(r.api)
    )
      cfg.api = r.api as ProviderApi;
    if (typeof r.name === "string" && r.name.trim()) cfg.name = r.name.trim();
    if (typeof r.catalogFile === "string" && r.catalogFile.trim())
      cfg.catalogFile = r.catalogFile.trim();
    if (r.discoverModels === true) cfg.discoverModels = true;
    const discovered = record(r.discovered);
    if (discovered) {
      const models = catalogRows(discovered.models);
      cfg.discovered = {
        at: typeof discovered.at === "string" ? discovered.at : "",
        models,
      };
    }
    // Layer order, weakest first: discovery, the catalog file, inline rows.
    const inline = r.catalog !== undefined ? catalogRows(r.catalog) : undefined;
    const fromFile = cfg.catalogFile
      ? loadCatalogFile(cfg.catalogFile)
      : undefined;
    const catalog = mergeCatalogs(cfg.discovered?.models, fromFile, inline);
    if (Object.keys(catalog).length) cfg.catalog = catalog;
    out[id] = cfg;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Pure normalization (exported for tests): raw JSON → typed config.
 *  `loadCatalogFile` resolves each provider's `catalogFile`; the default reads
 *  it from disk, tests pass their own. */
export function normalizeModelProviderConfig(
  raw: unknown,
  loadCatalogFile: (
    file: string,
  ) => Record<string, ProviderCatalogModel> | undefined = readCatalogFile,
): ModelProviderSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const enabled = r.enabled === true;
  const bridge =
    r.bridge && typeof r.bridge === "object" && !Array.isArray(r.bridge)
      ? (r.bridge as Record<string, unknown>)
      : undefined;
  return {
    enabled,
    bridgeAccountIds:
      stringArray(bridge?.accounts) ?? stringArray(r.bridgeAccountIds),
    port: typeof r.port === "number" && r.port > 0 ? r.port : undefined,
    pickerModels: canonicalPickerModels(r.pickerModels),
    bridgeMaxRequestsPerHour:
      typeof r.bridgeMaxRequestsPerHour === "number" &&
      r.bridgeMaxRequestsPerHour > 0
        ? r.bridgeMaxRequestsPerHour
        : undefined,
    openaiAccounts: stringArray(bridge?.openaiAccounts),
    xaiAccounts: stringArray(bridge?.xaiAccounts),
    providers: providerMap(r.providers, loadCatalogFile),
    orchestrator: r.orchestrator === true,
  };
}

/**
 * A configured provider's metadata in Pi's registerProvider shape, layered
 * onto whatever Open Session already knows about the id. Undefined when the
 * config adds nothing (no `api`, no catalog rows).
 *
 * A declared `api` makes an id unknown to both Pi and Open Session runnable:
 * the run registers it as a plain OpenAI-compatible provider at `baseURL`.
 * Catalog rows fill the fields the conservative stub otherwise guesses;
 * unknown fields keep the stub's value, so a row with only `contextWindow`
 * still runs. Pi's six thinking rungs pass through unmapped: an operator who
 * lists `efforts` names the levels the gateway itself accepts.
 */
export function configuredProviderCatalog(
  id: string,
  cfg: ModelProviderConfig | undefined,
): PiProviderCatalog | undefined {
  if (!cfg) return undefined;
  const rows = Object.values(cfg.catalog || {});
  if (!cfg.api && !cfg.name && !rows.length) return undefined;
  return {
    name: cfg.name || id,
    api: cfg.api || "openai-completions",
    baseUrl: cfg.baseURL || "",
    models: rows.map((row) => ({
      id: row.id,
      name: row.name || row.id,
      reasoning: row.reasoning ?? true,
      thinkingLevelMap: {},
      input: row.input || ["text"],
      cost: row.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: row.contextWindow || FALLBACK_CONTEXT_WINDOW,
      maxTokens: row.maxTokens || FALLBACK_MAX_TOKENS,
    })),
  };
}

/** The conservative table a model unknown to every catalog registers with:
 *  safe window and output floors, zero cost because unknown pricing must
 *  under-report. */
export const FALLBACK_CONTEXT_WINDOW = 131_072;
export const FALLBACK_MAX_TOKENS = 32_768;

/** The configured catalog row for `pi/<provider>/<model>` (undefined when the
 *  operator pinned nothing and discovery recorded nothing). Reads the config
 *  fresh unless the caller passes a snapshot; loops over many models should
 *  pass one, since each fresh read reparses every catalog file. */
export function configuredCatalogModel(
  provider: string,
  model: string,
  providers: Record<string, ModelProviderConfig> = modelProviders(),
): ProviderCatalogModel | undefined {
  const catalog = providers[provider]?.catalog;
  if (!catalog) return undefined;
  return (
    catalog[model] ??
    Object.values(catalog).find(
      (row) => row.id.toLowerCase() === model.toLowerCase(),
    )
  );
}

export function readModelProviderConfig(): ModelProviderSettings | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    return normalizeModelProviderConfig(
      JSON.parse(readFileSync(path, "utf-8")),
    );
  } catch (e) {
    console.warn(`[model-providers] Failed to parse ${path}:`, e);
    return null;
  }
}

export const DEFAULT_BRIDGE_PORT = 3456;

export function bridgePort(): number {
  return readModelProviderConfig()?.port || DEFAULT_BRIDGE_PORT;
}

export const DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR = 300;

/** Rolling per-account request ceiling for the native Anthropic bridge. */
export function bridgeMaxRequestsPerHour(): number {
  return (
    readModelProviderConfig()?.bridgeMaxRequestsPerHour ||
    DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR
  );
}

/** The Orchestrator presets are opt-in (off by default): `"orchestrator": true`
 *  in the config file, or OPENSESSION_ORCHESTRATOR=1. Gates only the picker —
 *  stored orchestrator/<name> session ids resolve and run regardless. */
export function orchestratorEnabled(): boolean {
  if (process.env.OPENSESSION_ORCHESTRATOR === "1") return true;
  return readModelProviderConfig()?.orchestrator === true;
}

/** Configured Pi model ids to surface in the picker. */
export function configuredPickerModels(): string[] {
  return (readModelProviderConfig()?.pickerModels || []).filter((id) =>
    id.startsWith("pi/"),
  );
}

// ── Write path (Settings → Model providers) ─────────────────────────────────
//
// Raw-JSON read-modify-write: the normalized shape above drops/renames fields
// (bridge, legacy aliases), so writes always go through the raw object to
// preserve everything we don't own. Atomic rename + 0600 — the file holds keys.

function readRawModelProviderConfig(): Record<string, unknown> {
  const path = configPath();
  if (!existsSync(path)) return {};
  // Unlike the read path (fail-soft null), a write built on `{}` would clobber
  // a config that's merely unparseable — fail loudly instead.
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Cannot update ${path}: existing content is not a JSON object`,
    );
  }
  return raw as Record<string, unknown>;
}

function writeRawModelProviderConfig(raw: Record<string, unknown>): void {
  const path = configPath();
  writeJsonAtomic(path, raw);
  chmodSync(path, 0o600);
}

function rawProviders(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.providers &&
    typeof raw.providers === "object" &&
    !Array.isArray(raw.providers)
    ? (raw.providers as Record<string, unknown>)
    : {};
}

function rawPickerModels(raw: Record<string, unknown>): string[] {
  return canonicalPickerModels(raw.pickerModels) || [];
}

/** Configured third-party providers (id → apiKey/baseURL). Read fresh. */
export function modelProviders(): Record<string, ModelProviderConfig> {
  return readModelProviderConfig()?.providers || {};
}

/** The Settings-writable subset of a provider. Catalog rows, the catalog file
 *  and discovery results are hand-edited or recorded by discovery, never
 *  replaced from the form. */
export interface ModelProviderSettingsInput {
  apiKey?: string;
  baseURL?: string;
  /** `""` clears the protocol (back to a Pi-known slug). */
  api?: ProviderApi | "";
  name?: string;
  discoverModels?: boolean;
}

function rawProvider(
  providers: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  return record(providers[id]) || {};
}

/**
 * Upsert a third-party provider. Field semantics: `undefined` keeps the stored
 * value, `""` clears it, anything else replaces it. Fields the form does not
 * own (catalog, catalogFile, discovered, anything unknown) are preserved as
 * stored. Throws on invalid ids and on the bridge providers (anthropic/openai
 * run on subscriptions, not keys).
 */
export function setModelProvider(
  id: string,
  cfg: ModelProviderSettingsInput,
): void {
  if (!PROVIDER_ID_RE.test(id)) {
    throw new Error(
      `Invalid provider id "${id}" (lowercase letters, digits and dashes only)`,
    );
  }
  if (BRIDGE_PROVIDER_IDS.has(id)) {
    throw new Error(
      `"${id}" runs on the subscription bridge, not a raw API key`,
    );
  }
  const raw = readRawModelProviderConfig();
  const providers = rawProviders(raw);
  const next: Record<string, unknown> = { ...rawProvider(providers, id) };
  const setString = (key: "apiKey" | "baseURL" | "api" | "name") => {
    const value = cfg[key];
    if (value === undefined) return;
    if (value) next[key] = value;
    else delete next[key];
  };
  setString("apiKey");
  setString("baseURL");
  setString("api");
  setString("name");
  if (cfg.discoverModels !== undefined) {
    if (cfg.discoverModels) next.discoverModels = true;
    else delete next.discoverModels;
  }
  // Validate the effective provider before anything touches disk: a custom
  // protocol without a base URL can never run, so it must not be stored.
  if (next.api && !next.baseURL) {
    throw new Error(`Provider "${id}" declares an api and needs a base URL`);
  }
  providers[id] = next;
  raw.providers = providers;
  writeRawModelProviderConfig(raw);
}

/** Record what `/v1/models` discovery returned for a provider. Replaces the
 *  previous discovery block only; operator rows are untouched. */
export function setProviderDiscovered(
  id: string,
  discovered: { at: string; models: Record<string, ProviderCatalogModel> },
): void {
  const raw = readRawModelProviderConfig();
  const providers = rawProviders(raw);
  if (!(id in providers)) throw new Error(`Provider "${id}" is not configured`);
  providers[id] = { ...rawProvider(providers, id), discovered };
  raw.providers = providers;
  writeRawModelProviderConfig(raw);
}

/** Remove a third-party provider. Returns whether it existed. */
export function removeModelProvider(id: string): boolean {
  const raw = readRawModelProviderConfig();
  const providers = rawProviders(raw);
  if (!(id in providers)) return false;
  delete providers[id];
  if (Object.keys(providers).length) raw.providers = providers;
  else delete raw.providers;
  writeRawModelProviderConfig(raw);
  return true;
}

/** Add an id to pickerModels (idempotent). Returns the stored list. */
export function addPickerModel(id: string): string[] {
  return addPickerModels([id]);
}

/** Add ids to pickerModels in one write (idempotent). Returns the stored list. */
export function addPickerModels(ids: readonly string[]): string[] {
  const raw = readRawModelProviderConfig();
  const list = rawPickerModels(raw);
  for (const id of ids) if (!list.includes(id)) list.push(id);
  raw.pickerModels = list;
  writeRawModelProviderConfig(raw);
  return list;
}

/** Remove an id from pickerModels. Returns the stored list. */
export function removePickerModel(id: string): string[] {
  const raw = readRawModelProviderConfig();
  const list = rawPickerModels(raw).filter((x) => x !== id);
  raw.pickerModels = list;
  writeRawModelProviderConfig(raw);
  return list;
}

/** Masked display form of a stored key ("sk-x…wxyz") — the full value never
 *  leaves the server. */
export function maskProviderKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return "…";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
