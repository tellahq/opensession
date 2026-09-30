import { resolve } from "path";

/** The server-side RPC socket the MCP proxy talks to. Stable path. */
export function rpcSocketPath(sessionsDir: string): string {
  return `${sessionsDir}/opensession-rpc.sock`;
}

/**
 * Ceiling for one call to an Open Session MCP tool. Tools may legitimately
 * block for many minutes on a person: register_credential waits 15 minutes
 * for a pasted secret, ask_human about 20 minutes for a teammate, and
 * request_credential and ask_user until the owner answers. The MCP SDK's
 * default request timeout is 60s, so every client of these servers passes
 * this explicitly instead.
 */
export const RPC_TOOL_CALL_TIMEOUT_MS = 30 * 60_000;

/** Absolute paths used by Codex MCP stdio proxy config. */
export const BUN_BIN = process.execPath;
export const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
/** The MCP stdio proxy entry. The env override exists for the bundled server
 * sidecar (os1-mac local mode): there the server is a single bundled file with
 * no src/ tree next to it, and the shell points this at the prebundled
 * mcp-proxy.js it ships alongside. Unset everywhere else. */
export const MCP_PROXY_ENTRY =
  process.env.OPENSESSION_MCP_PROXY_ENTRY?.trim() ||
  resolve(import.meta.dir, "../runner-host/mcp-proxy.ts");

/** Loopback streamable-HTTP MCP listener (run-rpc.ts startMcpHttpServer):
 * host-local pi runs consume the in-process opensession-* servers as
 * `type:"remote"` entries against this port instead of spawning a stdio
 * proxy subprocess per server per instance (664 procs / 42GB RSS on
 * 2026-07-27). MUST stay stable across restarts — detached engine servers
 * survive with the URL baked into their config, exactly like the unix
 * socket path. (3851 belongs to the PR-video agent; 3850/3854/3855/3860
 * are also taken on this box.) */
export const MCP_HTTP_PORT = parseInt(
  process.env.OPENSESSION_MCP_HTTP_PORT || "3852",
  10,
);

export function mcpHttpUrl(serverName: string): string {
  return `http://127.0.0.1:${MCP_HTTP_PORT}/mcp/${serverName}`;
}
