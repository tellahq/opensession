// The ids the new layout's minibar can carry besides Sessions. Kept apart
// from the pref (lib/minibar-pref.ts) so a test can read them without the
// pref's server sync.

/** Everything the minibar can carry besides Sessions, in the order it shows
 *  them: the places first, then single pages pinned beside them. */
export const MINIBAR_ITEM_IDS = [
  "channels",
  "activity",
  "support",
  "library",
  "prs",
  "issues",
  "tasks",
  "catchup",
  "automations",
  "goals",
  "security",
  "reports",
  "databases",
  "analytics",
] as const;

export type MinibarItemId = (typeof MINIBAR_ITEM_IDS)[number];

/** Every place besides Sessions, and no single page. */
export const DEFAULT_MINIBAR_ITEMS: readonly MinibarItemId[] = [
  "channels",
  "activity",
  "support",
  "library",
];
