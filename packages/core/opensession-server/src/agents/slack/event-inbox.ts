/**
 * Durable intake for Slack events that can create or continue a session.
 *
 * Slack requires a fast HTTP acknowledgement, while mention/DM handling can
 * perform API lookups and model calls before it reaches the durable message
 * queue. Persisting the raw event first closes that loss window: a crash or
 * restart replays the event, and the existing message queue deduplicates the
 * eventual enqueue by Slack message timestamp.
 */

import { writeJsonAtomicAsync } from "../../server/shared/atomic-write";
import { readTextIfExists } from "../../server/shared/async-fs";

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
  private loading: Promise<void> | undefined;
  /** Writes run one at a time and each renders the records when it starts,
   *  so the file always ends on the newest state. */
  private persistChain: Promise<void> = Promise.resolve();
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
  async enqueue(
    kind: SlackEventInboxKind,
    event: any,
  ): Promise<SlackEventInboxEnqueueResult> {
    await this.load();
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
      await this.persist();
    } catch (error) {
      this.records.delete(id);
      throw error;
    }
    this.kick();
    return "enqueued";
  }

  /** Start replay after Slack's sessions, worktree map, and identity are ready. */
  async start(): Promise<void> {
    await this.load();
    this.started = true;
    return this.drain();
  }

  stop(): void {
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  async pendingCount(): Promise<number> {
    await this.load();
    return this.records.size;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Exposed for deterministic tests and operational drains. */
  async drain(): Promise<void> {
    await this.load();
    if (!this.started) return;
    const work: Promise<void>[] = [];
    for (const record of this.records.values()) {
      if (!this.inFlight.has(record.id)) work.push(this.process(record));
    }
    await Promise.all(work);
  }

  private load(): Promise<void> {
    this.loading ??= this.readStore().catch((error) => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  private async readStore(): Promise<void> {
    try {
      const text = await readTextIfExists(this.storePath);
      if (text === undefined) return;
      const parsed = JSON.parse(text);
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
      throw new Error(`Failed to load Slack event inbox: ${errorText(error)}`);
    }
  }

  private persist(): Promise<void> {
    const write = this.persistChain.then(() =>
      writeJsonAtomicAsync(
        this.storePath,
        [...this.records.values()],
        false,
        0o600,
      ),
    );
    this.persistChain = write.catch(() => {});
    return write;
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
        await this.remove(record.id);
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
      await this.remove(record.id);
    } catch (error) {
      record.attempts += 1;
      record.lastError = errorText(error);
      try {
        await this.persist();
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

  private async remove(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    try {
      await this.persist();
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
