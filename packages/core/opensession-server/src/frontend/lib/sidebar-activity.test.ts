import { describe, expect, test } from "bun:test";
import { activityBandFor, type ActivityRow } from "./sidebar-activity";

const TODAY = Date.parse("2026-08-22T00:00:00Z");

function row(patch: Partial<ActivityRow> = {}): ActivityRow {
  return {
    lastActivity: "2026-08-20T12:00:00Z",
    running: false,
    status: "pending",
    ...patch,
  };
}

describe("activity sidebar bands", () => {
  test("separates running work from idle recent work", () => {
    expect(activityBandFor(row({ running: true }), TODAY, false)).toBe(
      "inprogress",
    );
    expect(
      activityBandFor(
        row({ lastActivity: "2026-08-22T09:00:00Z" }),
        TODAY,
        false,
      ),
    ).toBe("recent");
  });

  test("keeps drafts and blocked work in their higher-priority bands", () => {
    expect(activityBandFor(row({ running: true }), TODAY, true)).toBe("drafts");
    expect(
      activityBandFor(
        row({ running: true, status: "needsinput" }),
        TODAY,
        false,
      ),
    ).toBe("needsaction");
  });

  test("keeps idle work in its activity-day band", () => {
    expect(
      activityBandFor(
        row({ lastActivity: "2026-08-21T09:00:00Z" }),
        TODAY,
        false,
      ),
    ).toBe("yesterday");
    expect(activityBandFor(row(), TODAY, false)).toBe("earlier");
  });
});
