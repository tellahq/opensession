import { describe, expect, test } from "bun:test";
import { TranscriptTopApproachGate } from "./transcript-top-approach";

describe("TranscriptTopApproachGate", () => {
  test("range responses cannot create another history request", () => {
    const gate = new TranscriptTopApproachGate();
    gate.request();
    expect(gate.shouldFire(true, 0)).toBe(true);
    expect(gate.shouldFire(true, 2_000)).toBe(false);
  });

  test("continued upward input fires after the cooldown", () => {
    const gate = new TranscriptTopApproachGate();
    gate.request();
    expect(gate.shouldFire(true, 0)).toBe(true);
    gate.request();
    expect(gate.shouldFire(true, 899)).toBe(false);
    expect(gate.shouldFire(true, 900)).toBe(true);
  });

  test("keeps an upward intent until the reader reaches the top window", () => {
    const gate = new TranscriptTopApproachGate();
    gate.request();
    expect(gate.shouldFire(false, 0)).toBe(false);
    expect(gate.shouldFire(true, 50)).toBe(true);
  });

  test("reset drops intent when the scroll container changes", () => {
    const gate = new TranscriptTopApproachGate();
    gate.request();
    gate.reset();
    expect(gate.shouldFire(true, 1_000)).toBe(false);
  });
});
