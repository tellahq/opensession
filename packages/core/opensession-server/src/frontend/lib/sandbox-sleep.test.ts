import { expect, test } from "bun:test";
import { sandboxSleepSummary, sleepsInLabel } from "./sandbox-sleep";

test("says what a sleeping Sandbox keeps", () => {
  expect(sandboxSleepSummary("box")).toBe(
    "Keeps files while asleep. Running processes start again on wake.",
  );
});

test("counts down to the idle deadline", () => {
  const now = Date.parse("2026-10-25T10:00:00Z");
  expect(sleepsInLabel("2026-10-25T10:12:10Z", now)).toBe(
    "Sleeps in 13 min if unused",
  );
  expect(sleepsInLabel("2026-10-25T10:00:30Z", now)).toBe(
    "Sleeps in under a minute if unused",
  );
  expect(sleepsInLabel(undefined, now)).toBeNull();
});
