/**
 * The run-host wire contract moved to the protocol package
 * (`@tellahq/opensession-protocol/runner`) — this shim re-exports it so import
 * sites and git history stay stable, and keeps the deployment-specific spawn
 * paths that don't belong in a published protocol.
 */
import { fileURLToPath } from "url";

export * from "@tellahq/opensession-protocol/runner";
export { isCompiledBinary, runnerHostArgv, mcpProxyArgv } from "./exe";

/** Absolute paths of the host/proxy entrypoints and the bun binary, for
 *  spawning FROM SOURCE. In a compiled binary there is no `bun` on PATH and no
 *  `src/` tree next to the executable; the spawn sites re-exec the binary with
 *  a subcommand instead (see ./exe and src/main.ts), so these source paths are
 *  never consulted. REPO_ROOT resolves to a harmless in-bundle path there. */
export const BUN_BIN = Bun.which("bun") || process.execPath;
export const REPO_ROOT = fileURLToPath(
  new URL("../../../../..", import.meta.url),
).replace(/\/$/, "");
export const HOST_ENTRY = `${REPO_ROOT}/packages/core/opensession-server/src/runner-host/host.ts`;
export const MCP_PROXY_ENTRY = `${REPO_ROOT}/packages/core/opensession-server/src/runner-host/mcp-proxy.ts`;
