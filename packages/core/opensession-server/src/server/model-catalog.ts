import { accountServesUser, listAccountsPublic } from "./claude-accounts";
import {
  claudeMythosModelOf,
  isClaudeApiAccount,
  isClaudeApiOnlyModel,
} from "./claude-api-credentials";
import { listCodexAccountsPublic } from "./codex-accounts";
import { designatedBridgeAccountIds, modelProviders } from "./model-providers";
import { piAnthropicTransport } from "./pi-config";
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

/** Capacity key for one Mythos release: some API account serving the user
 *  was verified to have access to it. */
export function claudeApiModelCapacity(mythosModel: string): string {
  return `${CLAUDE_API_CAPACITY}:${mythosModel}`;
}

/** The Claude accounts that could serve `user`'s runs, usable or not.
 * A bridge designation fences Anthropic runs to the accounts it names, so
 * only those count: an API account added outside it cannot serve Mythos.
 * Claude capacity is per person, with the routing owner gate: another user's
 * personal account (subscription or API) never serves this user's run. The
 * HTTP bridge carries no run identity, so there only shared accounts serve
 * anyone. */
export function claudeAccountsForUser(
  user?: string,
  billingLogin?: string,
): ReturnType<typeof listAccountsPublic> {
  const designated = designatedBridgeAccountIds();
  const runUser = piAnthropicTransport() === "bridge" ? undefined : user;
  return listAccountsPublic().filter(
    (a) =>
      (!designated.length || designated.includes(a.id)) &&
      accountServesUser(a, runUser, billingLogin),
  );
}

/** Provider capacity configured on this server for `user` (the person who
 * would run the model), with `billingLogin` their verified GitHub login: a
 * personal Claude API account counts only for its own login. Temporary
 * exhaustion does not change the catalog or default; adding or removing an
 * account does. */
export function configuredModelProviders(
  user?: string,
  billingLogin?: string,
): Set<string> {
  const claude = claudeAccountsForUser(user, billingLogin);
  // An API account counts only for the Mythos releases a Models API check
  // verified; an unverified one is no capacity at all.
  const mythos = new Set(
    claude.filter(isClaudeApiAccount).flatMap((a) => a.mythosModels ?? []),
  );
  return new Set([
    ...(claude.some((a) => !isClaudeApiAccount(a)) ? ["anthropic"] : []),
    ...(mythos.size ? [CLAUDE_API_CAPACITY] : []),
    ...[...mythos].map(claudeApiModelCapacity),
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
  if (provider === "anthropic" && isClaudeApiOnlyModel(model)) {
    const mythos = claudeMythosModelOf(model);
    return !!mythos && configuredProviders.has(claudeApiModelCapacity(mythos));
  }
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
