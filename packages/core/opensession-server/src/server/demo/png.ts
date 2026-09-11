/**
 * A tiny PNG encoder for demo stills. The demo transcript places media with
 * OPENSESSION_IMAGE / OPENSESSION_COMPARE lines, and the /media route streams
 * real files, so the generator has to write real PNGs into the demo's state
 * directory. Solid rectangles are all the demo needs, and they cost no
 * dependency.
 */

import { deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];

export interface PngRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: Rgb;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, "ascii"), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGB PNG of `background` with `rects` painted over it in order. */
export function encodePng(
  width: number,
  height: number,
  background: Rgb,
  rects: readonly PngRect[],
): Uint8Array {
  const stride = width * 3 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      raw[at] = background[0];
      raw[at + 1] = background[1];
      raw[at + 2] = background[2];
    }
  }
  for (const rect of rects) {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(width, rect.x + rect.w);
    const y1 = Math.min(height, rect.y + rect.h);
    for (let y = y0; y < y1; y++) {
      const row = y * stride;
      for (let x = x0; x < x1; x++) {
        const at = row + 1 + x * 3;
        raw[at] = rect.color[0];
        raw[at + 1] = rect.color[1];
        raw[at + 2] = rect.color[2];
      }
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
