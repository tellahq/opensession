/**
 * Calendar arithmetic for `ui/date-picker`, in UTC.
 *
 * The dates these grids show are bare days (`YYYY-MM-DD`), not instants: the
 * analytics range is UTC days and the server buckets them that way. So every
 * step here goes through `Date.UTC` and never through the local-time
 * constructors. `new Date("2026-07-19").getDate()` is the 18th anywhere west
 * of Greenwich, which lands the whole picker a day off for half the world.
 *
 * ISO day strings sort the way the days do, so "is this in the range" is a
 * plain string comparison and no Date object escapes this module.
 */

/** A bare day, `YYYY-MM-DD`. */
export type IsoDay = string;

const DAY_MS = 86_400_000;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function utcMs(day: IsoDay): number {
  return Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
}

export function toIsoDay(ms: number): IsoDay {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Round-trips rather than range-checking the parts: `Date.UTC` happily
 *  normalises month 13 and day 40 into the next year, so only re-formatting
 *  tells a real day from a plausible-looking string. */
export function isIsoDay(value: string | null | undefined): value is IsoDay {
  if (!value || !ISO_SHAPE.test(value)) return false;
  const ms = utcMs(value);
  return !Number.isNaN(ms) && toIsoDay(ms) === value;
}

export function todayIsoDay(): IsoDay {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(day: IsoDay, n: number): IsoDay {
  return toIsoDay(utcMs(day) + n * DAY_MS);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Clamps the day to the target month, so a month step from the 31st lands on
 *  the 28th rather than spilling into March. */
export function addMonths(day: IsoDay, n: number): IsoDay {
  const year = Number(day.slice(0, 4));
  const month0 = Number(day.slice(5, 7)) - 1;
  const date = Number(day.slice(8, 10));
  const target = new Date(Date.UTC(year, month0 + n, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  return toIsoDay(Date.UTC(ty, tm, Math.min(date, daysInMonth(ty, tm + 1))));
}

export function startOfMonth(day: IsoDay): IsoDay {
  return `${day.slice(0, 7)}-01`;
}

/** The same day of the month inside `month`, clamped to its length, so paging
 *  from the 31st into a shorter month lands on its last day. */
export function dayInMonth(month: IsoDay, date: number): IsoDay {
  const year = Number(month.slice(0, 4));
  const month1 = Number(month.slice(5, 7));
  return toIsoDay(
    Date.UTC(
      year,
      month1 - 1,
      Math.min(Math.max(date, 1), daysInMonth(year, month1)),
    ),
  );
}

export function isSameMonth(a: IsoDay, b: IsoDay): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** Inclusive on both ends; an absent bound is no bound. */
export function isWithin(day: IsoDay, min?: IsoDay, max?: IsoDay): boolean {
  if (min && day < min) return false;
  if (max && day > max) return false;
  return true;
}

export function clampDay(day: IsoDay, min?: IsoDay, max?: IsoDay): IsoDay {
  if (min && day < min) return min;
  if (max && day > max) return max;
  return day;
}

/**
 * Which weekday a calendar opens on, 0 = Sunday through 6 = Saturday.
 * `Intl.Locale`'s week info knows (Monday across most of Europe, Sunday in the
 * US), and ships as a method in Chrome and a property in Safari. Monday is the
 * fallback where neither exists.
 */
export function weekStartFor(locale?: string): number {
  try {
    const info = new Intl.Locale(locale ?? resolvedLocale()) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    // Intl counts Monday 1 through Sunday 7; JS counts Sunday 0.
    if (typeof first === "number") return first % 7;
  } catch {
    // An engine without week info, or a locale tag it won't parse.
  }
  return 1;
}

function resolvedLocale(): string {
  return new Intl.DateTimeFormat().resolvedOptions().locale;
}

/**
 * Six weeks of days covering the month `anchor` falls in, starting on
 * `weekStart`. Always six rows: a calendar that grows a row for a 31-day month
 * beginning on a Sunday would resize its own popup as you page through it.
 */
export function monthGrid(anchor: IsoDay, weekStart: number): IsoDay[][] {
  const first = startOfMonth(anchor);
  const lead = (new Date(utcMs(first)).getUTCDay() - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const weeks: IsoDay[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: IsoDay[] = [];
    for (let d = 0; d < 7; d++) row.push(addDays(start, w * 7 + d));
    weeks.push(row);
  }
  return weeks;
}

/** Column headings: the initial to read, the full name for screen readers. */
export function weekdayHeadings(
  weekStart: number,
  locale?: string,
): Array<{ short: string; long: string }> {
  const loc = locale ?? resolvedLocale();
  const narrow = new Intl.DateTimeFormat(loc, {
    weekday: "narrow",
    timeZone: "UTC",
  });
  const long = new Intl.DateTimeFormat(loc, {
    weekday: "long",
    timeZone: "UTC",
  });
  // 2026-03-01 is a Sunday, so this walk starts from a known weekday 0.
  const sunday = Date.UTC(2026, 2, 1);
  return Array.from({ length: 7 }, (_, i) => {
    const at = new Date(sunday + ((weekStart + i) % 7) * DAY_MS);
    return { short: narrow.format(at), long: long.format(at) };
  });
}

export function monthTitle(day: IsoDay, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(utcMs(day)));
}

/** The day as a field reads it: "19 Jul 2026" / "Jul 19, 2026" per locale. */
export function formatDay(day: IsoDay, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(utcMs(day)));
}

/**
 * A range as one label: "May 20 – Aug 17, 2026". The near end drops the year
 * whenever the far end already carries it, because a range inside one year
 * says it once — spelled out twice it is the longest thing in the bar and the
 * repetition is the least informative part of it.
 */
export function formatDayRange(
  from: IsoDay,
  to: IsoDay,
  locale?: string,
): string {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const start = sameYear
    ? new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(utcMs(from)))
    : formatDay(from, locale);
  return `${start} – ${formatDay(to, locale)}`;
}

/** The full day, for the cell's accessible name. */
export function formatDayLong(day: IsoDay, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(utcMs(day)));
}

export function dayOfMonth(day: IsoDay): number {
  return Number(day.slice(8, 10));
}

/**
 * Where a day sits in a painted range: nowhere, or a band that opens, runs
 * through, or closes. A band also closes at the ends of its week, so it
 * follows the row rather than floating off the edge of the grid.
 */
export type RangeSpan = null | { open: boolean; close: boolean };

export function rangeSpanAt(
  day: IsoDay,
  week: IsoDay[],
  index: number,
  from?: IsoDay,
  to?: IsoDay,
): RangeSpan {
  if (!from || !to || from > to || day < from || day > to) return null;
  return {
    open: day === from || index === 0,
    close: day === to || index === week.length - 1,
  };
}
