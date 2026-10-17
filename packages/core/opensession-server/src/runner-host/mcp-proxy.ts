/**
 * mcp-proxy — a stdio MCP server that forwards tools/list and tools/call for
 * ONE opensession-* server to the opensession process over its run-rpc
 * (src/server/run-rpc.ts), via the shared relay in run-rpc-relay.ts.
 *
 * Run hosts no longer spawn this: they mount every opensession-* server on a
 * single in-process relay (host.ts). It stays as `opensession mcp-proxy` for
 * MCP clients that can only consume an external stdio server.
 *
 * Env:
 *   OPENSESSION_RPC_SOCKET  — opensession's run-rpc unix socket path, OR
 *   OPENSESSION_RPC_WS_URL  — opensession's /rpc-ws WebSocket route (remote
 *                     sandboxes, where a unix socket can't cross the boundary)
 *   OPENSESSION_RPC_WS_HOST — WS mode: this run's hostId (the rpc-ws upgrade is
 *                     authenticated per ws-transport run, not per rpc token)
 *   OPENSESSION_RPC_WS_AUTH — WS mode: the run's wsToken, the upgrade bearer
 *   OPENSESSION_RPC_TOKEN   — per-run bearer sent IN each frame (maps to session +
 *                     user via dispatchRunRpc; also the unix-socket bearer)
 *   OPENSESSION_MCP_SERVER  — which interactive server to proxy (e.g. opensession-sessions)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createRunRpcRelay,
  relayMcpServer,
  runRpcRelayConfigError,
  type RunRpcRelayConfig,
} from "./run-rpc-relay";

const cfg: Partial<RunRpcRelayConfig> = {
  socket: process.env.OPENSESSION_RPC_SOCKET || "",
  wsUrl: process.env.OPENSESSION_RPC_WS_URL || "",
  wsHost: process.env.OPENSESSION_RPC_WS_HOST || "",
  wsAuth: process.env.OPENSESSION_RPC_WS_AUTH || "",
  token: process.env.OPENSESSION_RPC_TOKEN || "",
};
const SERVER_NAME = process.env.OPENSESSION_MCP_SERVER || "";
if (runRpcRelayConfigError(cfg) || !SERVER_NAME) {
  console.error(
    "mcp-proxy: OPENSESSION_RPC_SOCKET or OPENSESSION_RPC_WS_URL (+ OPENSESSION_RPC_WS_HOST/OPENSESSION_RPC_WS_AUTH), plus OPENSESSION_RPC_TOKEN and OPENSESSION_MCP_SERVER are required",
  );
  process.exit(2);
}

const relay = createRunRpcRelay(cfg as RunRpcRelayConfig);
await relayMcpServer(relay, SERVER_NAME).connect(new StdioServerTransport());
