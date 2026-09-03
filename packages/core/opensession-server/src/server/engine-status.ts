/** Shared readiness check for Setup and `opensession doctor`. */
import { listAccountsPublic } from "./claude-accounts";
import { listCodexAccountsPublic } from "./codex-accounts";
import { listXaiAccountsPublic } from "./xai-accounts";
import { accountProviderForModel } from "./models";
import { configuredInteractiveDefaultModel } from "./model-catalog";
import { modelProviders } from "./model-providers";
import { piConfigPath, piEngineEnabled } from "./pi-config";
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

export function engineStatus(): EngineStatus {
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
  const claudeAvailable = claudePool.filter(
    (account) => account.usable && !account.exhaustedUntil,
  ).length;
  const codexAvailable = codexPool.filter(
    (account) => account.usable && !account.exhaustedUntil,
  ).length;
  const defaultModel = configuredInteractiveDefaultModel();
  const provider = accountProviderForModel(defaultModel);
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
