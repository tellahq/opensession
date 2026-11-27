// Per-user colors for sidebar workspace rows. They share the tab-colors store
// (one per-user map, synced across devices, same swatch keys) under a `row:`
// prefix, so a row's color never also paints a session tab that happens to
// share its id.
import { useEffect, useState } from "react";
import {
  colorHex,
  getTabColors,
  onTabColorsChanged,
  setTabColor,
  TAB_COLORS,
} from "./tab-colors";

export const ROW_COLORS = TAB_COLORS;

function storeKey(rowKey: string): string {
  return `row:${rowKey}`;
}

export function rowColorKey(
  colors: Record<string, string>,
  rowKey: string,
): string | null {
  return colors[storeKey(rowKey)] ?? null;
}

/** Set a row's color, or clear it with `null`. */
export function setRowColor(rowKey: string, color: string | null): void {
  setTabColor(storeKey(rowKey), color);
}

/** The live per-user color map (row colors and tab colors). */
export function useRowColors(): Record<string, string> {
  const [colors, setColors] = useState(getTabColors);
  useEffect(() => {
    setColors(getTabColors());
    return onTabColorsChanged(() => setColors(getTabColors()));
  }, []);
  return colors;
}

/** The swatch hex a row is tinted with, for the `--row-tint` variable. */
export function rowTintHex(colorKey: string | null): string | null {
  return colorKey ? colorHex(colorKey) : null;
}

/**
 * The row's wash: a faint mix of its swatch, painted on a pseudo-element
 * behind the row's content (the row is `relative z-1`, so `-z-1` stays inside
 * it). It sits over the row's own background, so the hover wash and the
 * selection fill still read through it.
 */
export const ROW_TINT_CLASS =
  "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-control before:bg-[color-mix(in_srgb,var(--row-tint)_13%,transparent)] before:content-['']";
