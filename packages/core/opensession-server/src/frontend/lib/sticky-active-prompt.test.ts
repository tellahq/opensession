import { describe, expect, test } from "bun:test";
import {
  pickStickyPromptId,
  summarizeUserPrompt,
} from "./sticky-active-prompt";

describe("summarizeUserPrompt", () => {
  test("collapses whitespace, skips leading blockquotes, and truncates cleanly", () => {
    expect(
      summarizeUserPrompt(
        "> quoted context\nFix the retry loop\nin pi-runner.ts",
      ),
    ).toBe("Fix the retry loop in pi-runner.ts");
    const long = "a".repeat(200);
    const out = summarizeUserPrompt(long, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("pickStickyPromptId", () => {
  test("returns the last user prompt scrolled above the viewport on a long turn", () => {
    expect(
      pickStickyPromptId({
        scrollTop: 500,
        containerTop: 100,
        containerBottom: 900,
        prompts: [
          { id: "u1", top: -600, bottom: -540 },
          { id: "u2", top: -180, bottom: -120 },
          { id: "u3", top: 700, bottom: 760 },
        ],
      }),
    ).toBe("u2");
  });

  test("returns null near top of transcript or right before the next prompt", () => {
    expect(
      pickStickyPromptId({
        scrollTop: 40,
        containerTop: 100,
        containerBottom: 900,
        prompts: [{ id: "u1", top: -50, bottom: 10 }],
      }),
    ).toBeNull();

    expect(
      pickStickyPromptId({
        scrollTop: 400,
        containerTop: 100,
        containerBottom: 900,
        prompts: [
          { id: "u1", top: -180, bottom: -120 },
          { id: "u2", top: 210, bottom: 260 },
        ],
      }),
    ).toBeNull();
  });
});
