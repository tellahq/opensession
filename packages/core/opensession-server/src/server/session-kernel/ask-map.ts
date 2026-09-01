import { sessionAsk } from "./kernel";
import { immutableCopy } from "./immutable-copy";

const globalResolvers = globalThis as typeof globalThis & {
  __opensessionAskRuntimeFields?: Map<string, Record<string, unknown>>;
};
const runtimeFields = (globalResolvers.__opensessionAskRuntimeFields ??=
  new Map());
const durableProjection = new Map<string, unknown>();

function splitValue(value: unknown): {
  durable: unknown;
  ephemeral: Record<string, unknown>;
} {
  if (!value || typeof value !== "object")
    return { durable: value, ephemeral: {} };
  const durable: Record<string, unknown> = {};
  const ephemeral: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "function") ephemeral[key] = item;
    else durable[key] = immutableCopy(item);
  }
  return { durable, ephemeral };
}

/** Durable ask facts in the actor, merged with gateway-only resolver closures. */
export class AskOwnedMap<V> {
  readonly [Symbol.toStringTag] = "AskOwnedMap";
  get size(): number {
    return durableProjection.size;
  }
  async clear(): Promise<void> {
    await sessionAsk({ op: "clear" });
    durableProjection.clear();
    runtimeFields.clear();
  }
  async delete(sessionId: string): Promise<boolean> {
    const deleted = await sessionAsk({ op: "delete", sessionId });
    durableProjection.delete(sessionId);
    runtimeFields.delete(sessionId);
    return deleted;
  }
  get(sessionId: string): V | undefined {
    return this.mergeRuntimeFields(sessionId, durableProjection.get(sessionId));
  }
  async getAsync(sessionId: string): Promise<V | undefined> {
    const durable = await sessionAsk({ op: "snapshot", sessionId });
    if (durable === undefined) durableProjection.delete(sessionId);
    else durableProjection.set(sessionId, durable);
    return this.mergeRuntimeFields(sessionId, durable);
  }
  private mergeRuntimeFields(
    sessionId: string,
    durable: unknown,
  ): V | undefined {
    if (durable === undefined) return undefined;
    return immutableCopy({
      ...(durable as Record<string, unknown>),
      ...(runtimeFields.get(sessionId) ?? {}),
    } as V);
  }
  has(sessionId: string): boolean {
    return durableProjection.has(sessionId);
  }
  async set(sessionId: string, value: V): Promise<this> {
    const { durable, ephemeral } = splitValue(value);
    await sessionAsk({ op: "set", sessionId, value: durable });
    durableProjection.set(sessionId, durable);
    if (Object.keys(ephemeral).length) runtimeFields.set(sessionId, ephemeral);
    else runtimeFields.delete(sessionId);
    return this;
  }
  private list(): Array<[string, V]> {
    return [...durableProjection].map(([sessionId]) => [
      sessionId,
      this.get(sessionId)!,
    ]);
  }
  entries(): MapIterator<[string, V]> {
    return this.list()[Symbol.iterator]();
  }
  keys(): MapIterator<string> {
    return this.list()
      .map(([key]) => key)
      [Symbol.iterator]();
  }
  values(): MapIterator<V> {
    return this.list()
      .map(([, value]) => value)
      [Symbol.iterator]();
  }
  forEach(
    callbackfn: (value: V, key: string, map: AskOwnedMap<V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.list())
      callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }
}

/** Process-only executor handles. They are not actor state. */
export class EphemeralSessionMap<V> extends Map<string, V> {}
export class EphemeralSessionSet extends Set<string> {}
