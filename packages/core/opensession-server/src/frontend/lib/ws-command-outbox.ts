import type { WSClientMessage } from "./types";

// Keep the shipped v1 key stable. The value migrates from one aggregate array
// to per-request records so tabs cannot overwrite each other's durable intent.
const KEY_PREFIX = "opensession-ws-command-outbox:v1";
const MAX_COMMAND_BYTES = 3 * 1024 * 1024;
const utf8Bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

type MutationMessage = WSClientMessage & { requestId: string };
type AckMessage = Extract<WSClientMessage, { type: "command_ack" }>;
type StoredItem = { message: MutationMessage; createdAt: number };
type LegacyStored = { version: 1; items: StoredItem[] };
type StorageLike = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

function storage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function requestId(message: WSClientMessage): string | undefined {
  return "requestId" in message && typeof message.requestId === "string"
    ? message.requestId
    : undefined;
}

export function shouldRetireCommandResult(result: {
  status: "completed" | "failed";
  terminal?: boolean;
}): boolean {
  return result.status === "completed" || result.terminal === true;
}

/** Durable per-request intent and acknowledgement records. */
export class WsCommandOutbox {
  constructor(
    private readonly store: StorageLike | undefined = storage(),
    private readonly now = () => Date.now(),
    private readonly keyPrefix = `${KEY_PREFIX}:local:anonymous`,
  ) {
    this.migrateAggregate();
  }

  put(message: WSClientMessage): boolean {
    const id = requestId(message);
    if (!this.store || !id || message.type === "command_ack") return false;
    const key = this.itemKey(id);
    const existing = this.allItems().find(
      (item) => item.message.requestId === id,
    );
    if (existing) {
      if (JSON.stringify(existing.message) !== JSON.stringify(message))
        throw new Error(`WebSocket command id ${id} was reused`);
      return true;
    }
    const item = {
      message: message as MutationMessage,
      createdAt: this.now(),
    };
    const currentBytes = this.allItems().reduce(
      (sum, stored) => sum + utf8Bytes(stored),
      0,
    );
    if (currentBytes + utf8Bytes(item) > MAX_COMMAND_BYTES) return false;
    return this.write(key, item);
  }

  /** Retire the mutation only after its durable acknowledgement is recorded. */
  ack(id: string, sessionId: string): boolean {
    if (
      !this.store ||
      !this.allItems().some((item) => item.message.requestId === id)
    )
      return false;
    const ack: AckMessage = { type: "command_ack", sessionId, requestId: id };
    if (!this.write(this.ackKey(id), ack)) return false;
    try {
      this.store.removeItem(this.itemKey(id));
    } catch {
      // pending() suppresses an item that already has an ack record, so a
      // failed cleanup cannot replay the mutation.
    }
    return !!this.read<AckMessage>(this.ackKey(id));
  }

  /** Old servers have no receipt/ack protocol, so one successful send retires. */
  retireLegacy(id: string): boolean {
    if (!this.store) return false;
    const existed = this.allItems().some(
      (item) => item.message.requestId === id,
    );
    if (!existed) return false;
    if (
      this.isLegacyId(id) &&
      !this.write(this.retiredKey(id), { requestId: id })
    )
      return false;
    try {
      this.store.removeItem(this.itemKey(id));
    } catch {}
    return !this.allItems().some((item) => item.message.requestId === id);
  }

  confirmAck(id: string): boolean {
    if (!this.store || !this.read<AckMessage>(this.ackKey(id))) return false;
    if (
      this.isLegacyId(id) &&
      !this.write(this.retiredKey(id), { requestId: id })
    )
      return false;
    try {
      this.store.removeItem(this.ackKey(id));
      return !this.read<AckMessage>(this.ackKey(id));
    } catch {
      return false;
    }
  }

