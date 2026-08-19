import { describe, expect, it } from "bun:test";
import {
  MAX_CATCHUP_MINUTES,
  cronMatches,
  minuteKey,
  nextRun,
  parseCron,
  pendingMinutes,
} from "./cron";

// Helper: build a UTC date. Month is 1-based here for readability.
function utc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

describe("parseCron", () => {
  it("parses a wildcard expression", () => {
    const specs = parseCron("* * * * *");
    expect(specs).not.toBeNull();
    expect(specs!.length).toBe(5);
    for (const s of specs!) expect(s.any).toBe(true);
  });

  it("parses exact values, ranges, steps and lists", () => {
    expect(parseCron("0 12 * * *")).not.toBeNull();
    expect(parseCron("1-5 * * * *")).not.toBeNull();
    expect(parseCron("*/15 * * * *")).not.toBeNull();
    expect(parseCron("1-30/5 * * * *")).not.toBeNull();
    expect(parseCron("1,15,45 * * * *")).not.toBeNull();
    expect(parseCron("0 9,17 * * 1-5")).not.toBeNull();
  });

  it("tolerates extra whitespace", () => {
    expect(parseCron("  0  12 * *   * ")).not.toBeNull();
  });

  it("rejects the wrong number of fields", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * * *")).toBeNull();
    expect(parseCron("* * * * * *")).toBeNull();
  });

  it("rejects out-of-range values", () => {
    expect(parseCron("60 * * * *")).toBeNull(); // minute > 59
    expect(parseCron("* 24 * * *")).toBeNull(); // hour > 23
    expect(parseCron("* * 0 * *")).toBeNull(); // day-of-month < 1
    expect(parseCron("* * 32 * *")).toBeNull(); // day-of-month > 31
    expect(parseCron("* * * 0 *")).toBeNull(); // month < 1
    expect(parseCron("* * * 13 *")).toBeNull(); // month > 12
    expect(parseCron("* * * * 8")).toBeNull(); // dow > 7
    expect(parseCron("50-70 * * * *")).toBeNull(); // range runs out of bounds
  });

  it("rejects malformed fields", () => {
    expect(parseCron("a * * * *")).toBeNull();
    expect(parseCron("1--5 * * * *")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull(); // step < 1
    expect(parseCron("-5 * * * *")).toBeNull();
    expect(parseCron("1-5-9 * * * *")).toBeNull();
    expect(parseCron("*/x * * * *")).toBeNull();
  });

  it("accepts dow 7 as an alias for Sunday", () => {
    expect(parseCron("* * * * 7")).not.toBeNull();
    expect(parseCron("* * * * 0")).not.toBeNull();
  });

  // NOTE: possible bug — a reversed range like "5-1" parses "successfully" but
  // yields an empty value set: the loop `for (v = lo; v <= hi)` never runs, so
  // the field matches nothing and the expression silently never fires (and
  // nextRun scans a full year before giving up). Arguably parseCron should
  // return null here. This test documents current behavior.
  it("reversed range parses but never matches (documented quirk)", () => {
    const specs = parseCron("5-1 * * * *");
    expect(specs).not.toBeNull();
    expect(specs![0].any).toBe(false);
    expect(specs![0].values.size).toBe(0);
    for (const m of [0, 1, 3, 5, 30]) {
      expect(cronMatches("5-1 * * * *", utc(2026, 7, 1, 10, m))).toBe(false);
    }
  });
});

