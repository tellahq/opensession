import { describe, expect, test } from "bun:test";
import {
  SNOOZE_SOMEDAY,
  formatRemaining,
  snoozeIsActive,
  snoozePresets,
} from "./snoozes";

describe("workspace snoozes", () => {
  test("Someday never lapses and reads plainly", () => {
    expect(snoozeIsActive(SNOOZE_SOMEDAY, Date.UTC(9999, 0, 1))).toBe(true);
    expect(formatRemaining(SNOOZE_SOMEDAY)).toBe("Someday");
  });

  test("timed snoozes still wake", () => {
    expect(
      snoozeIsActive(
        "2026-08-20T13:00:00Z",
        Date.parse("2026-08-20T12:00:00Z"),
      ),
    ).toBe(true);
    expect(
      snoozeIsActive(
        "2026-08-20T11:00:00Z",
        Date.parse("2026-08-20T12:00:00Z"),
      ),
    ).toBe(false);
  });

  test("Someday is the final preset", () => {
    const presets = snoozePresets(new Date("2026-08-20T12:00:00Z"));
    expect(presets.at(-1)).toEqual({ label: "Someday", until: SNOOZE_SOMEDAY });
    expect(
      presets
        .slice(0, -1)
        .every((preset) => !Number.isNaN(Date.parse(preset.until))),
    ).toBe(true);
  });
});
