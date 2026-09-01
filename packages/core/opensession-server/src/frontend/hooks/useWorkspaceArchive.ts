import { useEffect, useState } from "react";
import { fetchWorkspaceArchivedSessions } from "../lib/api";
import type { UnifiedSession } from "../lib/types";

/**
 * The archived sessions of ONE workspace.
 *
 * The app polls the live slice only, so a workspace opened cold holds no
 * closed sessions at all and its tab strip drops the history menu as if it had
 * never closed a tab. The whole archived index is the wrong thing to load for
 * that: it is the entire instance's history (1,984 KB here, and it only
 * grows), for a question about one workspace. So ask the server to scope it,
 * `?archived=only&slim=1&workspace=<id>`, which comes back in the tens of rows.
 *
 * Deliberately NOT part of useSessions' archived index. `settledOverrides`
 * (lib/session-slices) forgets a local archive as soon as an index fetch that
 * started after it lands, and a scoped list would settle overrides belonging
 * to every OTHER workspace. These rows stay separate and are merged only where
 * the history menu is built (lib/workspace-archive).
 *
 * `revision` is the caller's "something was archived or restored" counter; a
 * bump refetches. There is no poll: a workspace's history changes when someone
 * here closes a tab, and a teammate's close can wait for the next visit.
 */
export function useWorkspaceArchive(
  workspaceId: string | null,
  revision: number,
): UnifiedSession[] {
  const [rows, setRows] = useState<UnifiedSession[]>([]);
  useEffect(() => {
    if (!workspaceId) {
      setRows([]);
      return;
    }
    let active = true;
    const controller = new AbortController();
    void (async () => {
      await (async () => {
        const sessions = await fetchWorkspaceArchivedSessions(
          workspaceId,
          controller.signal,
        );
        if (!active) return;
        setRows(sessions);
      })().catch(async () => {
        // The history menu is an extra; a failed fetch just leaves it out
        // rather than putting an error in front of the session someone
        // came here to read.
      });
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [workspaceId, revision]);
  return rows;
}
