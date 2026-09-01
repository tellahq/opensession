/** Very short relative time ("now", "5m", "3h", "2d", then a date). Used by
 * message labels and sidebar workspace rows; pair with a tooltip/title carrying
 * the full local time. */
export function shortTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(+d)) return "";
  const s = (Date.now() - +d) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The real wall-clock time behind a message, written out: "Today at 14:32",
 * "Yesterday at 09:05", "Jul 12 at 14:32", "Jul 12, 2025 at 14:32". The locale
 * picks 12h/24h; no seconds — a transcript reads in minutes, and durations are
 * the TurnFooter's job. Used by hover reveals and timestamp tooltips.
 *
 * Absolute only, deliberately: these strings render inside memoized bubbles
 * with stable entry refs, so a relative part ("5m ago") would freeze at
 * whatever it was when the bubble last rendered. Only the day words go stale,
 * and only across midnight — the same tradeoff shortTime already makes. */
export function fullTime(ts: string, now: Date = new Date()): string {
  const d = new Date(ts);
  if (Number.isNaN(+d)) return "";
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const midnight = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(d)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date} at ${time}`;
}

/** A duration, one unit at a time: "7s", "42s", "1m", "12m", "1h 4m", "2h".
 * Null under a second — there is nothing worth showing.
 *
 * Seconds are dropped the moment a minute is on the clock: past that they are
 * noise nobody reads, and on a live ticker they also make the string change
 * width every second. Hours keep their minutes, because rounding a 1h59m run
 * down to "1h" throws away an hour of it — the ratio seconds have to a minute
 * is the same, but a minute is not worth the same as an hour.
 *
 * Used by every duration in the UI: the sidebar's live run ticker, turn and
 * tool footers, automation and workflow run ledgers. Pair a live one with
 * `tabular-nums` so the digits don't jitter as they tick. */
export function formatDuration(ms: number): string | null {
  const secs = Math.round(ms / 1000);
  if (!Number.isFinite(secs) || secs < 1) return null;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
}

/** Live elapsed time since `fromMs`, for tickers that count a run up. Reads
 * "0s" rather than nothing at the very start, so the slot doesn't pop in. */
export function elapsedSince(
  fromMs: number,
  nowMs: number = Date.now(),
): string {
  return formatDuration(Math.max(0, nowMs - fromMs)) ?? "0s";
}

/** Coarse relative age for prewarming/papercuts status lines ("just now",
 * "5m ago", "3h ago", "2d ago"; "never" without a timestamp). */
export function warmAgo(iso?: string): string {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
