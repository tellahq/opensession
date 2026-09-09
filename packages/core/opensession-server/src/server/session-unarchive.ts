import { isArchivedId, setArchived } from "./archive";
import { clearSessionFileArchive } from "./plain-archive";
import { publishSessionChange } from "./session-cache";
import type { UnifiedSession } from "./types";

type ArchivableSession = Pick<UnifiedSession, "id" | "aliasIds" | "archived">;

export interface HumanTurnUnarchiveDeps {
  isArchivedId: typeof isArchivedId;
  setArchived: typeof setArchived;
  clearSessionFileArchive: typeof clearSessionFileArchive;
  publishSessionChange: typeof publishSessionChange;
}

const defaultDeps: HumanTurnUnarchiveDeps = {
  isArchivedId,
  setArchived,
  clearSessionFileArchive,
  publishSessionChange,
};

/** Restore an archived session when accepting a person's turn. */
export async function unarchiveForHumanTurn(
  session: ArchivableSession,
  deps: HumanTurnUnarchiveDeps = defaultDeps,
): Promise<boolean> {
  const ids = new Set([session.id, ...(session.aliasIds || [])]);
  if (!session.archived && ![...ids].some(deps.isArchivedId)) return false;

  for (const id of ids) await deps.setArchived(id, false);
  await deps.clearSessionFileArchive(session.id);
  await deps.publishSessionChange(session.id);
  return true;
}