describe("cronMatches", () => {
  it("wildcard matches any minute", () => {
    expect(cronMatches("* * * * *", utc(2026, 7, 1, 10, 30))).toBe(true);
    expect(cronMatches("* * * * *", utc(2026, 12, 31, 23, 59))).toBe(true);
  });

  it("matches exact minute/hour", () => {
    expect(cronMatches("30 14 * * *", utc(2026, 7, 1, 14, 30))).toBe(true);
    expect(cronMatches("30 14 * * *", utc(2026, 7, 1, 14, 31))).toBe(false);
    expect(cronMatches("30 14 * * *", utc(2026, 7, 1, 15, 30))).toBe(false);
  });

  it("matches ranges", () => {
    // 2026-07-01 is a Wednesday (dow 3)
    expect(cronMatches("0 9 * * 1-5", utc(2026, 7, 1, 9, 0))).toBe(true);
    // 2026-07-05 is a Sunday (dow 0)
    expect(cronMatches("0 9 * * 1-5", utc(2026, 7, 5, 9, 0))).toBe(false);
  });

  it("matches steps", () => {
    for (const m of [0, 15, 30, 45]) {
      expect(cronMatches("*/15 * * * *", utc(2026, 7, 1, 8, m))).toBe(true);
    }
    for (const m of [1, 14, 16, 59]) {
      expect(cronMatches("*/15 * * * *", utc(2026, 7, 1, 8, m))).toBe(false);
    }
  });

  it("matches ranged steps (1-30/5)", () => {
    for (const m of [1, 6, 11, 16, 21, 26]) {
      expect(cronMatches("1-30/5 * * * *", utc(2026, 7, 1, 8, m))).toBe(true);
    }
    for (const m of [0, 2, 5, 30, 31, 36]) {
      expect(cronMatches("1-30/5 * * * *", utc(2026, 7, 1, 8, m))).toBe(false);
    }
  });

  it("supports 'a/n' meaning a..max step n", () => {
    for (const m of [10, 30, 50]) {
      expect(cronMatches("10/20 * * * *", utc(2026, 7, 1, 8, m))).toBe(true);
    }
    for (const m of [0, 20, 40]) {
      expect(cronMatches("10/20 * * * *", utc(2026, 7, 1, 8, m))).toBe(false);
    }
  });

  it("matches comma lists", () => {
    for (const m of [1, 15, 45]) {
      expect(cronMatches("1,15,45 * * * *", utc(2026, 7, 1, 8, m))).toBe(true);
    }
    expect(cronMatches("1,15,45 * * * *", utc(2026, 7, 1, 8, 30))).toBe(false);
  });

  it("treats dow 7 as Sunday", () => {
    const sunday = utc(2026, 7, 5, 6, 0); // 2026-07-05 is a Sunday
    const monday = utc(2026, 7, 6, 6, 0);
    expect(cronMatches("0 6 * * 7", sunday)).toBe(true);
    expect(cronMatches("0 6 * * 0", sunday)).toBe(true);
    expect(cronMatches("0 6 * * 7", monday)).toBe(false);
  });

  it("dow range ending in 7 includes Sunday", () => {
    const saturday = utc(2026, 7, 4, 6, 0);
    const sunday = utc(2026, 7, 5, 6, 0);
    const friday = utc(2026, 7, 3, 6, 0);
    expect(cronMatches("0 6 * * 6-7", saturday)).toBe(true);
    expect(cronMatches("0 6 * * 6-7", sunday)).toBe(true);
    expect(cronMatches("0 6 * * 6-7", friday)).toBe(false);
  });

  it("month field matches 1-based months", () => {
    expect(cronMatches("0 0 * 7 *", utc(2026, 7, 15, 0, 0))).toBe(true);
    expect(cronMatches("0 0 * 7 *", utc(2026, 8, 15, 0, 0))).toBe(false);
  });

  it("dom-only restriction requires dom to match", () => {
    expect(cronMatches("0 0 15 * *", utc(2026, 7, 15, 0, 0))).toBe(true);
    expect(cronMatches("0 0 15 * *", utc(2026, 7, 16, 0, 0))).toBe(false);
  });

  it("dow-only restriction requires dow to match", () => {
    // 2026-07-03 is a Friday (dow 5)
    expect(cronMatches("0 0 * * 5", utc(2026, 7, 3, 0, 0))).toBe(true);
    expect(cronMatches("0 0 * * 5", utc(2026, 7, 4, 0, 0))).toBe(false);
  });

  it("when both dom and dow are restricted, either may match (OR)", () => {
    const expr = "0 0 13 * 5"; // 13th of the month OR any Friday
    // 2026-07-03: Friday, not the 13th → matches via dow
    expect(cronMatches(expr, utc(2026, 7, 3, 0, 0))).toBe(true);
    // 2026-07-13: Monday the 13th → matches via dom
    expect(cronMatches(expr, utc(2026, 7, 13, 0, 0))).toBe(true);
    // 2026-07-01: Wednesday the 1st → neither
    expect(cronMatches(expr, utc(2026, 7, 1, 0, 0))).toBe(false);
  });

  it("returns false for invalid expressions", () => {
    expect(cronMatches("not a cron", utc(2026, 7, 1, 0, 0))).toBe(false);
    expect(cronMatches("61 * * * *", utc(2026, 7, 1, 0, 0))).toBe(false);
  });
});

