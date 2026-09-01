import { afterEach, describe, expect, test } from "bun:test";
import { envCapacity } from "./env-capacity";

const NAME = "OPENSESSION_TEST_CAPACITY_KNOB";

afterEach(() => {
  delete process.env[NAME];
});

describe("envCapacity", () => {
  test("returns the fallback when unset or blank", () => {
    expect(envCapacity(NAME, 8, 1, 64)).toBe(8);
    process.env[NAME] = "  ";
    expect(envCapacity(NAME, 8, 1, 64)).toBe(8);
  });

  test("accepts a bounded integer", () => {
    process.env[NAME] = "16";
    expect(envCapacity(NAME, 8, 1, 64)).toBe(16);
    process.env[NAME] = "1";
    expect(envCapacity(NAME, 8, 1, 64)).toBe(1);
    process.env[NAME] = "64";
    expect(envCapacity(NAME, 8, 1, 64)).toBe(64);
  });

  test("keeps the fallback for out-of-range or malformed values", () => {
    for (const raw of [
      "0",
      "65",
      "-3",
      "2.5",
      "abc",
      "8x",
      "Infinity",
      "NaN",
    ]) {
      process.env[NAME] = raw;
      expect(envCapacity(NAME, 8, 1, 64)).toBe(8);
    }
  });
});
