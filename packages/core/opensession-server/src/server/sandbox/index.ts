/**
 * Sandbox provider registry (docs/self-hosting-sandboxes.md).
 *
 * `getSandboxProvider()` resolves the provider for a run: an explicit spec
 * wins, otherwise the config file (~/.opensession/sandbox.json) decides, and
 * the kill-switch file (<sessions-dir>/disable-sandboxes) forces "local".
 * Four Sandbox backends are implemented, Daytona, Box, Tart (macOS VMs on a
 * Mac Runner), and use.computer (macOS VMs on reserved Macs); a retired or
 * unknown id throws at dispatch instead of silently running unsandboxed.
 */

import { LocalProvider } from "./local";
import { DaytonaProvider } from "./adapters/daytona";
import { BoxProvider } from "./adapters/box";
import { TartProvider } from "./adapters/tart";
import { UseComputerProvider } from "./adapters/usecomputer";
import { effectiveSandboxProvider, isRetiredSandboxProvider } from "./config";
import type { SandboxProvider, SandboxProviderId } from "./provider";

export type {
  Sandbox,
  SandboxProvider,
  SandboxProviderId,
  SandboxSessionSpec,
  SandboxStatus,
  ExecOpts,
  ExecResult,
  PortMap,
} from "./provider";
export {
  sandboxConfig,
  sandboxesEnabled,
  effectiveSandboxProvider,
  type SandboxConfig,
} from "./config";
export {
  workspaceExecFor,
  hostWorkspaceExec,
  hasRemoteWorkspace,
  type WorkspaceExec,
  type WorkspaceExecSession,
} from "./workspace-exec";
export { LocalProvider } from "./local";

// Shared instances — every provider keeps its state on disk / at the
// provider, not here. The remote adapters import their SDKs lazily inside
// methods, so constructing them is free at boot.
const localProvider = new LocalProvider();
const daytonaProvider = new DaytonaProvider();
const boxProvider = new BoxProvider();
const tartProvider = new TartProvider();
const useComputerProvider = new UseComputerProvider();

/**
 * Resolve a SandboxProvider. `spec` (a provider id, e.g. from a session file's
 * `sandbox.provider`) overrides the config; omitted = effective config value.
 * Remote adapters fail loudly at ensure-time when their credentials
 * isn't configured — a premature config flip never silently runs unsandboxed.
 */
export function getSandboxProvider(
  spec?: SandboxProviderId | string,
): SandboxProvider {
  const id = (spec as SandboxProviderId) || effectiveSandboxProvider();
  switch (id) {
    case "local":
      return localProvider;
    case "daytona":
      return daytonaProvider;
    case "box":
      return boxProvider;
    case "tart":
      return tartProvider;
    case "usecomputer":
      return useComputerProvider;
    default:
      if (isRetiredSandboxProvider(id))
        throw new Error(
          `Sandbox provider "${id}" has been retired; this session's Sandbox can no longer be reached. Start a new session on Daytona or Boat.`,
        );
      throw new Error(`unknown sandbox provider "${id}"`);
  }
}
