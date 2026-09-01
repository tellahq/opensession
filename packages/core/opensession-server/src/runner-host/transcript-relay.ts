/**
 * Bounded history for the run-host's proxied transcript appends (the
 * `transcript` frame; see src/server/transcript-forward.ts for the seam and
 * host.ts for the wiring).
 *
 * Socket-mode hosts have a live-only stream. Frames sent while the server is
 * detached are gone. Lines carry stable uuids and upsert server-side, so the
 * recovery is simply to re-send recorded batches on every (re)attach. The
 * history is byte-bounded and retains the newest complete batches: once the
 * budget fills, older batches are evicted because they are most likely already
 * committed by the previously attached server. This keeps the disconnect tail
 * (including terminal tool results and final answers) recoverable without
 * letting the host grow without limit (`overflowed` reports truncation once).
 * WS hosts normally replay through their sequenced ring buffer. A full server
 * restart intentionally mints a fresh replay epoch, however, so only this
 * idempotent transcript history may cross that unknown event watermark.
 */

export interface TranscriptBatch {
  engineSessionId: string;
  lines: Record<string, unknown>[];
}

export class TranscriptRelay {
  private history: TranscriptBatch[] = [];
  private sizes: number[] = [];
  private bytes = 0;
  private overflow = false;

  constructor(private readonly maxBytes = 8 * 1024 * 1024) {}

  /** Record one batch for later resend. False means the bounded history became
   *  partial. An individually oversized batch cannot be retained; otherwise
   *  the oldest complete batches are evicted so this newest batch survives. */
  record(engineSessionId: string, lines: Record<string, unknown>[]): boolean {
    const size = JSON.stringify(lines).length;
    if (size > this.maxBytes) {
      this.overflow = true;
      return false;
    }

    let complete = true;
    while (this.bytes + size > this.maxBytes && this.history.length) {
      this.history.shift();
      this.bytes -= this.sizes.shift() || 0;
      this.overflow = true;
      complete = false;
    }
    this.history.push({ engineSessionId, lines });
    this.sizes.push(size);
    this.bytes += size;
    return complete;
  }

  /** All recorded batches, oldest first, for a reattach resend. */
  replay(): readonly TranscriptBatch[] {
    return this.history;
  }

  /** True once at least one batch fell outside the byte budget. */
  get overflowed(): boolean {
    return this.overflow;
  }
}