  pending(): MutationMessage[] {
    const acked = new Set(this.pendingAcks().map((ack) => ack.requestId));
    return this.allItems()
      .filter((item) => !acked.has(item.message.requestId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((item) => item.message);
  }

  pendingAcks(): AckMessage[] {
    return this.records<AckMessage>(":ack:");
  }

  stats(): { pending: number; acknowledgements: number; bytes: number } {
    const items = this.allItems();
    return {
      pending: items.length,
      acknowledgements: this.pendingAcks().length,
      bytes: items.reduce((sum, item) => sum + utf8Bytes(item), 0),
    };
  }

  /** Explicit recovery escape hatch. The tombstone prevents a stale tab write. */
  forget(id: string): boolean {
    if (!this.store || !this.write(this.retiredKey(id), { requestId: id }))
      return false;
    try {
      this.store.removeItem(this.itemKey(id));
      this.store.removeItem(this.ackKey(id));
    } catch {
      return false;
    }
    return !this.allItems().some((item) => item.message.requestId === id);
  }

  /** Move the previously shipped user key into this verified scope. */
  adoptLegacyPrefix(oldPrefix: string): void {
    if (!this.store || oldPrefix === this.keyPrefix) return;
    const marker = `${oldPrefix}:migration-scope`;
    const bound = this.store.getItem(marker);
    if (bound && bound !== this.keyPrefix) return;
    const copies: Array<[string, string, string]> = [];
    for (let index = 0; index < this.store.length; index++) {
      const key = this.store.key(index);
      if (
        !key ||
        key === marker ||
        (key !== oldPrefix && !key.startsWith(`${oldPrefix}:`))
      )
        continue;
      const suffix = key.slice(oldPrefix.length);
      const value = this.store.getItem(key);
      if (value != null)
        copies.push([`${this.keyPrefix}${suffix}`, value, key]);
    }
    try {
      this.store.setItem(marker, this.keyPrefix);
      if (this.store.getItem(marker) !== this.keyPrefix) return;
      for (const [key, value] of copies) {
        if (this.store.getItem(key) == null) this.store.setItem(key, value);
        if (this.store.getItem(key) !== value) return;
      }
      this.migrateAggregate();
      for (const [, , source] of copies) this.store.removeItem(source);
    } catch {}
  }

  private allItems(): StoredItem[] {
    const retired = new Set(
      this.records<{ requestId: string }>(":retired:").map(
        (item) => item.requestId,
      ),
    );
    const byId = new Map<string, StoredItem>();
    for (const item of this.legacy()?.items ?? []) {
      const id = requestId(item.message);
      if (id && !retired.has(id) && Number.isFinite(item.createdAt))
        byId.set(id, item);
    }
    for (const item of this.records<StoredItem>(":item:")) {
      const id = requestId(item.message);
      if (id && !retired.has(id) && Number.isFinite(item.createdAt))
        byId.set(id, item);
    }
    return [...byId.values()];
  }

  private legacy(): LegacyStored | undefined {
    const value = this.read<LegacyStored>(this.keyPrefix);
    return value?.version === 1 && Array.isArray(value.items)
      ? value
      : undefined;
  }

  private migrateAggregate(): void {
    if (!this.store) return;
    const raw = this.store.getItem(this.keyPrefix);
    if (!raw) return;
    try {
      const legacy = JSON.parse(raw) as LegacyStored;
      if (legacy.version !== 1 || !Array.isArray(legacy.items)) return;
      const retired = new Set(
        this.records<{ requestId: string }>(":retired:").map(
          (item) => item.requestId,
        ),
      );
      for (const item of legacy.items) {
        const id = requestId(item?.message);
        if (!id || retired.has(id) || !Number.isFinite(item?.createdAt))
          continue;
        if (!this.write(this.legacyKey(id), { requestId: id })) return;
        if (!this.read<StoredItem>(this.itemKey(id)))
          if (!this.write(this.itemKey(id), item)) return;
      }
      // A marker prevents rescanning while keeping the stable base key.
      this.store.setItem(this.keyPrefix, JSON.stringify({ version: 2 }));
      // Retired ids remain as tiny permanent suppressors. A stale tab may still
      // finish a migration write after this marker is visible.
    } catch {
      // Leave the v1 value untouched so a later reload can retry migration.
    }
  }

  private records<T>(kind: ":item:" | ":ack:" | ":retired:"): T[] {
    if (!this.store) return [];
    const prefix = `${this.keyPrefix}${kind}`;
    const records: T[] = [];
    for (let index = 0; index < this.store.length; index++) {
      const key = this.store.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value = this.read<T>(key);
      if (value) records.push(value);
    }
    return records;
  }

  private itemKey(id: string): string {
    return `${this.keyPrefix}:item:${id}`;
  }

  private ackKey(id: string): string {
    return `${this.keyPrefix}:ack:${id}`;
  }

  private isLegacyId(id: string): boolean {
    if (this.read<{ requestId: string }>(this.legacyKey(id))) return true;
    return (this.legacy()?.items ?? []).some(
      (item) => item.message.requestId === id,
    );
  }

  private legacyKey(id: string): string {
    return `${this.keyPrefix}:legacy:${id}`;
  }

  private retiredKey(id: string): string {
    return `${this.keyPrefix}:retired:${id}`;
  }

  private read<T>(key: string): T | undefined {
    try {
      const raw = this.store?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: unknown): boolean {
    if (!this.store) return false;
    try {
      this.store.setItem(key, JSON.stringify(value));
      return this.store.getItem(key) === JSON.stringify(value);
    } catch {
      return false;
    }
  }
}

const scopedOutboxes = new Map<string, WsCommandOutbox>();

export function normalizeCommandScope(scope: string): string {
  const normalized = scope.trim().toLowerCase();
  return normalized ? encodeURIComponent(normalized) : "local%3Aanonymous";
}

export function localCommandScope(): string {
  try {
    return `local:${globalThis.localStorage?.getItem("opensession-user") || "anonymous"}`;
  } catch {
    return "local:anonymous";
  }
}

export function wsCommandOutboxForScope(scope: string): WsCommandOutbox {
  const normalized = normalizeCommandScope(scope);
  let outbox = scopedOutboxes.get(normalized);
  if (!outbox) {
    outbox = new WsCommandOutbox(
      storage(),
      () => Date.now(),
      `${KEY_PREFIX}:${normalized}`,
    );
    const priorScoped = scope
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:._-]/g, "_");
    outbox.adoptLegacyPrefix(`${KEY_PREFIX}:${priorScoped}`);
    try {
      const legacyUser =
        globalThis.localStorage?.getItem("opensession-user") || "anonymous";
      outbox.adoptLegacyPrefix(`${KEY_PREFIX}:${legacyUser.toLowerCase()}`);
    } catch {}
    scopedOutboxes.set(normalized, outbox);
  }
  return outbox;
}
