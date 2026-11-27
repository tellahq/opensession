import { describe, expect, test } from "bun:test";
import {
  MAX_DICTATION_VOCABULARY_CHARS,
  normalizeDictationVocabulary,
} from "./dictation-vocabulary";

describe("normalizeDictationVocabulary", () => {
  test("splits commas and newlines, trims whitespace, and deduplicates case-insensitively", () => {
    expect(
      normalizeDictationVocabulary(
        "  Open Session,\nDaytona, open session\n\n  Pi  SDK , ",
      ),
    ).toBe("Open Session, Daytona, Pi SDK");
  });

  test("caps total length without leaving a broken trailing term", () => {
    const many = Array.from({ length: 80 }, (_, i) => `TermNumber${i}`).join(
      ", ",
    );
    const out = normalizeDictationVocabulary(many);
    expect(out.length).toBeLessThanOrEqual(MAX_DICTATION_VOCABULARY_CHARS);
    expect(out.endsWith(",")).toBe(false);
    expect(out.startsWith("TermNumber0")).toBe(true);
  });
});
