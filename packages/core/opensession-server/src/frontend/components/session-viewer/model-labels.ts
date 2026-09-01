import {
  baseModelId,
  friendlyModelSlug,
  routedModelParts,
  workspacePresetLabel,
} from "../ModelEffortSelect";
import type { ModelOption } from "../../lib/api";

export function modelIsCodex(id: string, models: ModelOption[]): boolean {
  const found = models.find((m) => m.id === id);
  if (found) return found.provider === "codex";
  return id.startsWith("gpt") || id.startsWith("codex");
}

// Friendly "<name> · <engine>" for the model-switch divider, so a cross-provider
// switch reads unmistakably as e.g. "Sonnet · Claude → GPT-5.5 · Codex". Pure
// (no models list needed) so it works in the transcript_init weave before the
// models endpoint has loaded.
const MODEL_NAMES: Record<string, string> = {
  "claude-fable-5-1": "Fable 5.1",
  "claude-fable-5": "Fable 5",
  "claude-opus-5": "Opus 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-sonnet-5": "Sonnet",
  "claude-haiku-4-5-20251001": "Haiku",
  "gpt-5.5": "GPT-5.5",
  "gpt-5": "GPT-5",
  codex: "Codex",
};
export function prettyModel(id: string): string {
  // A workspace preset names itself; with no models list to read its label
  // from, its slug is still a name and its storage path is not.
  const preset = workspacePresetLabel(baseModelId(id), []);
  if (preset) return preset;
  // Pi ids get their friendly name with no engine suffix — the engine
  // is an implementation detail ("Sonnet 5", not "… · Pi").
  const oc = routedModelParts(id);
  if (oc) return friendlyModelSlug(oc.model);
  const isCodex = id.startsWith("gpt") || id.startsWith("codex");
  const name = MODEL_NAMES[id] || id;
  return `${name} · ${isCodex ? "Codex" : "Claude"}`;
}
/** Model label for the header/info metadata lines: the registry label, but
 * pi ids always take the pure friendly-name path (the server's labels
 * for them only refresh on restart). */
export function metadataModelLabel(
  effectiveModel: string,
  models: ModelOption[],
): string {
  const preset = workspacePresetLabel(baseModelId(effectiveModel), models);
  if (preset) return preset;
  if (routedModelParts(effectiveModel)) return prettyModel(effectiveModel);
  return (
    models.find((m) => m.id === effectiveModel)?.label ||
    prettyModel(effectiveModel)
  );
}
// An automatic fallback arrives as by = "auto-switch — <from label> <reason>",
// which repeats the model the divider already names. Keep only the reason, and
// take the from-model's name from it: a dial preset id ("dial/opus-fable") has
// no friendly name of its own here, so prettyModel would print the raw slug.
const AUTO_SWITCH_BY =
  /^auto-switch — (.+) (out of credits|hit a transient engine error)$/;
export function switchDividerText(
  model: string,
  from?: string,
  by?: string,
): string {
  const auto = by ? AUTO_SWITCH_BY.exec(by) : null;
  const fromName = from ? (auto ? auto[1] : prettyModel(from)) : "";
  const head = fromName
    ? `Switched ${fromName} → ${prettyModel(model)}`
    : `Switched to ${prettyModel(model)}`;
  const suffix = auto ? auto[2] : by;
  return suffix ? `${head} · ${suffix}` : head;
}
