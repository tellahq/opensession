import { z } from "zod";
import type { WSClientMessage } from "./types";

// Keep the shipped v1 key stable. The value migrates from one aggregate array
// to per-request records so tabs cannot overwrite each other's durable intent.
const KEY_PREFIX = "opensession-ws-command-outbox:v1";
export const MAX_COMMAND_BYTES = 3 * 1024 * 1024;
// A pending command is replayed on every reconnect until the server retires
// it. One that has waited this long belongs to a session nobody is coming
// back to, and keeping it only blocks new sends once the byte budget is spent.
export const PENDING_TTL_MS = 7 * 24 * 60 * 60_000;
// Tombstones only guard the seconds-long migration race between two tabs.
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60_000;
const jsonValueSchema = z.json();
const sessionMutationFields = {
  sessionId: z.string(),
  requestId: z.string(),
};
const mutationMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("load_transcript_range"),
      ...sessionMutationFields,
      firstSeq: z.number(),
      lastSeq: z.number(),
      afterSeq: z.number().optional(),
      epoch: z.number(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("answer_question"),
      ...sessionMutationFields,
      questionId: z.string(),
      answers: z.record(z.string(), z.string()).nullable(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("prompt"),
      ...sessionMutationFields,
      content: z.string(),
      user: z.string().optional(),
      images: z.array(z.string()).optional(),
      files: jsonValueSchema.optional(),
      busyMode: z.enum(["queue", "steer"]).optional(),
      effort: z.string().optional(),
      fastMode: z.boolean().optional(),
      contextSessions: z.array(z.string()).optional(),
      contextChats: z.array(z.string()).optional(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("interrupt_prompt"),
      ...sessionMutationFields,
      content: z.string(),
      user: z.string().optional(),
      images: z.array(z.string()).optional(),
      files: jsonValueSchema.optional(),
      effort: z.string().optional(),
      fastMode: z.boolean().optional(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("delete_queued_prompt"),
      ...sessionMutationFields,
      queueId: z.string().optional(),
      queueIndex: z.number().optional(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("take_queued_prompt"),
      ...sessionMutationFields,
      queueId: z.string(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("take_steered_prompt"),
      ...sessionMutationFields,
      queueId: z.string(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("update_queued_prompt"),
      ...sessionMutationFields,
      queueId: z.string().optional(),
      queueIndex: z.number().optional(),
      content: z.string(),
      images: z.array(z.string()).optional(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("steer_queued_prompt"),
      ...sessionMutationFields,
      queueId: z.string().optional(),
      queueIndex: z.number().optional(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("interrupt_queued_prompt"),
      ...sessionMutationFields,
      queueId: z.string().optional(),
      queueIndex: z.number().optional(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("reorder_queued_prompt"),
      ...sessionMutationFields,
      order: z.array(z.string()),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("cancel"),
      requestId: z.string(),
      sessionId: z.string().optional(),
    })
    .catchall(jsonValueSchema),
  z
    .object({
      type: z.literal("create_session"),
      requestId: z.string(),
      clientSessionId: z.string().optional(),
      branch: z.string(),
      prompt: z.string(),
      titlePrompt: z.string().optional(),
      user: z.string(),
      cloud: z.boolean().optional(),
      mode: z.enum(["ask", "code", "scratch"]).optional(),
      repo: z.string().optional(),
      workspaceId: z.string().optional(),
      createWorkspace: z.object({ name: z.string().optional() }).optional(),
      worktreeMode: z.enum(["share", "stack", "ask"]).optional(),
      checkoutMode: z.enum(["default", "checkout", "worktree"]).optional(),
      model: z.string().optional(),
      mcpServers: z.array(z.string()).optional(),
      executor: z.enum(["box", "daytona", "modal"]).optional(),
      sandbox: z.union([z.boolean(), z.string()]).optional(),
      images: z.array(z.string()).optional(),
      files: jsonValueSchema.optional(),
      effort: z
        .enum(["none", "low", "medium", "high", "xhigh", "max"])
        .optional(),
      fastMode: z.boolean().optional(),
      accountId: z.string().optional(),
      forkFrom: z
        .object({ sourceId: z.string(), messageId: z.string().optional() })
        .optional(),
      fromPr: z.boolean().optional(),
      plainThreadId: z.string().optional(),
    })
    .catchall(jsonValueSchema),
]);
const ackMessageSchema = z.object({
  type: z.literal("command_ack"),
  sessionId: z.string(),
  requestId: z.string(),
});
const storedItemSchema = z.object({
  message: mutationMessageSchema,
  createdAt: z.number(),
});
const legacyStoredSchema = z.object({
  version: z.literal(1),
  items: z.array(storedItemSchema),
});
const retiredRecordSchema = z.object({
  requestId: z.string(),
  at: z.number().optional(),
});

type JsonValue = z.infer<typeof jsonValueSchema>;
type MutationMessage = z.infer<typeof mutationMessageSchema>;
type AckMessage = z.infer<typeof ackMessageSchema>;
type StoredItem = z.infer<typeof storedItemSchema>;
type LegacyStored = z.infer<typeof legacyStoredSchema>;
type Tombstone = z.infer<typeof retiredRecordSchema>;

/** Why a command could not be saved. `full` is our own byte budget; `blocked`
 * is the browser refusing the write (origin quota, private mode, corruption). */
export type PutFailure = "unavailable" | "full" | "blocked";
export type PutResult = { ok: true } | { ok: false; reason: PutFailure };

export function describePutFailure(reason: PutFailure): string {
  switch (reason) {
    case "unavailable":
      return "This browser has no local storage, so the command cannot be saved for reconnect.";
    case "full":
      return "Pending sends are using all reserved storage. Forget one under Settings, Preferences.";
    case "blocked":
      return "Local storage is full. Forget pending sends under Settings, Preferences, or clear site data.";
  }
}

const utf8Bytes = (value: StoredItem) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
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
  return "requestId" in message ? message.requestId : undefined;
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
    this.prune();
  }

  put(message: WSClientMessage): boolean {
    return this.tryPut(message).ok;
  }

  tryPut(message: WSClientMessage): PutResult {
    const id = requestId(message);
    if (!this.store) return { ok: false, reason: "unavailable" };
    if (!id || message.type === "command_ack")
      return { ok: false, reason: "blocked" };
    const key = this.itemKey(id);
    const existing = this.allItems().find(
      (item) => item.message.requestId === id,
    );
    if (existing) {
      if (JSON.stringify(existing.message) !== JSON.stringify(message))
        throw new Error(`WebSocket command id ${id} was reused`);
      return { ok: true };
    }
    const storedMessage = mutationMessageSchema.parse(
      JSON.parse(JSON.stringify(message)),
    );
    const item = {
      message: storedMessage,
      createdAt: this.now(),
    };
    const currentBytes = this.allItems().reduce(
      (sum, stored) => sum + utf8Bytes(stored),
      0,
    );
    if (currentBytes + utf8Bytes(item) > MAX_COMMAND_BYTES)
      return { ok: false, reason: "full" };
    return this.write(key, item)
      ? { ok: true }
      : { ok: false, reason: "blocked" };
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
    return !!this.read(this.ackKey(id), ackMessageSchema);
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
      !this.write(this.retiredKey(id), this.tombstone(id))
    )
      return false;
    try {
      this.store.removeItem(this.itemKey(id));
    } catch {}
    return !this.allItems().some((item) => item.message.requestId === id);
  }

  confirmAck(id: string): boolean {
    if (!this.store || !this.read(this.ackKey(id), ackMessageSchema))
      return false;
    if (
      this.isLegacyId(id) &&
      !this.write(this.retiredKey(id), this.tombstone(id))
    )
      return false;
    try {
      this.store.removeItem(this.ackKey(id));
      return !this.read(this.ackKey(id), ackMessageSchema);
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
    return this.records(":ack:", ackMessageSchema);
  }

  stats() {
    const items = this.allItems();
    return {
      pending: items.length,
      acknowledgements: this.pendingAcks().length,
      bytes: items.reduce((sum, item) => sum + utf8Bytes(item), 0),
    };
  }

  /** Explicit recovery escape hatch. The tombstone prevents a stale tab write. */
  forget(id: string): boolean {
    if (!this.store || !this.write(this.retiredKey(id), this.tombstone(id)))
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
      this.records(":retired:", retiredRecordSchema).map(
        (item) => item.requestId,
      ),
    );
    const byId = new Map<string, StoredItem>();
    const oldest = this.now() - PENDING_TTL_MS;
    for (const item of [
      ...(this.legacy()?.items ?? []),
      ...this.records(":item:", storedItemSchema),
    ]) {
      const id = requestId(item.message);
      if (
        id &&
        !retired.has(id) &&
        Number.isFinite(item.createdAt) &&
        item.createdAt >= oldest
      )
        byId.set(id, item);
    }
    return [...byId.values()];
  }

  /** Drop expired pending items and tombstones. Best effort: a failed removal
   * is invisible because allItems() already filters by age. */
  private prune(): void {
    if (!this.store) return;
    const now = this.now();
    const stale: string[] = [];
    for (const key of this.keys(":item:")) {
      const item = this.read(key, storedItemSchema);
      if (!item || item.createdAt < now - PENDING_TTL_MS) stale.push(key);
    }
    for (const key of [...this.keys(":retired:"), ...this.keys(":legacy:")]) {
      const tombstone = this.read(key, retiredRecordSchema);
      if (!tombstone) continue;
      // Shipped before timestamps: start its clock now instead of guessing.
      if (tombstone.at === undefined)
        this.write(key, { ...tombstone, at: now });
      else if (tombstone.at < now - TOMBSTONE_TTL_MS) stale.push(key);
    }
    for (const key of stale) {
      try {
        this.store.removeItem(key);
      } catch {}
    }
  }

  private keys(kind: ":item:" | ":retired:" | ":legacy:"): string[] {
    if (!this.store) return [];
    const prefix = `${this.keyPrefix}${kind}`;
    const found: string[] = [];
    for (let index = 0; index < this.store.length; index++) {
      const key = this.store.key(index);
      if (key?.startsWith(prefix)) found.push(key);
    }
    return found;
  }

  private tombstone(id: string): Tombstone {
    return { requestId: id, at: this.now() };
  }

  private legacy(): LegacyStored | undefined {
    const value = this.read(this.keyPrefix, legacyStoredSchema);
    return value?.version === 1 && Array.isArray(value.items)
      ? value
      : undefined;
  }

  private migrateAggregate(): void {
    if (!this.store) return;
    const raw = this.store.getItem(this.keyPrefix);
    if (!raw) return;
    try {
      const result = legacyStoredSchema.safeParse(JSON.parse(raw));
      if (!result.success) return;
      const legacy = result.data;
      const retired = new Set(
        this.records(":retired:", retiredRecordSchema).map(
          (item) => item.requestId,
        ),
      );
      for (const item of legacy.items) {
        const id = requestId(item?.message);
        if (!id || retired.has(id) || !Number.isFinite(item?.createdAt))
          continue;
        if (!this.write(this.legacyKey(id), this.tombstone(id))) return;
        if (!this.read(this.itemKey(id), storedItemSchema))
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

  private records<T>(
    kind: ":item:" | ":ack:" | ":retired:",
    schema: z.ZodType<T>,
  ): T[] {
    if (!this.store) return [];
    const prefix = `${this.keyPrefix}${kind}`;
    const records: T[] = [];
    for (let index = 0; index < this.store.length; index++) {
      const key = this.store.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value = this.read(key, schema);
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
    if (this.read(this.legacyKey(id), retiredRecordSchema)) return true;
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

  private read<T>(key: string, schema: z.ZodType<T>): T | undefined {
    try {
      const raw = this.store?.getItem(key);
      if (!raw) return undefined;
      const result = schema.safeParse(JSON.parse(raw));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: JsonValue): boolean {
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