describe("nextRun", () => {
  it("returns the next matching minute strictly after `from`", () => {
    const from = utc(2026, 7, 1, 8, 10, 30);
    const next = nextRun("*/15 * * * *", from);
    expect(next).toEqual(utc(2026, 7, 1, 8, 15, 0));
  });

  it("is strictly after: an exact-match `from` rolls to the next occurrence", () => {
    const from = utc(2026, 7, 1, 8, 15, 0);
    const next = nextRun("*/15 * * * *", from);
    expect(next).toEqual(utc(2026, 7, 1, 8, 30, 0));
  });

  it("zeroes seconds/millis", () => {
    const from = new Date(Date.UTC(2026, 6, 1, 8, 0, 42, 500));
    const next = nextRun("* * * * *", from);
    expect(next).toEqual(utc(2026, 7, 1, 8, 1, 0));
  });

  it("rolls over an hour boundary", () => {
    const next = nextRun("*/15 * * * *", utc(2026, 7, 1, 8, 50));
    expect(next).toEqual(utc(2026, 7, 1, 9, 0, 0));
  });

  it("rolls over a day boundary", () => {
    const next = nextRun("30 8 * * *", utc(2026, 7, 1, 9, 0));
    expect(next).toEqual(utc(2026, 7, 2, 8, 30, 0));
  });

  it("rolls over a month boundary", () => {
    const next = nextRun("0 0 1 * *", utc(2026, 7, 31, 12, 0));
    expect(next).toEqual(utc(2026, 8, 1, 0, 0, 0));
  });

  it("rolls over a year boundary", () => {
    const next = nextRun("0 0 1 1 *", utc(2026, 12, 31, 23, 30));
    expect(next).toEqual(utc(2027, 1, 1, 0, 0, 0));
  });

  it("respects day-of-week when rolling forward", () => {
    // From Wednesday 2026-07-01, next Monday 09:00 is 2026-07-06
    const next = nextRun("0 9 * * 1", utc(2026, 7, 1, 10, 0));
    expect(next).toEqual(utc(2026, 7, 6, 9, 0, 0));
  });

  it("returns null for invalid expressions", () => {
    expect(nextRun("bogus", utc(2026, 7, 1))).toBeNull();
    expect(nextRun("* * * *", utc(2026, 7, 1))).toBeNull();
  });

  it("returns null when nothing matches within ~a year (Feb 31)", () => {
    // Scans the full ~1-year window minute by minute; intentionally slow-ish.
    expect(nextRun("0 0 31 2 *", utc(2026, 7, 1))).toBeNull();
  }, 30_000);

  it("does not mutate the `from` date", () => {
    const from = utc(2026, 7, 1, 8, 10, 30);
    const copy = new Date(from.getTime());
    nextRun("* * * * *", from);
    expect(from.getTime()).toBe(copy.getTime());
  });
});

describe("pendingMinutes", () => {
  it("returns just the current minute when no minute was missed", () => {
    const now = utc(2026, 8, 17, 14, 3, 12);
    expect(pendingMinutes("2026-08-17T14:02", now)).toEqual([utc(2026, 8, 17, 14, 3)]);
  });

  it("returns every whole minute a tick missed, oldest first", () => {
    // Last tick landed in 13:59, next one not until 14:02: 14:00 and 14:01 had
    // no tick in them at all.
    const minutes = pendingMinutes("2026-08-17T13:59", utc(2026, 8, 17, 14, 2, 6));
    expect(minutes).toEqual([
      utc(2026, 8, 17, 14, 0),
      utc(2026, 8, 17, 14, 1),
      utc(2026, 8, 17, 14, 2),
    ]);
  });

  it("catches up nothing on a fresh scheduler", () => {
    // lastMinute "" means "no history", not "replay the last five minutes":
    // a restart must never fire a burst of backdated automations.
    const minutes = pendingMinutes("", utc(2026, 8, 17, 14, 2, 6));
    expect(minutes).toEqual([utc(2026, 8, 17, 14, 2)]);
  });

  it("clamps a long gap to MAX_CATCHUP_MINUTES, keeping the newest", () => {
    const minutes = pendingMinutes("2026-08-17T13:30", utc(2026, 8, 17, 14, 2, 6));
    expect(minutes.length).toBe(MAX_CATCHUP_MINUTES);
    expect(minutes[0]).toEqual(utc(2026, 8, 17, 13, 58));
    expect(minutes[minutes.length - 1]).toEqual(utc(2026, 8, 17, 14, 2));
  });

  it("returns nothing when the clock has not advanced past the last minute", () => {
    expect(pendingMinutes("2026-08-17T14:02", utc(2026, 8, 17, 14, 2, 30))).toEqual([]);
    expect(pendingMinutes("2026-08-17T14:05", utc(2026, 8, 17, 14, 2, 30))).toEqual([]);
  });

  it("falls back to the current minute for an unparseable last minute", () => {
    expect(pendingMinutes("not-a-minute", utc(2026, 8, 17, 14, 2, 6))).toEqual([
      utc(2026, 8, 17, 14, 2),
    ]);
  });

  it("does not mutate `now`", () => {
    const now = utc(2026, 8, 17, 14, 2, 6);
    const copy = now.getTime();
    pendingMinutes("2026-08-17T13:59", now);
    expect(now.getTime()).toBe(copy);
  });
});

