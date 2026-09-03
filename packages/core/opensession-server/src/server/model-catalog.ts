import { listAccountsPublic } from "./claude-accounts";
import { listCodexAccountsPublic } from "./codex-accounts";
import { modelProviders } from "./model-providers";
import { hasXaiAccounts } from "./xai-accounts";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";
import {
  KNOWN_MODELS,
  interactiveDefaultModel,
  modelPreset,
  orchestratorPreset,
  orchestratorWorkerModels,
  refreshPickerModels,
  toPiModel,
} from "./models";

export interface PickerPresetRequirement {
  group?: string;
  lead: { model: string };
  supporting?: Array<{ model: string }>;
}

/** Provider capacity configured on this server. Temporary exhaustion does not
 * change the catalog or default; adding or removing an account does. */
export function configuredModelProviders(): Set<string> {
  return new Set([
    ...(listAccountsPublic().length ? ["anthropic"] : []),
    ...(listCodexAccountsPublic().length ? ["openai"] : []),
    ...(hasXaiAccounts() ? [XAI_OAUTH_PROVIDER] : []),
    ...Object.entries(modelProviders())
      .filter(([, provider]) => !!provider.apiKey)
      .map(([provider]) => provider),
  ]);
}

/** Upstream provider needed to run one selectable model. */
export function modelUpstreamProvider(model: string): string | undefined {
  return toPiModel(model)?.match(/^pi\/([^/]+)\//)?.[1];
}

/** Picker/storage id for a selection. Presets keep their own id instead of
 * collapsing to their concrete lead model at dispatch. */
export function pickerModelId(model: string): string {
  const preset = modelPreset(model);
  if (preset) return model.startsWith("pi/") ? model : `pi/${model}`;
  return toPiModel(model) || model;
}

export function modelFitsConfiguredProviders(
  model: string,
  configuredProviders: ReadonlySet<string>,
): boolean {
  const provider = modelUpstreamProvider(model);
  return !!provider && configuredProviders.has(provider);
}

/**
 * Whether every provider a preset names is configured. The Dial is offered as
 * a cross-provider feature, so its whole tier family stays out of the picker
 * until both Anthropic and OpenAI are present, including its same-provider
 * lower tiers.
 */
export function presetFitsConfiguredProviders(
  preset: PickerPresetRequirement,
  configuredProviders: ReadonlySet<string>,
): boolean {
  const requiredProviders = new Set(
    [preset.lead, ...(preset.supporting || [])]
      .map((member) => modelUpstreamProvider(member.model))
      .filter((provider): provider is string => !!provider),
  );
  if (preset.group === "dial") {
    requiredProviders.add("anthropic");
    requiredProviders.add("openai");
  }
  return [...requiredProviders].every((provider) =>
    configuredProviders.has(provider),
  );
}

function selectionFitsConfiguredProviders(
  model: string,
  configuredProviders: ReadonlySet<string>,
): boolean {
  const preset = modelPreset(model);
  if (!preset) return modelFitsConfiguredProviders(model, configuredProviders);
  const orchestrator = orchestratorPreset(model);
  return presetFitsConfiguredProviders(
    {
      group: orchestrator ? "orchestrator" : "dial",
      lead: { model: preset.model },
      supporting: orchestrator
        ? orchestratorWorkerModels(orchestrator, configuredProviders).map(
            (worker) => ({ model: worker }),
          )
        : undefined,
    },
    configuredProviders,
  );
}

/** Capacity-aware default shared by the picker and untouched session creates. */
export function chooseConfiguredDefaultModel(
  preferred: string,
  configuredProviders: ReadonlySet<string>,
  fallbackModels: readonly string[],
): string {
  const normalizedPreferred = pickerModelId(preferred);
  if (
    selectionFitsConfiguredProviders(normalizedPreferred, configuredProviders)
  ) {
    return normalizedPreferred;
  }
  return (
    fallbackModels
      .map((model) => toPiModel(model) || model)
      .find((model) =>
        modelFitsConfiguredProviders(model, configuredProviders),
      ) || normalizedPreferred
  );
}

export function configuredInteractiveDefaultModel(
  configuredProviders = configuredModelProviders(),
): string {
  refreshPickerModels();
  return chooseConfiguredDefaultModel(
    interactiveDefaultModel(),
    configuredProviders,
    KNOWN_MODELS.filter((model) => model.provider === "pi").map(
      (model) => model.id,
    ),
  );
}
