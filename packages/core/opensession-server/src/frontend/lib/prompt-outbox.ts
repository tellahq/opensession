import { z } from "zod";
import { deliverSessionPrompt, type PromptDelivery } from "./api/sessions";
import { BASE } from "./api/request";
import { randomUUID } from "./random-uuid";

export type PromptOutboxState = "pending" | "sending" | "failed";

export interface PromptOutboxItem {
  /** Stable id reused for every retry and recognized by the server receipt store. */
  clientId: string;
  sessionId: string;
  content: string;
  images?: string[];
  /** Staged `{ name, path }` refs or legacy inline composer file data. */
  files?: unknown[];
  /** Large pastes, sent beside `content`; the server places them after it. */
  pastedTexts?: string[];
  effort?: string;
  fastMode?: boolean;
  busyMode?: "queue" | "steer";
  contextSessions?: string[];
  user?: string;
  /** UI-only causal anchor for the optimistic transcript bubble. Never sent to
   *  the prompt endpoint; persisted so a reload keeps the same placement. */
  transcriptAfterEntryId?: string | null;
  transcriptAfterSeq?: number;
  state: PromptOutboxState;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  error?: string;
}

export type PromptOutboxInput = Omit<
  PromptOutboxItem,
  "clientId" | "state" | "attempts" | "createdAt" | "nextAttemptAt" | "error"
>;

type StoredOutbox = { version: 1; items: PromptOutboxItem[] };

const promptOutboxItemSchema: z.ZodType<PromptOutboxItem> = z.looseObject({
  clientId: z.string(),
  sessionId: z.string(),
  content: z.string(),
  images: z.array(z.string()).optional(),
  files: z.array(z.unknown()).optional(),
  effort: z.string().optional(),
  fastMode: z.boolean().optional(),
  busyMode: z.enum(["queue", "steer"]).optional(),
  contextSessions: z.array(z.string()).optional(),
  user: z.string().optional(),
  transcriptAfterEntryId: z.string().nullable().optional(),
  transcriptAfterSeq: z.number().optional(),
  state: z.enum(["pending", "sending", "failed"]),
  attempts: z.number(),
  createdAt: z.number(),
  nextAttemptAt: z.union([
    z.number(),
    z.null().transform(() => Number.POSITIVE_INFINITY),
  ]),
  error: z.string().optional(),
});

const storedOutboxSchema = z.object({
  version: z.literal(1),
  items: z.array(z.unknown()),
});

const quotaErrorSchema = z.object({
  name: z.string().optional(),
  code: z.number().optional(),
});

const statusErrorSchema = z.object({ status: z.coerce.number() });

type DeliveryObserver = (
  item: PromptOutboxItem,
  result: PromptDelivery,
) => void;
type Listener = () => void;
interface OutboxLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export const PROMPT_OUTBOX_MAX_ITEMS = 100;
export const PROMPT_OUTBOX_RETRY_BASE_MS = 1_000;
export const PROMPT_OUTBOX_RETRY_MAX_MS = 30_000;

function serverScope(): string {
  return typeof location === "undefined"
    ? "server"
    : `${location.origin}${BASE}`;
}

function storageKey(scope: string): string {
  return `opensession-prompt-outbox:v1:${scope}`;
}

function copy(item: PromptOutboxItem): PromptOutboxItem {
  return {
    ...item,
    images: item.images?.slice(),
    files: item.files?.slice(),
    contextSessions: item.contextSessions?.slice(),
  };
}

/**
 * A small localStorage-backed REST outbox. It is intentionally UI-agnostic: a
 * composer persists first, then subscribes to state and delivery observations.
 */
