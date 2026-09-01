/**
 * API-key model providers and subscription account preferences shared by Pi.
 * Stored in ~/.opensession-model-providers.json with mode 0600. Reads are
 * fresh per call; Settings writes preserve unknown fields.
 */

import { homeDir } from "./paths";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { chmodSync, existsSync, readFileSync } from "fs";

const HOME = homeDir();

/** Bridge-config file path (exported for the state-path regression test). */
export function configPath(): string {
  return (
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG ||
    stateDir("model-providers.json")
  );
}

/** One configured third-party provider (xai, openrouter, groq, …). */
export interface ModelProviderConfig {
  apiKey?: string;
  baseURL?: string;
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

function canonicalPickerModels(v: unknown): string[] | undefined {
  const ids = stringArray(v);
  return ids
    ? [...new Set(ids.map(canonicalProviderPickerModelId))]
    : undefined;
}

function providerMap(
  v: unknown,
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
    out[id] = {
      ...(typeof r.apiKey === "string" && r.apiKey ? { apiKey: r.apiKey } : {}),
      ...(typeof r.baseURL === "string" && r.baseURL
        ? { baseURL: r.baseURL }
        : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Pure normalization (exported for tests): raw JSON → typed config. */
export function normalizeModelProviderConfig(
  raw: unknown,
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
    providers: providerMap(r.providers),
    orchestrator: r.orchestrator === true,
  };
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

/**
 * Upsert a third-party provider. Field semantics: `undefined` keeps the stored
 * value, `""` clears it, anything else replaces it. Throws on invalid ids and
 * on the bridge providers (anthropic/openai run on subscriptions, not keys).
 */
export function setModelProvider(id: string, cfg: ModelProviderConfig): void {
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
  const existing =
    providers[id] &&
    typeof providers[id] === "object" &&
    !Array.isArray(providers[id])
      ? (providers[id] as Record<string, unknown>)
      : {};
  const next: ModelProviderConfig = {
    ...(typeof existing.apiKey === "string" && existing.apiKey
      ? { apiKey: existing.apiKey }
      : {}),
    ...(typeof existing.baseURL === "string" && existing.baseURL
      ? { baseURL: existing.baseURL }
      : {}),
  };
  if (cfg.apiKey !== undefined) {
    if (cfg.apiKey) next.apiKey = cfg.apiKey;
    else delete next.apiKey;
  }
  if (cfg.baseURL !== undefined) {
    if (cfg.baseURL) next.baseURL = cfg.baseURL;
    else delete next.baseURL;
  }
  providers[id] = next;
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
  const raw = readRawModelProviderConfig();
  const list = rawPickerModels(raw);
  if (!list.includes(id)) list.push(id);
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
