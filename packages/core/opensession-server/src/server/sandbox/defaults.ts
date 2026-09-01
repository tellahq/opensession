/** Workspace + personal defaults for new interactive sandbox sessions. */

import { getUiPrefs, patchUiPrefs } from "../ui-prefs";
import type { SandboxProviderId } from "./provider";
import {
  RUNNABLE_SANDBOX_PROVIDERS,
  type RunnableSandboxProviderId,
  resolveRequestedSandbox,
  sandboxConfig,
  sandboxProviderCertified,
  sandboxProviderConfigured,
  setWorkspaceSandboxDefault,
} from "./config";
import {
  getSandboxConnection,
  isWorkspaceSandboxProvider,
  sandboxConnectionReady,
} from "./connections";

export type WorkspaceSandboxDefault = RunnableSandboxProviderId | "none";
export type PersonalSandboxDefault = WorkspaceSandboxDefault | "workspace";

export interface SandboxDefaultsStatus {
  workspace: WorkspaceSandboxDefault;
  personal: PersonalSandboxDefault;
  effective: WorkspaceSandboxDefault;
}

const PERSONAL_PREF_KEY = "sandbox-default";

function runnable(value: unknown): value is RunnableSandboxProviderId {
  return (
    typeof value === "string" &&
    (RUNNABLE_SANDBOX_PROVIDERS as readonly string[]).includes(value)
  );
}

export function workspaceSandboxDefault(): WorkspaceSandboxDefault {
  const value = sandboxConfig().sessionDefault;
  return runnable(value) ? value : "none";
}

export function personalSandboxDefault(user: string): PersonalSandboxDefault {
  const value = getUiPrefs(user || "Anonymous")[PERSONAL_PREF_KEY];
  if (value === "none" || value === "workspace" || runnable(value))
    return value;
  return "workspace";
}

export function sandboxDefaultsStatus(user: string): SandboxDefaultsStatus {
  const workspace = workspaceSandboxDefault();
  const personal = personalSandboxDefault(user);
  return {
    workspace,
    personal,
    effective: effectiveSandboxDefault(workspace, personal),
  };
}

export function effectiveSandboxDefault(
  workspace: WorkspaceSandboxDefault,
  personal: PersonalSandboxDefault,
): WorkspaceSandboxDefault {
  return personal === "workspace" ? workspace : personal;
}

function assertAvailable(
  value: string,
): asserts value is RunnableSandboxProviderId {
  if (!runnable(value)) throw new Error(`Unknown sandbox provider "${value}"`);
  if (
    isWorkspaceSandboxProvider(value) &&
    getSandboxConnection(value) &&
    !sandboxConnectionReady(value)
  ) {
    throw new Error(`Sandbox provider "${value}" is not currently available`);
  }
  if (!sandboxProviderCertified(value) || !sandboxProviderConfigured(value)) {
    throw new Error(`Sandbox provider "${value}" is not currently available`);
  }
}

export function saveWorkspaceSandboxDefault(
  value: string,
): SandboxDefaultsStatus {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "none") assertAvailable(normalized);
  setWorkspaceSandboxDefault(normalized);
  return sandboxDefaultsStatus("Anonymous");
}

export function savePersonalSandboxDefault(
  user: string,
  value: string,
): SandboxDefaultsStatus {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "workspace" && normalized !== "none")
    assertAvailable(normalized);
  patchUiPrefs(user || "Anonymous", { [PERSONAL_PREF_KEY]: normalized });
  return sandboxDefaultsStatus(user || "Anonymous");
}

/** Apply defaults only when a caller omitted `sandbox`. false/""/"local"
 * remain explicit Host choices, preserving per-session overrides. */
export function resolveInteractiveSandbox(
  requested: boolean | string | undefined | null,
  user: string | undefined | null,
  repoId?: string,
  model?: string | null,
):
  | { ok: true; provider: SandboxProviderId | null }
  | { ok: false; error: string } {
  if (requested !== undefined && requested !== null) {
    return resolveRequestedSandbox(requested, repoId, model);
  }
  const selected = sandboxDefaultsStatus(user || "Anonymous").effective;
  return resolveRequestedSandbox(
    selected === "none" ? "local" : selected,
    repoId,
    model,
  );
}
