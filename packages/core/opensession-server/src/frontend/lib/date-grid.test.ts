import { describe, expect, it } from "bun:test";
import {
  addDays,
  addMonths,
  clampDay,
  dayInMonth,
  daysInMonth,
  formatDay,
  formatDayRange,
  isIsoDay,
  isWithin,
  monthGrid,
  monthTitle,
  rangeSpanAt,
  startOfMonth,
  weekdayHeadings,
  weekStartFor,
} from "./date-grid";

describe("isIsoDay", () => {
  it("takes a real day", () => {
    expect(isIsoDay("2026-07-19")).toBe(true);
    expect(isIsoDay("2024-02-29")).toBe(true);
  });

  it("rejects a plausible string that is not a day", () => {
    // Date.UTC would normalise both of these instead of failing.
    expect(isIsoDay("2026-13-01")).toBe(false);
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("2025-02-29")).toBe(false);
    expect(isIsoDay("19/07/2026")).toBe(false);
    expect(isIsoDay("")).toBe(false);
    expect(isIsoDay(null)).toBe(false);
  });
});

describe("addDays", () => {
  it("crosses a month and a year", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("crosses a DST boundary without losing a day", () => {
    // Europe/Amsterdam springs forward on 2026-03-29; in UTC nothing moves.
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
  });
});

describe("addMonths", () => {
  it("clamps into a shorter month rather than spilling over", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("crosses years", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });
});

describe("daysInMonth", () => {
  it("knows the short months and leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe("monthGrid", () => {
  it("always returns six weeks of seven days", () => {
    for (const anchor of ["2026-02-10", "2026-07-19", "2026-08-01"]) {
      const grid = monthGrid(anchor, 1);
      expect(grid).toHaveLength(6);
      for (const week of grid) expect(week).toHaveLength(7);
    }
  });

  it("leads in from the week start and runs unbroken", () => {
    // July 2026 opens on a Wednesday, so a Monday-start grid leads with
    // Jun 29, the month shown in the analytics range picker.
    const grid = monthGrid("2026-07-19", 1);
    expect(grid[0][0]).toBe("2026-06-29");
    expect(grid[0][2]).toBe("2026-07-01");
    expect(grid[5][6]).toBe("2026-08-09");

    const flat = grid.flat();
    for (let i = 1; i < flat.length; i++) {
      expect(flat[i]).toBe(addDays(flat[i - 1], 1));
    }
  });

  it("shifts the lead-in with the week start", () => {
    expect(monthGrid("2026-07-19", 0)[0][0]).toBe("2026-06-28");
    expect(monthGrid("2026-07-19", 6)[0][0]).toBe("2026-06-27");
  });

  it("opens on the 1st when the month starts on the week start, and runs long", () => {
    // June 2026 opens on a Monday, so a Monday-start grid has no lead-in and
    // spends all six rows' slack on the far end.
    const grid = monthGrid("2026-06-15", 1);
    expect(grid[0][0]).toBe("2026-06-01");
    expect(grid[5][6]).toBe("2026-07-12");
  });

  it("holds the anchor's month whatever day of it is passed", () => {
    expect(monthGrid("2026-07-01", 1)).toEqual(monthGrid("2026-07-31", 1));
  });
});

describe("bounds", () => {
  it("treats both ends as inclusive", () => {
    expect(isWithin("2026-07-19", "2026-07-19", "2026-08-17")).toBe(true);
    expect(isWithin("2026-08-17", "2026-07-19", "2026-08-17")).toBe(true);
    expect(isWithin("2026-07-18", "2026-07-19", "2026-08-17")).toBe(false);
    expect(isWithin("2026-08-18", "2026-07-19", "2026-08-17")).toBe(false);
  });

  it("passes anything through when a bound is missing", () => {
    expect(isWithin("1999-01-01", undefined, "2026-08-17")).toBe(true);
    expect(isWithin("2999-01-01", "2026-07-19", undefined)).toBe(true);
  });

  it("clamps to the nearest bound", () => {
    expect(clampDay("2026-01-01", "2026-07-19", "2026-08-17")).toBe(
      "2026-07-19",
    );
    expect(clampDay("2026-12-01", "2026-07-19", "2026-08-17")).toBe(
      "2026-08-17",
    );
    expect(clampDay("2026-08-01", "2026-07-19", "2026-08-17")).toBe(
      "2026-08-01",
    );
  });
});

describe("startOfMonth", () => {
  it("keeps the month and drops the day", () => {
    expect(startOfMonth("2026-07-19")).toBe("2026-07-01");
  });
});

describe("dayInMonth", () => {
  it("keeps the day of the month", () => {
    expect(dayInMonth("2026-08-01", 19)).toBe("2026-08-19");
  });

  it("clamps to the month's length in both directions", () => {
    expect(dayInMonth("2026-02-01", 31)).toBe("2026-02-28");
    expect(dayInMonth("2024-02-01", 31)).toBe("2024-02-29");
    expect(dayInMonth("2026-07-01", 0)).toBe("2026-07-01");
  });
});

describe("rangeSpanAt", () => {
  // One week of the July 2026 grid, Sunday-start: Jul 19 through Jul 25.
  const week = monthGrid("2026-07-19", 0)[3];

  it("paints nothing without both ends, or outside them", () => {
    expect(
      rangeSpanAt("2026-07-20", week, 1, undefined, "2026-08-17"),
    ).toBeNull();
    expect(
      rangeSpanAt("2026-07-20", week, 1, "2026-07-19", undefined),
    ).toBeNull();
    expect(
      rangeSpanAt("2026-07-18", week, 1, "2026-07-19", "2026-08-17"),
    ).toBeNull();
    expect(
      rangeSpanAt("2026-08-18", week, 1, "2026-07-19", "2026-08-17"),
    ).toBeNull();
  });

  it("paints nothing when the range is inverted", () => {
    expect(
      rangeSpanAt("2026-07-20", week, 1, "2026-08-17", "2026-07-19"),
    ).toBeNull();
  });

  it("opens at the range start and closes at its end", () => {
    expect(
      rangeSpanAt("2026-07-19", week, 0, "2026-07-19", "2026-07-22"),
    ).toEqual({
      open: true,
      close: false,
    });
    expect(
      rangeSpanAt("2026-07-22", week, 3, "2026-07-19", "2026-07-22"),
    ).toEqual({
      open: false,
      close: true,
    });
  });

  it("closes at the ends of a week so the band follows the row", () => {
    // A range spanning the whole week: the row's own edges cap it.
    expect(rangeSpanAt(week[0], week, 0, "2026-07-01", "2026-08-17")).toEqual({
      open: true,
      close: false,
    });
    expect(rangeSpanAt(week[6], week, 6, "2026-07-01", "2026-08-17")).toEqual({
      open: false,
      close: true,
    });
    expect(rangeSpanAt(week[3], week, 3, "2026-07-01", "2026-08-17")).toEqual({
      open: false,
      close: false,
    });
  });

  it("caps both ends of a single-day range", () => {
    expect(
      rangeSpanAt("2026-07-21", week, 2, "2026-07-21", "2026-07-21"),
    ).toEqual({
      open: true,
      close: true,
    });
  });
});

describe("labels", () => {
  it("names the month and year", () => {
    expect(monthTitle("2026-07-19", "en-US")).toBe("July 2026");
  });

  it("formats a day a field can read", () => {
    expect(formatDay("2026-07-19", "en-US")).toBe("Jul 19, 2026");
  });

  it("says the year once in a range inside one year", () => {
    expect(formatDayRange("2026-05-20", "2026-08-17", "en-US")).toBe(
      "May 20 – Aug 17, 2026",
    );
  });

  it("keeps both years when a range crosses one", () => {
    expect(formatDayRange("2025-12-20", "2026-08-17", "en-US")).toBe(
      "Dec 20, 2025 – Aug 17, 2026",
    );
  });

  it("heads the columns in week order", () => {
    const monday = weekdayHeadings(1, "en-US").map((h) => h.long);
    expect(monday[0]).toBe("Monday");
    expect(monday[6]).toBe("Sunday");

    const sunday = weekdayHeadings(0, "en-US").map((h) => h.long);
    expect(sunday[0]).toBe("Sunday");
    expect(sunday[6]).toBe("Saturday");
  });
});

describe("weekStartFor", () => {
  it("reads the locale's own week start, or falls back to Monday", () => {
    // Intl week info is not on every engine; the contract is only that the
    // answer is a weekday index, and Monday where nothing is known.
    for (const locale of ["en-US", "en-GB", "nl-NL", "not-a-locale"]) {
      const start = weekStartFor(locale);
      expect(Number.isInteger(start)).toBe(true);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThanOrEqual(6);
    }
  });
});
