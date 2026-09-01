import type { OpenPr } from "./api";

/** Keep an unchanged poll response referentially stable so Sidebar does not
 * reconcile every row just because the server returned a fresh JSON array. */
export function sameOpenPrSnapshot(
  current: readonly OpenPr[] | null,
  next: readonly OpenPr[],
): boolean {
  if (current === null || current.length !== next.length) return false;
  return JSON.stringify(current) === JSON.stringify(next);
}
