/** Shared readiness check for Setup and `opensession doctor`. */
import { listAccountsPublic, resolveAccount } from "./claude-accounts";
import { listCodexAccountsPublic } from "./codex-accounts";
import { listXaiAccountsPublic } from "./xai-accounts";
import { accountProviderForModel } from "./models";
import {
  configuredInteractiveDefaultModel,
  configuredModelProviders,
} from "./model-catalog";
import { designatedBridgeAccountIds, modelProviders } from "./model-providers";
import {
  piAnthropicTransport,
  piConfigPath,
  piEngineEnabled,
} from "./pi-config";
import { homeDir } from "./paths";

function engineConfigLabel(): string {
  const home = homeDir();
  const path = piConfigPath();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export interface EngineStatus {
  piEnabled: boolean;
  claudeAccounts: number;
  codexAccounts: number;
  xaiAccounts: number;
  defaultModel: string;
  provider: "claude" | "codex" | "xai" | undefined;
  ready: boolean;
  blocker: string | null;
  fix: string | null;
  fixableInApp: boolean;
}

/** `user` is the person viewing: Claude capacity, and so the default model,
 *  counts only accounts that serve them. */
export function engineStatus(user?: string): EngineStatus {
  const enabled = piEngineEnabled();
  const claudePool = listAccountsPublic();
  const codexPool = listCodexAccountsPublic();
  const xaiPool = listXaiAccountsPublic();
  const claudeAccounts = claudePool.length;
  const codexAccounts = codexPool.length;
  const xaiAccounts = xaiPool.length;
  const xaiAvailable = xaiPool.filter(
    (account) => account.usable && !account.exhaustedUntil,
  ).length;
  const codexAvailable = codexPool.filter(
    (account) => account.usable && !account.exhaustedUntil,
  ).length;
  const defaultModel = configuredInteractiveDefaultModel(
    configuredModelProviders(user),
  );
  const provider = accountProviderForModel(defaultModel);
  // Claude readiness asks the runner's own selector, as a peek that does not
  // consume a round-robin turn: the designation, the owner gate for this user
  // (the HTTP bridge carries no run identity), the account kind, and both
  // account-wide and per-model sidelines for the default model.
  const claudeAvailable =
    "account" in
    resolveAccount({
      user: piAnthropicTransport() === "bridge" ? undefined : user,
      model: defaultModel,
      designatedIds: designatedBridgeAccountIds(),
      recordPick: false,
    });
  const base = {
    piEnabled: enabled,
    claudeAccounts,
    codexAccounts,
    xaiAccounts,
    defaultModel,
    provider,
  };
  const blocked = (blocker: string, fix: string, fixableInApp = false) => ({
    ...base,
    ready: false,
    blocker,
    fix,
    fixableInApp,
  });

  if (!enabled) {
    return blocked(
      "The Pi engine is switched off, so no agent turn can run.",
      `Turn it on here. This writes \`enabled: true\` to ${engineConfigLabel()}.`,
      true,
    );
  }
  if (provider === "claude" && !claudeAvailable) {
    return blocked(
      "No usable Claude accounts are available for the default model.",
      "Add a Claude account under Workspace → Setup, or wait for an exhausted account to reset.",
    );
  }
  if (provider === "codex" && !codexAvailable) {
    return blocked(
      "No usable ChatGPT accounts are available for the default model.",
      "Add a ChatGPT account under Workspace → Setup, or wait for an exhausted account to reset.",
    );
  }
  if (provider === "xai" && !xaiAvailable) {
    return blocked(
      "No usable SuperGrok accounts are available for the default model.",
      "Add an xAI account under Workspace → Setup, or wait for an exhausted account to reset.",
    );
  }
  if (
    !provider &&
    !claudeAvailable &&
    !codexAvailable &&
    !xaiAvailable &&
    !Object.keys(modelProviders()).length
  ) {
    return blocked(
      `No model capacity is configured for "${defaultModel}".`,
      "Add a Claude or ChatGPT account, or a provider API key, under Workspace → Models.",
    );
  }
  return {
    ...base,
    ready: true,
    blocker: null,
    fix: null,
    fixableInApp: false,
  };
}
