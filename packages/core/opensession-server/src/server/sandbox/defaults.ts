/** Workspace + personal defaults for new interactive sandbox sessions. */

import { getUiPrefs, patchUiPrefs } from "../ui-prefs";
import type { SandboxProviderId } from "./provider";
import {
  RUNNABLE_SANDBOX_PROVIDERS,
  type RunnableSandboxProviderId,
  repoSandboxDefault,
  repoSandboxGpu,
  resolveRequestedSandbox,
  sandboxConfig,
  sandboxProviderCertified,
  sandboxProviderConfigured,
  setRepoPortalSandbox,
  setRepoSandboxDefault,
  setWorkspaceSandboxDefault,
  type SandboxGpu,
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
  /** What a new session starts in, for `repo` when one was named. */
  effective: WorkspaceSandboxDefault;
  /** Per-repo overrides; a repo absent here follows workspace and personal.
   *  Modal with a GPU reads as the Machine menu names it (`modal:T4`). */
  repos: Record<string, string>;
  /** Repos whose Portals run in a Sandbox of their own for sessions on this
   * machine (repo id → provider); a repo absent here runs them beside the
   * session. */
  portals: Record<string, RunnableSandboxProviderId>;
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

export function repoSandboxDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [repoId, override] of Object.entries(
    sandboxConfig().perRepo || {},
  )) {
    if (override.sessionDefault)
      out[repoId] = override.sessionGpu
        ? `${override.sessionDefault}:${override.sessionGpu}`
        : override.sessionDefault;
  }
  return out;
}

export function repoPortalSandboxes(): Record<
  string,
  RunnableSandboxProviderId
> {
  const out: Record<string, RunnableSandboxProviderId> = {};
  for (const [repoId, override] of Object.entries(
    sandboxConfig().perRepo || {},
  )) {
    if (override.portalSandbox) out[repoId] = override.portalSandbox;
  }
  return out;
}

export function sandboxDefaultsStatus(
  user: string,
  repoId?: string,
): SandboxDefaultsStatus {
  const workspace = workspaceSandboxDefault();
  const personal = personalSandboxDefault(user);
  return {
    workspace,
    personal,
    effective: effectiveSandboxDefault(
      workspace,
      personal,
      repoSandboxDefault(repoId),
    ),
    repos: repoSandboxDefaults(),
    portals: repoPortalSandboxes(),
  };
}

/** Precedence: the repo's own default, then the person's, then the
 * workspace's. A repo that should always run in a Sandbox therefore does,
 * whatever a person set for themselves; only a per-session choice beats it. */
export function effectiveSandboxDefault(
  workspace: WorkspaceSandboxDefault,
  personal: PersonalSandboxDefault,
  repo?: WorkspaceSandboxDefault | null,
): WorkspaceSandboxDefault {
  if (repo) return repo;
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

export function saveRepoSandboxDefault(
  repoId: string,
  value: string,
): SandboxDefaultsStatus {
  const normalized = value.trim().toLowerCase();
  const provider = normalized.split(":")[0] || "";
  if (provider !== "workspace" && provider !== "none")
    assertAvailable(provider);
  setRepoSandboxDefault(repoId, value.trim());
  return sandboxDefaultsStatus("Anonymous", repoId);
}

/** `none` runs the repo's Portals beside the session again. */
export function saveRepoPortalSandbox(
  repoId: string,
  value: string,
): SandboxDefaultsStatus {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "none") assertAvailable(normalized);
  setRepoPortalSandbox(repoId, normalized);
  return sandboxDefaultsStatus("Anonymous", repoId);
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

/** The GPU a new session gets when neither its Sandbox nor its GPU was
 * chosen and its project's default is Modal with a GPU. */
export function defaultSandboxGpu(
  requestedSandbox: unknown,
  requestedGpu: unknown,
  provider: string | null | undefined,
  repoId?: string,
): SandboxGpu | undefined {
  if (requestedSandbox !== undefined && requestedSandbox !== null)
    return undefined;
  if (requestedGpu !== undefined && requestedGpu !== null) return undefined;
  if (provider !== "modal" || repoSandboxDefault(repoId) !== "modal")
    return undefined;
  return repoSandboxGpu(repoId);
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
  const selected = sandboxDefaultsStatus(user || "Anonymous", repoId).effective;
  return resolveRequestedSandbox(
    selected === "none" ? "local" : selected,
    repoId,
    model,
  );
}
