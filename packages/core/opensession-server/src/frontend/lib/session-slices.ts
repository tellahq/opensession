/**
 * Assembling one session list out of the slices the server now serves.
 *
 * `GET /api/sessions` used to answer with every session, archived included —
 * 8.5 MB and 6,223 rows on a busy instance, of which the archived ones were
 * 46% of the bytes and none of the cold start. The app now polls the live
 * slice (`?archived=exclude`) and fetches the archived index
 * (`?archived=only&slim=1`) separately, after first paint.
 *
 * Everything downstream still reads ONE array. That is deliberate: the sidebar
 * badge, the tab strip's history menu, the Archived page and ⌘Z-undo all filter
 * on `archived` today, and splitting the state would mean rewiring five call
 * sites instead of merging in one place.
 *
 * The awkward part is the gap between a local archive and the server agreeing.
 * Archiving drops a session out of the live slice on the very next poll, while
 * the archived index is fetched far less often — so without help the row would
 * blink out of existence for a few seconds. A local override holds it (or, for
 * an unarchive, hides the stale indexed copy) until a fetch that started AFTER
 * the change comes back. That's also how an override that the server never
 * confirms — a session unarchived from another device, or deleted — stops
 * being held: the next index rebuild disagrees, and the override is dropped
 * rather than pinning a ghost row forever.
 */

import type { UnifiedSession } from "./types";

/** A session archived here, held until an index fetch settles it. */
export interface LocalArchiveOverride {
  session: UnifiedSession;
  /** When the change was made locally; a later fetch settles it. */
  at: number;
}

export interface SessionSlices {
  /** The polled live list (`?archived=exclude`). */
  live: UnifiedSession[];
  /** When the live list last came back, settled or 304. */
  liveAt: number;
  /** The archived index, or null before the first one lands. */
  archivedIndex: UnifiedSession[] | null;
  /** When the archived index last came back, settled or 304. */
  archivedIndexAt: number;
  locallyArchived: ReadonlyMap<string, LocalArchiveOverride>;
  /** Sessions unarchived here → when, so a later live poll settles them. */
  locallyUnarchived: ReadonlyMap<string, number>;
}

/**
 * The live list, plus every archived session not already in it.
 *
 * Returns `live` itself when there is nothing to add, so the common case keeps
 * its array identity and doesn't re-render the whole app on a poll that
 * changed nothing.
 */
export function mergeSessionSlices(
  slices: Pick<
    SessionSlices,
    "live" | "archivedIndex" | "locallyArchived" | "locallyUnarchived"
  >,
): UnifiedSession[] {
  const { live, archivedIndex, locallyArchived, locallyUnarchived } = slices;
  if (!archivedIndex?.length && locallyArchived.size === 0) return live;
  const seen = new Set(live.map((s) => s.id));
  const merged = [...live];
  for (const session of archivedIndex ?? []) {
    // A session unarchived here is still in the index until the next
    // rebuild; showing it would put the row back in Archived a beat after
    // the person took it out.
    if (seen.has(session.id) || locallyUnarchived.has(session.id)) continue;
    seen.add(session.id);
    merged.push(session);
  }
  for (const [id, override] of locallyArchived) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(override.session);
  }
  return merged;
}

/**
 * Which local overrides the server has caught up with, and can be forgotten.
 *
 * An override settles when the relevant slice confirms it — or when a fetch
 * that STARTED after the change comes back still disagreeing, which means the
 * change didn't take (or was undone elsewhere) and holding the row any longer
 * would be inventing state.
 */
export function settledOverrides(slices: SessionSlices): {
  archived: string[];
  unarchived: string[];
} {
  const archived: string[] = [];
  const indexed = slices.archivedIndex
    ? new Set(slices.archivedIndex.map((s) => s.id))
    : null;
  for (const [id, override] of slices.locallyArchived) {
    if (indexed && (indexed.has(id) || slices.archivedIndexAt > override.at))
      archived.push(id);
  }
  const liveIds = new Set(slices.live.map((s) => s.id));
  const unarchived: string[] = [];
  for (const [id, at] of slices.locallyUnarchived) {
    if (liveIds.has(id) || slices.liveAt > at) unarchived.push(id);
  }
  return { archived, unarchived };
}
