/**
 * Sandbox provider registry (docs/self-hosting-sandboxes.md).
 *
 * `getSandboxProvider()` resolves the provider for a run: an explicit spec
 * wins, otherwise the config file (~/.opensession-sandbox.json) decides, and the
 * kill-switch file (<sessions-dir>/disable-sandboxes) forces "local".
 * Every registered provider is implemented (local host, Docker, Lambda
 * MicroVM, and the remote Daytona/E2B/Box/Modal adapters); an unknown id
 * still throws at run start instead of silently running unsandboxed.
 */

import { LocalProvider } from "./local";
import { DockerProvider } from "./docker";
import { DaytonaProvider } from "./adapters/daytona";
import { E2bProvider } from "./adapters/e2b";
import { BoxProvider } from "./adapters/box";
import { ModalProvider } from "./adapters/modal";
import { LambdaMicrovmProvider } from "./adapters/lambda-microvm";
import { effectiveSandboxProvider } from "./config";
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
  RunHandle,
  RunHandleCallbacks,
} from "./provider";
export {
  sandboxConfig,
  sandboxesEnabled,
  effectiveSandboxProvider,
  type SandboxConfig,
  type SandboxWorkspaceMode,
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
const dockerProvider = new DockerProvider();
const daytonaProvider = new DaytonaProvider();
const e2bProvider = new E2bProvider();
const boxProvider = new BoxProvider();
const modalProvider = new ModalProvider();
const lambdaMicrovmProvider = new LambdaMicrovmProvider();

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
    case "docker":
      return dockerProvider;
    case "daytona":
      return daytonaProvider;
    case "e2b":
      return e2bProvider;
    case "box":
      return boxProvider;
    case "modal":
      return modalProvider;
    case "microvm":
      throw new Error(
        "Local MicroVM has been retired; choose a managed remote provider",
      );
    case "lambda-microvm":
      return lambdaMicrovmProvider;
    default:
      throw new Error(`unknown sandbox provider "${id}"`);
  }
}
