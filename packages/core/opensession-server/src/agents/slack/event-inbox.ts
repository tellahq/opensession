/**
 * Durable intake for Slack events that can create or continue a session.
 *
 * Slack requires a fast HTTP acknowledgement, while mention/DM handling can
 * perform API lookups and model calls before it reaches the durable message
 * queue. Persisting the raw event first closes that loss window: a crash or
 * restart replays the event, and the existing message queue deduplicates the
 * eventual enqueue by Slack message timestamp.
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "../../server/shared/atomic-write";

export type SlackEventInboxKind = "direct_message" | "mention";

export interface SlackEventInboxRecord {
  id: string;
  kind: SlackEventInboxKind;
  event: any;
  receivedAt: string;
  attempts: number;
  lastError?: string;
}

export interface SlackEventInboxDependencies {
  handleDirectMessage: (event: any) => Promise<void>;
  handleMention: (event: any) => Promise<void>;
  isProcessed: (id: string) => boolean;
  markProcessed: (id: string) => void;
}

export interface SlackEventInboxOptions {
  retryDelayMs?: number;
}

export type SlackEventInboxEnqueueResult = "enqueued" | "pending" | "processed";

function eventId(event: any): string {
  const channel = typeof event?.channel === "string" ? event.channel : "";
  const ts = typeof event?.ts === "string" ? event.ts : "";
  if (!channel || !ts)
    throw new Error("Slack session event is missing channel or ts");
  return `${channel}-${ts}`;
}

function errorText(error: unknown): string {
  return String((error as Error)?.message || error).slice(0, 500);
}

export class SlackEventInbox {
  private readonly records = new Map<string, SlackEventInboxRecord>();
  private readonly inFlight = new Set<string>();
  private readonly retryDelayMs: number;
  private loaded = false;
  private started = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly storePath: string,
    private readonly deps: SlackEventInboxDependencies,
    options: SlackEventInboxOptions = {},
  ) {
    this.retryDelayMs = Math.max(1_000, options.retryDelayMs ?? 60_000);
  }

  /** Persist before returning so the webhook may safely acknowledge Slack. */
  enqueue(kind: SlackEventInboxKind, event: any): SlackEventInboxEnqueueResult {
    this.ensureLoaded();
    const id = eventId(event);
    if (this.deps.isProcessed(id)) return "processed";
    if (this.records.has(id)) {
      this.kick();
      return "pending";
    }

    const record: SlackEventInboxRecord = {
      id,
      kind,
      event,
      receivedAt: new Date().toISOString(),
      attempts: 0,
    };
    this.records.set(id, record);
    try {
      this.persist();
    } catch (error) {
      this.records.delete(id);
      throw error;
    }
    this.kick();
    return "enqueued";
  }

  /** Start replay after Slack's sessions, worktree map, and identity are ready. */
  start(): Promise<void> {
    this.ensureLoaded();
    this.started = true;
    return this.drain();
  }

  stop(): void {
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  pendingCount(): number {
    this.ensureLoaded();
    return this.records.size;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Exposed for deterministic tests and operational drains. */
  async drain(): Promise<void> {
    this.ensureLoaded();
    if (!this.started) return;
    const work: Promise<void>[] = [];
    for (const record of this.records.values()) {
      if (!this.inFlight.has(record.id)) work.push(this.process(record));
    }
    await Promise.all(work);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.storePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      for (const value of parsed) {
        const record = value as Partial<SlackEventInboxRecord>;
        if (
          typeof record.id !== "string" ||
          (record.kind !== "direct_message" && record.kind !== "mention") ||
          !record.event ||
          typeof record.receivedAt !== "string"
        )
          continue;
        this.records.set(record.id, {
          ...record,
          attempts: Number.isFinite(record.attempts)
            ? Number(record.attempts)
            : 0,
        } as SlackEventInboxRecord);
      }
    } catch (error) {
      this.loaded = false;
      throw new Error(`Failed to load Slack event inbox: ${errorText(error)}`);
    }
  }

  private persist(): void {
    writeJsonAtomic(this.storePath, [...this.records.values()], false, 0o600);
  }

  private kick(): void {
    if (!this.started) return;
    void this.drain().catch((error) => {
      console.error("[slack] Event inbox drain failed:", error);
      this.scheduleRetry();
    });
  }

  private async process(record: SlackEventInboxRecord): Promise<void> {
    this.inFlight.add(record.id);
    try {
      if (this.deps.isProcessed(record.id)) {
        this.remove(record.id);
        return;
      }

      if (record.kind === "direct_message") {
        await this.deps.handleDirectMessage(record.event);
      } else {
        await this.deps.handleMention(record.event);
      }

      // Persist completion before removing the inbox record. If the process
      // dies between these writes, replay sees the processed id and only
      // cleans up the stale inbox entry.
      this.deps.markProcessed(record.id);
      this.remove(record.id);
    } catch (error) {
      record.attempts += 1;
      record.lastError = errorText(error);
      try {
        this.persist();
      } catch (persistError) {
        console.error(
          "[slack] Failed to persist event inbox failure:",
          persistError,
        );
      }
      console.error(
        `[slack] Event inbox attempt ${record.attempts} failed for ${record.id}:`,
        error,
      );
      this.scheduleRetry();
    } finally {
      this.inFlight.delete(record.id);
    }
  }

  private remove(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    try {
      this.persist();
    } catch (error) {
      this.records.set(id, record);
      throw error;
    }
  }

  private scheduleRetry(): void {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.kick();
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }
}
