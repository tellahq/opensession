// Workspace snoozes, stored server-side per user (keyed on the UserPicker
// name) like pins, so they follow you across devices. A snooze is an overlay
// on a sidebar row key (`workspace:<id>` or a solo session id): while its `until`
// is in the future, or is `"someday"`, the row parks in the Snoozed section; once lapsed the entry
// is ignored (the row falls back to its derived lane) and the Sidebar prunes
// it, marking the row unread so the wake is visible. The public API stays
// synchronous (an in-memory cache): the store is a lib/user-map instance,
// which owns hydration and ordered per-key delta writes.
import { fetchSnoozes, saveSnoozesApi } from "./api";
import * as userMap from "./user-map";

const CHANGE_EVENT = "opensession-snoozes-changed";
export const SNOOZE_SOMEDAY = "someday";

const store = userMap.makeUserMap<string>({
  changeEvent: CHANGE_EVENT,
  fetchMap: fetchSnoozes,
  saveDelta: saveSnoozesApi,
});

export function getSnoozes(): Record<string, string> {
  return store.get();
}

/** Whether a stored snooze is still active. */
export function snoozeIsActive(
  until: string | undefined,
  now = Date.now(),
): boolean {
  return until === SNOOZE_SOMEDAY || (!!until && Date.parse(until) > now);
}

/** The active snooze value for a row key, or null (lapsed entries excluded). */
export function snoozeUntil(key: string): string | null {
  const until = store.get()[key];
  return snoozeIsActive(until) ? until : null;
}

export function setSnooze(key: string, untilIso: string): void {
  store.update((snoozes) => ({ ...snoozes, [key]: untilIso }));
}

export function clearSnooze(key: string): void {
  store.update((snoozes) => {
    if (!(key in snoozes)) return null;
    const next = { ...snoozes };
    delete next[key];
    return next;
  });
}

export function onSnoozesChanged(handler: () => void): () => void {
  return store.onChanged(handler);
}

// ── Snooze presets (the right-click flyout) ─────────────────────────────────
// T3-style: each option resolves to a concrete local time, shown in the label.
// "This evening" only offers while it's still meaningfully ahead of 6 PM.

export interface SnoozePreset {
  label: string;
  until: string;
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString([], { weekday: "short" });
}

export function snoozePresets(now = new Date()): SnoozePreset[] {
  const out: SnoozePreset[] = [];
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  out.push({
    label: `In 1 hour (${fmtTime(inOneHour)})`,
    until: inOneHour.toISOString(),
  });
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() - now.getTime() > 30 * 60 * 1000)
    out.push({
      label: `This evening (${fmtTime(evening)})`,
      until: evening.toISOString(),
    });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  out.push({
    label: `Tomorrow (${fmtDay(tomorrow)} ${fmtTime(tomorrow)})`,
    until: tomorrow.toISOString(),
  });
  const nextWeek = new Date(now);
  // Next Monday 9:00 — always at least a full day out.
  const day = nextWeek.getDay(); // 0 = Sunday
  const daysToMonday = (8 - day) % 7 || 7;
  nextWeek.setDate(nextWeek.getDate() + daysToMonday);
  nextWeek.setHours(9, 0, 0, 0);
  out.push({
    label: `Next week (${fmtDay(nextWeek)} ${fmtTime(nextWeek)})`,
    until: nextWeek.toISOString(),
  });
  out.push({ label: "Someday", until: SNOOZE_SOMEDAY });
  return out;
}

/** Compact time-to-wake for the row badge: "57m", "14h", "6d". */
export function formatRemaining(untilIso: string, nowMs = Date.now()): string {
  if (untilIso === SNOOZE_SOMEDAY) return "Someday";
  const ms = Math.max(0, Date.parse(untilIso) - nowMs);
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
