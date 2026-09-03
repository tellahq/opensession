import { describe, expect, test } from "bun:test";
import {
  PASTED_TEXT_FILE_NAME,
  PASTED_TEXT_FILE_THRESHOLD,
  PASTED_TEXT_THRESHOLD,
  composePastedText,
  pastedTextFile,
  pastedTextLineLabel,
  shouldAttachPastedTextAsFile,
  shouldCollapsePastedText,
} from "./pasted-text";

describe("pasted text attachments", () => {
  test("collapse starts at 2500 characters", () => {
    expect(
      shouldCollapsePastedText("x".repeat(PASTED_TEXT_THRESHOLD - 1)),
    ).toBe(false);
    expect(shouldCollapsePastedText("x".repeat(PASTED_TEXT_THRESHOLD))).toBe(
      true,
    );
  });

  test("a paste past the file threshold goes as a file", () => {
    expect(
      shouldAttachPastedTextAsFile("x".repeat(PASTED_TEXT_FILE_THRESHOLD - 1)),
    ).toBe(false);
    expect(
      shouldAttachPastedTextAsFile("x".repeat(PASTED_TEXT_FILE_THRESHOLD)),
    ).toBe(true);
    // A chip still collapses a paste of that size, so a surface without a
    // file channel has a fallback.
    expect(
      shouldCollapsePastedText("x".repeat(PASTED_TEXT_FILE_THRESHOLD)),
    ).toBe(true);
  });

  test("the file keeps the text verbatim as plain text", async () => {
    const text = "line one\nline two\n";
    const file = pastedTextFile(text);
    expect(file.name).toBe(PASTED_TEXT_FILE_NAME);
    // Bun's File adds a charset the browser's does not; the media type is
    // what the upload and the image/file split read.
    expect(file.type.startsWith("text/plain")).toBe(true);
    expect(await file.text()).toBe(text);
  });

  test("summarizes Unix and Windows line endings", () => {
    expect(pastedTextLineLabel("one")).toBe("+1 line");
    expect(pastedTextLineLabel("one\ntwo\r\nthree\rfour")).toBe("+4 lines");
  });

  test("a note folds pasted blocks behind a divider, message first", () => {
    expect(
      composePastedText("Summarize this", ["First block", "Second block"]),
    ).toBe(
      [
        "Summarize this",
        "---",
        "Pasted text:",
        "First block",
        "---",
        "Pasted text:",
        "Second block",
      ].join("\n\n"),
    );
    expect(composePastedText("Visible", [])).toBe("Visible");
  });

  test("a lone paste goes out bare, later ones still split", () => {
    expect(composePastedText("", ["Only block"])).toBe("Only block");
    expect(composePastedText("", ["First", "Second"])).toBe(
      "First\n\n---\n\nPasted text:\n\nSecond",
    );
    expect(composePastedText("Ask", ["", "Body"])).toBe(
      "Ask\n\n---\n\nPasted text:\n\nBody",
    );
  });
});