export class PromptOutbox {
  private items: PromptOutboxItem[] = [];
  private listeners = new Set<Listener>();
  private observers = new Set<DeliveryObserver>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly key: string;
  private readonly onStorage = (event: StorageEvent) => {
    if (event.key === this.key) {
      this.reload();
      void this.flush();
    }
  };
  private readonly onOnline = () => {
    const now = this.now();
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.state !== "pending" || item.nextAttemptAt <= now) return item;
      changed = true;
      return { ...item, nextAttemptAt: now };
    });
    if (changed) this.persist();
    void this.flush();
  };

  constructor(
    private readonly opts: {
      storage?: Pick<Storage, "getItem" | "setItem">;
      scope?: string;
      now?: () => number;
      locks?: OutboxLockManager;
      deliver?: (
        sessionId: string,
        body: Omit<
          PromptOutboxItem,
          | "sessionId"
          | "state"
          | "attempts"
          | "createdAt"
          | "nextAttemptAt"
          | "error"
        >,
      ) => Promise<PromptDelivery>;
    } = {},
  ) {
    this.key = storageKey(opts.scope ?? serverScope());
    this.reload(false);
    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.onStorage);
      window.addEventListener("online", this.onOnline);
      queueMicrotask(() => void this.flush());
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", this.onStorage);
      window.removeEventListener("online", this.onOnline);
    }
  }

  list(sessionId?: string): PromptOutboxItem[] {
    return this.items
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .map(copy);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observeDelivery(observer: DeliveryObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /** Persists synchronously before returning. Throws rather than evicting data. */
  enqueue(input: PromptOutboxInput): PromptOutboxItem {
    this.reload(false);
    if (this.items.length >= PROMPT_OUTBOX_MAX_ITEMS)
      throw new Error(
        "Prompt outbox is full. Retry or discard a failed prompt before sending another.",
      );
    const now = this.now();
    const item: PromptOutboxItem = {
      ...input,
      clientId: randomUUID(),
      state: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
    };
    this.items.push(item);
    try {
      this.persist();
    } catch (error) {
      this.items.pop();
      throw error;
    }
    this.emit();
    void this.flush();
    return copy(item);
  }

  retry(clientId: string): void {
    this.mutate(clientId, (item) => ({
      ...item,
      state: "pending",
      attempts: 0,
      error: undefined,
      nextAttemptAt: this.now(),
    }));
    void this.flush();
  }

  discard(clientId: string): void {
    this.reload(false);
    const next = this.items.filter((item) => item.clientId !== clientId);
    if (next.length === this.items.length) return;
    this.items = next;
    this.persist();
    this.emit();
  }

  /** Replaces editable payload fields while preserving the idempotency key. */
  edit(clientId: string, patch: Partial<PromptOutboxInput>): void {
    this.mutate(clientId, (item) => ({
      ...item,
      ...patch,
      state: "pending",
      attempts: 0,
      error: undefined,
      nextAttemptAt: this.now(),
    }));
    void this.flush();
  }

  async flush(): Promise<void> {
    this.reload(false);
    const now = this.now();
    const sendingSessions = new Set(
      this.items
        .filter((item) => item.state === "sending")
        .map((item) => item.sessionId),
    );
    const sessions = [
      ...new Set(
        this.items
          .filter(
            (item) =>
              item.state === "pending" &&
              item.nextAttemptAt <= now &&
              !sendingSessions.has(item.sessionId),
          )
          .map((item) => item.sessionId),
      ),
    ];
    await Promise.all(
      sessions.map((sessionId) => this.flushSession(sessionId)),
    );
    this.schedule();
  }

  private async flushSession(sessionId: string): Promise<void> {
    const locks =
      this.opts.locks ??
      (typeof navigator !== "undefined" ? navigator.locks : undefined);
    if (!locks) {
      await this.flushSessionOwned(sessionId);
      return;
    }
    // localStorage shares the durable queue across tabs, but its in-memory
    // `sending` guard does not. Without an origin-wide lock every open tab
    // submits the same client id, and the actor correctly rejects all but the
    // winner as "already in progress". Those retry writes are what made one
    // optimistic message flash through "Waiting to send". Re-read storage only
    // after ownership transfers: the prior tab usually removed the item while
    // this caller waited, so there is then nothing left to deliver.
    await locks.request(`${this.key}:deliver:${sessionId}`, async () => {
      this.reload(false);
      await this.flushSessionOwned(sessionId);
    });
  }

  private async flushSessionOwned(sessionId: string): Promise<void> {
    while (true) {
      const item = this.items.find(
        (candidate) =>
          candidate.sessionId === sessionId &&
          candidate.state === "pending" &&
          candidate.nextAttemptAt <= this.now(),
      );
      if (!item) return;
      try {
        this.replace(item.clientId, { ...item, state: "sending" });
      } catch {
        // Storage is full. Leave the item pending rather than rejecting the
        // flush; a later attempt runs once something has been discarded.
        return;
      }
      try {
        const result = await (
          this.opts.deliver ?? ((id, body) => deliverSessionPrompt(id, body))
        )(sessionId, this.body(item));
        this.items = this.items.filter(
          (candidate) => candidate.clientId !== item.clientId,
        );
        this.persist();
        this.emit();
        for (const observer of this.observers) observer(copy(item), result);
      } catch (error) {
        const attempts = item.attempts + 1;
        const message =
          error instanceof Error ? error.message : "Prompt delivery failed";
        const parsedStatus = statusErrorSchema.safeParse(error);
        const failed =
          parsedStatus.success && !isRetryableStatus(parsedStatus.data.status);
        try {
          this.replace(item.clientId, {
            ...item,
            attempts,
            state: failed ? "failed" : "pending",
            error: message,
            nextAttemptAt: failed
              ? Number.POSITIVE_INFINITY
              : this.now() + retryDelay(attempts),
          });
        } catch {
          // A full store can't record the failure either. `replace` rolled the
          // item back to pending, which is the safe reading of an unknown
          // outcome: the stable client id makes a replay idempotent.
        }
        return; // Preserve ordering within this session after a failed head item.
      }
    }
  }

  private body(item: PromptOutboxItem) {
    const {
      sessionId: _sessionId,
      state: _state,
      attempts: _attempts,
      createdAt: _createdAt,
      nextAttemptAt: _nextAttemptAt,
      error: _error,
      transcriptAfterEntryId: _transcriptAfterEntryId,
      transcriptAfterSeq: _transcriptAfterSeq,
      ...body
    } = item;
    return body;
  }

  private mutate(
    clientId: string,
    change: (item: PromptOutboxItem) => PromptOutboxItem,
  ): void {
    this.reload(false);
    const item = this.items.find(
      (candidate) => candidate.clientId === clientId,
    );
    if (!item) throw new Error("Prompt no longer exists in the outbox.");
    this.replace(clientId, change(item));
  }

  private replace(clientId: string, next: PromptOutboxItem): void {
    const previous = this.items;
    this.items = this.items.map((item) =>
      item.clientId === clientId ? next : item,
    );
    try {
      this.persist();
    } catch (error) {
      // A failed write must not leave memory ahead of storage, or a reload
      // silently rewinds a state change the UI already showed. Same discipline
      // as enqueue's pop-on-throw.
      this.items = previous;
      throw error;
    }
    this.emit();
  }

  private reload(notify = true): void {
    const raw =
      this.opts.storage?.getItem(this.key) ??
      (typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(this.key));
    if (!raw) return;
    try {
      const result = storedOutboxSchema.safeParse(JSON.parse(raw));
      if (!result.success) return;
      const parsedItems = result.data.items.flatMap((value) => {
        const item = promptOutboxItemSchema.safeParse(value);
        return item.success ? [item.data] : [];
      });
      const sending = new Set(
        this.items
          .filter((item) => item.state === "sending")
          .map((item) => item.clientId),
      );
      let resumed = false;
      const now = this.now();
      this.items = parsedItems
        .map((item) => {
          // The item state is the in-tab send lock. Keep it across reloads
          // triggered by another enqueue or a cross-tab storage event.
          if (sending.has(item.clientId))
            return { ...item, state: "sending" as const };
          // A tab can close after recording `sending` but before receiving the
          // response. A different tab has no local sending owner, so it resumes
          // the row as pending; the stable client id makes a replay safe.
          if (item.state !== "sending") return item;
          resumed = true;
          return { ...item, state: "pending" as const, nextAttemptAt: now };
        })
        .sort((a, b) => a.createdAt - b.createdAt);
      if (resumed) this.persist();
      if (notify) this.emit();
    } catch {
      // Keep the malformed value untouched; a later write must never silently
      // erase recoverable durable prompts.
    }
  }

  private persist(): void {
    const storage =
      this.opts.storage ??
      (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!storage) throw new Error("Prompt outbox storage is unavailable.");
    try {
      storage.setItem(
        this.key,
        JSON.stringify({
          version: 1,
          items: this.items,
        } satisfies StoredOutbox),
      );
    } catch (error) {
      // The browser's own text here is a DOMException naming setItem and a
      // storage key, which reads like an attachment limit and names nothing
      // anyone can act on. Say what happened and what frees the space.
      const quotaError = quotaErrorSchema.safeParse(error);
      if (
        !quotaError.success ||
        (quotaError.data.name !== "QuotaExceededError" &&
          quotaError.data.name !== "NS_ERROR_DOM_QUOTA_REACHED" &&
          quotaError.data.code !== 22 &&
          quotaError.data.code !== 1014)
      )
        throw error;
      throw new Error(
        "No room left to save this message for delivery. Discard a failed message to make space.",
      );
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const next = this.items
      .filter((item) => item.state === "pending")
      .reduce(
        (earliest, item) => Math.min(earliest, item.nextAttemptAt),
        Number.POSITIVE_INFINITY,
      );
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => void this.flush(),
      Math.max(0, next - this.now()),
    );
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

/** One process-wide queue. Multiple mounted session panes subscribe to their
 * own slice, while a single sender preserves ordering and avoids redundant
 * retries inside one tab. Stable client ids still make cross-tab races safe. */
export const promptOutbox = new PromptOutbox();

function retryDelay(attempt: number): number {
  return Math.min(
    PROMPT_OUTBOX_RETRY_MAX_MS,
    PROMPT_OUTBOX_RETRY_BASE_MS * 2 ** (attempt - 1),
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
