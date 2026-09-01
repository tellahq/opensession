import { describe, expect, test } from "bun:test";
import { onboardingResponseCompleted } from "./useOnboarding";

describe("onboarding response compatibility", () => {
  test("treats a missing GET route as a completed legacy instance", async () => {
    expect(
      await onboardingResponseCompleted(
        Response.json({ error: "Not found" }, { status: 404 }),
        true,
      ),
    ).toBe(true);
  });

  test("does not hide a missing completion route", async () => {
    expect(
      onboardingResponseCompleted(
        Response.json({ error: "Not found" }, { status: 404 }),
      ),
    ).rejects.toThrow("Not found");
  });

  test("preserves required and completed responses", async () => {
    expect(
      await onboardingResponseCompleted(Response.json({ completed: false })),
    ).toBe(false);
    expect(
      await onboardingResponseCompleted(Response.json({ completed: true })),
    ).toBe(true);
  });
});
