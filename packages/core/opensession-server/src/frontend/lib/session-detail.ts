import type { UnifiedSession } from "./types";

/**
 * The fields `GET /api/sessions` leaves out that this client reads, which only
 * the session you have OPEN does. They live on `GET /api/sessions/:id`.
 *
 * absent here because the web has never read either, and modelling a field
 * nothing renders is how one ends up back in the payload.
 *
 * Named as a set rather than merged wholesale, because the list projection
 * also OMITS falsy values (`isRunning`, `queuedCount`, `waitingForInput`, …).
 * A blanket merge would let a stale detail snapshot's `isRunning: true` pour
 * back over a fresh row that dropped `isRunning: false`, and the session would
 * read as running long after it stopped.
 */
export const SESSION_DETAIL_ONLY = [
  "claudeSessionId",
  "codexThreadId",
  "modelHistory",
  "transcriptPath",
] as const satisfies readonly (keyof UnifiedSession)[];

/**
 * One session from the row the poll keeps fresh plus the detail-only fields
 * behind it.
 *
 * The list row is the base on purpose: it is the copy that churns with the
 * run, where a hydrated copy is a snapshot from whenever it was fetched. The
 * detail response only ever fills in what the row does not carry.
 */
export function mergeSessionDetail(
  fromList: UnifiedSession,
  detail: UnifiedSession | null,
): UnifiedSession {
  if (!detail) return fromList;
  // A summary row carries less than the detail response does across the
  // board, so the whole session wins outright there.
  if (fromList.slim) return detail;
  const merged: UnifiedSession = { ...fromList };
  for (const key of SESSION_DETAIL_ONLY)
    if (detail[key] !== undefined)
      Object.assign(merged, { [key]: detail[key] });
  return merged;
}
