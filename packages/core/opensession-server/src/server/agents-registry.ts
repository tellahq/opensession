/**
 * The loaded agent modules (Plain/Linear/Slack/Stripe/…). Registered once at
 * boot (loadAgents runs behind the __opensessionBooted guard) and read by the
 * health route; globalThis-backed so the set survives a hot reload.
 */

import type { AgentModule } from "../agents/types";

const g = globalThis as any;

export function getAgents(): AgentModule[] {
  return (g.__agents as AgentModule[] | undefined) ?? [];
}

export function setAgents(agents: AgentModule[]): void {
  g.__agents = agents;
}
