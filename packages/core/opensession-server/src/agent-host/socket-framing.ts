const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const newline = 0x0a;
const carriageReturn = 0x0d;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export class NdjsonFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NdjsonFrameError";
  }
}

/** Incremental, byte-bounded NDJSON decoder. Once a frame fails, the decoder
 * stays failed so callers cannot accidentally continue on a compromised stream. */
export class BoundedNdjsonDecoder {
  private buffered = Buffer.alloc(0);
  private failed = false;

  constructor(readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array): unknown[] {
    if (this.failed)
      throw new NdjsonFrameError("decoder is closed after a framing error");
    if (chunk.byteLength === 0) return [];

    const messages: unknown[] = [];
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== newline) continue;
      this.append(chunk.subarray(start, index));
      messages.push(this.decodeBuffered());
      start = index + 1;
    }
    this.append(chunk.subarray(start));
    return messages;
  }

  finish(): void {
    if (this.failed) return;
    if (this.buffered.byteLength !== 0) this.fail("unterminated NDJSON frame");
  }

  private append(chunk: Uint8Array): void {
    if (this.buffered.byteLength + chunk.byteLength > this.maxFrameBytes) {
      this.fail(`NDJSON frame exceeds ${this.maxFrameBytes} bytes`);
    }
    if (chunk.byteLength === 0) return;
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
  }

  private decodeBuffered(): unknown {
    let frame = this.buffered;
    this.buffered = Buffer.alloc(0);
    if (frame.at(-1) === carriageReturn) frame = frame.subarray(0, -1);
    if (frame.byteLength === 0) this.fail("empty NDJSON frame");
    try {
      return JSON.parse(utf8.decode(frame));
    } catch {
      return this.fail("malformed NDJSON frame");
    }
  }

  private fail(message: string): never {
    this.failed = true;
    this.buffered = Buffer.alloc(0);
    throw new NdjsonFrameError(message);
  }
}

export function encodeNdjsonFrame(
  value: unknown,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new NdjsonFrameError("message is not JSON serializable");
  }
  if (json === undefined)
    throw new NdjsonFrameError("message is not JSON serializable");
  const frame = Buffer.from(`${json}\n`, "utf8");
  if (frame.byteLength - 1 > maxFrameBytes) {
    throw new NdjsonFrameError(`NDJSON frame exceeds ${maxFrameBytes} bytes`);
  }
  return frame;
}

export const AGENT_HOST_MAX_FRAME_BYTES = DEFAULT_MAX_FRAME_BYTES;
