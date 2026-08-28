import type { AgentTurnFence } from "@tellahq/opensession-protocol";

export interface AgentHostRegistration<T> {
  fence: AgentTurnFence;
  value: T;
}

function lineageKey(fence: AgentTurnFence): string {
  return JSON.stringify([fence.sessionId, fence.runId, fence.turnId]);
}

function ownershipKey(fence: AgentTurnFence): string {
  return JSON.stringify([
    fence.sessionId,
    fence.runId,
    fence.turnId,
    fence.generation,
  ]);
}

/** Process-local ownership index. It deliberately has no expiry or timers. */
export class AgentHostRegistry<T> {
  private readonly owners = new Map<string, AgentHostRegistration<T>>();
  private readonly lineages = new Map<string, AgentHostRegistration<T>>();

  register(fence: AgentTurnFence, value: T): AgentHostRegistration<T> {
    const lineage = lineageKey(fence);
    const current = this.lineages.get(lineage);
    if (current) {
      const kind =
        current.fence.generation === fence.generation
          ? "duplicate"
          : current.fence.generation > fence.generation
            ? "stale"
            : "conflicting";
      throw new Error(`${kind} Agent Host ownership for ${lineage}`);
    }
    const registration = { fence: { ...fence }, value };
    this.owners.set(ownershipKey(fence), registration);
    this.lineages.set(lineage, registration);
    return registration;
  }

  unregister(fence: AgentTurnFence, value?: T): boolean {
    const key = ownershipKey(fence);
    const current = this.owners.get(key);
    if (!current || (value !== undefined && current.value !== value))
      return false;
    this.owners.delete(key);
    this.lineages.delete(lineageKey(fence));
    return true;
  }

  find(fence: AgentTurnFence): T | undefined {
    return this.owners.get(ownershipKey(fence))?.value;
  }
}
