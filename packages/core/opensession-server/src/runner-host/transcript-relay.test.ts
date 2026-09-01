/**
 * The socket-mode resend half of the proxied-transcript seam: bounded
 * recording, oldest-first replay, and the newest-tail overflow contract. Live
 * sends keep going while bounded resends become partial. Pure in-memory; no
 * host process involved.
 */

import { describe, expect, test } from "bun:test";
import { TranscriptRelay } from "./transcript-relay";

const line = (id: string, text: string) => ({
  uuid: id,
  type: "assistant",
  text,
});

describe("TranscriptRelay", () => {
  test("records batches and replays them oldest first", () => {
    const relay = new TranscriptRelay();
    expect(relay.record("pi-1", [line("a", "one")])).toBe(true);
    expect(relay.record("pi-1", [line("b", "two")])).toBe(true);
    expect(relay.record("os-1", [line("c", "user")])).toBe(true);
    const batches = relay.replay();
    expect(batches.map((b) => b.engineSessionId)).toEqual([
      "pi-1",
      "pi-1",
      "os-1",
    ]);
    expect(batches[0].lines[0].uuid).toBe("a");
    expect(relay.overflowed).toBe(false);
  });

  test("keeps existing history when one batch is too large to retain", () => {
    const relay = new TranscriptRelay(64);
    expect(relay.record("pi-1", [line("a", "fits")])).toBe(true);
    expect(relay.record("pi-1", [line("b", "x".repeat(200))])).toBe(false);
    expect(relay.overflowed).toBe(true);
    expect(relay.replay().length).toBe(1);
    expect(relay.replay()[0].lines[0].uuid).toBe("a");
  });

  test("evicts the oldest batches so the disconnect tail remains replayable", () => {
    const relay = new TranscriptRelay(120);
    expect(relay.record("pi-1", [line("old", "x".repeat(20))])).toBe(true);
    expect(relay.record("pi-1", [line("tail", "y".repeat(20))])).toBe(false);
    expect(relay.overflowed).toBe(true);
    expect(relay.replay().map((batch) => batch.lines[0].uuid)).toEqual([
      "tail",
    ]);
  });

  test("a small batch after an oversized batch may still fit", () => {
    const relay = new TranscriptRelay(120);
    expect(relay.record("pi-1", [line("a", "x".repeat(20))])).toBe(true);
    expect(relay.record("pi-1", [line("b", "y".repeat(500))])).toBe(false);
    expect(relay.record("pi-1", [line("c", "z")])).toBe(true);
    expect(relay.replay().map((b) => b.lines[0].uuid)).toEqual(["a", "c"]);
    expect(relay.overflowed).toBe(true);
  });
});
