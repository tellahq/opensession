import { listAccountsPublic } from "./claude-accounts";
import { listCodexAccountsPublic } from "./codex-accounts";
import { modelProviders } from "./model-providers";
import { hasXaiAccounts } from "./xai-accounts";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";
import {
  KNOWN_MODELS,
  interactiveDefaultModel,
  refreshPickerModels,
  toPiModel,
} from "./models";

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

/** Picker/storage id for a selection. */
export function pickerModelId(model: string): string {
  return toPiModel(model) || model;
}

export function modelFitsConfiguredProviders(
  model: string,
  configuredProviders: ReadonlySet<string>,
): boolean {
  const provider = modelUpstreamProvider(model);
  return !!provider && configuredProviders.has(provider);
}

/** Capacity-aware default shared by the picker and untouched session creates. */
export function chooseConfiguredDefaultModel(
  preferred: string,
  configuredProviders: ReadonlySet<string>,
  fallbackModels: readonly string[],
): string {
  const normalizedPreferred = pickerModelId(preferred);
  if (modelFitsConfiguredProviders(normalizedPreferred, configuredProviders)) {
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
