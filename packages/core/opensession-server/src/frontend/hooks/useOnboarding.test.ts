import { describe, expect, test } from "bun:test";
import {
  onboardingResponseCompleted,
  shouldRecheckOnboarding,
} from "./useOnboarding";

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

describe("onboarding recheck after sign-in", () => {
  const signedOut = { required: true, authenticated: false };
  const signedIn = { required: true, authenticated: true, login: "acme" };

  test("rechecks once a signed-out browser signs in", () => {
    expect(shouldRecheckOnboarding(signedOut, signedIn, "failed")).toBe(true);
    // The 401 for a request sent before sign-in may not have arrived yet.
    expect(shouldRecheckOnboarding(signedOut, signedIn, "loading")).toBe(true);
  });

  test("retries a failed check when sign-in is confirmed", () => {
    expect(shouldRecheckOnboarding(null, signedIn, "failed")).toBe(true);
    expect(
      shouldRecheckOnboarding(
        null,
        { required: false, authenticated: false },
        "failed",
      ),
    ).toBe(true);
  });

  test("leaves a settled or in-flight check alone on a normal load", () => {
    expect(shouldRecheckOnboarding(null, signedIn, "loading")).toBe(false);
    expect(shouldRecheckOnboarding(null, signedIn, "complete")).toBe(false);
    expect(shouldRecheckOnboarding(signedIn, signedIn, "required")).toBe(false);
  });

  test("does not recheck while still signed out", () => {
    expect(shouldRecheckOnboarding(null, signedOut, "failed")).toBe(false);
    expect(shouldRecheckOnboarding(signedIn, null, "failed")).toBe(false);
  });
});
