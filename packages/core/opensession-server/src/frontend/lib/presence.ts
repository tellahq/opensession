/**
 * Who the session header's facepile is about.
 *
 * The `presence` frame carries one name per SOCKET, including every socket of
 * your own — so the raw list is not a list of people, and it is not a list of
 * OTHER people either. Both corrections happen here:
 *
 * - Your own faces come out. You know you're here; a face that is always
 *   present on every session you open is the one thing a presence pile must
 *   never show, because it reads as somebody standing behind you rather than
 *   as multiplayer. (The native app has always filtered its own name out.)
 * - Everyone else is counted per person, so a teammate with a laptop and a
 *   phone on the same session is one face, not two.
 *
 * Names arrive as the picker's first-name form ("Kent"), but a client can hold
 * the full display name ("Kent de Bruin") — compare on the person key, or you
 * filter nobody and every session shows your own face again.
 */

import { personKey } from "./review-queue";

/** Presence viewers minus your own devices. */
export function otherViewers(viewers: string[], me?: string | null): string[] {
  const mine = personKey(me || "");
  if (!mine) return [...viewers];
  return viewers.filter((v) => personKey(v) !== mine);
}

/** One entry per person, in first-seen order, with how many devices they have. */
export function dedupeViewers(
  viewers: string[],
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of viewers) counts.set(v, (counts.get(v) || 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, count }));
}

/** Match Feed's pile: reading order is also front-to-back, and every squircle
 * cuts a full ring in the surface beneath it. */
export function facepileAvatarStyle(
  index: number,
  count: number,
  ring: string,
) {
  return {
    zIndex: count - index,
    boxShadow: `var(--avatar-edge), 0 0 0 2px ${ring}`,
  };
}
