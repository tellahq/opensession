/**
 * Per-user workspace snoozes. Like pins.ts, each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file under `~/.opensession-snoozes/` of shape
 * `{ snoozes: { [rowKey]: until } }`, where `rowKey` is a sidebar row key
 * (`workspace:<id>` or a solo session id) and `until` is either an ISO wake
 * time or `"someday"` for an indefinite snooze. Filename, directory resolution
 * and legacy-name fallback come from
 * shared/user-store.ts. Snoozing is attention management (an overlay, like a
 * pin, not a workspace state), so it lives per-user and syncs across devices;
 * the lane derivation is untouched — the frontend parks actively-snoozed rows
 * in the Snoozed section and lets lapsed entries fall back to their derived
 * lane. The server does no time logic: the frontend prunes lapsed entries when
 * it sees them (marking the row unread so the wake is visible).
 */

import { getSettlements, setSettlements } from "./settlements";
import { catalogUserStore } from "./shared/catalog-user-store";

export const SNOOZE_SOMEDAY = "someday";
export type Snoozes = Record<string, string>;

/** Keep only string-key entries whose value is a wake time or Someday. */
function clean(input: unknown): Snoozes {
  const out: Snoozes = {};
  if (input && typeof input === "object") {
    for (const [key, until] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (
        typeof key === "string" &&
        key.length > 0 &&
        key.length <= 128 &&
        typeof until === "string" &&
        (until === SNOOZE_SOMEDAY || !Number.isNaN(Date.parse(until)))
      ) {
        out[key] = until;
      }
    }
  }
  return out;
}

const store = catalogUserStore<Snoozes>({
  name: "snoozes",
  field: "snoozes",
  clean,
});

export async function getSnoozes(user: string): Promise<Snoozes> {
  const current = await store.get(user);
  const settlements = await getSettlements(user);
  if (Object.keys(settlements).length === 0) return current;

  // Settled was retired in favour of an indefinite snooze. Migrate each
  // person's explicit Settled rows exactly once, preserving a more specific
  // snooze they already chose. Clearing the old map makes Unsnooze stick.
  const migrated = { ...current };
  for (const [key, record] of Object.entries(settlements))
    if (record.state === "settled" && !(key in migrated))
      migrated[key] = SNOOZE_SOMEDAY;
  const stored = await store.update(user, (latest) => ({
    ...migrated,
    ...latest,
  }));
  await setSettlements(user, {});
  return stored;
}

/** Replace a user's snoozes (validated). Returns the stored map. */
export async function setSnoozes(
  user: string,
  snoozes: unknown,
): Promise<Snoozes> {
  return store.set(user, snoozes);
}

/** Apply a delta under the catalog CAS; the result is validated like `setSnoozes`. */
export function updateSnoozes(
  user: string,
  mutate: (value: Snoozes) => unknown,
): Promise<Snoozes> {
  return store.update(user, mutate);
}
