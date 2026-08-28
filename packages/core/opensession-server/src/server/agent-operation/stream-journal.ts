import type { AgentGatewayLiveEventSink } from "./gateway";
const MAX_FRAMES = 128,
  MAX_BYTES = 1024 * 1024,
  MAX_CHUNK = 48 * 1024;
export class AgentOperationStreamRecoveryRequiredError extends Error {
  constructor(message = "operation stream recovery required") {
    super(message);
    this.name = "AgentOperationStreamRecoveryRequiredError";
  }
}
export class AgentOperationStreamClosedError extends Error {
  constructor() {
    super("operation stream is closed");
    this.name = "AgentOperationStreamClosedError";
  }
}
type Frame = { seq: number; bytes: Uint8Array };
type Waiter = {
  through: number;
  resolve: () => void;
  reject: (e: unknown) => void;
};
/** Memory-only bounded journal. Publication resolves only after cumulative Host ACK. */
export class AgentOperationStreamJournal implements AgentGatewayLiveEventSink {
  readonly #frames: Frame[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #drainers = new Set<() => void>();
  #next = 1;
  #acked = 0;
  #bytes = 0;
  #closed = false;
  #failure: unknown;
  async publish(event: Readonly<unknown>): Promise<void> {
    if (this.#closed) throw new AgentOperationStreamClosedError();
    const bytes = new TextEncoder().encode(`${JSON.stringify(event)}\n`);
    if (bytes.byteLength > MAX_CHUNK)
      throw new AgentOperationStreamRecoveryRequiredError(
        "operation stream chunk is too large",
      );
    if (
      this.#frames.length >= MAX_FRAMES ||
      this.#bytes + bytes.byteLength > MAX_BYTES
    )
      throw new AgentOperationStreamRecoveryRequiredError(
        "operation stream journal is full",
      );
    const seq = this.#next++;
    this.#frames.push({ seq, bytes });
    this.#bytes += bytes.byteLength;
    this.#notify();
    await new Promise<void>((resolve, reject) =>
      this.#waiters.push({ through: seq, resolve, reject }),
    );
  }
  acknowledge(through: number): void {
    if (
      !Number.isSafeInteger(through) ||
      through < this.#acked ||
      through >= this.#next
    )
      throw new AgentOperationStreamRecoveryRequiredError(
        "invalid operation stream cursor",
      );
    this.#acked = through;
    while (this.#frames[0]?.seq <= through)
      this.#bytes -= this.#frames.shift()!.bytes.byteLength;
    for (let i = this.#waiters.length - 1; i >= 0; i--) {
      const w = this.#waiters[i]!;
      if (w.through <= through) {
        this.#waiters.splice(i, 1);
        w.resolve();
      }
    }
    this.#notify();
    if (!this.#waiters.length) {
      for (const drain of this.#drainers) drain();
      this.#drainers.clear();
    }
  }
  replay(after: number): AsyncIterable<Uint8Array> {
    if (!Number.isSafeInteger(after) || after < 0 || after >= this.#next)
      throw new AgentOperationStreamRecoveryRequiredError(
        "invalid operation stream cursor",
      );
    const oldest = this.#frames[0]?.seq ?? this.#next;
    if (after < oldest - 1)
      throw new AgentOperationStreamRecoveryRequiredError(
        "operation stream cursor is too old",
      );
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let cursor = after;
        for (;;) {
          const frame = self.#frames.find((f) => f.seq === cursor + 1);
          if (frame) {
            cursor = frame.seq;
            yield frame.bytes.slice();
            continue;
          }
          if (self.#failure) throw self.#failure;
          if (self.#closed) return;
          await new Promise<void>((resolve) => self.#listeners.add(resolve));
        }
      },
    };
  }
  async close(): Promise<unknown> {
    this.#closed = true;
    this.#notify();
    if (this.#waiters.length)
      await new Promise<void>((resolve) => this.#drainers.add(resolve));
    return Object.freeze({ throughStreamSeq: this.#acked });
  }
  async fail(_reason?: unknown): Promise<void> {
    this.#closed = true;
    // The journal is transport-facing. Never retain or replay caller/provider
    // diagnostics, which may contain payload or credential material.
    this.#failure = new AgentOperationStreamClosedError();
    for (const w of this.#waiters.splice(0)) w.reject(this.#failure);
    for (const drain of this.#drainers) drain();
    this.#drainers.clear();
    this.#notify();
  }
  get bytes() {
    return this.#bytes;
  }
  get frameCount() {
    return this.#frames.length;
  }
  get acknowledgedThrough() {
    return this.#acked;
  }
  #notify() {
    for (const listener of this.#listeners) listener();
    this.#listeners.clear();
  }
}
