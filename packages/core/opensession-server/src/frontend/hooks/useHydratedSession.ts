import { useEffect } from "react";
import useSWR from "swr";
import { API_SWR_OPTIONS, apiSWRKey } from "../lib/api-swr";
import { fetchSession } from "../lib/api";
import { mergeSessionDetail } from "../lib/session-detail";
import type { UnifiedSession } from "../lib/types";

/**
 * The whole session behind the open route.
 *
 * The list is a SUMMARY now: it carries what rows render and drops the engine
 * ids, the transcript path and the model-switch history, which together were
 * ~14% of its bytes and which nothing but the open conversation reads. The
 * archived index goes further and carries summaries outright (`slim`). So the
 * open session always fetches its own detail, and three ordinary things stop
 * being possible: opening a session that isn't in the live list at all,
 * opening one from Archived, and having the session you are reading archived
 * out from under you by someone else.
 *
 * The list row stays the base when there is one. It is the copy the poll keeps
 * fresh, while a hydrated copy is a snapshot from whenever it was fetched.
 * The detail cache paints immediately when a session is revisited, revalidates
 * on mount, and refreshes whenever the row's `lastActivity` moves.
 *
 * Resolves aliases the same way the list lookup does, so an old link keeps
 * working. A failure leaves the last good copy in place: the list poll is still
 * running, and a list row without its detail still renders the conversation.
 */
export function useHydratedSession(
  sessionId: string | null,
  fromList: UnifiedSession | null,
): UnifiedSession | null {
  const { data: hydrated = null, mutate } = useSWR<UnifiedSession | null>(
    sessionId ? apiSWRKey.session(sessionId) : null,
    () => fetchSession(sessionId!),
    API_SWR_OPTIONS,
  );
  const have =
    hydrated &&
    sessionId &&
    (hydrated.id === sessionId || hydrated.aliasIds?.includes(sessionId))
      ? hydrated
      : null;
  // Refetch on new activity: the detail-only fields change when the session
  // runs, and `lastActivity` is the list's marker that it has.
  const at = fromList?.lastActivity ?? null;
  useEffect(() => {
    if (sessionId) void mutate();
  }, [sessionId, at, mutate]);

  // Identity matters here, not cost: the merge would otherwise mint a fresh
  // session object on every render of the app, and the viewer hangs effects
  // off the session it is handed. The React Compiler preserves referential
  // identity across renders for these inputs.
  if (!sessionId) return null;
  if (!fromList) return have;
  return mergeSessionDetail(fromList, have);
}
