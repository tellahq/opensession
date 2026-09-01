/** FIFO for Bun's unbuffered TCPSocket.write API. */
export class SocketWriteQueue {
  private pending: Uint8Array[] = [];
  private bytes = 0;
  private overflowed = false;

  constructor(
    private readonly writeNow: (data: Uint8Array) => number,
    private readonly maxBufferedBytes = 32 * 1024 * 1024,
    private readonly onOverflow?: () => void,
  ) {}

  write(line: string): boolean {
    if (this.overflowed) return false;
    const data = Buffer.from(line);
    if (this.bytes + data.byteLength > this.maxBufferedBytes) {
      this.overflowed = true;
      this.onOverflow?.();
      return false;
    }
    this.pending.push(data);
    this.bytes += data.byteLength;
    this.flush();
    return true;
  }

  drain(): void {
    this.flush();
  }

  get bufferedBytes(): number {
    return this.bytes;
  }

  private flush(): void {
    while (this.pending.length > 0) {
      const data = this.pending[0];
      let written: number;
      try {
        written = this.writeNow(data);
      } catch {
        return;
      }
      if (written <= 0) return;
      if (written < data.byteLength) {
        this.pending[0] = data.subarray(written);
        this.bytes -= written;
        return;
      }
      this.pending.shift();
      this.bytes -= data.byteLength;
    }
  }
}
