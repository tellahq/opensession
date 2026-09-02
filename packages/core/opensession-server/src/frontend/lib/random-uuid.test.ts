import { expect, test } from "bun:test";
import { randomUUID } from "./random-uuid";

test("uses the browser's native UUID generator when available", () => {
  const source = {
    getRandomValues: <T extends ArrayBufferView | null>(value: T) => value,
    randomUUID: (): `${string}-${string}-${string}-${string}-${string}` =>
      "native-id-id-id-id",
  };
  expect(randomUUID(source)).toBe("native-id-id-id-id");
});

test("falls back to getRandomValues on an insecure HTTP origin", () => {
  const source = {
    getRandomValues: <T extends ArrayBufferView | null>(value: T) => {
      if (!value) return value;
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = index;
      return value;
    },
  };
  expect(randomUUID(source)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
});
