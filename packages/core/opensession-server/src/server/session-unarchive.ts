import { isArchivedId, setArchived } from "./archive";
import { clearSessionFileArchive } from "./plain-archive";
import { invalidateSessionsCache } from "./session-cache";
import type { UnifiedSession } from "./types";

type ArchivableSession = Pick<UnifiedSession, "id" | "aliasIds" | "archived">;

export interface HumanTurnUnarchiveDeps {
  isArchivedId: typeof isArchivedId;
  setArchived: typeof setArchived;
  clearSessionFileArchive: typeof clearSessionFileArchive;
  invalidateSessionsCache: typeof invalidateSessionsCache;
}

const defaultDeps: HumanTurnUnarchiveDeps = {
  isArchivedId,
  setArchived,
  clearSessionFileArchive,
  invalidateSessionsCache,
};

/** Restore an archived session when accepting a person's turn. */
export async function unarchiveForHumanTurn(
  session: ArchivableSession,
  deps: HumanTurnUnarchiveDeps = defaultDeps,
): Promise<boolean> {
  const ids = new Set([session.id, ...(session.aliasIds || [])]);
  if (!session.archived && ![...ids].some(deps.isArchivedId)) return false;

  for (const id of ids) deps.setArchived(id, false);
  await deps.clearSessionFileArchive(session.id);
  deps.invalidateSessionsCache();
  return true;
}
