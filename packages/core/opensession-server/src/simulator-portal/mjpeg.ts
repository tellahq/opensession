const START = Buffer.from([0xff, 0xd8]);
const END = Buffer.from([0xff, 0xd9]);
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** idb's mjpeg format is concatenated JPEGs, not an HTTP multipart stream. */
export function jpegFrames(onFrame: (frame: Uint8Array) => void) {
  let pending = Buffer.alloc(0);
  return (chunk: Uint8Array) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const start = pending.indexOf(START);
      if (start < 0) {
        pending = pending.subarray(-1);
        return;
      }
      if (start > 0) pending = pending.subarray(start);
      const end = pending.indexOf(END, 2);
      if (end < 0) {
        if (pending.length > MAX_FRAME_BYTES) {
          pending = Buffer.alloc(0);
          throw new Error("Simulator frame exceeds the 4 MiB limit");
        }
        return;
      }
      if (end + 2 > MAX_FRAME_BYTES)
        throw new Error("Simulator frame exceeds the 4 MiB limit");
      onFrame(pending.subarray(0, end + 2));
      pending = pending.subarray(end + 2);
    }
  };
}
