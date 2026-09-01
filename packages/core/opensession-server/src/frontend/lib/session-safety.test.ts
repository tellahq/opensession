import { describe, expect, test } from "bun:test";
import { safetyContinuationPrompt } from "./session-safety";

describe("paused session continuation", () => {
  test("carries queued prompts in order without claiming the uncertain action completed", () => {
    const prompt = safetyContinuationPrompt("Ship the fix", [
      { content: "Please include the mobile layout", user: "Ada" },
      { content: "", images: ["data:image/png;base64,abc"] },
    ]);

    expect(prompt).toContain("avoid repeating uncertain side effects");
    expect(
      prompt.indexOf("Ada: Please include the mobile layout"),
    ).toBeLessThan(prompt.indexOf("User: (attachment only)"));
    expect(prompt).toContain("1 attachment");
  });

  test("still carries transcript context when no prompt was queued", () => {
    expect(safetyContinuationPrompt("Investigate", [])).toContain(
      "Review the carried conversation",
    );
  });
});
