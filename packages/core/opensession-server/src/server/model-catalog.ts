import { listAccountsPublic } from "./claude-accounts";
import {
  isClaudeApiAccount,
  isClaudeApiOnlyModel,
} from "./claude-api-credentials";
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

/** Capacity key for Claude API accounts. They serve only API-only models
 * (Mythos), so they do not make the rest of the `anthropic` catalog runnable. */
export const CLAUDE_API_CAPACITY = "anthropic:api";

/** Provider capacity configured on this server. Temporary exhaustion does not
 * change the catalog or default; adding or removing an account does. */
export function configuredModelProviders(): Set<string> {
  const claude = listAccountsPublic();
  return new Set([
    ...(claude.some((a) => !isClaudeApiAccount(a)) ? ["anthropic"] : []),
    ...(claude.some(isClaudeApiAccount) ? [CLAUDE_API_CAPACITY] : []),
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
  if (!provider) return false;
  // Mythos runs only on Claude API accounts; subscriptions cannot serve it.
  if (provider === "anthropic" && isClaudeApiOnlyModel(model))
    return configuredProviders.has(CLAUDE_API_CAPACITY);
  return configuredProviders.has(provider);
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
