/**
 * Per-user session tab colors. Like pins.ts, each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file under `~/.opensession-tab-colors/` of shape
 * `{ colors: { [sessionId]: colorKey } }`, where `colorKey` is one of the
 * named swatches in the frontend palette (see lib/tab-colors.ts). Colors are
 * a per-user view preference, so they live next to pins and sync across
 * devices; filename, directory resolution and legacy-name fallback come from
 * shared/user-store.ts.
 */

import { userStore } from "./shared/user-store";

/** Allowed swatch keys — keep in sync with TAB_COLORS in lib/tab-colors.ts. */
const ALLOWED = new Set([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
]);

export type TabColors = Record<string, string>;

/** Keep only string-id → allowed-color entries. */
function clean(input: unknown): TabColors {
  const out: TabColors = {};
  if (input && typeof input === "object") {
    for (const [id, color] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (
        typeof id === "string" &&
        typeof color === "string" &&
        ALLOWED.has(color)
      ) {
        out[id] = color;
      }
    }
  }
  return out;
}

const store = userStore<TabColors>({
  name: "tab-colors",
  field: "colors",
  clean,
});

export function getTabColors(user: string): TabColors {
  return store.get(user);
}

/** Replace a user's tab colors (validated). Returns the stored map. */
export function setTabColors(user: string, colors: unknown): TabColors {
  return store.set(user, colors);
}
