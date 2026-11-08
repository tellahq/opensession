import { isCoordinating } from "../../lib/session-threads";
import type { UnifiedSession, Workspace } from "../../lib/types";
import { IconDelegate } from "../icons";

/** Whether a sidebar row holds a session in coordinator mode. */
export function rowCoordinates(row: {
  sessions: readonly UnifiedSession[];
  workspace?: Workspace | null;
}): boolean {
  return row.sessions.some((session) => isCoordinating(session, row.workspace));
}

/**
 * A workspace whose conversation hands work to threads (coordinator mode).
 * Same slot and faint ink as the row's other origin marks, beside the title.
 */
export function CoordinatorMark() {
  return (
    <span
      className="ml-1 flex shrink-0 items-center text-faint"
      role="img"
      aria-label="Coordinator mode: hands work to threads"
      title="Coordinator mode: hands work to threads"
    >
      <IconDelegate size={20} />
    </span>
  );
}
