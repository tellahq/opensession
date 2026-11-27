import { describe, expect, test } from "bun:test";
import { shouldHandleTranscriptEscape } from "./esc-stop-confirm";

const baseEvent = {
  key: "Escape",
  defaultPrevented: false,
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target: null,
};

describe("shouldHandleTranscriptEscape", () => {
  test("accepts a plain Escape outside inputs and dialogs", () => {
    expect(shouldHandleTranscriptEscape(baseEvent, null)).toBe(true);
  });

  test("ignores non-Escape, repeated, modified, or already-handled events", () => {
    expect(
      shouldHandleTranscriptEscape({ ...baseEvent, key: "Enter" }, null),
    ).toBe(false);
    expect(
      shouldHandleTranscriptEscape({ ...baseEvent, repeat: true }, null),
    ).toBe(false);
    expect(
      shouldHandleTranscriptEscape(
        { ...baseEvent, defaultPrevented: true },
        null,
      ),
    ).toBe(false);
    expect(
      shouldHandleTranscriptEscape({ ...baseEvent, metaKey: true }, null),
    ).toBe(false);
  });
});
