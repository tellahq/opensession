import { describe, expect, test } from "bun:test";
import {
  BoundedNdjsonDecoder,
  NdjsonFrameError,
  encodeNdjsonFrame,
} from "./socket-framing";

describe("bounded NDJSON framing", () => {
  test("frames split multibyte input by bytes", () => {
    const decoder = new BoundedNdjsonDecoder(32);
    const frame = encodeNdjsonFrame({ text: "🌊" }, 32);
    expect(decoder.push(frame.subarray(0, frame.byteLength - 2))).toEqual([]);
    expect(decoder.push(frame.subarray(frame.byteLength - 2))).toEqual([
      { text: "🌊" },
    ]);
  });

  test("fails closed on malformed and oversized frames", () => {
    const malformed = new BoundedNdjsonDecoder(8);
    expect(() => malformed.push(Buffer.from("nope\n"))).toThrow(
      NdjsonFrameError,
    );
    expect(() => malformed.push(Buffer.from("{}\n"))).toThrow(NdjsonFrameError);
    const oversized = new BoundedNdjsonDecoder(2);
    expect(() => oversized.push(Buffer.from("123"))).toThrow("exceeds 2 bytes");
  });
});
