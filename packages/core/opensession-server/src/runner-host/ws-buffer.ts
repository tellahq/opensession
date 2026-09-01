/**
 * ws-buffer — host-side frame buffering for the WS run transport (the
 * TODO(ws-buffer-ack) in host.ts; docs/self-hosting-sandboxes.md).
 *
 * The unix-socket transport is deliberately live-only and does NOT use this.
 * In WS mode (remote sandboxes / docker-ws), host.ts stamps every outbound
 * host→server frame (except transport-level `hello`/`ping`) with a monotonic
 * `seq` and keeps the serialized line in this bounded ring buffer. The
 * opensession side (src/server/run-ws.ts) acks the last CONSUMED seq — on
 * socket open and then periodically — and the host replays everything after
 * the acked watermark on reconnect; the server drops any seq it has already
 * consumed, so a replay overlap never double-applies.
 *
 * Bounds: WS_BUFFER_MAX_FRAMES frames / WS_BUFFER_MAX_BYTES of serialized
 * lines, with one oversized frame allowed alongside the normal byte budget.
 * On overflow the OLDEST frames are dropped and the buffer remembers the
 * highest dropped seq; a later replay that needs to reach behind that point
 * reports the hole as a `gap` so the server can log the loss (the transcript
 * jsonl remains the durable copy).
 *
 * Epochs: the server's ack carries an `epoch` — a random id minted when the
 * host's seq record is created server-side and kept for the registration's
 * lifetime (it survives `bun --hot` reloads, not full restarts). The host
 * only replays into a server whose epoch matches the one it last streamed to;
 * a fresh epoch (opensession fully restarted, so its consumed-watermark is
 * gone) gets frames from the current connection onward only — exactly the old
 * live-only semantics, where hello/meta.done/journal cover correctness.
 */

export const WS_BUFFER_MAX_FRAMES = 5000;
export const WS_BUFFER_MAX_BYTES = 5 * 1024 * 1024;

export interface WsAck {
  seq: number;
  epoch?: string;
}

export interface WsReplay {
  /** Frames dropped by overflow that the requested replay can't reach. */
  gap: { from: number; to: number } | null;
  /** Serialized frames (NDJSON lines) after the requested watermark, in order. */
  lines: string[];
}

/**
 * Where a (re)connected host should resume streaming from, given the server's
 * first ack on the new socket. `prevEpoch` is the epoch of the server we last
 * streamed to (null on the first connection), `openSeq` the buffer's lastSeq
 * at the moment this socket opened.
 */
export function replayStartFor(
  ack: WsAck,
  prevEpoch: string | null,
  openSeq: number,
): number {
  if (ack.epoch && ack.epoch === prevEpoch) {
    // Same server-side registration — its consumed watermark is authoritative
    // (clamped: it can never have consumed frames we haven't produced).
    return Math.min(ack.seq, openSeq);
  }
  // Unknown/new server process: never replay pre-connection frames into a
  // consumer that may have already applied them before it restarted.
  return openSeq;
}

interface BufferedFrame {
  seq: number;
  line: string;
  bytes: number;
}

export class WsFrameBuffer {
  private frames: BufferedFrame[] = [];
  private bytes = 0;
  private seq = 0;
  /** Highest seq ever dropped by overflow (0 = none). */
  private droppedThrough = 0;

  constructor(
    private readonly maxFrames = WS_BUFFER_MAX_FRAMES,
    private readonly maxBytes = WS_BUFFER_MAX_BYTES,
  ) {}

  get lastSeq(): number {
    return this.seq;
  }

  /** Stamp `msg` with the next seq, buffer its serialized line, return it. */
  stamp(msg: Record<string, unknown>): string {
    const seq = ++this.seq;
    const line = JSON.stringify({ ...msg, seq }) + "\n";
    // Byte length, not string length: a serialized line is sent as UTF-8, so
    // counting UTF-16 code units undercounts anything non-ASCII and lets the
    // ring hold more bytes than its budget.
    const bytes = Buffer.byteLength(line);
    this.frames.push({ seq, line, bytes });
    this.bytes += bytes;
    // Allow ONE oversized frame on top of the normal byte budget. A sandboxed
    // Read returns its image inline (piToolResultImages), and after
    // base64 expansion that single frame can exceed maxBytes on its own —
    // under a plain cap it would be evicted the moment it arrived, so the one
    // frame most worth replaying after a disconnect could never be replayed.
    // Bounded work: the scan is over at most maxFrames entries and only runs
    // while the ring is actually over budget.
    for (;;) {
      const largest = this.frames.reduce(
        (max, frame) => Math.max(max, frame.bytes),
        0,
      );
      const byteLimit =
        largest > this.maxBytes ? largest + this.maxBytes : this.maxBytes;
      if (this.frames.length <= this.maxFrames && this.bytes <= byteLimit)
        break;
      const dropped = this.frames.shift()!;
      this.bytes -= dropped.bytes;
      this.droppedThrough = dropped.seq;
    }
    return line;
  }

  /** The server consumed everything up to `seq` — release those frames. */
  ack(seq: number): void {
    while (this.frames.length && this.frames[0].seq <= seq) {
      this.bytes -= this.frames.shift()!.bytes;
    }
  }

  /** Everything after the `after` watermark, plus the overflow gap (if the
   *  buffer no longer reaches back that far). */
  replayFrom(after: number): WsReplay {
    const lines = this.frames.filter((f) => f.seq > after).map((f) => f.line);
    const gap =
      this.droppedThrough > after
        ? { from: after + 1, to: this.droppedThrough }
        : null;
    return { gap, lines };
  }
}
