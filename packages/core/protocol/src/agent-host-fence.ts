import { decodeExecutorId } from "./executor";

export interface AgentTurnFence {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly generation: number;
}

const plainExact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  return ownKeys.length === keys.length && ownKeys.every((key) =>
    typeof key === "string" && keys.includes(key) && "value" in descriptors[key]! && descriptors[key]!.enumerable,
  );
};

export function isAgentTurnFence(value: unknown): value is AgentTurnFence {
  return plainExact(value, ["sessionId", "runId", "turnId", "generation"]) &&
    !!decodeExecutorId(value.sessionId) && !!decodeExecutorId(value.runId) &&
    !!decodeExecutorId(value.turnId) && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0;
}

export function decodeAgentTurnFence(value: unknown): Readonly<AgentTurnFence> | undefined {
  if (!isAgentTurnFence(value)) return undefined;
  return Object.freeze({ sessionId: value.sessionId, runId: value.runId, turnId: value.turnId, generation: value.generation });
}
