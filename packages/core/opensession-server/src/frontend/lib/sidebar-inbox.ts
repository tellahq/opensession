import type { UnifiedSession, Workspace } from "./types";

export interface InboxRow {
  key: string;
  workspace: Workspace | null;
  createdAt: string;
  sessions: UnifiedSession[];
}

function validTime(value: string | null | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** The stable creation anchor for a workspace row. */
export function inboxCreatedAt(row: InboxRow): string {
  if (row.workspace?.createdAt) return row.workspace.createdAt;
  let oldest = row.createdAt || "";
  for (const session of row.sessions)
    if (
      validTime(oldest) === Number.NEGATIVE_INFINITY ||
      validTime(session.createdAt) < validTime(oldest)
    )
      oldest = session.createdAt;
  return oldest;
}

/** Inbox keeps new work at the top without moving rows for ordinary activity. */
export function sortInboxByCreation<T extends InboxRow>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((left, right) => {
    const created =
      validTime(inboxCreatedAt(right)) - validTime(inboxCreatedAt(left));
    return created || left.key.localeCompare(right.key);
  });
}
