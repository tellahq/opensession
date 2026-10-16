import { assertPersonalAttachmentsAbsent } from "./personal-image-admission";
import type { McpRuntime } from "./mcp-runtime";

interface PersonalMcpOptions {
  personalRepo?: unknown;
  images?: unknown;
  files?: unknown;
  attachments?: unknown;
  mcpServers?: unknown;
  inProcessMcp?: unknown;
}
/** First-release private surface: built-in local tools and projected Git/GH,
 * never configured/shared MCP defaults, SDK mounts, relay or proxy grants. */
export function assertPersonalMcpNone(opts: PersonalMcpOptions): void {
  if (!opts.personalRepo) return;
  const mounts = opts.inProcessMcp;
  if (
    !Array.isArray(opts.mcpServers) ||
    opts.mcpServers.length ||
    (mounts !== undefined &&
      (!mounts ||
        typeof mounts !== "object" ||
        Array.isArray(mounts) ||
        Object.keys(mounts).length))
  )
    throw new Error(
      "Personal runs require an explicit empty MCP scope and no MCP configs",
    );
}
export function assertPersonalHostMcpNone(
  opts: PersonalMcpOptions & { proxyMcpServers?: unknown; rpcToken?: unknown },
): void {
  assertPersonalAttachmentsAbsent(opts);
  assertPersonalMcpNone(opts);
  if (
    opts.personalRepo &&
    (!Array.isArray(opts.proxyMcpServers) ||
      opts.proxyMcpServers.length ||
      opts.rpcToken !== undefined)
  )
    throw new Error("Personal hosts cannot carry MCP proxy grants");
}
/** Lazy shared factory is deliberately not invoked for private work, even to
 * discover configured server names. Empty scopes must not turn into defaults. */
export async function createRunMcpRuntime(
  opts: PersonalMcpOptions,
  shared: () => Promise<McpRuntime>,
): Promise<McpRuntime> {
  if (!opts.personalRepo) return shared();
  assertPersonalMcpNone(opts);
  return {
    hasCatalog: false,
    catalog: async () => [],
    callExact: async () => {
      throw new Error("MCP is unavailable for personal runs");
    },
    close: async () => {},
  };
}
export function assertPersonalPiPath(
  personal: unknown,
  resolved: { dial?: unknown; orchestrator?: unknown } | null,
): void {
  if (personal && (!resolved || resolved.dial || resolved.orchestrator))
    throw new Error(
      "Personal runs require a supported non-delegating Pi model",
    );
}
