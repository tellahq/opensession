import { describe, expect, test } from "bun:test";
import {
  explainProviderSafetyBlock,
  isProviderSafetyBlock,
} from "./provider-safety";
import { isTransientRunError } from "./runner-shared";
import { isPiUsageLimitShape } from "./pi-runner";

const rejection =
  "Codex error: This request was blocked by our safety systems. Reason: Potentially unintended activity.";

describe("provider safety blocks", () => {
  test.each([
    rejection,
    `Run failed: pi: ${rejection}`,
    "Provider error: safety_violation",
    '{"error":{"code":"content_policy_violation"}}',
  ])("recognizes the provider rejection: %s", (message) => {
    expect(isProviderSafetyBlock(message)).toBe(true);
  });

  test.each([
    undefined,
    null,
    "",
    "fetch failed (socket hang up)",
    "Codex error: The usage limit has been reached",
    "Path is outside the session workspace",
    "Permission denied",
    "Safety tests failed",
  ])("does not reclassify other errors: %s", (message) => {
    expect(isProviderSafetyBlock(message)).toBe(false);
  });

  test("safety takes precedence over transient and usage-limit text", () => {
    const message = `${rejection} (HTTP 429, gateway timeout)`;
    expect(isTransientRunError(message)).toBe(false);
    for (const provider of ["openai", "anthropic", "xai"]) {
      expect(isPiUsageLimitShape(message, provider)).toBe(false);
    }
  });

  test("preserves the reason and explains that recovery will not retry", () => {
    expect(explainProviderSafetyBlock(rejection)).toBe(
      `${rejection}\nThe model provider blocked this request. Open Session will not automatically retry it or switch accounts or models.`,
    );
    expect(isProviderSafetyBlock(explainProviderSafetyBlock(rejection))).toBe(
      true,
    );
    expect(explainProviderSafetyBlock("fetch failed")).toBe("fetch failed");
  });
});
