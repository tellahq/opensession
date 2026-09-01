import { describe, expect, test } from "bun:test";
import { SocketWriteQueue } from "./socket-write-queue";

describe("SocketWriteQueue", () => {
  test("delivers a terminal frame after a saturated transcript replay", () => {
    const written: Uint8Array[] = [];
    let capacity = 32 * 1024;
    const queue = new SocketWriteQueue((data) => {
      const size = Math.min(capacity, data.byteLength);
      if (size === 0) return 0;
      written.push(data.slice(0, size));
      capacity -= size;
      return size;
    });
    const frames = Array.from(
      { length: 512 },
      (_, index) =>
        JSON.stringify({
          t: "transcript",
          engineSessionId: "pi-restart",
          lines: [{ uuid: `line-${index}`, content: "x".repeat(16 * 1024) }],
        }) + "\n",
    );
    const terminal =
      JSON.stringify({
        t: "end",
        done: { type: "done", result: "PI_SURVIVED_RESTART" },
      }) + "\n";

    for (const frame of frames) queue.write(frame);
    queue.write(terminal);
    expect(queue.bufferedBytes).toBeGreaterThan(0);

    while (queue.bufferedBytes > 0) {
      capacity = 64 * 1024;
      queue.drain();
    }

    const output = Buffer.concat(written).toString();
    expect(output).toBe(frames.join("") + terminal);
    expect(output.endsWith(terminal)).toBe(true);
  });

  test("rejects an unbounded stalled connection", () => {
    let overflowed = 0;
    const queue = new SocketWriteQueue(
      () => 0,
      10,
      () => overflowed++,
    );

    expect(queue.write("1234567890")).toBe(true);
    expect(queue.write("x")).toBe(false);
    expect(queue.write("y")).toBe(false);
    expect(queue.bufferedBytes).toBe(10);
    expect(overflowed).toBe(1);
  });
});