// Mirrors the decision the automations scheduler makes on each 20s tick
// (startScheduler in automations.ts): skip a repeat of the same minute, take
// the minutes this tick owns, fire at most once per automation per tick.
function runTicks(schedule: string, ticks: Date[], seed = ""): string[] {
  let lastFiredMinute = seed;
  const fired: string[] = [];
  for (const now of ticks) {
    const currentMinute = minuteKey(now);
    if (currentMinute === lastFiredMinute) continue;
    const minutes = pendingMinutes(lastFiredMinute, now);
    lastFiredMinute = currentMinute;
    if (minutes.some((minute) => cronMatches(schedule, minute))) fired.push(currentMinute);
  }
  return fired;
}

describe("scheduler catch-up", () => {
  it("fires an hourly automation whose minute fell inside a tick gap", () => {
    // The 2026-08-17 incident: ticks stop at 13:59:37 and resume at 14:01:42,
    // so nothing ever woke up inside 14:00 and the hourly slot was lost.
    const fired = runTicks(
      "0 * * * *",
      [utc(2026, 8, 17, 13, 59, 37), utc(2026, 8, 17, 14, 1, 42)],
      "2026-08-17T13:59"
    );
    expect(fired).toEqual(["2026-08-17T14:01"]);
  });

  it("fires nothing retroactively on a fresh boot", () => {
    // Booting at 14:01:46 with the first tick at 14:02:06 must NOT resurrect
    // the 14:00 slot the dead process missed.
    const fired = runTicks("0 * * * *", [
      utc(2026, 8, 17, 14, 2, 6),
      utc(2026, 8, 17, 14, 2, 26),
      utc(2026, 8, 17, 14, 2, 46),
    ]);
    expect(fired).toEqual([]);
  });

  it("still fires the boot minute's own slot", () => {
    // Booting at 14:00:03 with the first tick at 14:00:23: the current minute
    // is always evaluated, so no-catch-up-on-boot does not itself skip a slot.
    const fired = runTicks("0 * * * *", [utc(2026, 8, 17, 14, 0, 23)]);
    expect(fired).toEqual(["2026-08-17T14:00"]);
  });

  it("does not fire every skipped occurrence after a long gap", () => {
    // A per-minute schedule with a 30-minute gap: one catch-up run, not 30.
    const fired = runTicks(
      "* * * * *",
      [utc(2026, 8, 17, 13, 30, 5), utc(2026, 8, 17, 14, 0, 5)],
      "2026-08-17T13:29"
    );
    expect(fired).toEqual(["2026-08-17T13:30", "2026-08-17T14:00"]);
  });

  it("does not double-fire a slot covered by both catch-up and the next tick", () => {
    // 14:00 is caught up by the 14:01 tick; the ticks that follow own only
    // later minutes, so the hourly runs exactly once for the hour.
    const ticks = [
      utc(2026, 8, 17, 13, 59, 40),
      utc(2026, 8, 17, 14, 1, 0),
      utc(2026, 8, 17, 14, 1, 20),
      utc(2026, 8, 17, 14, 1, 40),
      utc(2026, 8, 17, 14, 2, 0),
      utc(2026, 8, 17, 14, 2, 20),
    ];
    expect(runTicks("0 * * * *", ticks, "2026-08-17T13:59")).toEqual(["2026-08-17T14:01"]);
  });

  it("fires an hourly exactly once when ticks land normally", () => {
    const ticks: Date[] = [];
    for (let s = 0; s < 60 * 5; s += 20) ticks.push(new Date(utc(2026, 8, 17, 13, 58, 0).getTime() + s * 1000));
    expect(runTicks("0 * * * *", ticks, "2026-08-17T13:57")).toEqual(["2026-08-17T14:00"]);
  });
});
