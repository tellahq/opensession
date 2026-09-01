/**
 * Shared mechanics for the swipe decks (Support Tinder, catch-up).
 * The motion numbers are deliberately identical across decks — change them
 * here and every deck keeps the same feel.
 */

/** Px of drag past which a release commits. */
export const SWIPE_DISTANCE = 110;
/** Px/s flick that commits regardless of distance. */
export const SWIPE_VELOCITY = 520;
/** How long an undo/status toast lingers. */
export const UNDO_MS = 7000;

/** Fisher–Yates, returns a new array — the deck order is rolled once per visit. */
export function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function ageDays(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000);
}

/** "today" for anything under a day, else "Nd"; empty for a missing timestamp. */
export function ageLabel(ts: string | null): string {
  if (!ts) return "";
  const d = ageDays(ts);
  if (d <= 0) return "today";
  return `${d}d`;
}

/**
 * Fresh green, drifting yellow, stale red — the CLI's age tint. The thresholds
 * are per-deck (Support Tinder reads ticket age at 1/4 days), so each caller
 * passes its own.
 */
export function ageTone(
  ts: string | null,
  freshDays: number,
  staleDays: number,
): string {
  if (!ts) return "text-faint";
  const d = ageDays(ts);
  if (d < freshDays) return "text-green";
  if (d < staleDays) return "text-yellow";
  return "text-red";
}
