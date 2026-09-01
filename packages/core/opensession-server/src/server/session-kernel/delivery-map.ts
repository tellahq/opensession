import type { DeliverySlot } from "./store";
import {
  sessionDelivery,
  sessionDeliveryEntriesCached,
  sessionDeliveryProjectionCached,
} from "./kernel";
import { immutableCopy } from "./immutable-copy";

/** Map-compatible projection backed by the actor's durable delivery aggregate. */
export class DeliveryOwnedMap<V> {
  readonly [Symbol.toStringTag] = "DeliveryOwnedMap";
  constructor(private readonly slot: DeliverySlot) {}

  get size(): number {
    return this.entriesArray().length;
  }

  async clear(): Promise<void> {
    await sessionDelivery({ op: "clear_slot", slot: this.slot });
  }

  async delete(sessionId: string): Promise<boolean> {
    return sessionDelivery({ op: "delete", sessionId, slot: this.slot });
  }

  get(sessionId: string): V | undefined {
    const state = sessionDeliveryProjectionCached(sessionId);
    const value =
      this.slot === "queued"
        ? state.queued
        : this.slot === "steered"
          ? state.steered
          : state.dispatch;
    if (this.slot !== "dispatch" && Array.isArray(value) && value.length === 0)
      return undefined;
    return value === undefined ? undefined : immutableCopy(value as V);
  }

  has(sessionId: string): boolean {
    return this.get(sessionId) !== undefined;
  }

  async set(sessionId: string, value: V): Promise<this> {
    await sessionDelivery({
      op: "set",
      sessionId,
      slot: this.slot,
      value: immutableCopy(value),
    });
    return this;
  }

  private entriesArray(): Array<[string, V]> {
    return sessionDeliveryEntriesCached(this.slot).map(([sessionId, value]) => [
      sessionId,
      immutableCopy(value as V),
    ]);
  }

  entries(): MapIterator<[string, V]> {
    return this.entriesArray()[Symbol.iterator]();
  }
  keys(): MapIterator<string> {
    return this.entriesArray()
      .map(([key]) => key)
      [Symbol.iterator]();
  }
  values(): MapIterator<V> {
    return this.entriesArray()
      .map(([, value]) => value)
      [Symbol.iterator]();
  }
  forEach(
    callbackfn: (value: V, key: string, map: DeliveryOwnedMap<V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entriesArray())
      callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }
}
