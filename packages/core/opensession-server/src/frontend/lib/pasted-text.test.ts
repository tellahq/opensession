import { describe, expect, test } from "bun:test";
import {
  PASTED_TEXT_THRESHOLD,
  composePastedText,
  pastedTextLineLabel,
  shouldCollapsePastedText,
  type PastedTextAttachment,
} from "./pasted-text";

const attachment = (text: string, id = text): PastedTextAttachment => ({
  id,
  text,
});

describe("pasted text attachments", () => {
  test("collapse starts at 2500 characters", () => {
    expect(
      shouldCollapsePastedText("x".repeat(PASTED_TEXT_THRESHOLD - 1)),
    ).toBe(false);
    expect(shouldCollapsePastedText("x".repeat(PASTED_TEXT_THRESHOLD))).toBe(
      true,
    );
  });

  test("summarizes Unix and Windows line endings", () => {
    expect(pastedTextLineLabel("one")).toBe("+1 line");
    expect(pastedTextLineLabel("one\ntwo\r\nthree\rfour")).toBe("+4 lines");
  });

  test("keeps pasted context ahead of the visible instruction", () => {
    expect(
      composePastedText("Summarize this", [
        attachment("First block"),
        attachment("Second block"),
      ]),
    ).toBe("First block\n\nSecond block\n\nSummarize this");
    expect(composePastedText("", [attachment("Only block")])).toBe(
      "Only block",
    );
    expect(composePastedText("Visible", [])).toBe("Visible");
  });
});
