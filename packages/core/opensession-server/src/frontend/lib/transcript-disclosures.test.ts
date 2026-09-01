import { describe, expect, test } from "bun:test";
import { createTranscriptDisclosureLedger } from "./transcript-disclosures";

describe("transcript disclosure ledger", () => {
  test("restores a choice when a live group gains more entries", () => {
    const ledger = createTranscriptDisclosureLedger();
    ledger.write("tool-run", "session-1", ["step-a", "step-b"], true);

    expect(
      ledger.read("tool-run", "session-1", ["step-a", "step-b", "step-c"]),
    ).toBe(true);
  });

  test("restores a choice when older entries are prepended", () => {
    const ledger = createTranscriptDisclosureLedger();
    ledger.write("turn", "session-1", ["step-b", "step-c"], false);

    expect(
      ledger.read("turn", "session-1", ["step-a", "step-b", "step-c"]),
    ).toBe(false);
  });

  test("uses the latest choice when previously separate groups merge", () => {
    const ledger = createTranscriptDisclosureLedger();
    ledger.write("tool-run", "session-1", ["step-a"], true);
    ledger.write("tool-run", "session-1", ["step-b"], false);

    expect(ledger.read("tool-run", "session-1", ["step-a", "step-b"])).toBe(
      false,
    );
  });

  test("does not carry choices between sessions or disclosure levels", () => {
    const ledger = createTranscriptDisclosureLedger();
    ledger.write("tool-call", "session-1", ["step-a"], false);

    expect(ledger.read("tool-call", "session-1", ["step-a"])).toBe(false);
    expect(ledger.read("tool-call", "session-2", ["step-a"])).toBeUndefined();
    expect(ledger.read("tool-run", "session-1", ["step-a"])).toBeUndefined();
    expect(ledger.read("turn", "session-1", ["step-a"])).toBeUndefined();
  });

  test("bounds remembered entry ids", () => {
    const ledger = createTranscriptDisclosureLedger(2);
    ledger.write("tool-run", "session-1", ["step-a"], true);
    ledger.write("tool-run", "session-1", ["step-b"], false);
    ledger.write("tool-run", "session-1", ["step-c"], true);

    expect(ledger.read("tool-run", "session-1", ["step-a"])).toBeUndefined();
    expect(ledger.read("tool-run", "session-1", ["step-c"])).toBe(true);
  });
});
