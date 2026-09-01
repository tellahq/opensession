import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const root = `${process.env.OPENSESSION_SCRATCH || "/tmp"}/opensession-snoozes-test-${process.pid}`;
process.env.OPENSESSION_STATE_DIR = root;

const { getSnoozes, setSnoozes, SNOOZE_SOMEDAY } = await import("./snoozes");
const { getSettlements, setSettlements } = await import("./settlements");

beforeEach(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("per-user snoozes", () => {
  test("keeps timed and Someday snoozes", () => {
    setSnoozes("Michiel", {
      "workspace:timed": "2027-01-01T09:00:00.000Z",
      "workspace:someday": SNOOZE_SOMEDAY,
      "workspace:bad": "later perhaps",
    });
    expect(getSnoozes("Michiel")).toEqual({
      "workspace:timed": "2027-01-01T09:00:00.000Z",
      "workspace:someday": SNOOZE_SOMEDAY,
    });
  });

  test("migrates Settled rows to Someday once", () => {
    setSnoozes("Michiel", {
      "workspace:timed": "2027-01-01T09:00:00.000Z",
    });
    setSettlements("Michiel", {
      "workspace:new": { state: "settled", at: "2026-08-20T12:00:00Z" },
      "workspace:timed": { state: "settled", at: "2026-08-20T12:00:00Z" },
      "workspace:active": { state: "active", at: "2026-08-20T12:00:00Z" },
    });

    expect(getSnoozes("Michiel")).toEqual({
      "workspace:new": SNOOZE_SOMEDAY,
      "workspace:timed": "2027-01-01T09:00:00.000Z",
    });
    expect(getSettlements("Michiel")).toEqual({});

    setSnoozes("Michiel", {});
    expect(getSnoozes("Michiel")).toEqual({});
  });
});
