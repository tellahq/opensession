/**
 * Trim the empty margin around a tile icon.
 *
 * Icons arrive drawn to whatever proportions their author chose: the org
 * avatar puts its mark on 62% of its canvas, an Apple-style app icon on 80%.
 * A letter tile fills its square completely, so those icons sit in a row of
 * tiles reading visibly smaller than the ones beside them — the thing this
 * fixes. Cropping to the artwork, and squaring it off without adding any
 * margin back, makes every icon land at the size the tile actually is.
 *
 * Deliberately dependency-free: this runs on a handful of small PNGs when an
 * icon is fetched or first served, and a tile is not worth adding an image
 * library (or a python/ImageMagick runtime dependency) to the install.
 *
 * Only the straightforward PNGs are handled — 8-bit, non-interlaced, in the
 * four common color types. Anything else returns null and is served untouched,
 * which is also what happens when there's no margin worth trimming.
 */

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

interface Decoded {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  pixels: Uint8Array;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readChunks(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

/** Undo the per-scanline filter PNG applies before compressing. */
function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`filter ${filter}`);
      row[x] = value & 0xff;
    }
  }
  return out;
}

function decode(bytes: Uint8Array): Decoded | null {
  const chunks = readChunks(bytes);
  const header = chunks.find((c) => c.type === "IHDR");
  if (!header) return null;
  const view = new DataView(
    header.data.buffer,
    header.data.byteOffset,
    header.data.byteLength,
  );
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const depth = header.data[8];
  const colorType = header.data[9];
  const interlace = header.data[12];
  // 8-bit, non-interlaced only. Everything else keeps its original bytes.
  if (depth !== 8 || interlace !== 0) return null;
  const channels =
    colorType === 6
      ? 4
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 3
            ? 1
            : colorType === 0
              ? 1
              : 0;
  if (!channels) return null;

  const idat = chunks.filter((c) => c.type === "IDAT");
  if (!idat.length) return null;
  const compressed = new Uint8Array(
    idat.reduce((n, c) => n + c.data.length, 0),
  );
  let at = 0;
  for (const chunk of idat) {
    compressed.set(chunk.data, at);
    at += chunk.data.length;
  }
  // node:zlib, not Bun.inflateSync: PNG's IDAT is zlib-wrapped and Bun's
  // helper takes raw deflate ("invalid stored block lengths" otherwise).
  const raw = unfilter(
    new Uint8Array(inflateSync(compressed)),
    width,
    height,
    channels,
  );

  const palette = chunks.find((c) => c.type === "PLTE")?.data;
  const paletteAlpha = chunks.find((c) => c.type === "tRNS")?.data;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const dst = i * 4;
    if (colorType === 6) {
      pixels.set(raw.subarray(src, src + 4), dst);
    } else if (colorType === 2) {
      pixels.set(raw.subarray(src, src + 3), dst);
      pixels[dst + 3] = 255;
    } else if (colorType === 4) {
      pixels.fill(raw[src], dst, dst + 3);
      pixels[dst + 3] = raw[src + 1];
    } else if (colorType === 0) {
      pixels.fill(raw[src], dst, dst + 3);
      pixels[dst + 3] = 255;
    } else if (colorType === 3 && palette) {
      const index = raw[src];
      pixels.set(palette.subarray(index * 3, index * 3 + 3), dst);
      pixels[dst + 3] = paletteAlpha?.[index] ?? 255;
    } else return null;
  }
  return { width, height, pixels };
}

function encode({ width, height, pixels }: Decoded): Uint8Array {
  const stride = width * 4;
  // Filter 0 on every row: these are small images and the point is a correct
  // file, not the last byte of compression.
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(
      pixels.subarray(y * stride, (y + 1) * stride),
      y * (stride + 1) + 1,
    );
  }
  const idat = new Uint8Array(deflateSync(raw));

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    new DataView(out.buffer).setUint32(
      8 + data.length,
      crc32(out.subarray(4, 8 + data.length)),
    );
    return out;
  };
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Crop a PNG to its artwork and square it off, so it fills a tile like every
 * other icon does.
 *
 * No margin is added back. A letter tile paints its color to its own edges, so
 * any breathing room left around the artwork reads as a smaller icon sitting in
 * a row beside the lettered ones — which is the whole thing this exists to
 * stop. The tile's own rounding is the only frame an icon gets.
 *
 * Returns null when there's nothing to do — already tight, fully opaque (a
 * photo avatar has no margin to find, and guessing one from edge color would
 * eat real artwork), or a PNG shape this doesn't decode.
 */
export function trimIconMargin(bytes: Uint8Array): Uint8Array | null {
  let image: Decoded | null;
  try {
    image = decode(bytes);
  } catch {
    return null;
  }
  if (!image) return null;
  const { width, height, pixels } = image;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Anything but near-transparent counts as artwork.
      if (pixels[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // fully transparent

  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  const out = Math.max(contentW, contentH);

  // Already tight: the artwork reaches the canvas edge (within a rounding
  // pixel or two), so there is nothing to crop. This is also what makes the
  // trim idempotent — a re-serve or a re-fetch of an icon this already
  // squared off finds it done rather than eating into the art.
  if (out / Math.max(width, height) >= 0.98) return null;

  const canvas = new Uint8Array(out * out * 4);
  // Centred: the artwork's own box, not the file's, decides the middle. Only
  // the shorter side gets any inset, and only to make the result square.
  const offsetX = Math.round((out - contentW) / 2);
  const offsetY = Math.round((out - contentH) / 2);
  for (let y = 0; y < contentH; y++) {
    const src = ((minY + y) * width + minX) * 4;
    const dst = ((offsetY + y) * out + offsetX) * 4;
    canvas.set(pixels.subarray(src, src + contentW * 4), dst);
  }
  return encode({ width: out, height: out, pixels: canvas });
}
