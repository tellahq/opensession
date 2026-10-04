import { readFile } from "node:fs/promises";
import { configuredAcpAgents, acpUnavailableReason } from "./acp-config";
import {
  createAcpAdapter,
  acpCapabilities,
  type AcpMcpServer,
} from "./acp-adapter";
import type { EngineAdapter } from "./engine-adapter";
import { configuredMcpConfigPath } from "./config";
import { mcpServerAllowedForRun } from "./runner-shared";
import type { RunAgentOpts } from "./agent-runner";
import { BUN_BIN, MCP_PROXY_ENTRY, rpcSocketPath } from "./run-rpc-protocol";
import { sessionsDir } from "./paths";

const instances = new Map<
  string,
  { fingerprint: string; adapter: EngineAdapter }
>();
function instance(id: string): EngineAdapter {
  const config = configuredAcpAgents().find((agent) => agent.id === id);
  if (!config) throw new Error(`ACP agent is not configured: ${id}`);
  const fingerprint = JSON.stringify(config);
  const cached = instances.get(id);
  if (cached?.fingerprint === fingerprint) return cached.adapter;
  if (cached?.adapter.activeCount())
    throw new Error("ACP configuration changed while its agent is running");
  const adapter = createAcpAdapter(config);
  instances.set(id, { fingerprint, adapter });
  return adapter;
}
export async function acpModelMetadata() {
  return Promise.all(
    configuredAcpAgents().map(async (agent) => {
      const unavailableReason = await acpUnavailableReason(agent);
      return {
        id: `acp/${agent.id}`,
        label: agent.name,
        provider: "acp" as const,
        aliases: [],
        efforts: [],
        engineKind: "acp",
        engineInstanceId: agent.id,
        engineCapabilities: instance(agent.id).capabilities,
        available: !unavailableReason,
        unavailableReason,
      };
    }),
  );
}

/** ACP receives only scoped stdio connectors. URL-only connectors cannot be
 * represented by v1's required stdio transport and are not granted. */
export async function resolveAcpMcp(
  opts: RunAgentOpts,
  token: string,
): Promise<AcpMcpServer[]> {
  let configured: Record<string, any> = {};
  try {
    configured =
      JSON.parse(await readFile(configuredMcpConfigPath(), "utf8"))
        .mcpServers || {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const scope =
    opts.mcpServers === "all" ? Object.keys(configured) : opts.mcpServers;
  const servers: AcpMcpServer[] = [];
  for (const name of scope || []) {
    const cfg = configured[name];
    if (
      !cfg ||
      !mcpServerAllowedForRun(name, cfg.allowedUsers, opts.user, [
        opts.mcpGrantUser,
      ])
    )
      continue;
    if (!cfg.command) continue;
    if (Object.keys(opts.confirmTools || {}).length)
      throw new Error(
        "ACP cannot grant external stdio connectors with confirmation-required tools",
      );
    servers.push({
      name,
      command: cfg.command,
      args: cfg.args || [],
      env: Object.entries(cfg.env || {}).map(([name, value]) => ({
        name,
        value: String(value),
      })),
    });
  }
  if (opts.journal?.osSessionId) {
    for (const name of Object.keys(opts.inProcessMcp || {}))
      servers.push({
        name,
        command: BUN_BIN,
        args: [MCP_PROXY_ENTRY],
        env: [
          {
            name: "OPENSESSION_RPC_SOCKET",
            value: rpcSocketPath(sessionsDir()),
          },
          { name: "OPENSESSION_RPC_TOKEN", value: token },
          { name: "OPENSESSION_MCP_SERVER", value: name },
        ],
      });
  } else if (Object.keys(opts.inProcessMcp || {}).length)
    throw new Error("ACP MCP bridge requires an owning session");
  return servers;
}

export const acpDriver: EngineAdapter = {
  kind: "acp",
  capabilities: acpCapabilities(),
  busy: (id) => [...instances.values()].some(({ adapter }) => adapter.busy(id)),
  activeCount: () =>
    [...instances.values()].reduce(
      (n, { adapter }) => n + adapter.activeCount(),
      0,
    ),
  steer: () => false,
  retract: () => false,
  cancel(id) {
    let cancelled = false;
    for (const { adapter } of instances.values())
      if (adapter.cancel(id)) cancelled = true;
    return cancelled;
  },
  async *run(opts, model) {
    const id = model.slice("acp/".length);
    const token = crypto.randomUUID();
    const rpc = await import("./run-rpc");
    try {
      const servers = await resolveAcpMcp(opts, token);
      if (opts.journal?.osSessionId)
        rpc.registerRunToken(token, {
          sessionId: opts.journal.osSessionId,
          user: opts.user,
          humanPrompter: opts.user,
          promptEntryId: opts.promptEntryId,
          allowedServers: Object.keys(opts.inProcessMcp || {}),
          allowWorkspaceExec: false,
        });
      yield* instance(id).run(
        {
          ...opts,
          mcpServers: [],
          inProcessMcp: undefined,
          confirmTools: undefined,
          acpMcpServers: servers,
        } as import("./acp-adapter").AcpRunOptions,
        model,
      );
    } catch (error) {
      yield {
        type: "error",
        content: error instanceof Error ? error.message : String(error),
        model,
        provider: "acp",
      };
    } finally {
      rpc.unregisterRunToken(token);
    }
  },
};
