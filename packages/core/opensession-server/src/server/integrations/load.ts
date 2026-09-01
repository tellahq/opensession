/**
 * Turns the integration registry into loaded agent modules.
 *
 * This replaces the hand-written if-block chain that used to live in
 * `loadAgents()` in opensession.ts. Behaviour is deliberately identical:
 *
 *  - enable resolution is env-flag-wins-over-config, and only the literal
 *    string "true" enables via env (an unset flag falls through to config)
 *  - a module that throws on import is logged and skipped, never fatal
 *  - `always` modules load regardless of configuration and self-gate
 *  - registry order is boot order (see the note in registry.ts)
 *
 * Boot path: changes here need a real `systemctl restart opensession`.
 */

import type { AgentModule } from "../../agents/types";
import { configuredIntegration } from "../config";
import {
  INTEGRATIONS,
  type IntegrationContext,
  type IntegrationSpec,
} from "./registry";

/**
 * Env flag wins over config when set; otherwise config decides.
 *
 * Note the asymmetry, which is long-standing behaviour: `ENABLE_X=false` and
 * `ENABLE_X=0` are NOT equivalent — only the literal "true" enables, so any
 * other value disables. Onboarding writes explicit values to avoid relying on
 * this.
 */
export function isEnabled(spec: IntegrationSpec): boolean {
  const env = process.env[spec.enableFlag];
  return env == null
    ? configuredIntegration(spec.id).enabled === true
    : env === "true";
}

/** Which integrations would load right now, without importing anything. */
export function activeIntegrations(): IntegrationSpec[] {
  return INTEGRATIONS.filter((spec) => {
    if (spec.always) return true;
    if (!isEnabled(spec)) return false;
    return spec.requires ? spec.requires() : true;
  });
}

export async function loadIntegrations(
  ctx: IntegrationContext,
): Promise<AgentModule[]> {
  const agents: AgentModule[] = [];

  for (const spec of activeIntegrations()) {
    try {
      agents.push(await spec.load(ctx));
      console.log(`[agents] ${spec.label} loaded`);
    } catch (e) {
      console.error(`[agents] Failed to load ${spec.id} agent:`, e);
    }
  }

  return agents;
}
