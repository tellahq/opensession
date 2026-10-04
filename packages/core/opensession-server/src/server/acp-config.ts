import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, delimiter } from "node:path";
import { getConfig } from "./config";
import type { AcpAgentConfig } from "./acp-adapter";

export function parseAcpAgents(value: unknown): AcpAgentConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("acp must be an array");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object")
      throw new Error("Invalid ACP agent");
    const agent = entry as AcpAgentConfig;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent.id) || ids.has(agent.id))
      throw new Error("Invalid or duplicate ACP id");
    if (
      typeof agent.name !== "string" ||
      !agent.name.trim() ||
      typeof agent.command !== "string" ||
      !agent.command.trim()
    )
      throw new Error("ACP name and command are required");
    if (
      agent.args !== undefined &&
      (!Array.isArray(agent.args) ||
        agent.args.some((arg) => typeof arg !== "string"))
    )
      throw new Error("ACP args must be strings");
    if (
      agent.env !== undefined &&
      (!agent.env ||
        typeof agent.env !== "object" ||
        Array.isArray(agent.env) ||
        Object.entries(agent.env).some(
          ([key, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string",
        ))
    )
      throw new Error("Invalid ACP environment");
    ids.add(agent.id);
    return {
      id: agent.id,
      name: agent.name.trim(),
      command: agent.command.trim(),
      args: agent.args || [],
      env: agent.env || {},
    };
  });
}
export function configuredAcpAgents(): AcpAgentConfig[] {
  return getConfig().acp || [];
}
export async function acpUnavailableReason(
  agent: AcpAgentConfig,
): Promise<string | undefined> {
  const candidates = isAbsolute(agent.command)
    ? [agent.command]
    : agent.command.includes("/")
      ? []
      : (agent.env?.PATH || process.env.PATH || "")
          .split(delimiter)
          .map((dir) => join(dir, agent.command));
  for (const path of candidates) {
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return undefined;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return `ACP executable unavailable: ${agent.command}. Install it or configure an absolute command path.`;
}
