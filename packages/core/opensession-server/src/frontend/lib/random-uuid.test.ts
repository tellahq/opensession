import { expect, test } from "bun:test";
import { randomUUID } from "./random-uuid";

test("uses the browser's native UUID generator when available", () => {
  const source = {
    getRandomValues: <T extends ArrayBufferView | null>(value: T) => value,
    randomUUID: () =>
      "native-id" as `${string}-${string}-${string}-${string}-${string}`,
  };
  expect(randomUUID(source)).toBe("native-id");
});

test("falls back to getRandomValues on an insecure HTTP origin", () => {
  const source = {
    getRandomValues: <T extends ArrayBufferView | null>(value: T) => {
      const bytes = value as Uint8Array;
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = index;
      return value;
    },
  };
  expect(randomUUID(source)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
});
