/** Pi-only model id helpers shared by every model picker. */
export const ENGINE_IDS = ["pi"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export interface EngineOption {
  id: EngineId;
  label: string;
  available: boolean;
}

/** Retired picker presets (The Dial, The Orchestrator, one-off combos) and
 * the model each ran on. Older sessions still store these ids; the server
 * routes them to the same models (models.ts RETIRED_PRESET_MODELS). */
const RETIRED_PRESET_MODELS = new Map<string, string>([
  ["dial/ultra", "pi/anthropic/claude-fable-5-1"],
  ["dial/high", "pi/openai/gpt-6.1-sol"],
  ["dial/medium", "pi/openai/gpt-6.1-sol"],
  ["dial/low", "pi/openai/gpt-6-luna"],
  ["dial/opus-fable", "pi/anthropic/claude-opus-5-5"],
  ["orchestrator/fable", "pi/anthropic/claude-fable-5-1"],
  ["orchestrator/fable-sol", "pi/anthropic/claude-fable-5-1"],
  ["orchestrator/sol", "pi/openai/gpt-6.1-sol"],
]);
const stripPi = (id: string) => (id.startsWith("pi/") ? id.slice(3) : id);
/** Workspace ("Custom") preset ids name no model the client can recover. */
const isWorkspacePresetId = (id: string) =>
  stripPi(id).startsWith("workspace-preset/");

export function modelEngine(_id: string): EngineId {
  return "pi";
}

/** Catalog ids are already Pi-routed, so selection lookups use them verbatim.
 * A retired preset id reads as the model it ran on. */
export function baseModelId(id: string): string {
  return RETIRED_PRESET_MODELS.get(stripPi(id).toLowerCase()) ?? id;
}

export function modelVendor(id: string): string | null {
  if (isWorkspacePresetId(id)) return null;
  const rest = stripPi(baseModelId(id));
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : null;
}

export function isAnthropicModel(
  id: string,
  accountProvider?: string | null,
): boolean {
  return (
    modelVendor(id) === "anthropic" ||
    (modelVendor(id) === null && accountProvider === "claude")
  );
}

export function engineModelId(_engine: EngineId, id: string): string | null {
  if (!id) return null;
  const base = baseModelId(id);
  if (base !== id) return base;
  if (id.startsWith("pi/")) return id;
  if (isWorkspacePresetId(id)) return `pi/${id}`;
  if (id.startsWith("claude-")) return `pi/anthropic/${id}`;
  if (id.startsWith("gpt-") || id.startsWith("codex-"))
    return `pi/openai/${id}`;
  return id.includes("/") ? `pi/${id}` : null;
}

export function piModelId(id: string): string | null {
  return engineModelId("pi", id);
}

export function modelEngineKey(id: string): string {
  const rest = stripPi(baseModelId(id));
  if (isWorkspacePresetId(rest)) return rest;
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(slash + 1) : rest;
}
